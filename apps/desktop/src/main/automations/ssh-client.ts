import { createHash } from "node:crypto";
import { Client, type ConnectConfig } from "ssh2";
import type { SshHostsStore } from "@deyin/host-core";
import type { SshTestResult } from "@deyin/host-core";

export function hostFingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64")}`;
}

export interface SshConnectOptions {
  hostId: string;
  hosts: SshHostsStore;
  /** When true, accept an unpinned host and return its fingerprint instead of failing. */
  allowNewHost?: boolean;
  /** If set, only accept when the observed fingerprint matches this value. */
  expectedFingerprint?: string;
}

export interface SshSession {
  client: Client;
  fingerprint: string;
}

export function connectSsh(opts: SshConnectOptions): Promise<SshSession> {
  const resolved = opts.hosts.resolveCredentials(opts.hostId);
  if (!resolved) return Promise.reject(new Error("SSH host not found."));

  const { host, privateKey, passphrase, password } = resolved;
  if (host.authMethod === "privateKey" && !privateKey) {
    return Promise.reject(new Error("No private key configured for this host."));
  }
  if (host.authMethod === "password" && !password) {
    return Promise.reject(new Error("No password configured for this host."));
  }

  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let observedFingerprint: string | undefined;

    const config: ConnectConfig = {
      host: host.host,
      port: host.port,
      username: host.username,
      readyTimeout: 30_000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer) => {
        const fp = hostFingerprint(key);
        observedFingerprint = fp;
        if (opts.expectedFingerprint) {
          return fp === opts.expectedFingerprint;
        }
        if (!host.knownHostFingerprint) {
          return opts.allowNewHost === true;
        }
        return fp === host.knownHostFingerprint;
      },
    };

    if (host.authMethod === "privateKey" && privateKey) {
      config.privateKey = privateKey;
      if (passphrase) config.passphrase = passphrase;
    } else if (host.authMethod === "password" && password) {
      config.password = password;
    }

    client
      .on("ready", () => {
        if (settled) return;
        settled = true;
        if (!observedFingerprint) {
          client.end();
          reject(new Error("Could not verify host key."));
          return;
        }
        resolve({ client, fingerprint: observedFingerprint });
      })
      .on("error", (err) => {
        if (settled) return;
        settled = true;
        // Raw ssh2 error (e.g., "Host key verification failed") propagates to the
        // caller. testSshHost handles the first-connect fingerprint-return path
        // explicitly via the !pinned && !acceptFingerprint branch, so callers
        // don't need a re-derived "pin first" message here.
        reject(err);
      })
      .connect(config);
  });
}

export function execCommand(client: Client, command: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      let stdout = "";
      let stderr = "";
      stream
        .on("close", (code: number) => resolve({ stdout, stderr, code: code ?? 0 }))
        .on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
      stream.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
    });
  });
}

export function execStreaming(
  client: Client,
  command: string,
  onStdoutLine: (line: string) => void,
  onStderr: (chunk: string) => void,
  /** Written to the remote command's stdin, then the write side is closed. */
  stdin?: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      if (stdin !== undefined) {
        stream.end(stdin);
      }
      let buffer = "";
      stream
        .on("close", (code: number) => {
          if (buffer.length > 0) onStdoutLine(buffer);
          resolve(code ?? 0);
        })
        .on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          let idx = buffer.indexOf("\n");
          while (idx >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (line.length > 0) onStdoutLine(line);
            idx = buffer.indexOf("\n");
          }
        });
      stream.stderr.on("data", (chunk: Buffer) => onStderr(chunk.toString("utf8")));
    });
  });
}

/**
 * Test connectivity. When `acceptFingerprint` is provided, connect requiring that
 * fingerprint matches the live host key, then pin it only after observation.
 */
export async function testSshHost(
  hosts: SshHostsStore,
  hostId: string,
  acceptFingerprint?: string,
): Promise<SshTestResult> {
  const stored = hosts.get(hostId);
  if (!stored) return { ok: false, message: "Host not found." };

  let session: SshSession | undefined;
  try {
    const pinned = Boolean(hosts.get(hostId)?.knownHostFingerprint);
    session = await connectSsh({
      hostId,
      hosts,
      allowNewHost: !pinned && !acceptFingerprint,
      expectedFingerprint: acceptFingerprint,
    });

    // First connect without a pin: return fingerprint for the user to accept.
    if (!pinned && !acceptFingerprint) {
      return {
        ok: false,
        message: "Accept the host fingerprint to pin this server.",
        hostFingerprint: session.fingerprint,
      };
    }

    // User accepted: pin only after we observed the matching key.
    if (acceptFingerprint && acceptFingerprint === session.fingerprint) {
      hosts.setKnownFingerprint(hostId, session.fingerprint);
    }

    const nodeRes = await execCommand(session.client, "node -v 2>/dev/null || echo ''");
    const nodeVersion = nodeRes.stdout.trim();
    const nodeMajor = Number.parseInt(nodeVersion.replace(/^v/, ""), 10);
    if (!nodeVersion || !Number.isFinite(nodeMajor) || nodeMajor < 20) {
      return {
        ok: false,
        message: "Node.js 20+ is required on the remote server.",
        nodeVersion: nodeVersion || undefined,
      };
    }

    const deyinRes = await execCommand(
      session.client,
      "command -v deyin >/dev/null 2>&1 && deyin --version 2>/dev/null || echo ''",
    );
    const deyinVersion = deyinRes.stdout.trim();
    if (!deyinVersion) {
      return {
        ok: false,
        message: "deyin CLI not found. Install with: npm install -g @deyin/cli",
        nodeVersion,
      };
    }

    return { ok: true, message: "Connection successful.", nodeVersion, deyinVersion };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    session?.client.end();
  }
}
