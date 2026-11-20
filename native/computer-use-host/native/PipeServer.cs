using System.IO.Pipes;
using System.Text;
using System.Text.Json.Nodes;

namespace Deyin.ComputerUseHost;

/// <summary>
/// Newline-delimited JSON-RPC over a named pipe. Requests on one connection run concurrently (so "cancel" and
/// "ping" are answered while an action is running), responses are written one at a time, and host events are
/// pushed to every connected client.
/// </summary>
public sealed class PipeServer
{
  private readonly string _pipeName;
  private readonly RpcHost _host;
  private readonly List<Connection> _connections = new();
  private readonly object _connectionsLock = new();

  public PipeServer(string pipeName, RpcHost host)
  {
    _pipeName = pipeName;
    _host = host;
    _host.Notify += Broadcast;
  }

  private sealed class Connection
  {
    public required StreamWriter Writer { get; init; }
    public SemaphoreSlim WriteLock { get; } = new(1, 1);
    public bool Closed;

    public async Task SendAsync(string line)
    {
      await WriteLock.WaitAsync();
      try
      {
        if (!Closed) await Writer.WriteLineAsync(line);
      }
      catch
      {
        Closed = true;
      }
      finally
      {
        WriteLock.Release();
      }
    }
  }

  public async Task RunAsync(CancellationToken cancellationToken = default)
  {
    while (!cancellationToken.IsCancellationRequested)
    {
      // CurrentUserOnly: other local users must not be able to drive this user's desktop.
      var pipe = new NamedPipeServerStream(
        _pipeName,
        PipeDirection.InOut,
        NamedPipeServerStream.MaxAllowedServerInstances,
        PipeTransmissionMode.Byte,
        PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
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
      // Ownership transfers to the handler, which disposes the pipe once the client disconnects.
      _ = Task.Run(() => HandleClientAsync(pipe, cancellationToken), cancellationToken);
    }
  }

  private async Task HandleClientAsync(NamedPipeServerStream pipe, CancellationToken cancellationToken)
  {
    var writer = new StreamWriter(pipe, new UTF8Encoding(false), 64 * 1024, leaveOpen: true) { AutoFlush = true };
    var connection = new Connection { Writer = writer };
    lock (_connectionsLock) _connections.Add(connection);
    try
    {
      using var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 64 * 1024, leaveOpen: true);
      while (pipe.IsConnected && !cancellationToken.IsCancellationRequested)
      {
        var line = await reader.ReadLineAsync(cancellationToken);
        if (line is null) break;
        if (string.IsNullOrWhiteSpace(line)) continue;
        // Not awaited: the next line (possibly "cancel") must be read while this one runs.
        _ = Task.Run(async () => await connection.SendAsync(await _host.HandleAsync(line)), cancellationToken);
      }
    }
    catch
    {
      // client disconnect
    }
    finally
    {
      connection.Closed = true;
      lock (_connectionsLock) _connections.Remove(connection);
      // A client that went away must not leave an action running unattended.
      _host.CancelAll();
      try { pipe.Disconnect(); } catch { /* ignore */ }
      await pipe.DisposeAsync();
    }
  }

  private void Broadcast(string type, JsonNode? payload)
  {
    var line = RpcHost.Notification(type, payload);
    Connection[] targets;
    lock (_connectionsLock) targets = _connections.ToArray();
    foreach (var c in targets) _ = c.SendAsync(line);
  }
}
