using System.Diagnostics;
using Deyin.ComputerUseHost;

// Optional arguments (all supplied by the Deyin app; tests pass them too):
//   --pipe <name>     pipe to listen on (default "deyin-computer-use")
//   --shots <dir>     where window screenshots are written
//   --parent <pid>    exit when this process exits, so a crashed app never leaves a host behind
string? Arg(string name)
{
  var args = Environment.GetCommandLineArgs();
  var i = Array.IndexOf(args, name);
  return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
}

var shotsDir = Arg("--shots")
  ?? Environment.GetEnvironmentVariable("DEYIN_COMPUTER_USE_SHOTS")
  ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Deyin", "computer-use", "shots");
Directory.CreateDirectory(shotsDir);

if (int.TryParse(Arg("--parent"), out var parentPid) && parentPid > 0)
{
  try
  {
    var parent = Process.GetProcessById(parentPid);
    _ = parent.WaitForExitAsync().ContinueWith(_ => Environment.Exit(0));
  }
  catch (ArgumentException)
  {
    // The parent is already gone; there is nobody to serve.
    return;
  }
}

var pipeName = Arg("--pipe") ?? "deyin-computer-use";
var host = new RpcHost(shotsDir);
var server = new PipeServer(pipeName, host);
await server.RunAsync();
