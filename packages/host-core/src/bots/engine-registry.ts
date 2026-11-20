import { randomBytes } from "node:crypto";
import type { Storage } from "../storage.js";
import { ENGINE_DEFAULT_PORT } from "./engine-protocol.js";
import type { EngineSupervisor } from "./engine-view.js";
import { BotError } from "./types.js";

const FILE = "bot-engines.json";

/** An engine this app has put on one of the person's servers. The key to talk to it is kept apart, encrypted. */
export interface EngineRegistration {
  /** The SSH host it is on (`SshHostsStore`). */
  hostId: string;
  /** Port on the server's own loopback. */
  port: number;
  installedAt: number;
  /** The engine's version as last seen. */
  version?: string;
  supervisor: EngineSupervisor;
  /** Whether it comes back by itself after the server restarts. */
  survivesReboot: boolean;
}

interface StoredRegistration extends EngineRegistration {
  tokenCipher: string;
}

interface RegistryFile {
  servers: StoredRegistration[];
}

type StorageLike = Pick<Storage, "readJson" | "writeJson" | "cipher">;

export interface EngineRegistryOptions {
  now?: () => number;
}

export const ENGINE_TOKEN_MIN_LENGTH = 32;
const MIN_PORT = 1024;

/** A fresh key for an engine: 256 random bits as hex. */
export function generateEngineToken(): string {
  return randomBytes(32).toString("hex");
}

function isSupervisor(value: unknown): value is EngineSupervisor {
  return value === "systemd" || value === "nohup";
}

function view(stored: StoredRegistration): EngineRegistration {
  const { tokenCipher: _tokenCipher, ...rest } = stored;
  return { ...rest };
}

/** Keep only the entries a damaged file might have mangled; one bad entry must not lose the others. */
function cleaned(raw: unknown): StoredRegistration[] {
  if (typeof raw !== "object" || raw === null) return [];
  const list = (raw as { servers?: unknown }).servers;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: StoredRegistration[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const v = item as Record<string, unknown>;
    if (typeof v.hostId !== "string" || v.hostId === "" || seen.has(v.hostId)) continue;
    if (typeof v.tokenCipher !== "string" || v.tokenCipher === "") continue;
    if (typeof v.port !== "number" || !Number.isInteger(v.port) || v.port < MIN_PORT || v.port > 65535) continue;
    if (typeof v.installedAt !== "number" || !Number.isFinite(v.installedAt)) continue;
    if (!isSupervisor(v.supervisor)) continue;
    seen.add(v.hostId);
    out.push({
      hostId: v.hostId,
      port: v.port,
      installedAt: v.installedAt,
      supervisor: v.supervisor,
      survivesReboot: v.survivesReboot === true,
      tokenCipher: v.tokenCipher,
      ...(typeof v.version === "string" && v.version !== "" ? { version: v.version } : {}),
    });
  }
  return out;
}

/**
 * The engines on the person's servers (`bot-engines.json`). The engine's key is encrypted before it is written and
 * never comes back from `list` or `get`; `token` is the only way to read it, for the connection to that engine.
 */
export class EngineRegistryStore {
  private servers: StoredRegistration[];
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: StorageLike, options: EngineRegistryOptions = {}) {
    this.servers = cleaned(storage.readJson<unknown>(FILE, { servers: [] }));
    this.now = options.now ?? Date.now;
  }

  list(): EngineRegistration[] {
    return this.servers.map(view);
  }

  get(hostId: string): EngineRegistration | undefined {
    const found = this.servers.find((s) => s.hostId === hostId);
    return found ? view(found) : undefined;
  }

  /** The engine's key, or null when there is no engine on that host or the stored key can no longer be read. */
  token(hostId: string): string | null {
    const found = this.servers.find((s) => s.hostId === hostId);
    return found ? this.storage.cipher.decrypt(found.tokenCipher) : null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Record an engine, replacing what was kept for that host. Throws `BotError` and changes nothing when it is not usable. */
  save(input: { hostId: string; port?: number; token: string; supervisor: EngineSupervisor; survivesReboot: boolean; version?: string }): EngineRegistration {
    if (typeof input.hostId !== "string" || input.hostId === "") throw new BotError("invalid", "Choose a server.");
    const port = input.port ?? ENGINE_DEFAULT_PORT;
    if (!Number.isInteger(port) || port < MIN_PORT || port > 65535) {
      throw new BotError("invalid", `The engine's port must be a whole number from ${MIN_PORT} to 65535.`);
    }
    if (typeof input.token !== "string" || input.token.length < ENGINE_TOKEN_MIN_LENGTH) {
      throw new BotError("invalid", `The engine's key must be at least ${ENGINE_TOKEN_MIN_LENGTH} characters.`);
    }
    if (!isSupervisor(input.supervisor)) throw new BotError("invalid", "Say how the engine is kept running.");
    const existing = this.servers.find((s) => s.hostId === input.hostId);
    const next: StoredRegistration = {
      hostId: input.hostId,
      port,
      installedAt: existing?.installedAt ?? this.now(),
      supervisor: input.supervisor,
      survivesReboot: input.survivesReboot,
      tokenCipher: this.storage.cipher.encrypt(input.token),
      ...(input.version ? { version: input.version } : {}),
    };
    this.servers = [...this.servers.filter((s) => s.hostId !== input.hostId), next];
    this.commit();
    return view(next);
  }

  /** Remember the version the engine reported. A host with no engine is left alone. */
  setVersion(hostId: string, version: string): void {
    const found = this.servers.find((s) => s.hostId === hostId);
    if (!found || found.version === version || version === "") return;
    found.version = version;
    this.commit();
  }

  remove(hostId: string): boolean {
    const before = this.servers.length;
    this.servers = this.servers.filter((s) => s.hostId !== hostId);
    if (this.servers.length === before) return false;
    this.commit();
    return true;
  }

  private commit(): void {
    this.storage.writeJson(FILE, { servers: this.servers } satisfies RegistryFile);
    for (const listener of [...this.listeners]) listener();
  }
}
