using System.Diagnostics;
using System.IO;
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
        var target = ResolveShortcutTarget(lnk);
        var id = !string.IsNullOrWhiteSpace(target)
          ? Path.GetFileNameWithoutExtension(target).ToLowerInvariant()
          : name.ToLowerInvariant().Replace(' ', '-');
        apps.TryAdd(id, new { id, name, path = target ?? lnk });
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
    var hwnd = new IntPtr(handle);
    if (!IsWindowVisible(hwnd) && int.TryParse(windowId, out var pid))
    {
      var candidate = FindWindowForProcess(pid, string.Empty);
      if (candidate != IntPtr.Zero) return candidate;
    }
    return hwnd;
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
    var processName = string.Empty;
    try
    {
      processName = proc.ProcessName;
    }
    catch { }
    if (string.IsNullOrWhiteSpace(processName) || processName.Equals("unknown", StringComparison.OrdinalIgnoreCase))
    {
      try
      {
        processName = Path.GetFileNameWithoutExtension(psi.FileName);
      }
      catch { }
    }

    try
    {
      proc.WaitForInputIdle(5000);
    }
    catch
    {
      // Some processes do not have a graphical message loop or fail WaitForInputIdle
    }

    var hwnd = IntPtr.Zero;
    try
    {
      hwnd = proc.MainWindowHandle;
    }
    catch { }

    for (var i = 0; i < 20 && hwnd == IntPtr.Zero; i++)
    {
      Thread.Sleep(250);
      try
      {
        proc.Refresh();
        hwnd = proc.MainWindowHandle;
      }
      catch { }

      if (hwnd == IntPtr.Zero)
      {
        hwnd = FindWindowForProcess(proc.Id, processName);
      }
    }

    var windowIdStr = hwnd != IntPtr.Zero ? hwnd.ToInt64().ToString() : string.Empty;
    return (windowIdStr, proc.Id);
  }

  public IntPtr FindWindowForProcess(int pid, string processName)
  {
    IntPtr candidate = IntPtr.Zero;
    EnumWindows((hWnd, _) =>
    {
      if (!IsWindowVisible(hWnd)) return true;
      var title = GetTitle(hWnd);
      if (string.IsNullOrWhiteSpace(title)) return true;

      GetWindowThreadProcessId(hWnd, out var windowPid);
      if (pid > 0 && windowPid == pid)
      {
        candidate = hWnd;
        return false;
      }

      if (!string.IsNullOrWhiteSpace(processName) && candidate == IntPtr.Zero)
      {
        try
        {
          var pName = Process.GetProcessById((int)windowPid).ProcessName;
          if (pName.Equals(processName, StringComparison.OrdinalIgnoreCase))
          {
            candidate = hWnd;
          }
        }
        catch { }
      }
      return true;
    }, IntPtr.Zero);
    return candidate;
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

  private static string? ResolveShortcutTarget(string lnkPath)
  {
    try
    {
      var shellType = Type.GetTypeFromProgID("WScript.Shell");
      if (shellType is null) return null;
      dynamic shell = Activator.CreateInstance(shellType)!;
      dynamic shortcut = shell.CreateShortcut(lnkPath);
      return (string?)shortcut.TargetPath;
    }
    catch
    {
      return null;
    }
  }
}
