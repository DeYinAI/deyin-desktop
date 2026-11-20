using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace Deyin.ComputerUseHost;

/// <summary>The user grabbed the mouse or keyboard while the host was driving them.</summary>
public sealed class UserTookOverException : Exception
{
  public UserTookOverException()
    : base("The user took over the mouse or keyboard, so the action was abandoned.")
  {
  }
}

/// <summary>Where the host reports things on its own (the user took over, raw input started) to the client.</summary>
internal static class HostEvents
{
  public static Action<string, JsonNode?>? Sink { get; set; }

  public static void Raise(string type, object? payload = null) =>
    Sink?.Invoke(type, payload is null ? null : Json.ToNode(payload));
}

/// <summary>
/// Notices real keyboard and mouse input while a raw-input action runs, so a person reaching for the mouse is
/// never fought over. Events the host itself injected carry a flag and are ignored.
///
/// Low-level hooks cost every input event on the machine a call into this process, so they are installed only
/// while at least one <see cref="Lease"/> is alive, on a dedicated thread with its own message loop. The callbacks
/// do nothing but set flags.
/// </summary>
internal static class InputWatch
{
  private const int WH_KEYBOARD_LL = 13;
  private const int WH_MOUSE_LL = 14;
  private const uint WM_APP = 0x8000;
  private const uint InstallMessage = WM_APP + 1;
  private const uint RemoveMessage = WM_APP + 2;
  private const int WM_MOUSEMOVE = 0x0200;
  private const int WM_KEYDOWN = 0x0100;
  private const int WM_SYSKEYDOWN = 0x0104;
  private const uint LLMHF_INJECTED = 0x01;
  private const uint LLMHF_LOWER_IL_INJECTED = 0x02;
  private const uint LLKHF_LOWER_IL_INJECTED = 0x02;
  private const uint LLKHF_INJECTED = 0x10;

  /// <summary>A real pointer movement smaller than this is a resting hand or sensor noise, not intent.</summary>
  private const int MoveThresholdPx = 6;

  /// <summary>Set DEYIN_CU_NO_TAKEOVER=1 to turn the watch off (for example while debugging on a busy machine).</summary>
  private static readonly bool Disabled = Environment.GetEnvironmentVariable("DEYIN_CU_NO_TAKEOVER") == "1";

  private static readonly object Gate = new();
  private static readonly List<Lease> Active = new();
  private static readonly ManualResetEventSlim ThreadReady = new(false);
  private static readonly ManualResetEventSlim HooksInstalled = new(false);
  private static readonly HookProc KeyboardCallback = OnKeyboard;
  private static readonly HookProc MouseCallback = OnMouse;
  private static volatile Lease[] _snapshot = Array.Empty<Lease>();
  private static Thread? _thread;
  private static uint _threadId;
  private static IntPtr _keyboardHook;
  private static IntPtr _mouseHook;

  /// <summary>One raw-input session's view of whether the user took over.</summary>
  public sealed class Lease : IDisposable
  {
    private readonly ManualResetEventSlim _signal = new(false);
    private volatile bool _tookOver;

    /// <summary>Set while the host itself is moving the cursor or restoring focus, which is not the user.</summary>
    public volatile bool Suspended;

    internal POINT Anchor;

    public bool TookOver => _tookOver;

    /// <summary>Signalled when the user takes over, so waits can end at once.</summary>
    public WaitHandle Signal => _signal.WaitHandle;

    internal void Trip()
    {
      _tookOver = true;
      _signal.Set();
    }

    public void Dispose() => End(this);
  }

  public static Lease Begin()
  {
    var lease = new Lease();
    Native.GetCursorPos(out lease.Anchor);
    if (Disabled) return lease;
    lock (Gate)
    {
      EnsureThread();
      Active.Add(lease);
      _snapshot = Active.ToArray();
      if (Active.Count == 1)
      {
        HooksInstalled.Reset();
        PostThreadMessage(_threadId, InstallMessage, IntPtr.Zero, IntPtr.Zero);
      }
    }
    // Installed within a few milliseconds; never hold up an action for longer than this on a stuck message loop.
    HooksInstalled.Wait(500);
    return lease;
  }

  /// <summary>Test hook: behave as if the user touched the mouse or keyboard. Returns how many sessions it reached.</summary>
  public static int TripAll()
  {
    var leases = _snapshot;
    foreach (var lease in leases) lease.Trip();
    return leases.Length;
  }

  private static void End(Lease lease)
  {
    lock (Gate)
    {
      if (!Active.Remove(lease)) return;
      _snapshot = Active.ToArray();
      if (Active.Count == 0) PostThreadMessage(_threadId, RemoveMessage, IntPtr.Zero, IntPtr.Zero);
    }
  }

  private static void EnsureThread()
  {
    if (_thread is not null) return;
    _thread = new Thread(Pump) { IsBackground = true, Name = "deyin-input-watch" };
    _thread.SetApartmentState(ApartmentState.STA);
    _thread.Start();
    ThreadReady.Wait(2000);
  }

  private static void Pump()
  {
    PeekMessage(out _, IntPtr.Zero, 0, 0, 0); // creates this thread's message queue before anyone posts to it
    _threadId = Native.GetCurrentThreadId();
    ThreadReady.Set();
    while (GetMessage(out var message, IntPtr.Zero, 0, 0) > 0)
    {
      if (message.Message == InstallMessage) Install();
      else if (message.Message == RemoveMessage) Remove();
    }
  }

  private static void Install()
  {
    if (_keyboardHook == IntPtr.Zero)
    {
      _keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, KeyboardCallback, GetModuleHandle(null), 0);
    }
    if (_mouseHook == IntPtr.Zero)
    {
      _mouseHook = SetWindowsHookEx(WH_MOUSE_LL, MouseCallback, GetModuleHandle(null), 0);
    }
    if (_keyboardHook == IntPtr.Zero || _mouseHook == IntPtr.Zero)
    {
      Console.Error.WriteLine($"[input-watch] could not install the input hooks (error {Marshal.GetLastWin32Error()}); takeover detection is off");
    }
    HooksInstalled.Set();
  }

  private static void Remove()
  {
    if (_keyboardHook != IntPtr.Zero) UnhookWindowsHookEx(_keyboardHook);
    if (_mouseHook != IntPtr.Zero) UnhookWindowsHookEx(_mouseHook);
    _keyboardHook = IntPtr.Zero;
    _mouseHook = IntPtr.Zero;
  }

  /// <summary>Holding a modifier is not typing; only the key pressed with it is.</summary>
  private static bool IsModifier(uint vk) => vk is >= 0x10 and <= 0x12 or >= 0xA0 and <= 0xA5 or 0x5B or 0x5C;

  private static IntPtr OnKeyboard(int code, IntPtr wParam, IntPtr lParam)
  {
    if (code >= 0)
    {
      var message = (int)wParam;
      if (message == WM_KEYDOWN || message == WM_SYSKEYDOWN)
      {
        var info = Marshal.PtrToStructure<KeyboardHookData>(lParam);
        var injected = (info.Flags & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED)) != 0;
        if (!injected && !IsModifier(info.VkCode))
        {
          foreach (var lease in _snapshot)
          {
            if (!lease.Suspended) lease.Trip();
          }
        }
      }
    }
    return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
  }

  private static IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam)
  {
    if (code >= 0)
    {
      var info = Marshal.PtrToStructure<MouseHookData>(lParam);
      var injected = (info.Flags & (LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED)) != 0;
      var message = (int)wParam;
      foreach (var lease in _snapshot)
      {
        if (lease.Suspended) continue;
        if (injected)
        {
          lease.Anchor = info.Point; // where the host itself left the pointer
          continue;
        }
        if (message != WM_MOUSEMOVE)
        {
          lease.Trip();
          continue;
        }
        var moved = Math.Abs(info.Point.X - lease.Anchor.X) + Math.Abs(info.Point.Y - lease.Anchor.Y);
        if (moved >= MoveThresholdPx) lease.Trip();
      }
    }
    return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
  }

  /* Win32 ----------------------------------------------------------------------- */

  private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  private struct KeyboardHookData
  {
    public uint VkCode;
    public uint ScanCode;
    public uint Flags;
    public uint Time;
    public IntPtr ExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct MouseHookData
  {
    public POINT Point;
    public uint MouseData;
    public uint Flags;
    public uint Time;
    public IntPtr ExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct PumpMessage
  {
    public IntPtr Window;
    public uint Message;
    public IntPtr WParam;
    public IntPtr LParam;
    public uint Time;
    public POINT Point;
  }

  [DllImport("user32.dll", SetLastError = true)]
  private static extern IntPtr SetWindowsHookEx(int hookId, HookProc callback, IntPtr module, uint threadId);

  [DllImport("user32.dll")]
  private static extern bool UnhookWindowsHookEx(IntPtr hook);

  [DllImport("user32.dll")]
  private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern int GetMessage(out PumpMessage message, IntPtr window, uint min, uint max);

  [DllImport("user32.dll")]
  private static extern bool PeekMessage(out PumpMessage message, IntPtr window, uint min, uint max, uint remove);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool PostThreadMessage(uint threadId, uint message, IntPtr wParam, IntPtr lParam);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  private static extern IntPtr GetModuleHandle(string? name);
}
