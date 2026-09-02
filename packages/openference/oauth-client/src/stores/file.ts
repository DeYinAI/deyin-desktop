import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TokenSet, TokenStore } from "../types.js";

export interface FileTokenStoreOptions {
  /** Absolute path to the credentials file, e.g. ~/.deyin/credentials.json. */
  path: string;
  /**
   * Optional symmetric encrypt/decrypt (e.g. Electron safeStorage). When provided,
   * the file contents are ciphertext. When omitted, JSON is written with 0600 perms.
   */
  encrypt?: (plaintext: string) => string | Buffer;
  decrypt?: (ciphertext: Buffer) => string;
}

/**
 * Persist a token set to a file. On POSIX the file is written with 0600 permissions.
 * For stronger protection, pass an `encrypt`/`decrypt` pair backed by the OS keychain
 * (the Electron app injects Electron `safeStorage` here).
 */
export class FileTokenStore implements TokenStore {
  constructor(private readonly opts: FileTokenStoreOptions) {}

  async load(): Promise<TokenSet | undefined> {
    try {
      const raw = await readFile(this.opts.path);
      const json = this.opts.decrypt ? this.opts.decrypt(raw) : raw.toString("utf8");
      return JSON.parse(json) as TokenSet;
    } catch {
      return undefined;
    }
  }

  /**
   * Write via temp file + rename. A refresh rewrites this file every time the
   * access token ages out, so an in-place write leaves a window where losing
   * power (or a Windows shutdown killing the process) truncates the file — and
   * a torn credentials file reads back as "signed out".
   */
  async save(tokens: TokenSet): Promise<void> {
    await mkdir(dirname(this.opts.path), { recursive: true });
    const json = JSON.stringify(tokens);
    const data = this.opts.encrypt ? this.opts.encrypt(json) : json;
    const tmp = `${this.opts.path}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, this.opts.path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async clear(): Promise<void> {
    await rm(this.opts.path, { force: true });
  }
}
