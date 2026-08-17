using System.Text.Json;
using System.Text.Json.Nodes;

namespace Deyin.ComputerUseHost;

public sealed class RpcHost
{
  private readonly string _shotsDir;
  private readonly WindowEnumerator _windows = new();
  private readonly UiaTree _uia = new();
  private readonly InputSimulator _input = new();
  private CancellationTokenSource? _operationCts;

  public RpcHost(string shotsDir)
  {
    _shotsDir = shotsDir;
    Directory.CreateDirectory(_shotsDir);
  }

  public string Handle(string line)
  {
    try
    {
      var node = JsonNode.Parse(line) as JsonObject;
      if (node is null) return Error(null, -32700, "Parse error");
      var id = node["id"];
      var method = node["method"]?.GetValue<string>();
      var parameters = node["params"] as JsonObject ?? new JsonObject();
      if (string.IsNullOrWhiteSpace(method)) return Error(id, -32600, "Invalid request");

      var result = method switch
      {
        "ping" => JsonSerializer.SerializeToNode(new { ok = true }),
        "cancel" => Cancel(),
        "list_apps" => JsonSerializer.SerializeToNode(_windows.ListApps()),
        "list_windows" => JsonSerializer.SerializeToNode(_windows.ListWindows()),
        "get_window_state" => GetWindowState(parameters),
        "launch_app" => LaunchApp(parameters),
        "click" => Click(parameters),
        "type_text" => TypeText(parameters),
        "press_key" => PressKey(parameters),
        "scroll" => Scroll(parameters),
        "drag" => Drag(parameters),
        "set_value" => SetValue(parameters),
        _ => throw new InvalidOperationException($"Unknown method: {method}"),
      };
      return Ok(id, result);
    }
    catch (Exception ex)
    {
      return Error(null, -32603, ex.Message);
    }
  }

  private JsonNode Cancel()
  {
    _operationCts?.Cancel();
    _operationCts = null;
    return JsonSerializer.SerializeToNode(new { cancelled = true })
      ?? throw new InvalidOperationException("Failed to serialize cancel response");
  }

  private JsonNode GetWindowState(JsonObject parameters)
  {
    var windowId = parameters["windowId"]?.GetValue<string>() ?? "";
    var screenshot = parameters["screenshot"]?.GetValue<bool>() ?? true;
    var tree = parameters["tree"]?.GetValue<bool>() ?? true;
    var hwnd = _windows.ResolveHwnd(windowId);
    if (hwnd == IntPtr.Zero) throw new InvalidOperationException($"Window not found: {windowId}");

    string? screenshotPath = null;
    object[] treeNodes = Array.Empty<object>();
    if (screenshot)
    {
      screenshotPath = ScreenshotCapture.CaptureWindow(hwnd, _shotsDir, windowId);
    }
    if (tree)
    {
      treeNodes = _uia.BuildTree(hwnd);
    }
    var title = _windows.GetTitle(hwnd);
    return JsonSerializer.SerializeToNode(new
    {
      windowId,
      title,
      screenshotPath,
      tree = treeNodes,
    })!;
  }

  private JsonNode LaunchApp(JsonObject parameters)
  {
    var appId = parameters["appId"]?.GetValue<string>() ?? "";
    if (string.IsNullOrWhiteSpace(appId)) throw new InvalidOperationException("appId is required");
    var (windowId, pid) = _windows.LaunchApp(appId);
    return JsonSerializer.SerializeToNode(new { launched = appId, windowId, pid })!;
  }

  private JsonNode Click(JsonObject parameters) => RunOp(() =>
  {
    var hwnd = _windows.ResolveHwnd(parameters["windowId"]?.GetValue<string>() ?? "");
    var point = _uia.ResolveRef(hwnd, parameters["ref"]?.GetValue<string>() ?? "");
    _input.Click(hwnd, point);
    return new { ok = true };
  });

  private JsonNode TypeText(JsonObject parameters) => RunOp(() =>
  {
    var hwnd = _windows.ResolveHwnd(parameters["windowId"]?.GetValue<string>() ?? "");
    var text = parameters["text"]?.GetValue<string>() ?? "";
    var refId = parameters["ref"]?.GetValue<string>();
    if (!string.IsNullOrWhiteSpace(refId))
    {
      var point = _uia.ResolveRef(hwnd, refId!);
      _input.Click(hwnd, point);
    }
    _input.TypeText(hwnd, text);
    return new { ok = true };
  });

  private JsonNode PressKey(JsonObject parameters) => RunOp(() =>
  {
    var hwnd = _windows.ResolveHwnd(parameters["windowId"]?.GetValue<string>() ?? "");
    var key = parameters["key"]?.GetValue<string>() ?? "";
    _input.PressKey(hwnd, key);
    return new { ok = true };
  });

  private JsonNode Scroll(JsonObject parameters) => RunOp(() =>
  {
    var hwnd = _windows.ResolveHwnd(parameters["windowId"]?.GetValue<string>() ?? "");
    var deltaY = parameters["deltaY"]?.GetValue<int>() ?? 600;
    _input.Scroll(hwnd, deltaY);
    return new { ok = true };
  });

  private JsonNode Drag(JsonObject parameters) => RunOp(() =>
  {
    var hwnd = _windows.ResolveHwnd(parameters["windowId"]?.GetValue<string>() ?? "");
    var from = _uia.ResolveRef(hwnd, parameters["fromRef"]?.GetValue<string>() ?? "");
    var to = _uia.ResolveRef(hwnd, parameters["toRef"]?.GetValue<string>() ?? "");
    _input.Drag(hwnd, from, to);
    return new { ok = true };
  });

  private JsonNode SetValue(JsonObject parameters) => RunOp(() =>
  {
    var hwnd = _windows.ResolveHwnd(parameters["windowId"]?.GetValue<string>() ?? "");
    var refId = parameters["ref"]?.GetValue<string>() ?? "";
    var value = parameters["value"]?.GetValue<string>() ?? "";
    _uia.SetValue(hwnd, refId, value);
    return new { ok = true };
  });

  private JsonNode RunOp(Func<object> action)
  {
    _operationCts?.Cancel();
    _operationCts = new CancellationTokenSource();
    var token = _operationCts.Token;
    token.ThrowIfCancellationRequested();
    var result = action();
    return JsonSerializer.SerializeToNode(result)!;
  }

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
}
