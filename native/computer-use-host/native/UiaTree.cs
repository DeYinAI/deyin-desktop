using System.Runtime.InteropServices;
using System.Windows.Automation;

namespace Deyin.ComputerUseHost;

public sealed class UiaTree
{
  private readonly Dictionary<IntPtr, Dictionary<string, AutomationElement>> _windowRefs = new();

  public object[] BuildTree(IntPtr hwnd)
  {
    var root = AutomationElement.FromHandle(hwnd);
    if (root is null) return Array.Empty<object>();
    var nodes = new List<object>();
    var refs = new Dictionary<string, AutomationElement>(StringComparer.OrdinalIgnoreCase);
    _windowRefs[hwnd] = refs;
    Walk(root, nodes, refs, 0, 500);
    return nodes.ToArray();
  }

  private void Walk(AutomationElement el, List<object> nodes, Dictionary<string, AutomationElement> refs, int depth, int budget)
  {
    if (nodes.Count >= budget || depth > 16) return;
    var rect = el.Current.BoundingRectangle;
    if (rect.Width <= 0 || rect.Height <= 0) return;

    var role = el.Current.ControlType.ProgrammaticName.Replace("ControlType.", "");
    var name = (el.Current.Name ?? "").Trim();

    // Filter A11y noise:
    // 1. Offscreen bounds with negative coords that aren't visible
    // 2. Stray 1x2 or minuscule text echoes at negative x
    // 3. Text nodes with purely whitespace/empty names
    var isMicroNode = rect.Width <= 2 && rect.Height <= 2;
    var isOffscreenNoise = rect.X < 0 && rect.Y < 0;
    var isEmptyText = role.Equals("Text", StringComparison.OrdinalIgnoreCase) && string.IsNullOrWhiteSpace(name);

    if (!(isMicroNode || isOffscreenNoise || isEmptyText))
    {
      var refId = $"e{nodes.Count + 1}";
      refs[refId] = el;
      nodes.Add(new
      {
        @ref = refId,
        role = role,
        name = name,
        bounds = new { x = rect.X, y = rect.Y, width = rect.Width, height = rect.Height },
      });
    }

    if (depth >= 16 || nodes.Count >= budget) return;
    try
    {
      foreach (AutomationElement child in el.FindAll(TreeScope.Children, Condition.TrueCondition))
      {
        Walk(child, nodes, refs, depth + 1, budget);
        if (nodes.Count >= budget) return;
      }
    }
    catch
    {
      // Element might be disposed/detached
    }
  }

  public (int X, int Y) ResolveRef(IntPtr hwnd, string refId)
  {
    if (_windowRefs.TryGetValue(hwnd, out var refs) && refs.TryGetValue(refId, out var el))
    {
      var rect = el.Current.BoundingRectangle;
      return ((int)(rect.X + rect.Width / 2), (int)(rect.Y + rect.Height / 2));
    }
    // If not found in cache for this hwnd, attempt rebuilding tree once for this hwnd
    BuildTree(hwnd);
    if (_windowRefs.TryGetValue(hwnd, out refs) && refs.TryGetValue(refId, out el))
    {
      var rect = el.Current.BoundingRectangle;
      return ((int)(rect.X + rect.Width / 2), (int)(rect.Y + rect.Height / 2));
    }
    throw new InvalidOperationException($"Unknown ref {refId} for window {hwnd}. Call get_window_state first.");
  }

  public void FocusRef(IntPtr hwnd, string refId)
  {
    if (_windowRefs.TryGetValue(hwnd, out var refs) && refs.TryGetValue(refId, out var el))
    {
      try
      {
        el.SetFocus();
      }
      catch { }
    }
  }

  public void SetValue(IntPtr hwnd, string refId, string value)
  {
    if (!_windowRefs.TryGetValue(hwnd, out var refs) || !refs.TryGetValue(refId, out var el))
    {
      BuildTree(hwnd);
      if (!_windowRefs.TryGetValue(hwnd, out refs) || !refs.TryGetValue(refId, out el))
      {
        throw new InvalidOperationException($"Unknown ref {refId} for window {hwnd}.");
      }
    }
    if (el.TryGetCurrentPattern(ValuePattern.Pattern, out var pattern) && pattern is ValuePattern valuePattern)
    {
      valuePattern.SetValue(value);
      return;
    }
    throw new InvalidOperationException($"Element {refId} does not support ValuePattern.");
  }
}
