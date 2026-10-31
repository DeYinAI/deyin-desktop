import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Turns a secret into text that is safe to keep on disk, and back. The desktop passes Electron's `safeStorage`. */
export interface Cipher {
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

/** The operating system's secret storage, which Electron's `safeStorage` provides. */
export interface SecretBackend {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(encrypted: Buffer): string;
}

const ENCRYPTED = "enc:";
const PLAIN = "plain:";

/**
 * Encrypts with the operating system's secret storage when it has one. Some Linux desktops have no keyring; the token is then kept
 * encoded but not encrypted, in a file only the user can read, and the Superagent docs say so.
 */
export function createCipher(backend: SecretBackend): Cipher {
  return {
    encrypt: (plain) => (backend.available() ? `${ENCRYPTED}${backend.encrypt(plain).toString("base64")}` : `${PLAIN}${Buffer.from(plain, "utf8").toString("base64")}`),
    decrypt(stored) {
      if (stored.startsWith(ENCRYPTED)) return backend.decrypt(Buffer.from(stored.slice(ENCRYPTED.length), "base64"));
      if (stored.startsWith(PLAIN)) return Buffer.from(stored.slice(PLAIN.length), "base64").toString("utf8");
      throw new Error("Unrecognized token encoding");
    },
  };
}

/**
 * The agent account's GitHub token, kept in one file readable only by the user. The token never leaves this store except to the
 * runtime, which puts it in a worker's shell environment; it is not part of any view and not logged.
 */
export class TokenStore {
  private token: string | undefined;

  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
  ) {
    this.token = this.read();
  }

  private read(): string | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { token?: unknown };
      if (typeof raw.token !== "string" || raw.token === "") return undefined;
      const plain = this.cipher.decrypt(raw.token).trim();
      return plain || undefined;
    } catch {
      return undefined;
    }
  }

  get(): string | undefined {
    return this.token;
  }

  set(token: string): void {
    const plain = token.trim();
    if (!plain) throw new Error("The token is empty");
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ token: this.cipher.encrypt(plain) }), { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    this.token = plain;
  }

  clear(): void {
    rmSync(this.file, { force: true });
    this.token = undefined;
  }
}
