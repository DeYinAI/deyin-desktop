using System.Globalization;
using System.Text.Json.Nodes;
using System.Windows.Automation;

namespace Deyin.ComputerUseHost;

/// <summary>A protocol-level failure with a JSON-RPC code the client can branch on.</summary>
public sealed class RpcException : Exception
{
  public int Code { get; }

  public RpcException(int code, string message) : base(message)
  {
    Code = code;
  }

  public const int InvalidParams = -32602;
  public const int Internal = -32603;
  public const int Cancelled = -32800;
  public const int TimedOut = -32001;
  public const int Busy = -32002;
  public const int NotFound = -32004;
  public const int TookOver = -32005;
}

public sealed class RpcHost
{
  /// <summary>How long a request waits for the previous action to finish before reporting the host as busy.</summary>
  private const int BusyWaitMs = 8000;
  /// <summary>How long past its own deadline a stuck operation is awaited before we stop waiting and answer.</summary>
  private const int TimeoutGraceMs = 1500;

  private sealed record Operation(Func<JsonObject, CancellationToken, JsonNode> Run, int TimeoutMs, bool Serialized);

  private readonly string _shotsDir;
  private readonly WindowEnumerator _windows = new();
  private readonly UiaTree _uia = new();
  private readonly UiaActions _actions = new();
  private readonly SemaphoreSlim _gate = new(1, 1);
  private readonly object _generationLock = new();
  private readonly Dictionary<string, Operation> _operations;
  private CancellationTokenSource _generation = new();

  /// <summary>Unsolicited notifications for the client (for example the user taking over the mouse).</summary>
  public event Action<string, JsonNode?>? Notify;

  public RpcHost(string shotsDir)
  {
    _shotsDir = shotsDir;
    Directory.CreateDirectory(_shotsDir);
    HostEvents.Sink = Raise;
    _operations = new Dictionary<string, Operation>
    {
      ["list_apps"] = new((_, _) => Json.ToNode(_windows.ListApps()), 30_000, false),
      ["list_windows"] = new((_, _) => Json.ToNode(_windows.ListWindows()), 10_000, false),
      ["get_window"] = new((p, _) => Json.ToNode(_windows.Describe(RequireWindow(p))), 4_000, false),
      ["list_displays"] = new((_, _) => Json.ToNode(Displays.List()), 4_000, false),
      ["get_window_state"] = new(GetWindowState, 20_000, true),
      ["launch_app"] = new(LaunchApp, 25_000, true),
      ["click"] = new(Click, 20_000, true),
      ["hover"] = new(Hover, 15_000, true),
      ["type_text"] = new(TypeText, 90_000, true),
      ["press_key"] = new(PressKey, 15_000, true),
      ["scroll"] = new(Scroll, 20_000, true),
      ["drag"] = new(Drag, 20_000, true),
      ["set_value"] = new(SetValue, 20_000, true),
    };
    // Real (non-injected) input cannot be produced from code, so the takeover path is exercised through this.
    // Refused unless the host was started for testing.
    if (Environment.GetEnvironmentVariable("DEYIN_CU_TEST_HOOKS") == "1")
    {
      _operations["simulate_takeover"] = new((_, _) => Json.ToNode(new { tripped = InputWatch.TripAll() }), 5_000, false);
    }
  }

  /* Dispatch ------------------------------------------------------------------- */

  public async Task<string> HandleAsync(string line)
  {
    JsonNode? id = null;
    try
    {
      if (JsonNode.Parse(line) is not JsonObject node) return Error(null, -32700, "Parse error");
      id = node["id"];
      var method = node["method"]?.GetValue<string>();
      if (string.IsNullOrWhiteSpace(method)) return Error(id, -32600, "Invalid request");
      var parameters = node["params"] as JsonObject ?? new JsonObject();
      return Ok(id, await DispatchAsync(method, parameters));
    }
    catch (RpcException ex)
    {
      return Error(id, ex.Code, ex.Message);
    }
    catch (UserTookOverException ex)
    {
      Raise("takeover");
      return Error(id, RpcException.TookOver, ex.Message);
    }
    catch (OperationCanceledException)
    {
      return Error(id, RpcException.Cancelled, "Cancelled");
    }
    catch (System.Text.Json.JsonException)
    {
      return Error(id, -32700, "Parse error");
    }
    catch (Exception ex)
    {
      return Error(id, RpcException.Internal, ex.Message);
    }
  }

  private async Task<JsonNode> DispatchAsync(string method, JsonObject parameters)
  {
    switch (method)
    {
      case "ping":
        return Ping();
      case "cancel":
        return CancelAll();
    }

    if (!_operations.TryGetValue(method, out var operation))
    {
      throw new RpcException(-32601, $"Unknown method: {method}");
    }

    CancellationToken generationToken;
    lock (_generationLock)
    {
      generationToken = _generation.Token;
    }
    // Linked to the current generation, so "cancel" stops this request whether it is waiting or running.
    var cts = CancellationTokenSource.CreateLinkedTokenSource(generationToken);
    cts.CancelAfter(operation.TimeoutMs);
    var token = cts.Token;

    var held = false;
    try
    {
      if (operation.Serialized)
      {
        if (!await _gate.WaitAsync(BusyWaitMs, token))
        {
          throw new RpcException(RpcException.Busy, "The computer-use host is still busy with the previous action. Try again in a moment.");
        }
        held = true;
      }
    }
    catch (OperationCanceledException)
    {
      cts.Dispose();
      throw OperationFailure(method, operation, generationToken);
    }
    catch
    {
      cts.Dispose();
      throw;
    }

    var work = Task.Run(() => operation.Run(parameters, token));
    // The gate is released exactly once: when the work ends, or when we stop waiting for it, whichever is first.
    // A read stuck inside a UI Automation call (an app showing a modal dialog from inside a provider call can
    // hold one for many seconds) must not block every request behind it.
    var gateReleased = 0;
    void ReleaseGate()
    {
      if (held && Interlocked.Exchange(ref gateReleased, 1) == 0) _gate.Release();
    }
    _ = work.ContinueWith(finished =>
    {
      _ = finished.Exception; // observed
      ReleaseGate();
      cts.Dispose();
    }, TaskScheduler.Default);

    var winner = await Task.WhenAny(work, Task.Delay(operation.TimeoutMs + TimeoutGraceMs));
    if (winner != work)
    {
      ReleaseGate();
      throw new RpcException(
        RpcException.TimedOut,
        $"{method} did not finish within {operation.TimeoutMs / 1000}s. The app may be busy (for example showing a dialog); check list_windows for a new window.");
    }

    try
    {
      return await work;
    }
    catch (OperationCanceledException)
    {
      throw OperationFailure(method, operation, generationToken);
    }
  }

  /// <summary>A cancelled token means either the user stopped the run or the operation hit its own deadline.</summary>
  private static Exception OperationFailure(string method, Operation operation, CancellationToken generationToken) =>
    generationToken.IsCancellationRequested
      ? new RpcException(RpcException.Cancelled, "Cancelled")
      : new RpcException(RpcException.TimedOut, $"{method} did not finish within {operation.TimeoutMs / 1000}s.");

  private JsonNode Ping()
  {
    var desktop = Native.VirtualDesktop();
    Native.GetCursorPos(out var cursor);
    return Json.ToNode(new
    {
      ok = true,
      version = 2,
      cursor = new { x = cursor.X, y = cursor.Y },
      foreground = Native.RootOf(Native.GetForegroundWindow()).ToInt64().ToString(),
      dpiAwareness = Displays.DpiAwareness(),
      elevated = Native.HostElevated,
      virtualDesktop = new WindowBounds(desktop.X, desktop.Y, desktop.Width, desktop.Height),
    });
  }

  /// <summary>Stop everything in flight and everything waiting. New requests start a fresh generation.</summary>
  public JsonNode CancelAll()
  {
    CancellationTokenSource previous;
    lock (_generationLock)
    {
      previous = _generation;
      _generation = new CancellationTokenSource();
    }
    previous.Cancel();
    return Json.ToNode(new { cancelled = true });
  }

  public void Raise(string type, JsonNode? payload = null) => Notify?.Invoke(type, payload);

  /* Observation ---------------------------------------------------------------- */

  private JsonNode GetWindowState(JsonObject p, CancellationToken ct)
  {
    var hwnd = RequireWindow(p);
    var windowId = Str(p, "windowId") ?? hwnd.ToInt64().ToString();
    var wantShot = Bool(p, "screenshot") ?? true;
    var wantTree = Bool(p, "tree") ?? true;
    var options = new TreeOptions(
      MaxNodes: Math.Clamp((int)(Number(p, "maxNodes") ?? 500), 20, 2000),
      MaxDepth: Math.Clamp((int)(Number(p, "depth") ?? 48), 1, 80),
      Query: string.IsNullOrWhiteSpace(Str(p, "query")) ? null : Str(p, "query"));

    var capture = wantShot ? WindowCapture.Capture(hwnd, _shotsDir, windowId) : null;
    ct.ThrowIfCancellationRequested();
    TreeResult? tree = null;
    string? treeError = null;
    if (wantTree)
    {
      try
      {
        tree = _uia.Build(hwnd, options, ct);
      }
      catch (UiaUnresponsiveException ex) when (capture is not null)
      {
        // The picture still shows what the app is doing; say why the tree is missing instead of failing the whole call.
        treeError = ex.Message;
      }
    }

    return Json.ToNode(new
    {
      window = _windows.Describe(hwnd),
      screenshot = capture is null
        ? null
        : new { path = capture.Path, width = capture.Width, height = capture.Height, scale = capture.Scale, method = capture.Method, note = capture.Note },
      tree = tree is null
        ? null
        : new { stateId = tree.StateId, nodes = tree.Nodes, visited = tree.Visited, truncated = tree.Truncated, note = tree.Note },
      treeError,
    });
  }

  private JsonNode LaunchApp(JsonObject p, CancellationToken ct)
  {
    var appId = Str(p, "appId") ?? "";
    if (string.IsNullOrWhiteSpace(appId)) throw new RpcException(RpcException.InvalidParams, "appId is required");
    var (windowId, pid) = _windows.LaunchApp(appId, ct);
    var window = windowId.Length > 0 && _windows.ResolveHwnd(windowId) is var h && h != IntPtr.Zero ? _windows.Describe(h) : null;
    return Json.ToNode(new { launched = appId, windowId, pid, window });
  }

  /* Actions -------------------------------------------------------------------- */

  private JsonNode Click(JsonObject p, CancellationToken ct)
  {
    var hwnd = RequireWindow(p);
    var target = ResolveTarget(hwnd, p, "ref", "x", "y", "click");
    var request = new ClickRequest(
      ParseButton(Str(p, "button")),
      Math.Clamp((int)(Number(p, "count") ?? 1), 1, 3),
      Keys.ParseModifiers(StringList(p, "modifiers")),
      ParseMethod(p));

    var element = target.Element;
    if (element is null && target.Point is { } at && request.IsPlainLeftClick && request.Method is "auto" or "uia")
    {
      element = ElementAt(hwnd, at);
    }
    return Json.ToNode(_actions.Click(hwnd, element, target.Point, request, ct));
  }

  private JsonNode Hover(JsonObject p, CancellationToken ct)
  {
    var hwnd = RequireWindow(p);
    var target = ResolveTarget(hwnd, p, "ref", "x", "y", "hover");
    var at = target.Point ?? throw new RpcException(RpcException.InvalidParams, "That element is scrolled out of view. Scroll it into view first.");
    // Hovering has no quiet equivalent: the pointer has to be there. It stays where the hover put it.
    using var raw = new RawInputSession(hwnd, ct) { RestoreCursor = false };
    raw.Hover(at.X, at.Y);
    return Json.ToNode(new ActionOutcome(true, "input", "pointer moved", raw.CursorMoved, raw.FocusChanged));
  }

  private JsonNode TypeText(JsonObject p, CancellationToken ct)
  {
    var hwnd = RequireWindow(p);
    var text = Str(p, "text") ?? "";
    var refText = Str(p, "ref");
    AutomationElement? element = string.IsNullOrWhiteSpace(refText) ? null : _uia.Resolve(hwnd, refText).Element;
    return Json.ToNode(_actions.TypeText(hwnd, element, text, ParseMethod(p), ct));
  }

  private JsonNode PressKey(JsonObject p, CancellationToken ct)
  {
    var hwnd = RequireWindow(p);
    var chord = Keys.ParseChord(Str(p, "key") ?? "");
    return Json.ToNode(_actions.PressKey(hwnd, chord, ct));
  }

  private JsonNode Scroll(JsonObject p, CancellationToken ct)
  {
    var hwnd = RequireWindow(p);
    var target = ResolveTarget(hwnd, p, "ref", "x", "y", "scroll", required: false);
    var deltaX = (int)(Number(p, "deltaX") ?? 0);
    var deltaY = (int)(Number(p, "deltaY") ?? (deltaX == 0 ? 600 : 0));
    var point = target.Point;
    if (target.Element is null && point is null)
    {
      // No target: scroll the middle of the window, like a user with the pointer over it.
      var frame = Native.FrameBounds(hwnd);
      point = new POINT { X = frame.Left + frame.Width / 2, Y = frame.Top + frame.Height / 2 };
    }
    return Json.ToNode(_actions.Scroll(hwnd, target.Element, point, deltaX, deltaY, ParseMethod(p), ct));
  }

  private JsonNode Drag(JsonObject p, CancellationToken ct)
  {
    var hwnd = RequireWindow(p);
    var from = ResolveTarget(hwnd, p, "fromRef", "fromX", "fromY", "drag start");
    var to = ResolveTarget(hwnd, p, "toRef", "toX", "toY", "drag end");
    var start = from.Point ?? throw new RpcException(RpcException.InvalidParams, "The drag start is scrolled out of view.");
    var end = to.Point ?? throw new RpcException(RpcException.InvalidParams, "The drag end is scrolled out of view.");
    using var raw = new RawInputSession(hwnd, ct);
    raw.Drag(start.X, start.Y, end.X, end.Y);
    return Json.ToNode(new ActionOutcome(true, "input", "drag", raw.CursorMoved, raw.FocusChanged));
  }

  private JsonNode SetValue(JsonObject p, CancellationToken ct)
  {
    var hwnd = RequireWindow(p);
    var refText = Str(p, "ref");
    if (string.IsNullOrWhiteSpace(refText)) throw new RpcException(RpcException.InvalidParams, "set_value needs a ref from get_state.");
    var element = _uia.Resolve(hwnd, refText).Element;
    return Json.ToNode(_actions.SetValue(hwnd, element, Str(p, "value") ?? "", ct));
  }

  /* Targets -------------------------------------------------------------------- */

  private sealed record Target(AutomationElement? Element, POINT? Point);

  /// <summary>
  /// A ref points at an element (and its on-screen center, when visible). x and y are pixels in the window
  /// screenshot, converted back to screen pixels with the same scale the screenshot was taken at.
  /// </summary>
  private Target ResolveTarget(IntPtr hwnd, JsonObject p, string refKey, string xKey, string yKey, string what, bool required = true)
  {
    var frame = Native.FrameBounds(hwnd);
    var refText = Str(p, refKey);
    if (!string.IsNullOrWhiteSpace(refText))
    {
      var element = _uia.Resolve(hwnd, refText).Element;
      var rect = element.Current.BoundingRectangle;
      if (rect.IsEmpty || rect.Width <= 0 || rect.Height <= 0) return new Target(element, null);
      var center = new POINT { X = (int)Math.Round(rect.X + rect.Width / 2), Y = (int)Math.Round(rect.Y + rect.Height / 2) };
      var visible = center.X >= frame.Left && center.X < frame.Right && center.Y >= frame.Top && center.Y < frame.Bottom;
      return new Target(element, visible ? center : null);
    }

    var x = Number(p, xKey);
    var y = Number(p, yKey);
    if (x is not null && y is not null)
    {
      var scale = _uia.ScaleFor(hwnd);
      var screen = new POINT
      {
        X = frame.Left + (int)Math.Round(x.Value / scale),
        Y = frame.Top + (int)Math.Round(y.Value / scale),
      };
      if (screen.X < frame.Left || screen.X >= frame.Right || screen.Y < frame.Top || screen.Y >= frame.Bottom)
      {
        var w = (int)Math.Round(frame.Width * scale);
        var h = (int)Math.Round(frame.Height * scale);
        throw new RpcException(
          RpcException.InvalidParams,
          $"({x:0.#}, {y:0.#}) is outside the window. Coordinates are pixels in the window screenshot: 0..{w} across, 0..{h} down.");
      }
      return new Target(null, screen);
    }

    if (required)
    {
      throw new RpcException(RpcException.InvalidParams, $"{what}: pass a ref from get_state, or x and y (pixels in the window screenshot).");
    }
    return new Target(null, null);
  }

  /// <summary>The accessibility element under a point, if it belongs to the target app (a covering window must not be clicked by mistake).</summary>
  private static AutomationElement? ElementAt(IntPtr hwnd, POINT at)
  {
    try
    {
      var element = AutomationElement.FromPoint(new System.Windows.Point(at.X, at.Y));
      return element.Current.ProcessId == (int)Native.ProcessIdOf(hwnd) ? element : null;
    }
    catch (Exception ex) when (ex is ElementNotAvailableException or System.Runtime.InteropServices.COMException)
    {
      return null;
    }
  }

  private IntPtr RequireWindow(JsonObject p)
  {
    var windowId = Str(p, "windowId") ?? "";
    var hwnd = _windows.ResolveHwnd(windowId);
    if (hwnd == IntPtr.Zero)
    {
      throw new RpcException(RpcException.NotFound, $"Window not found or closed: {windowId}");
    }
    return hwnd;
  }

  /* Parameter parsing ---------------------------------------------------------------- */

  private static string? Str(JsonObject p, string key) => p[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

  private static bool? Bool(JsonObject p, string key) => p[key] is JsonValue v && v.TryGetValue<bool>(out var b) ? b : null;

  private static double? Number(JsonObject p, string key)
  {
    if (p[key] is not JsonValue v) return null;
    if (v.TryGetValue<double>(out var d)) return d;
    if (v.TryGetValue<string>(out var s) && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed)) return parsed;
    return null;
  }

  private static IEnumerable<string> StringList(JsonObject p, string key) =>
    p[key] is JsonArray array
      ? array.Select(n => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null).Where(s => s is not null).Select(s => s!)
      : Array.Empty<string>();

  private static MouseButton ParseButton(string? button) => button?.ToLowerInvariant() switch
  {
    null or "" or "left" => MouseButton.Left,
    "right" => MouseButton.Right,
    "middle" => MouseButton.Middle,
    _ => throw new RpcException(RpcException.InvalidParams, $"Unknown button \"{button}\". Use left, right or middle."),
  };

  private static string ParseMethod(JsonObject p)
  {
    var method = Str(p, "method")?.ToLowerInvariant();
    return method switch
    {
      null or "" or "auto" => "auto",
      "uia" or "msg" or "input" => method,
      _ => throw new RpcException(RpcException.InvalidParams, $"Unknown method \"{method}\". Use auto, uia, msg or input."),
    };
  }

  /* Envelope ------------------------------------------------------------------------- */

  private static string Ok(JsonNode? id, JsonNode? result)
  {
    var obj = new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id?.DeepClone(), ["result"] = result?.DeepClone() };
    return obj.ToJsonString();
  }

  private static string Error(JsonNode? id, int code, string message)
  {
    var obj = new JsonObject
    {
      ["jsonrpc"] = "2.0",
      ["id"] = id?.DeepClone(),
      ["error"] = new JsonObject { ["code"] = code, ["message"] = message },
    };
    return obj.ToJsonString();
  }

  public static string Notification(string type, JsonNode? payload)
  {
    var obj = new JsonObject
    {
      ["jsonrpc"] = "2.0",
      ["method"] = "event",
      ["params"] = new JsonObject { ["type"] = type, ["data"] = payload?.DeepClone() },
    };
    return obj.ToJsonString();
  }
}
