using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Deyin.ComputerUseHost;

public sealed class WindowEnumerator
{
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  public IReadOnlyList<object> ListWindows()
  {
    var list = new List<object>();
    EnumWindows((hWnd, _) =>
    {
      if (!IsWindowVisible(hWnd)) return true;
      var title = GetTitle(hWnd);
      if (string.IsNullOrWhiteSpace(title)) return true;
      var processName = GetProcessName(hWnd);
      list.Add(new { id = hWnd.ToInt64().ToString(), title, app = processName });
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public IReadOnlyList<object> ListApps()
  {
    var apps = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
    foreach (var dir in new[]
             {
               Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms),
               Environment.GetFolderPath(Environment.SpecialFolder.Programs),
             })
    {
      if (!Directory.Exists(dir)) continue;
      foreach (var lnk in Directory.EnumerateFiles(dir, "*.lnk", SearchOption.AllDirectories))
      {
        var name = Path.GetFileNameWithoutExtension(lnk);
        if (string.IsNullOrWhiteSpace(name)) continue;
        var id = name.ToLowerInvariant().Replace(' ', '-');
        apps.TryAdd(id, new { id, name, path = lnk });
      }
    }
    foreach (var proc in Process.GetProcesses())
    {
      try
      {
        if (string.IsNullOrWhiteSpace(proc.MainWindowTitle)) continue;
        var id = proc.ProcessName.ToLowerInvariant();
        apps.TryAdd(id, new { id, name = proc.ProcessName, path = proc.MainModule?.FileName ?? proc.ProcessName });
      }
      catch
      {
        // access denied for some processes
      }
    }
    return apps.Values.Take(200).ToList();
  }

  public IntPtr ResolveHwnd(string windowId)
  {
    if (!long.TryParse(windowId, out var handle)) return IntPtr.Zero;
    return new IntPtr(handle);
  }

  public string GetTitle(IntPtr hwnd)
  {
    var sb = new StringBuilder(512);
    _ = GetWindowText(hwnd, sb, sb.Capacity);
    return sb.ToString();
  }

  public (string WindowId, int Pid) LaunchApp(string appId)
  {
    var psi = new ProcessStartInfo
    {
      FileName = appId.Contains('\\') || appId.Contains(':') ? appId : appId,
      UseShellExecute = true,
    };
    if (!appId.Contains('\\') && !appId.Contains(':'))
    {
      psi.FileName = appId.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? appId : $"{appId}.exe";
    }
    var proc = Process.Start(psi) ?? throw new InvalidOperationException($"Failed to launch {appId}");
    proc.WaitForInputIdle(5000);
    var hwnd = proc.MainWindowHandle;
    if (hwnd == IntPtr.Zero)
    {
      for (var i = 0; i < 20 && hwnd == IntPtr.Zero; i++)
      {
        Thread.Sleep(250);
        proc.Refresh();
        hwnd = proc.MainWindowHandle;
      }
    }
    return (hwnd == IntPtr.Zero ? proc.Id.ToString() : hwnd.ToInt64().ToString(), proc.Id);
  }

  private static string GetProcessName(IntPtr hwnd)
  {
    GetWindowThreadProcessId(hwnd, out var pid);
    try
    {
      return Process.GetProcessById((int)pid).ProcessName;
    }
    catch
    {
      return "unknown";
    }
  }
}
