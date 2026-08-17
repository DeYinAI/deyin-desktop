using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace Deyin.ComputerUseHost;

public static class ScreenshotCapture
{
  [DllImport("user32.dll")]
  private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll")]
  private static extern bool SetForegroundWindow(IntPtr hWnd);

  [StructLayout(LayoutKind.Sequential)]
  private struct RECT
  {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  public static string CaptureWindow(IntPtr hwnd, string shotsDir, string windowId)
  {
    if (!GetWindowRect(hwnd, out var rect)) throw new InvalidOperationException("Could not read window bounds.");
    var width = Math.Max(1, rect.Right - rect.Left);
    var height = Math.Max(1, rect.Bottom - rect.Top);
    SetForegroundWindow(hwnd);
    Thread.Sleep(80);
    using var bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp))
    {
      g.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
    }
    var file = Path.Combine(shotsDir, $"{windowId}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.png");
    bmp.Save(file, ImageFormat.Png);
    return file;
  }
}
