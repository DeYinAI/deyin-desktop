import type { Client, SFTPWrapper } from "ssh2";
import { connectSsh, type SshConnectOptions } from "../automations/ssh-client.js";

interface PooledConnection {
  client: Client;
  sftp: SFTPWrapper | null;
  refs: number;
  hostId: string;
}

/** One persistent ssh2 client per hostId, ref-counted by workspace consumers. */
export class SshConnectionPool {
  private readonly pool = new Map<string, PooledConnection>();
  private readonly pending = new Map<string, Promise<PooledConnection>>();

  async acquire(opts: SshConnectOptions): Promise<{ client: Client; sftp: SFTPWrapper; release: () => void }> {
    const existing = this.pool.get(opts.hostId);
    if (existing) {
      existing.refs += 1;
      const sftp = existing.sftp ?? (await this.openSftp(existing.client));
      existing.sftp = sftp;
      return { client: existing.client, sftp, release: () => this.release(opts.hostId) };
    }

    let pending = this.pending.get(opts.hostId);
    if (!pending) {
      pending = this.connectNew(opts);
      this.pending.set(opts.hostId, pending);
    }
    const conn = await pending;
    this.pending.delete(opts.hostId);
    conn.refs = 1;
    this.pool.set(opts.hostId, conn);
    const sftp = conn.sftp ?? (await this.openSftp(conn.client));
    conn.sftp = sftp;
    return { client: conn.client, sftp, release: () => this.release(opts.hostId) };
  }

  private async connectNew(opts: SshConnectOptions): Promise<PooledConnection> {
    const session = await connectSsh(opts);
    return { client: session.client, sftp: null, refs: 0, hostId: opts.hostId };
  }

  private openSftp(client: Client): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) reject(err);
        else resolve(sftp);
      });
    });
  }

  private release(hostId: string): void {
    const conn = this.pool.get(hostId);
    if (!conn) return;
    conn.refs -= 1;
    if (conn.refs <= 0) {
      conn.client.end();
      this.pool.delete(hostId);
    }
  }

  disconnect(hostId: string): void {
    const conn = this.pool.get(hostId);
    if (conn) {
      conn.client.end();
      this.pool.delete(hostId);
    }
  }

  disconnectAll(): void {
    for (const conn of this.pool.values()) conn.client.end();
    this.pool.clear();
    this.pending.clear();
  }
}
