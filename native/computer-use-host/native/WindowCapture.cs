using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace Deyin.ComputerUseHost;

/// <summary>A window screenshot. <c>Scale</c> is screenshot pixels per physical window pixel (1 unless the window is huge).</summary>
public sealed record CaptureResult(string? Path, int Width, int Height, double Scale, string Method, string? Note);

/// <summary>
/// Captures one window without activating it. PrintWindow with PW_RENDERFULLCONTENT renders Chromium, Electron
/// and UWP windows even when they are covered by other windows (verified in the spike); the old
/// SetForegroundWindow + CopyFromScreen path stole focus and photographed whatever was on top.
/// </summary>
public static class WindowCapture
{
  /// <summary>Longest screenshot edge. Larger windows are scaled down and every coordinate the host reports follows.</summary>
  public const int MaxEdge = 2560;

  public static double ScaleFor(int width, int height) =>
    Math.Min(1.0, (double)MaxEdge / Math.Max(1, Math.Max(width, height)));

  public static CaptureResult Capture(IntPtr hwnd, string dir, string windowId)
  {
    if (Native.IsIconic(hwnd))
    {
      return new CaptureResult(null, 0, 0, 1, "none", "The window is minimized, so there is no picture of it. The UI tree and quiet actions still work.");
    }
    if (!Native.GetWindowRect(hwnd, out var outer) || outer.Width <= 0 || outer.Height <= 0)
    {
      return new CaptureResult(null, 0, 0, 1, "none", "The window has no size to capture.");
    }

    var frame = Native.FrameBounds(hwnd);
    using var full = new Bitmap(outer.Width, outer.Height, PixelFormat.Format32bppArgb);
    var method = "printwindow";
    bool printed;
    using (var g = Graphics.FromImage(full))
    {
      var hdc = g.GetHdc();
      try
      {
        printed = Native.PrintWindow(hwnd, hdc, Native.PW_RENDERFULLCONTENT);
      }
      finally
      {
        g.ReleaseHdc(hdc);
      }
    }

    Bitmap source = full;
    Bitmap? screenCopy = null;
    try
    {
      string? note = null;
      var crop = Rectangle.Intersect(
        new Rectangle(frame.Left - outer.Left, frame.Top - outer.Top, frame.Width, frame.Height),
        new Rectangle(0, 0, full.Width, full.Height));

      if (!printed || IsBlank(full, crop))
      {
        // Some GPU surfaces come back flat. A screen copy is only trustworthy when nothing covers the window.
        if (IsUnobscured(hwnd, frame))
        {
          screenCopy = new Bitmap(frame.Width, frame.Height, PixelFormat.Format32bppArgb);
          using (var g = Graphics.FromImage(screenCopy))
          {
            g.CopyFromScreen(frame.Left, frame.Top, 0, 0, new Size(frame.Width, frame.Height), CopyPixelOperation.SourceCopy);
          }
          source = screenCopy;
          crop = new Rectangle(0, 0, screenCopy.Width, screenCopy.Height);
          method = "screen";
        }
        else
        {
          return new CaptureResult(
            null, 0, 0, 1, "none",
            "The window could not be captured while it is covered. Use the UI tree, or ask the user to bring it to the front.");
        }
      }

      if (crop.Width <= 0 || crop.Height <= 0)
      {
        return new CaptureResult(null, 0, 0, 1, "none", "The window has no visible area to capture.");
      }

      var scale = ScaleFor(crop.Width, crop.Height);
      var outWidth = Math.Max(1, (int)Math.Round(crop.Width * scale));
      var outHeight = Math.Max(1, (int)Math.Round(crop.Height * scale));
      using var result = new Bitmap(outWidth, outHeight, PixelFormat.Format32bppArgb);
      using (var g = Graphics.FromImage(result))
      {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.Half;
        g.DrawImage(source, new Rectangle(0, 0, outWidth, outHeight), crop, GraphicsUnit.Pixel);
      }

      Directory.CreateDirectory(dir);
      var file = Path.Combine(dir, $"{windowId}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.png");
      result.Save(file, ImageFormat.Png);
      if (scale < 1) note = $"Screenshot is scaled to {scale:0.##}x of the window's physical pixels; every coordinate in this state uses the screenshot's pixels.";
      return new CaptureResult(file, outWidth, outHeight, scale, method, note);
    }
    finally
    {
      screenCopy?.Dispose();
    }
  }

  /// <summary>True when a sampled grid of the image has at most one distinct color (a failed or empty render).</summary>
  private static bool IsBlank(Bitmap bmp, Rectangle area)
  {
    if (area.Width <= 0 || area.Height <= 0) return true;
    var seen = new HashSet<int>();
    const int grid = 24;
    for (var iy = 0; iy < grid; iy++)
    {
      for (var ix = 0; ix < grid; ix++)
      {
        var x = area.Left + (int)((ix + 0.5) * area.Width / grid);
        var y = area.Top + (int)((iy + 0.5) * area.Height / grid);
        seen.Add(bmp.GetPixel(Math.Min(x, bmp.Width - 1), Math.Min(y, bmp.Height - 1)).ToArgb() & 0x00FFFFFF);
        if (seen.Count > 1) return false;
      }
    }
    return true;
  }

  /// <summary>True when the window is the topmost thing at several sample points of its frame.</summary>
  internal static bool IsUnobscured(IntPtr hwnd, RECT frame)
  {
    if (Native.IsIconic(hwnd) || frame.Width <= 0 || frame.Height <= 0) return false;
    var root = Native.RootOf(hwnd);
    var rootPid = Native.ProcessIdOf(root);
    foreach (var (fx, fy) in new[] { (0.5, 0.5), (0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75) })
    {
      var pt = new POINT { X = frame.Left + (int)(frame.Width * fx), Y = frame.Top + (int)(frame.Height * fy) };
      var hit = Native.WindowFromPoint(pt);
      if (hit == IntPtr.Zero) return false;
      var hitRoot = Native.RootOf(hit);
      if (hitRoot == root) continue;
      // Click-through overlays (Deyin's own border) do not cover anything.
      if ((Native.GetWindowLongPtr(hitRoot, Native.GWL_EXSTYLE).ToInt64() & Native.WS_EX_TRANSPARENT) != 0) continue;
      // The app's own popups (menus, tooltips) are part of the window as far as the user is concerned.
      if (Native.ProcessIdOf(hitRoot) == rootPid) continue;
      return false;
    }
    return true;
  }
}
