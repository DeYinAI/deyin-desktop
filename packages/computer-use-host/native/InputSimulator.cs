using System.Runtime.InteropServices;

namespace Deyin.ComputerUseHost;

public sealed class InputSimulator
{
  [DllImport("user32.dll")]
  private static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern bool SetCursorPos(int x, int y);

  [DllImport("user32.dll")]
  private static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

  [DllImport("user32.dll")]
  private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  private const uint MOUSEEVENTF_LEFTUP = 0x0004;
  private const uint MOUSEEVENTF_WHEEL = 0x0800;
  private const int INPUT_KEYBOARD = 1;

  public void Click(IntPtr hwnd, (int X, int Y) point)
  {
    Focus(hwnd);
    SetCursorPos(point.X, point.Y);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
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
    foreach (var ch in key)
    {
      SendKey(ch);
    }
    if (key.Equals("Enter", StringComparison.OrdinalIgnoreCase)) SendVirtualKey(0x0D);
    else if (key.Equals("Tab", StringComparison.OrdinalIgnoreCase)) SendVirtualKey(0x09);
    else if (key.Equals("Escape", StringComparison.OrdinalIgnoreCase)) SendVirtualKey(0x1B);
  }

  public void Scroll(IntPtr hwnd, int deltaY)
  {
    Focus(hwnd);
    mouse_event(MOUSEEVENTF_WHEEL, 0, 0, (uint)deltaY, UIntPtr.Zero);
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
    SetForegroundWindow(hwnd);
    Thread.Sleep(40);
  }

  private static void SendKey(char ch)
  {
    var inputs = new[]
    {
      new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = ch, dwFlags = 0x0004 } } },
      new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = ch, dwFlags = 0x0006 } } },
    };
    SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
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
