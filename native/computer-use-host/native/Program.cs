using System.Text.Json;
using Deyin.ComputerUseHost;

var shotsDir = Environment.GetEnvironmentVariable("DEYIN_COMPUTER_USE_SHOTS")
  ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Deyin", "computer-use", "shots");
Directory.CreateDirectory(shotsDir);

var host = new RpcHost(shotsDir);
var server = new PipeServer("deyin-computer-use", host);
await server.RunAsync();
