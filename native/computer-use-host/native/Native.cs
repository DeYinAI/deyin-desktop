using System.Runtime.InteropServices;
using System.Text;

namespace Deyin.ComputerUseHost;

[StructLayout(LayoutKind.Sequential)]
internal struct RECT
{
  public int Left;
  public int Top;
  public int Right;
  public int Bottom;
  public readonly int Width => Right - Left;
  public readonly int Height => Bottom - Top;
}

[StructLayout(LayoutKind.Sequential)]
internal struct POINT
{
  public int X;
  public int Y;
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
internal struct MONITORINFOEX
{
  public int cbSize;
  public RECT rcMonitor;
  public RECT rcWork;
  public uint dwFlags;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
  public string szDevice;
}

[StructLayout(LayoutKind.Sequential)]
internal struct GUITHREADINFO
{
  public int cbSize;
  public uint flags;
  public IntPtr hwndActive;
  public IntPtr hwndFocus;
  public IntPtr hwndCapture;
  public IntPtr hwndMenuOwner;
  public IntPtr hwndMoveSize;
  public IntPtr hwndCaret;
  public RECT rcCaret;
}

[StructLayout(LayoutKind.Sequential)]
internal struct MOUSEINPUT
{
  public int dx;
  public int dy;
  public uint mouseData;
  public uint dwFlags;
  public uint time;
  public UIntPtr dwExtraInfo;
}

[StructLayout(LayoutKind.Sequential)]
internal struct KEYBDINPUT
{
  public ushort wVk;
  public ushort wScan;
  public uint dwFlags;
  public uint time;
  public UIntPtr dwExtraInfo;
}

[StructLayout(LayoutKind.Sequential)]
internal struct HARDWAREINPUT
{
  public uint uMsg;
  public ushort wParamL;
  public ushort wParamH;
}

// The union must contain the largest member (MOUSEINPUT) or sizeof(INPUT) is wrong and
// SendInput rejects every call with ERROR_INVALID_PARAMETER.
[StructLayout(LayoutKind.Explicit)]
internal struct InputUnion
{
  [FieldOffset(0)] public MOUSEINPUT mi;
  [FieldOffset(0)] public KEYBDINPUT ki;
  [FieldOffset(0)] public HARDWAREINPUT hi;
}

[StructLayout(LayoutKind.Sequential)]
internal struct INPUT
{
  public uint type;
  public InputUnion U;
}

internal delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
internal delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);

/// <summary>Win32 declarations shared by the host. Everything here is physical-pixel (PerMonitorV2).</summary>
internal static class Native
{
  public const int GA_ROOT = 2;
  public const int GA_ROOTOWNER = 3;
  public const int SW_RESTORE = 9;
  public const int GWL_EXSTYLE = -20;
  public const int GWL_STYLE = -16;
  public const long ES_READONLY = 0x0800;
  public const long WS_EX_TRANSPARENT = 0x20;
  public const long WS_EX_TOOLWINDOW = 0x80;

  public const uint INPUT_MOUSE = 0;
  public const uint INPUT_KEYBOARD = 1;
  public const uint MOUSEEVENTF_MOVE = 0x0001;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
  public const uint MOUSEEVENTF_WHEEL = 0x0800;
  public const uint MOUSEEVENTF_HWHEEL = 0x1000;
  public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
  public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
  public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;
  public const uint KEYEVENTF_SCANCODE = 0x0008;

  public const int SM_XVIRTUALSCREEN = 76;
  public const int SM_YVIRTUALSCREEN = 77;
  public const int SM_CXVIRTUALSCREEN = 78;
  public const int SM_CYVIRTUALSCREEN = 79;

  public const uint PW_RENDERFULLCONTENT = 0x2;
  public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  public const int DWMWA_CLOAKED = 14;
  public const uint MONITORINFOF_PRIMARY = 1;
  public const uint MONITOR_DEFAULTTONEAREST = 2;
  public const int MDT_EFFECTIVE_DPI = 0;

  public const uint SMTO_ABORTIFHUNG = 0x2;
  public const uint CWP_SKIPINVISIBLE = 0x1;
  public const uint CWP_SKIPDISABLED = 0x2;
  public const uint BM_CLICK = 0x00F5;
  /// <summary>Keyboard, mouse-move and mouse-button messages waiting in a queue.</summary>
  public const uint QS_INPUT = 0x0407;
  public const uint WM_SETTEXT = 0x000C;
  public const uint WM_CHAR = 0x0102;
  public const uint WM_KEYDOWN = 0x0100;
  public const uint WM_KEYUP = 0x0101;
  public const uint WM_MOUSEMOVE = 0x0200;
  public const uint WM_LBUTTONDOWN = 0x0201;
  public const uint WM_LBUTTONUP = 0x0202;
  public const uint WM_LBUTTONDBLCLK = 0x0203;
  public const uint WM_RBUTTONDOWN = 0x0204;
  public const uint WM_RBUTTONUP = 0x0205;
  public const uint WM_RBUTTONDBLCLK = 0x0206;
  public const uint WM_MBUTTONDOWN = 0x0207;
  public const uint WM_MBUTTONUP = 0x0208;
  public const uint WM_MBUTTONDBLCLK = 0x0209;
  public const uint WM_MOUSEWHEEL = 0x020A;
  public const uint WM_MOUSEHWHEEL = 0x020E;
  public const uint WM_CONTEXTMENU = 0x007B;
  public const int MK_LBUTTON = 0x1;
  public const int MK_RBUTTON = 0x2;
  public const int MK_SHIFT = 0x4;
  public const int MK_CONTROL = 0x8;
  public const int MK_MBUTTON = 0x10;

  public static readonly int InputSize = Marshal.SizeOf<INPUT>();

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT pt);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT pt);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, int flags);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT pt);
  [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr hWndParent, POINT pt, uint flags);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT pt);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] inputs, int cbSize);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW")]
  public static extern IntPtr SendMessageTimeoutPtr(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
  [DllImport("user32.dll")] public static extern uint GetQueueStatus(uint flags);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hMonitor, int dpiType, out uint dpiX, out uint dpiY);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT rect, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder exeName, ref int size);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr token, int infoClass, out int info, int length, out int returned);

  public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  public const uint TOKEN_QUERY = 0x0008;
  public const int TokenElevation = 20;

  /// <summary>True when the process runs elevated (administrator). Unknown processes count as not elevated.</summary>
  /// <summary>Full path of a process's executable, or null when it cannot be opened (protected or elevated processes).</summary>
  public static string? ImagePathOf(uint pid)
  {
    var process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (process == IntPtr.Zero) return null;
    try
    {
      var sb = new StringBuilder(1024);
      var size = sb.Capacity;
      return QueryFullProcessImageName(process, 0, sb, ref size) ? sb.ToString(0, size) : null;
    }
    finally
    {
      CloseHandle(process);
    }
  }

  public static bool IsProcessElevated(IntPtr process)
  {
    if (process == IntPtr.Zero) return false;
    if (!OpenProcessToken(process, TOKEN_QUERY, out var token)) return false;
    try
    {
      return GetTokenInformation(token, TokenElevation, out var elevated, sizeof(int), out _) && elevated != 0;
    }
    finally
    {
      CloseHandle(token);
    }
  }

  public static bool IsPidElevated(uint pid)
  {
    var process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (process == IntPtr.Zero) return false;
    try
    {
      return IsProcessElevated(process);
    }
    finally
    {
      CloseHandle(process);
    }
  }

  public static readonly bool HostElevated = IsProcessElevated(GetCurrentProcess());

  /// <summary>
  /// Windows drops input sent from a normal process to an administrator window (UIPI) without an error.
  /// Say so up front instead of reporting a click that never happened.
  /// </summary>
  public static void ThrowIfInputBlocked(IntPtr hwnd)
  {
    if (HostElevated) return;
    var pid = ProcessIdOf(hwnd);
    if (pid != 0 && IsPidElevated(pid))
    {
      throw new InvalidOperationException(
        "This app is running as administrator, so Windows blocks Deyin from sending it clicks or keys. Run Deyin as administrator to control it, or use a non-elevated app.");
    }
  }

  /// <summary>DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2.</summary>
  public static readonly IntPtr DpiContextPerMonitorV2 = new(-4);

  public static int MakeLParam(int low, int high) => (high << 16) | (low & 0xFFFF);

  /// <summary>
  /// The window class, with WinForms' per-app wrapper removed: "WindowsForms10.EDIT.app.0.1b2c3d" is an EDIT
  /// control and takes the same messages as one.
  /// </summary>
  public static string ControlClassOf(IntPtr hwnd)
  {
    var name = ClassNameOf(hwnd);
    if (!name.StartsWith("WindowsForms10.", StringComparison.Ordinal)) return name;
    var parts = name.Split('.');
    return parts.Length > 1 ? parts[1] : name;
  }

  public static string ClassNameOf(IntPtr hwnd)
  {
    var sb = new StringBuilder(256);
    return GetClassName(hwnd, sb, sb.Capacity) > 0 ? sb.ToString() : "";
  }

  public static string TitleOf(IntPtr hwnd)
  {
    var sb = new StringBuilder(512);
    _ = GetWindowText(hwnd, sb, sb.Capacity);
    return sb.ToString();
  }

  public static uint ProcessIdOf(IntPtr hwnd)
  {
    GetWindowThreadProcessId(hwnd, out var pid);
    return pid;
  }

  public static IntPtr RootOf(IntPtr hwnd)
  {
    var root = GetAncestor(hwnd, GA_ROOT);
    return root == IntPtr.Zero ? hwnd : root;
  }

  public static bool IsCloaked(IntPtr hwnd) =>
    DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out int cloaked, sizeof(int)) == 0 && cloaked != 0;

  /// <summary>The visible frame of a top-level window, without the invisible resize border Windows 10/11 add.</summary>
  public static RECT FrameBounds(IntPtr hwnd)
  {
    if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out RECT frame, Marshal.SizeOf<RECT>()) == 0 && frame.Width > 0 && frame.Height > 0)
    {
      return frame;
    }
    GetWindowRect(hwnd, out var rect);
    return rect;
  }

  public static (int X, int Y, int Width, int Height) VirtualDesktop() =>
    (GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN), GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN));
}
