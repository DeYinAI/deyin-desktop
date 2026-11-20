import { randomUUID } from "node:crypto";
import { PLAIN_CIPHER_PREFIX, type Storage } from "../storage.js";
import { BotError } from "./types.js";
import {
  VAULT_LIMITS,
  VAULT_SECRETS,
  isStoredVaultItem,
  isVaultGrant,
  parseVaultInput,
  resolveVaultField,
  secretForms,
  viewOf,
  type StoredVaultItem,
  type VaultGrant,
  type VaultItem,
  type VaultProtection,
  type VaultSecretName,
  type VaultSnapshot,
} from "./vault.js";
import { normalizeSite } from "./vault-sites.js";

const FILE = "vault.json";

type StorageLike = Pick<Storage, "readJson" | "writeJson" | "cipher">;

interface VaultFile {
  items: StoredVaultItem[];
  grants: VaultGrant[];
}

export interface VaultStoreOptions {
  now?: () => number;
  newId?: () => string;
}

/**
 * The Vault on disk (`vault.json`). Passwords, card numbers and security codes are encrypted with the host's
 * `SecretCipher` before they are written and are never returned by `list` or `get`; the only way to read one is
 * `field`, which the host uses to fill a page. A refused change leaves the file untouched.
 */
export class VaultStore {
  private items: StoredVaultItem[];
  private granted: VaultGrant[];
  private readonly listeners = new Set<() => void>();
  private secretCache: string[] | null = null;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(
    private readonly storage: StorageLike,
    options: VaultStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    const file = storage.readJson<Partial<VaultFile>>(FILE, { items: [], grants: [] });
    this.items = Array.isArray(file.items) ? file.items.filter(isStoredVaultItem) : [];
    this.granted = Array.isArray(file.grants) ? file.grants.filter(isVaultGrant) : [];
  }

  /** Whether secrets are encrypted by the operating system, or only protected by file permissions. */
  protection(): VaultProtection {
    try {
      return this.storage.cipher.encrypt("vault-probe").startsWith(PLAIN_CIPHER_PREFIX) ? "file-permissions" : "encrypted";
    } catch {
      return "file-permissions";
    }
  }

  list(): VaultItem[] {
    return this.items
      .map(viewOf)
      .sort((a, b) => a.title.localeCompare(b.title) || a.createdAt - b.createdAt);
  }

  get(id: string): VaultItem | null {
    const item = this.items.find((candidate) => candidate.id === id);
    return item ? viewOf(item) : null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Save a new item, or change the one named by `input.id`. Throws `BotError` and changes nothing when it is not acceptable. */
  put(input: unknown): VaultItem {
    const id = typeof input === "object" && input !== null ? (input as { id?: unknown }).id : undefined;
    const updating = typeof id === "string" && id !== "";
    const draft = parseVaultInput(input, updating ? "update" : "create");
    const now = this.now();
    let saved: StoredVaultItem;
    if (updating) {
      const existing = this.items.find((candidate) => candidate.id === id);
      if (!existing) throw new BotError("not_found", "That item is not in the Vault any more.");
      if (existing.kind !== draft.kind) throw new BotError("invalid", "An item's kind cannot be changed.");
      saved = {
        ...existing,
        title: draft.title,
        notes: draft.notes,
        updatedAt: now,
        data: { ...existing.data, ...draft.data },
        secrets: { ...existing.secrets, ...this.seal(draft.secrets) },
      };
    } else {
      if (this.items.length >= VAULT_LIMITS.items) {
        throw new BotError("limit", `The Vault is full (${VAULT_LIMITS.items} items). Remove one first.`);
      }
      saved = {
        id: this.newId(),
        kind: draft.kind,
        title: draft.title,
        notes: draft.notes,
        createdAt: now,
        updatedAt: now,
        data: draft.data,
        secrets: this.seal(draft.secrets),
      };
    }
    const others = this.items.filter((candidate) => candidate.id !== saved.id);
    // One contact is the default shipping address.
    const items =
      saved.kind === "contact" && saved.data.defaultShipping === true
        ? others.map((other) => (other.kind === "contact" && other.data.defaultShipping === true ? { ...other, data: { ...other.data, defaultShipping: false } } : other))
        : others;
    this.commit([...items, saved], this.granted);
    return viewOf(saved);
  }

  /** Take an item out, and every permission any Bot had to use it. */
  remove(id: string): void {
    if (!this.items.some((item) => item.id === id)) throw new BotError("not_found", "That item is not in the Vault any more.");
    this.commit(
      this.items.filter((item) => item.id !== id),
      this.granted.filter((grant) => grant.itemId !== id),
    );
  }

  /** Add a site to a login (after a person agreed to use it there). Returns false when it cannot be added. */
  addSite(id: string, site: string): boolean {
    const host = normalizeSite(site);
    const item = this.items.find((candidate) => candidate.id === id);
    if (!host || !item || item.kind !== "login") return false;
    const sites = Array.isArray(item.data.sites) ? item.data.sites.filter((entry): entry is string => typeof entry === "string") : [];
    if (sites.includes(host)) return true;
    if (sites.length >= VAULT_LIMITS.sites) return false;
    const next: StoredVaultItem = { ...item, updatedAt: this.now(), data: { ...item.data, sites: [...sites, host] } };
    this.commit(this.items.map((candidate) => (candidate.id === id ? next : candidate)), this.granted);
    return true;
  }

  /** The text to fill into `field` of an item, or null when it has none or a secret cannot be read. Host use only. */
  field(id: string, field: string): string | null {
    const item = this.items.find((candidate) => candidate.id === id);
    return item ? resolveVaultField(item, field, (stored) => this.open(stored)) : null;
  }

  /** Every saved secret in every form it could appear in, for hiding from what a Bot reads. */
  secretValues(): readonly string[] {
    if (this.secretCache) return this.secretCache;
    const found = new Set<string>();
    for (const item of this.items) {
      for (const name of VAULT_SECRETS) {
        const stored = item.secrets[name];
        const value = stored ? this.open(stored) : null;
        if (value) for (const form of secretForms(name, value)) found.add(form);
      }
    }
    this.secretCache = [...found];
    return this.secretCache;
  }

  /* Bot permissions --------------------------------------------------------- */

  hasGrant(botId: string, itemId: string, host: string): boolean {
    return this.granted.some((grant) => grant.botId === botId && grant.itemId === itemId && grant.host === host);
  }

  /** Remember that a Bot may use an item on a site. */
  grant(botId: string, itemId: string, host: string): void {
    if (!botId || !host || !this.items.some((item) => item.id === itemId)) throw new BotError("not_found", "That item is not in the Vault any more.");
    if (this.hasGrant(botId, itemId, host)) return;
    if (this.granted.length >= VAULT_LIMITS.grants) throw new BotError("limit", "Too many saved permissions. Remove an item or a Bot to free some.");
    this.commit(this.items, [...this.granted, { botId, itemId, host, grantedAt: this.now() }]);
  }

  /** Every permission a Bot has been given, oldest first. */
  grants(): VaultGrant[] {
    return this.granted.map((grant) => ({ ...grant })).sort((a, b) => a.grantedAt - b.grantedAt);
  }

  /** Take back one permission. The next use on that site asks again. */
  revoke(botId: string, itemId: string, host: string): void {
    if (!this.hasGrant(botId, itemId, host)) throw new BotError("not_found", "That permission is already gone.");
    this.commit(this.items, this.granted.filter((grant) => !(grant.botId === botId && grant.itemId === itemId && grant.host === host)));
  }

  snapshot(): VaultSnapshot {
    return { items: this.list(), grants: this.grants(), protection: this.protection() };
  }

  /** A deleted Bot keeps no permissions. */
  revokeBot(botId: string): void {
    if (!this.granted.some((grant) => grant.botId === botId)) return;
    this.commit(this.items, this.granted.filter((grant) => grant.botId !== botId));
  }

  /* Internals --------------------------------------------------------------- */

  private seal(secrets: Partial<Record<VaultSecretName, string>>): Partial<Record<VaultSecretName, string>> {
    const out: Partial<Record<VaultSecretName, string>> = {};
    for (const name of VAULT_SECRETS) {
      const value = secrets[name];
      if (value !== undefined) out[name] = this.storage.cipher.encrypt(value);
    }
    return out;
  }

  private open(stored: string): string | null {
    try {
      return this.storage.cipher.decrypt(stored);
    } catch {
      return null;
    }
  }

  private commit(items: StoredVaultItem[], grants: VaultGrant[]): void {
    this.storage.writeJson<VaultFile>(FILE, { items, grants });
    this.items = items;
    this.granted = grants;
    this.secretCache = null;
    for (const listener of [...this.listeners]) listener();
  }
}
