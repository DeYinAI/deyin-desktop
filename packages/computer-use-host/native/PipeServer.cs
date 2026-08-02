using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace Deyin.ComputerUseHost;

public sealed class PipeServer
{
  private readonly string _pipeName;
  private readonly RpcHost _host;

  public PipeServer(string pipeName, RpcHost host)
  {
    _pipeName = pipeName;
    _host = host;
  }

  public async Task RunAsync(CancellationToken cancellationToken = default)
  {
    while (!cancellationToken.IsCancellationRequested)
    {
      await using var pipe = new NamedPipeServerStream(
        _pipeName,
        PipeDirection.InOut,
        NamedPipeServerStream.MaxAllowedServerInstances,
        PipeTransmissionMode.Byte,
        PipeOptions.Asynchronous);
      await pipe.WaitForConnectionAsync(cancellationToken);
      _ = Task.Run(() => HandleClientAsync(pipe, cancellationToken), cancellationToken);
    }
  }

  private async Task HandleClientAsync(NamedPipeServerStream pipe, CancellationToken cancellationToken)
  {
    try
    {
      using var reader = new StreamReader(pipe, Encoding.UTF8, false, 64 * 1024, leaveOpen: true);
      using var writer = new StreamWriter(pipe, Encoding.UTF8, 64 * 1024, leaveOpen: true) { AutoFlush = true };
      while (pipe.IsConnected && !cancellationToken.IsCancellationRequested)
      {
        var line = await reader.ReadLineAsync(cancellationToken);
        if (line is null) break;
        if (string.IsNullOrWhiteSpace(line)) continue;
        var response = _host.Handle(line);
        await writer.WriteLineAsync(response);
      }
    }
    catch
    {
      // client disconnect
    }
    finally
    {
      try { pipe.Disconnect(); } catch { /* ignore */ }
    }
  }
}
