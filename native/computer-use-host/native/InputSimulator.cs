using System.Runtime.InteropServices;

namespace Deyin.ComputerUseHost;

public sealed class InputSimulator
{
  [DllImport("user32.dll")]
  private static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern IntPtr SetFocus(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr lpdwProcessId);

  [DllImport("kernel32.dll")]
  private static extern uint GetCurrentThreadId();

  [DllImport("user32.dll")]
  private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

  [DllImport("user32.dll")]
  private static extern bool SetCursorPos(int x, int y);

  [DllImport("user32.dll")]
  private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  private static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

  [DllImport("user32.dll")]
  private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  private const uint MOUSEEVENTF_LEFTUP = 0x0004;
  private const uint MOUSEEVENTF_WHEEL = 0x0800;
  private const int INPUT_KEYBOARD = 1;

  [StructLayout(LayoutKind.Sequential)]
  private struct RECT
  {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  public void Click(IntPtr hwnd, (int X, int Y) point)
  {
    Focus(hwnd);
    SetCursorPos(point.X, point.Y);
    Thread.Sleep(20);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
    Thread.Sleep(30);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
  }

  public void TypeText(IntPtr hwnd, string text)
  {
    Focus(hwnd);
    foreach (var ch in text)
    {
      SendKey(ch);
    }
  }

  public void PressKey(IntPtr hwnd, string key)
  {
    Focus(hwnd);
    if (TryGetVirtualKey(key, out var vk))
    {
      SendVirtualKey(vk);
    }
    else
    {
      foreach (var ch in key)
      {
        SendKey(ch);
      }
    }
  }

  private static bool TryGetVirtualKey(string key, out ushort vk)
  {
    switch (key.Trim().ToLowerInvariant())
    {
      case "enter":
      case "return":
        vk = 0x0D; return true;
      case "tab":
        vk = 0x09; return true;
      case "escape":
      case "esc":
        vk = 0x1B; return true;
      case "backspace":
        vk = 0x08; return true;
      case "space":
        vk = 0x20; return true;
      case "delete":
      case "del":
        vk = 0x2E; return true;
      case "end":
        vk = 0x23; return true;
      case "home":
        vk = 0x24; return true;
      case "pageup":
      case "prior":
        vk = 0x21; return true;
      case "pagedown":
      case "next":
        vk = 0x22; return true;
      case "up":
      case "arrowup":
        vk = 0x26; return true;
      case "down":
      case "arrowdown":
        vk = 0x28; return true;
      case "left":
      case "arrowleft":
        vk = 0x25; return true;
      case "right":
      case "arrowright":
        vk = 0x27; return true;
      default:
        vk = 0; return false;
    }
  }

  public void Scroll(IntPtr hwnd, int deltaY)
  {
    Focus(hwnd);
    if (GetWindowRect(hwnd, out var rect))
    {
      var cx = (rect.Left + rect.Right) / 2;
      var cy = (rect.Top + rect.Bottom) / 2;
      SetCursorPos(cx, cy);
    }
    // In Windows mouse wheel events, positive delta scrolls up (away from user),
    // negative delta scrolls down (toward user).
    // Invert deltaY so a positive delta_y argument scrolls down the page.
    var wheelDelta = -deltaY;
    mouse_event(MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)wheelDelta), UIntPtr.Zero);
  }

  public void Drag(IntPtr hwnd, (int X, int Y) from, (int X, int Y) to)
  {
    Focus(hwnd);
    SetCursorPos(from.X, from.Y);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
    SetCursorPos(to.X, to.Y);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
  }

  private static void Focus(IntPtr hwnd)
  {
    if (hwnd == IntPtr.Zero) return;
    try
    {
      var targetThread = GetWindowThreadProcessId(hwnd, IntPtr.Zero);
      var currentThread = GetCurrentThreadId();
      if (targetThread != currentThread && targetThread != 0)
      {
        AttachThreadInput(currentThread, targetThread, true);
        SetForegroundWindow(hwnd);
        SetFocus(hwnd);
        AttachThreadInput(currentThread, targetThread, false);
      }
      else
      {
        SetForegroundWindow(hwnd);
        SetFocus(hwnd);
      }
    }
    catch
    {
      SetForegroundWindow(hwnd);
    }
    Thread.Sleep(50);
  }

  private static void SendKey(char ch)
  {
    var down = new[]
    {
      new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = ch, dwFlags = 0x0004 } } },
    };
    SendInput(1, down, Marshal.SizeOf<INPUT>());
    Thread.Sleep(5);
    var up = new[]
    {
      new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = ch, dwFlags = 0x0006 } } },
    };
    SendInput(1, up, Marshal.SizeOf<INPUT>());
    Thread.Sleep(5);
  }

  private static void SendVirtualKey(ushort vk)
  {
    var inputs = new[]
    {
      new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = vk, dwFlags = 0 } } },
      new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = vk, dwFlags = 0x0002 } } },
    };
    SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct INPUT
  {
    public int type;
    public InputUnion U;
  }

  [StructLayout(LayoutKind.Explicit)]
  private struct InputUnion
  {
    [FieldOffset(0)] public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct KEYBDINPUT
  {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }
}
