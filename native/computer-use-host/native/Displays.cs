using System.Text.RegularExpressions;

namespace Deyin.ComputerUseHost;

/// <summary>One monitor in virtual-desktop physical pixels.</summary>
public sealed record DisplayInfo(
  string Id,
  string Name,
  bool Primary,
  int X,
  int Y,
  int Width,
  int Height,
  int WorkX,
  int WorkY,
  int WorkWidth,
  int WorkHeight,
  int Dpi,
  double Scale);

public static class Displays
{
  public static IReadOnlyList<DisplayInfo> List()
  {
    var list = new List<DisplayInfo>();
    MonitorEnumProc callback = (IntPtr monitor, IntPtr _, ref RECT _, IntPtr _) =>
    {
      var info = Describe(monitor);
      if (info is not null) list.Add(info);
      return true;
    };
    Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
    GC.KeepAlive(callback);
    return list.OrderByDescending(d => d.Primary).ThenBy(d => d.X).ThenBy(d => d.Y).ToList();
  }

  public static DisplayInfo? ForWindow(IntPtr hwnd)
  {
    var monitor = Native.MonitorFromWindow(hwnd, Native.MONITOR_DEFAULTTONEAREST);
    return monitor == IntPtr.Zero ? null : Describe(monitor);
  }

  private static DisplayInfo? Describe(IntPtr monitor)
  {
    var info = new MONITORINFOEX { cbSize = System.Runtime.InteropServices.Marshal.SizeOf<MONITORINFOEX>() };
    if (!Native.GetMonitorInfo(monitor, ref info)) return null;
    uint dpi = 96;
    if (Native.GetDpiForMonitor(monitor, Native.MDT_EFFECTIVE_DPI, out var dpiX, out _) == 0 && dpiX > 0) dpi = dpiX;
    // "\\.\DISPLAY2" -> "2": stable across calls, readable in tool output.
    var digits = Regex.Match(info.szDevice ?? "", @"(\d+)$").Value;
    var id = digits.Length > 0 ? digits : monitor.ToInt64().ToString();
    return new DisplayInfo(
      id,
      info.szDevice ?? "",
      (info.dwFlags & Native.MONITORINFOF_PRIMARY) != 0,
      info.rcMonitor.Left,
      info.rcMonitor.Top,
      info.rcMonitor.Width,
      info.rcMonitor.Height,
      info.rcWork.Left,
      info.rcWork.Top,
      info.rcWork.Width,
      info.rcWork.Height,
      (int)dpi,
      Math.Round(dpi / 96.0, 2));
  }

  /// <summary>"per-monitor-v2" when the manifest took effect. Anything else means coordinates may be virtualized.</summary>
  public static string DpiAwareness()
  {
    var context = Native.GetThreadDpiAwarenessContext();
    if (Native.AreDpiAwarenessContextsEqual(context, Native.DpiContextPerMonitorV2)) return "per-monitor-v2";
    return Native.GetAwarenessFromDpiAwarenessContext(context) switch
    {
      0 => "unaware",
      1 => "system",
      2 => "per-monitor",
      _ => "unknown",
    };
  }
}
