import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Encrypts secrets (provider API keys) before they hit disk. The desktop app adapts
 * Electron's safeStorage to this interface; the CLI falls back to `plainCipher` and
 * relies on 0600 file permissions instead.
 */
export interface SecretCipher {
  /** Returns a storable string. */
  encrypt(plaintext: string): string;
  /** Returns the plaintext, or null when the stored value cannot be decrypted. */
  decrypt(stored: string): string | null;
}

export const PLAIN_CIPHER_PREFIX = "plain:";

/** Marker-only "cipher" for hosts without OS-level encryption (file perms are the guard). */
export const plainCipher: SecretCipher = {
  encrypt: (plaintext) => `${PLAIN_CIPHER_PREFIX}${plaintext}`,
  decrypt: (stored) => (stored.startsWith(PLAIN_CIPHER_PREFIX) ? stored.slice(PLAIN_CIPHER_PREFIX.length) : null),
};

/**
 * Runtime-agnostic persistence used by the settings/agents/usage stores. Desktop backs
 * it with `app.getPath("userData")` + safeStorage; the CLI with `~/.deyin` + plainCipher.
 */
export interface Storage {
  readonly dir: string;
  readonly cipher: SecretCipher;
  readJson<T>(name: string, fallback: T): T;
  writeJson<T>(name: string, value: T): void;
  /** Resolve once every write queued so far has reached disk. */
  flush(): Promise<void>;
}

/**
 * JSON files in a directory, written 0600 inside a 0700 dir (best effort on
 * Windows). Writes are fire-and-forget: they queue on a per-file chain so
 * snapshots of the same file coalesce to the latest value and never interleave,
 * hit the disk asynchronously (off the Electron main thread), and land via
 * temp-file + rename so a crash mid-write can never tear a file. Hosts that
 * need durability at exit call `flush()` (the desktop quit path and the CLI
 * both do).
 */
export class FileStorage implements Storage {
  /** Latest serialized snapshot per file; a queued write always takes this. */
  private readonly pending = new Map<string, string>();
  /** Per-file serialized write chain. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    readonly dir: string,
    readonly cipher: SecretCipher = plainCipher,
  ) {}

  readJson<T>(name: string, fallback: T): T {
    try {
      return { ...fallback, ...(JSON.parse(readFileSync(join(this.dir, name), "utf8")) as T) };
    } catch {
      return structuredClone(fallback);
    }
  }

  writeJson<T>(name: string, value: T): void {
    this.pending.set(name, JSON.stringify(value, null, 2));
    const prev = this.chains.get(name) ?? Promise.resolve();
    this.chains.set(
      name,
      prev.then(() => this.writeNow(name)).catch((err: unknown) => {
        // Keep the chain alive (a rejected chain would drop every later write);
        // the value stays pending, so the next write retries it.
        console.warn(`[deyin] failed to persist ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }),
    );
  }

  private async writeNow(name: string): Promise<void> {
    const body = this.pending.get(name);
    if (body === undefined) return;
    const target = join(this.dir, name);
    const tmp = `${target}.tmp`;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, target);
    // A newer snapshot queued mid-write stays pending for the next chain step.
    if (this.pending.get(name) === body) this.pending.delete(name);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }
}

/** Default CLI data directory: $DEYIN_DATA_DIR or ~/.deyin */
export function defaultDataDir(env: Record<string, string | undefined> = process.env): string {
  return env.DEYIN_DATA_DIR ?? join(homedir(), ".deyin");
}
