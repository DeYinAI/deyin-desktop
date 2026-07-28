import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
}

/** JSON files in a directory, written 0600 inside a 0700 dir (best effort on Windows). */
export class FileStorage implements Storage {
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
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.dir, name), JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  }
}

/** Default CLI data directory: $DEYIN_DATA_DIR or ~/.deyin */
export function defaultDataDir(env: Record<string, string | undefined> = process.env): string {
  return env.DEYIN_DATA_DIR ?? join(homedir(), ".deyin");
}
