using System.Diagnostics;
using System.Text.RegularExpressions;
using System.Windows.Automation;

namespace Deyin.ComputerUseHost;

public sealed record TreeOptions(int MaxNodes = 500, int MaxDepth = 48, string? Query = null, int TimeBudgetMs = 8000);

public sealed class TreeResult
{
  public int StateId { get; init; }
  public object[] Nodes { get; init; } = Array.Empty<object>();
  /// <summary>Elements looked at, including ones the output omitted.</summary>
  public int Visited { get; init; }
  public bool Truncated { get; init; }
  public string? Note { get; init; }
}

/// <summary>The app stopped answering accessibility requests (typically: it is inside a modal dialog it opened from a UIA call).</summary>
public sealed class UiaUnresponsiveException : InvalidOperationException
{
  public UiaUnresponsiveException()
    : base(
      "The app is not answering accessibility requests, usually because it is showing a modal dialog. "
      + "Call list_windows: the dialog is its own window you can see and click.")
  {
  }
}

/// <summary>An element resolved from a ref, with the coordinate space it was observed in.</summary>
internal sealed record ResolvedElement(AutomationElement Element, int StateId, double Scale);

/// <summary>
/// Reads a window's accessibility tree with a UIA CacheRequest (one cross-process call per parent instead of one
/// per property), keeps the most interactive nodes when over budget, and hands out refs that carry the
/// observation id so a ref from an old observation is refused instead of clicking whatever moved into its slot.
/// </summary>
public sealed class UiaTree
{
  private const int KeepObservations = 4;
  private const int VisitBudget = 5000;
  private const int MaxChildrenPerNode = 400;

  private static readonly HashSet<string> InteractiveRoles = new(StringComparer.Ordinal)
  {
    "Button", "CheckBox", "ComboBox", "Edit", "Hyperlink", "ListItem", "MenuItem", "RadioButton", "Slider", "Spinner",
    "SplitButton", "TabItem", "TreeItem", "DataItem", "Document", "ScrollBar", "Thumb",
  };

  private static readonly HashSet<string> StructuralRoles = new(StringComparer.Ordinal)
  {
    "Pane", "Group", "Custom", "Header", "HeaderItem", "Separator", "Image", "ToolTip",
  };

  private sealed class Observation
  {
    public int StateId;
    public readonly Dictionary<int, AutomationElement> Elements = new();
    public double Scale = 1;
  }

  private sealed class Node
  {
    public AutomationElement El = null!;
    public int Parent = -1;
    public int Depth;
    public string Role = "";
    public string Name = "";
    public string? Value;
    public System.Windows.Rect Rect;
    public bool Enabled = true;
    public bool Focused;
    public bool Offscreen;
    public bool Password;
    public string? Toggle;
    public string? Expanded;
    public bool Selected;
    public string AutomationId = "";
    public readonly List<int> Children = new();
  }

  private readonly Dictionary<IntPtr, List<Observation>> _history = new();
  private readonly object _lock = new();
  private int _nextStateId;

  /* Observing ------------------------------------------------------------------ */

  /// <summary>
  /// The walk checks its own budget between UIA calls, but a single call can block for many seconds when the app
  /// is inside a modal dialog it opened from a UIA call. Run it where it can be abandoned: at the deadline, or when
  /// the run is cancelled.
  /// </summary>
  private List<Node> WalkBounded(IntPtr hwnd, CacheRequest cache, TreeOptions options, CancellationToken ct, out bool truncated)
  {
    List<Node>? result = null;
    var wasTruncated = false;
    Exception? failure = null;
    var worker = Task.Run(() =>
    {
      try
      {
        result = Walk(hwnd, cache, options, ct, out wasTruncated);
      }
      catch (Exception ex)
      {
        failure = ex;
      }
    });
    var graceMs = 3000;
    var finished = false;
    try
    {
      finished = worker.Wait(options.TimeBudgetMs + graceMs, ct);
    }
    catch (OperationCanceledException)
    {
      throw;
    }
    if (!finished)
    {
      throw new UiaUnresponsiveException();
    }
    if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    truncated = wasTruncated;
    return result ?? new List<Node>();
  }

  public TreeResult Build(IntPtr hwnd, TreeOptions options, CancellationToken ct)
  {
    var frame = Native.FrameBounds(hwnd);
    var scale = WindowCapture.ScaleFor(frame.Width, frame.Height);
    var cache = NewCacheRequest();

    var nodes = new List<Node>();
    var truncated = false;
    string? note = null;
    // Chromium and Electron only build their full accessibility tree once a client has asked for it.
    // The first read can be a stub, so a thin result gets one patient retry.
    for (var attempt = 0; attempt < 2; attempt++)
    {
      nodes = WalkBounded(hwnd, cache, options, ct, out truncated);
      if (nodes.Count > 12 || !IsChromiumHost(hwnd)) break;
      note = "Chromium-based window: its accessibility tree was thin on first read; retried once.";
      ct.WaitHandle.WaitOne(450);
    }

    var selected = Select(nodes, options, out var overBudget);
    var (outputNodes, observation) = Emit(nodes, selected, frame, scale);

    int stateId;
    lock (_lock)
    {
      stateId = ++_nextStateId;
      observation.StateId = stateId;
      observation.Scale = scale;
      if (!_history.TryGetValue(hwnd, out var list)) _history[hwnd] = list = new List<Observation>();
      list.Add(observation);
      while (list.Count > KeepObservations) list.RemoveAt(0);
    }

    // Refs are s<state>e<index>, so the output has to be built after the state id exists.
    var withState = outputNodes.Select(n => n with { Ref = $"s{stateId}e{n.Index}" }).Cast<object>().ToArray();
    return new TreeResult
    {
      StateId = stateId,
      Nodes = withState,
      Visited = nodes.Count,
      Truncated = truncated || overBudget,
      Note = note,
    };
  }

  private static CacheRequest NewCacheRequest()
  {
    var cache = new CacheRequest { AutomationElementMode = AutomationElementMode.Full, TreeScope = TreeScope.Element };
    cache.Add(AutomationElement.NameProperty);
    cache.Add(AutomationElement.ControlTypeProperty);
    cache.Add(AutomationElement.BoundingRectangleProperty);
    cache.Add(AutomationElement.IsOffscreenProperty);
    cache.Add(AutomationElement.IsEnabledProperty);
    cache.Add(AutomationElement.HasKeyboardFocusProperty);
    cache.Add(AutomationElement.AutomationIdProperty);
    cache.Add(AutomationElement.IsPasswordProperty);
    cache.Add(ValuePattern.ValueProperty);
    cache.Add(TogglePattern.ToggleStateProperty);
    cache.Add(ExpandCollapsePattern.ExpandCollapseStateProperty);
    cache.Add(SelectionItemPattern.IsSelectedProperty);
    return cache;
  }

  private static bool IsChromiumHost(IntPtr hwnd) =>
    Native.ClassNameOf(hwnd).StartsWith("Chrome_WidgetWin", StringComparison.Ordinal);

  private static List<Node> Walk(IntPtr hwnd, CacheRequest cache, TreeOptions options, CancellationToken ct, out bool truncated)
  {
    truncated = false;
    var nodes = new List<Node>();
    var watch = Stopwatch.StartNew();

    AutomationElement root;
    using (cache.Activate())
    {
      root = AutomationElement.FromHandle(hwnd);
    }
    var rootNode = ReadNode(root, -1, 0);
    if (rootNode is null) return nodes;
    nodes.Add(rootNode);

    var queue = new Queue<int>();
    queue.Enqueue(0);
    while (queue.Count > 0)
    {
      ct.ThrowIfCancellationRequested();
      if (nodes.Count >= VisitBudget || watch.ElapsedMilliseconds > options.TimeBudgetMs)
      {
        truncated = true;
        break;
      }

      var index = queue.Dequeue();
      var parent = nodes[index];
      if (parent.Depth >= options.MaxDepth || parent.Offscreen) continue;

      AutomationElementCollection children;
      try
      {
        using (cache.Activate())
        {
          children = parent.El.FindAll(TreeScope.Children, Condition.TrueCondition);
        }
      }
      catch (Exception ex) when (ex is ElementNotAvailableException or System.Runtime.InteropServices.COMException or InvalidOperationException)
      {
        continue; // the element went away mid-walk
      }

      var taken = 0;
      foreach (AutomationElement child in children)
      {
        if (++taken > MaxChildrenPerNode)
        {
          truncated = true;
          break;
        }
        var node = ReadNode(child, index, parent.Depth + 1);
        if (node is null) continue;
        parent.Children.Add(nodes.Count);
        queue.Enqueue(nodes.Count);
        nodes.Add(node);
      }
    }
    return nodes;
  }

  private static Node? ReadNode(AutomationElement el, int parent, int depth)
  {
    try
    {
      var cached = el.Cached;
      var node = new Node
      {
        El = el,
        Parent = parent,
        Depth = depth,
        Role = cached.ControlType.ProgrammaticName.Replace("ControlType.", ""),
        Name = (cached.Name ?? "").Trim(),
        Rect = cached.BoundingRectangle,
        Enabled = cached.IsEnabled,
        Focused = cached.HasKeyboardFocus,
        Offscreen = cached.IsOffscreen,
        AutomationId = cached.AutomationId ?? "",
        Password = cached.IsPassword,
      };

      if (!node.Password && el.GetCachedPropertyValue(ValuePattern.ValueProperty, true) is string value && value.Length > 0)
      {
        node.Value = value.Length > 200 ? value[..200] + "…" : value;
      }
      if (el.GetCachedPropertyValue(TogglePattern.ToggleStateProperty, true) is ToggleState toggle)
      {
        node.Toggle = toggle switch { ToggleState.On => "on", ToggleState.Off => "off", _ => "indeterminate" };
      }
      if (el.GetCachedPropertyValue(ExpandCollapsePattern.ExpandCollapseStateProperty, true) is ExpandCollapseState expand
          && expand != ExpandCollapseState.LeafNode)
      {
        node.Expanded = expand == ExpandCollapseState.Collapsed ? "collapsed" : "expanded";
      }
      if (el.GetCachedPropertyValue(SelectionItemPattern.IsSelectedProperty, true) is bool selected) node.Selected = selected;
      return node;
    }
    catch (Exception ex) when (ex is ElementNotAvailableException or InvalidOperationException or System.Runtime.InteropServices.COMException)
    {
      return null;
    }
  }

  /* Choosing what to report ---------------------------------------------------- */

  private static bool IsNoise(Node n)
  {
    if (n.Offscreen && n.Parent >= 0) return true;
    if (n.Rect.IsEmpty || n.Rect.Width <= 0 || n.Rect.Height <= 0) return true;
    // Stray 1x2 echoes, and text pushed off to negative coordinates, are accessibility noise.
    if (n.Rect.Width <= 2 && n.Rect.Height <= 2) return true;
    if (n.Rect.X < 0 && n.Rect.Y < 0 && n.Parent >= 0) return true;
    if (n.Role == "Text" && string.IsNullOrWhiteSpace(n.Name)) return true;
    return false;
  }

  /// <summary>0 = interactive, 1 = informative, 2 = structural filler.</summary>
  private static int PriorityOf(Node n)
  {
    if (InteractiveRoles.Contains(n.Role)) return 0;
    if (StructuralRoles.Contains(n.Role) && string.IsNullOrWhiteSpace(n.Name)) return 2;
    return string.IsNullOrWhiteSpace(n.Name) && n.Value is null ? 2 : 1;
  }

  private static HashSet<int> Select(List<Node> nodes, TreeOptions options, out bool overBudget)
  {
    overBudget = false;
    var max = Math.Clamp(options.MaxNodes, 1, 1500);
    var usable = new List<int>();
    for (var i = 0; i < nodes.Count; i++)
    {
      var n = nodes[i];
      if (i == 0) continue; // the window itself is always reported
      if (IsNoise(n)) continue;
      if (n.Role == "Text" && n.Parent >= 0 && string.Equals(nodes[n.Parent].Name, n.Name, StringComparison.Ordinal)) continue;
      if (PriorityOf(n) >= 2) continue;
      usable.Add(i);
    }

    HashSet<int> chosen;
    if (!string.IsNullOrWhiteSpace(options.Query))
    {
      var q = options.Query.Trim();
      var hits = usable.Where(i => Matches(nodes[i], q)).ToList();
      overBudget = hits.Count > max;
      chosen = new HashSet<int>(hits.Take(max));
      // Keep the named ancestors of every hit, so a match is readable in context.
      foreach (var hit in hits.Take(max).ToList())
      {
        for (var p = nodes[hit].Parent; p > 0; p = nodes[p].Parent)
        {
          if (chosen.Count >= max) break;
          if (!IsNoise(nodes[p]) && PriorityOf(nodes[p]) < 2) chosen.Add(p);
        }
      }
    }
    else
    {
      // Interactive controls first, so a busy page spends its budget on things the agent can act on.
      overBudget = usable.Count > max;
      chosen = new HashSet<int>(usable.Where(i => PriorityOf(nodes[i]) == 0).Take(max));
      foreach (var i in usable)
      {
        if (chosen.Count >= max) break;
        if (PriorityOf(nodes[i]) == 1) chosen.Add(i);
      }
    }
    chosen.Add(0);
    return chosen;
  }

  private static bool Matches(Node n, string q) =>
    n.Name.Contains(q, StringComparison.OrdinalIgnoreCase)
    || (n.Value?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false)
    || n.AutomationId.Contains(q, StringComparison.OrdinalIgnoreCase)
    || n.Role.Contains(q, StringComparison.OrdinalIgnoreCase);

  public sealed record OutNode(
    [property: System.Text.Json.Serialization.JsonIgnore] int Index,
    string Ref,
    string Role,
    string Name,
    string? Value,
    NodeBounds Bounds,
    int Depth,
    bool? Enabled,
    bool? Focused,
    string? Toggled,
    string? Expanded,
    bool? Selected,
    string? Id,
    bool? Password);

  public sealed record NodeBounds(int X, int Y, int Width, int Height);

  private static (List<OutNode> Nodes, Observation Observation) Emit(List<Node> nodes, HashSet<int> chosen, RECT frame, double scale)
  {
    var observation = new Observation();
    var output = new List<OutNode>();

    // Depth-first, so the outline reads top to bottom like the window does.
    var stack = new Stack<int>();
    stack.Push(0);
    while (stack.Count > 0)
    {
      var index = stack.Pop();
      var n = nodes[index];
      for (var c = n.Children.Count - 1; c >= 0; c--) stack.Push(n.Children[c]);
      if (!chosen.Contains(index)) continue;

      var e = output.Count + 1;
      observation.Elements[e] = n.El;
      var depth = n.Depth;
      output.Add(new OutNode(
        e,
        "",
        n.Role,
        n.Name,
        n.Value,
        new NodeBounds(
          (int)Math.Round((n.Rect.X - frame.Left) * scale),
          (int)Math.Round((n.Rect.Y - frame.Top) * scale),
          (int)Math.Round(n.Rect.Width * scale),
          (int)Math.Round(n.Rect.Height * scale)),
        depth,
        n.Enabled ? null : false,
        n.Focused ? true : null,
        n.Toggle,
        n.Expanded,
        n.Selected ? true : null,
        string.IsNullOrEmpty(n.AutomationId) ? null : n.AutomationId,
        n.Password ? true : null));
    }
    return (output, observation);
  }

  /* Resolving refs ------------------------------------------------------------- */

  private static readonly Regex RefPattern = new(@"^(?:s(\d+))?e(\d+)$", RegexOptions.Compiled | RegexOptions.IgnoreCase);

  /// <summary>
  /// Find the element a ref points at. A plain "e12" means "in the latest observation"; "s7e12" is pinned to
  /// observation 7 and is refused once a newer observation exists, because index 12 may now be a different element.
  /// </summary>
  internal ResolvedElement Resolve(IntPtr hwnd, string refText)
  {
    var match = RefPattern.Match((refText ?? "").Trim());
    if (!match.Success)
    {
      throw new InvalidOperationException($"\"{refText}\" is not a valid ref. Use a ref from get_state, like s3e12.");
    }

    Observation latest;
    Observation? target = null;
    lock (_lock)
    {
      if (!_history.TryGetValue(hwnd, out var list) || list.Count == 0)
      {
        throw new InvalidOperationException("No observation of this window yet. Call get_state first, then use its refs.");
      }
      latest = list[^1];
      if (match.Groups[1].Success)
      {
        var wanted = int.Parse(match.Groups[1].Value);
        target = list.FirstOrDefault(o => o.StateId == wanted);
        if (target is null)
        {
          throw new InvalidOperationException(
            $"Ref {refText} is from an observation that has expired (latest is s{latest.StateId}). Call get_state again and use the new refs.");
        }
        if (target.StateId != latest.StateId)
        {
          throw new InvalidOperationException(
            $"Ref {refText} is from observation s{target.StateId}, but the window was observed again (s{latest.StateId}) and the UI may have changed. Use a ref from the latest get_state.");
        }
      }
      target ??= latest;
    }

    var index = int.Parse(match.Groups[2].Value);
    if (!target.Elements.TryGetValue(index, out var element))
    {
      throw new InvalidOperationException($"Ref {refText} does not exist in observation s{target.StateId}. Call get_state and use one of its refs.");
    }

    try
    {
      // Touch a live property: a disposed or moved-away element throws here instead of mid-click.
      _ = element.Current.BoundingRectangle;
    }
    catch (ElementNotAvailableException)
    {
      throw new InvalidOperationException($"{refText} no longer exists (the UI changed). Call get_state to re-observe.");
    }
    return new ResolvedElement(element, target.StateId, target.Scale);
  }

  /// <summary>Screenshot pixels per physical pixel for this window: the latest observation's, or what a new one would use.</summary>
  public double ScaleFor(IntPtr hwnd)
  {
    lock (_lock)
    {
      if (_history.TryGetValue(hwnd, out var list) && list.Count > 0) return list[^1].Scale;
    }
    var frame = Native.FrameBounds(hwnd);
    return WindowCapture.ScaleFor(frame.Width, frame.Height);
  }

  public void Forget(IntPtr hwnd)
  {
    lock (_lock)
    {
      _history.Remove(hwnd);
    }
  }
}
