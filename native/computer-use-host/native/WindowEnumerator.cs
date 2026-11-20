using System.Diagnostics;

namespace Deyin.ComputerUseHost;

public sealed record WindowBounds(int X, int Y, int Width, int Height);

/// <summary>
/// A top-level window. <c>Bounds</c> are physical screen pixels of the visible frame; <c>DpiScale</c> is the
/// display's scale factor (1.5 = 150%). Both are facts about the window; the screenshot space is described separately.
/// </summary>
public sealed record WindowInfo(
  string Id,
  string Title,
  string App,
  int Pid,
  WindowBounds Bounds,
  string? DisplayId,
  double DpiScale,
  bool Minimized,
  bool Foreground,
  bool Elevated);

public sealed record AppInfo(string Id, string Name, string Path);

public sealed class WindowEnumerator
{
  private static readonly TimeSpan ProcessCacheTtl = TimeSpan.FromSeconds(10);
  private static readonly TimeSpan AppsCacheTtl = TimeSpan.FromSeconds(60);
  private const int LaunchWaitMs = 8000;

  private sealed record ProcessFacts(string Name, bool Elevated, long ExpiresAt);

  private readonly Dictionary<uint, ProcessFacts> _processes = new();
  private readonly object _lock = new();
  private IReadOnlyList<AppInfo>? _apps;
  private long _appsExpiresAt;

  /* Windows -------------------------------------------------------------------- */

  public IReadOnlyList<WindowInfo> ListWindows()
  {
    var found = new List<IntPtr>();
    Native.EnumWindows((hwnd, _) =>
    {
      if (IsAppWindow(hwnd)) found.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    var foreground = Native.RootOf(Native.GetForegroundWindow());
    return found.Select(h => Describe(h, foreground)).ToList();
  }

  public WindowInfo Describe(IntPtr hwnd) => Describe(hwnd, Native.RootOf(Native.GetForegroundWindow()));

  private WindowInfo Describe(IntPtr hwnd, IntPtr foreground)
  {
    var pid = Native.ProcessIdOf(hwnd);
    var facts = FactsFor(pid);
    var minimized = Native.IsIconic(hwnd);
    var frame = minimized ? default : Native.FrameBounds(hwnd);
    var display = minimized ? null : Displays.ForWindow(hwnd);
    return new WindowInfo(
      hwnd.ToInt64().ToString(),
      Native.TitleOf(hwnd),
      facts.Name,
      (int)pid,
      new WindowBounds(frame.Left, frame.Top, frame.Width, frame.Height),
      display?.Id,
      display?.Scale ?? 1,
      minimized,
      Native.RootOf(hwnd) == foreground,
      facts.Elevated);
  }

  /// <summary>Windows a person would call an app window: visible, titled, not a tool window, not cloaked (other virtual desktop, hidden UWP shell).</summary>
  private static bool IsAppWindow(IntPtr hwnd)
  {
    if (!Native.IsWindowVisible(hwnd)) return false;
    if (Native.IsCloaked(hwnd)) return false;
    if (string.IsNullOrWhiteSpace(Native.TitleOf(hwnd))) return false;
    var ex = Native.GetWindowLongPtr(hwnd, Native.GWL_EXSTYLE).ToInt64();
    return (ex & Native.WS_EX_TOOLWINDOW) == 0;
  }

  public IntPtr ResolveHwnd(string windowId)
  {
    if (!long.TryParse(windowId, out var handle) || handle == 0) return IntPtr.Zero;
    var hwnd = new IntPtr(handle);
    return Native.IsWindow(hwnd) && Native.IsWindowVisible(hwnd) ? hwnd : IntPtr.Zero;
  }

  public string GetTitle(IntPtr hwnd) => Native.TitleOf(hwnd);

  private ProcessFacts FactsFor(uint pid)
  {
    var now = Environment.TickCount64;
    lock (_lock)
    {
      if (_processes.TryGetValue(pid, out var cached) && cached.ExpiresAt > now) return cached;
    }
    var name = "unknown";
    try
    {
      name = Process.GetProcessById((int)pid).ProcessName;
    }
    catch
    {
      // the process ended, or it is protected
    }
    var facts = new ProcessFacts(name, Native.IsPidElevated(pid), now + (long)ProcessCacheTtl.TotalMilliseconds);
    lock (_lock)
    {
      _processes[pid] = facts;
    }
    return facts;
  }

  /* Apps ----------------------------------------------------------------------- */

  public IReadOnlyList<AppInfo> ListApps()
  {
    var now = Environment.TickCount64;
    lock (_lock)
    {
      if (_apps is not null && _appsExpiresAt > now) return _apps;
    }

    var apps = new Dictionary<string, AppInfo>(StringComparer.OrdinalIgnoreCase);
    foreach (var dir in new[]
             {
               Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms),
               Environment.GetFolderPath(Environment.SpecialFolder.Programs),
             })
    {
      if (!Directory.Exists(dir)) continue;
      foreach (var lnk in SafeEnumerateShortcuts(dir))
      {
        var name = Path.GetFileNameWithoutExtension(lnk);
        if (string.IsNullOrWhiteSpace(name)) continue;
        var target = ResolveShortcutTarget(lnk);
        var id = !string.IsNullOrWhiteSpace(target)
          ? Path.GetFileNameWithoutExtension(target).ToLowerInvariant()
          : name.ToLowerInvariant().Replace(' ', '-');
        apps.TryAdd(id, new AppInfo(id, name, target ?? lnk));
      }
    }

    // Anything with an open window is launchable even without a Start menu entry.
    foreach (var window in ListWindows())
    {
      var id = window.App.ToLowerInvariant();
      if (apps.ContainsKey(id)) continue;
      apps[id] = new AppInfo(id, window.App, Native.ImagePathOf((uint)window.Pid) ?? window.App);
    }

    var result = apps.Values.Take(300).ToList();
    lock (_lock)
    {
      _apps = result;
      _appsExpiresAt = now + (long)AppsCacheTtl.TotalMilliseconds;
    }
    return result;
  }

  private static IEnumerable<string> SafeEnumerateShortcuts(string dir)
  {
    try
    {
      return Directory.EnumerateFiles(dir, "*.lnk", SearchOption.AllDirectories).ToList();
    }
    catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
    {
      return Array.Empty<string>();
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

  /* Launching ---------------------------------------------------------------------- */

  /// <summary>
  /// Launch an app, or return its window if it is already running (a second Notepad is rarely what anyone wants).
  /// The window is found as "the new window that appeared", because packaged apps such as Calculator and Settings
  /// open their window under a different process than the one that was started.
  /// </summary>
  public (string WindowId, int Pid) LaunchApp(string appId, CancellationToken ct)
  {
    var isPathOrUri = appId.Contains('\\') || appId.Contains('/') || appId.Contains(':');
    var fileName = isPathOrUri || appId.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? appId : $"{appId}.exe";
    var expectedName = isPathOrUri ? "" : Path.GetFileNameWithoutExtension(fileName);

    if (expectedName.Length > 0)
    {
      var running = FindWindowForProcessName(expectedName);
      if (running != IntPtr.Zero) return (running.ToInt64().ToString(), (int)Native.ProcessIdOf(running));
    }

    var before = new HashSet<long>(ListWindows().Select(w => long.Parse(w.Id)));
    var process = Process.Start(new ProcessStartInfo { FileName = fileName, UseShellExecute = true })
      ?? throw new InvalidOperationException($"Failed to launch {appId}");

    var deadline = Environment.TickCount64 + LaunchWaitMs;
    while (Environment.TickCount64 < deadline)
    {
      ct.ThrowIfCancellationRequested();
      var fresh = ListWindows().Where(w => !before.Contains(long.Parse(w.Id))).ToList();
      var best = fresh.FirstOrDefault(w => ProcessMatches(w, process, expectedName)) ?? (fresh.Count == 1 ? fresh[0] : null);
      if (best is not null)
      {
        // Let the first frame paint so the screenshot is not a blank window.
        ct.WaitHandle.WaitOne(250);
        return (best.Id, best.Pid);
      }
      ct.WaitHandle.WaitOne(120);
    }
    return ("", SafePid(process));
  }

  private static bool ProcessMatches(WindowInfo window, Process started, string expectedName)
  {
    if (window.Pid == SafePid(started)) return true;
    return expectedName.Length > 0 && window.App.Equals(expectedName, StringComparison.OrdinalIgnoreCase);
  }

  private static int SafePid(Process process)
  {
    try
    {
      return process.Id;
    }
    catch
    {
      return 0;
    }
  }

  public IntPtr FindWindowForProcessName(string processName)
  {
    if (string.IsNullOrWhiteSpace(processName)) return IntPtr.Zero;
    return ListWindows()
      .Where(w => w.App.Equals(processName, StringComparison.OrdinalIgnoreCase))
      .Select(w => new IntPtr(long.Parse(w.Id)))
      .FirstOrDefault();
  }
}
