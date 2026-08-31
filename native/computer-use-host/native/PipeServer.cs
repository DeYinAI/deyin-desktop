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
      var pipe = new NamedPipeServerStream(
        _pipeName,
        PipeDirection.InOut,
        NamedPipeServerStream.MaxAllowedServerInstances,
        PipeTransmissionMode.Byte,
        PipeOptions.Asynchronous);
      try
      {
          await pipe.WaitForConnectionAsync(cancellationToken);
      }
      catch
      {
          // Cancelled or transient failure: this instance never got a client.
          await pipe.DisposeAsync();
          throw;
      }
      // Ownership transfers to the handler, which disposes the pipe once the
      // client disconnects. Disposing here (e.g. `await using`) would race the
      // handler and tear down the pipe mid-session, breaking every request
      // with EPIPE/ObjectDisposedException on the client side.
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
      await pipe.DisposeAsync();
    }
  }
}
