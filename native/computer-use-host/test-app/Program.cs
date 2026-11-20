using System.Windows.Forms;

namespace DeyinTestApp;

internal static class Program
{
  // --title <text>   window title (lets the test run a "target" and a "decoy" side by side)
  // --log <file>     append every event here
  // --pos <x,y>      top-left of the window in physical pixels
  // --cmd <file>     when this file appears, run its first line ("front" takes the foreground) and delete it
  // --size <w,h>     client size (a window wider than 2560 exercises screenshot downscaling)
  [STAThread]
  private static void Main(string[] args)
  {
    string? Arg(string name)
    {
      var i = Array.IndexOf(args, name);
      return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }

    ApplicationConfiguration.Initialize();
    Application.Run(new MainForm(Arg("--title") ?? "Deyin Test App", Arg("--log"), Arg("--pos"), Arg("--size"), Arg("--cmd")));
  }
}
