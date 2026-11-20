import { BotError, cleanBotLine, cleanBotText } from "./types.js";
import { normalizeSite } from "./vault-sites.js";

/**
 * The Vault: logins, cards and contacts a Bot may fill into a page without ever being shown them. What leaves the host is a *view* — titles, usernames, a card's last four digits — and never a password,
 * a card number or a security code. Those are write-only: stored encrypted, read by the host to fill a field,
 * and removed from anything a Bot is later shown. Everything here is data and pure functions; storing is in
 * `vault-store.ts`.
 */

export const VAULT_KINDS = ["login", "card", "contact"] as const;
export type VaultKind = (typeof VAULT_KINDS)[number];

export const VAULT_LIMITS = Object.freeze({
  items: 200,
  title: 120,
  notes: 2000,
  username: 320,
  password: 1024,
  sites: 20,
  line: 200,
  email: 320,
  emails: 5,
  phones: 5,
  phone: 40,
  /** Per-Bot permissions to use a saved item on a site. */
  grants: 1000,
});

export const CARD_BRANDS = ["visa", "mastercard", "amex", "discover", "diners", "jcb", "unionpay", "unknown"] as const;
export type CardBrand = (typeof CARD_BRANDS)[number];

export interface VaultAddress {
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  phone: string;
}

const ADDRESS_KEYS = ["name", "line1", "line2", "city", "region", "postalCode", "country", "phone"] as const satisfies readonly (keyof VaultAddress)[];

export function emptyAddress(): VaultAddress {
  return { name: "", line1: "", line2: "", city: "", region: "", postalCode: "", country: "", phone: "" };
}

export function isEmptyAddress(address: VaultAddress): boolean {
  return ADDRESS_KEYS.every((key) => address[key] === "");
}

interface VaultBase {
  id: string;
  title: string;
  notes: string;
  createdAt: number;
  updatedAt: number;
}

/** What a person (and the Vault page) sees of a login. The password is never part of it. */
export interface VaultLogin extends VaultBase {
  kind: "login";
  username: string;
  sites: string[];
  hasPassword: boolean;
}

export interface VaultCard extends VaultBase {
  kind: "card";
  brand: CardBrand;
  last4: string;
  expMonth: number;
  expYear: number;
  holderName: string;
  billingAddress: VaultAddress | null;
  hasSecurityCode: boolean;
}

export interface VaultContact extends VaultBase {
  kind: "contact";
  address: VaultAddress;
  defaultShipping: boolean;
  email: string;
  emails: string[];
  phones: string[];
}

export type VaultItem = VaultLogin | VaultCard | VaultContact;

/** The values that are never shown again once saved. */
export const VAULT_SECRETS = ["password", "number", "securityCode"] as const;
export type VaultSecretName = (typeof VAULT_SECRETS)[number];

/** An item as saved: plain fields, and secrets as cipher text. */
export interface StoredVaultItem {
  id: string;
  kind: VaultKind;
  title: string;
  notes: string;
  createdAt: number;
  updatedAt: number;
  data: Record<string, unknown>;
  secrets: Partial<Record<VaultSecretName, string>>;
}

/** A Bot's permission to use one saved item on one site. */
export interface VaultGrant {
  botId: string;
  itemId: string;
  host: string;
  grantedAt: number;
}

/** How the saved secrets are protected on this machine. */
export type VaultProtection = "encrypted" | "file-permissions";

/** Everything the Vault page shows: the items (no secrets), who may use what where, and how it is protected. */
export interface VaultSnapshot {
  items: VaultItem[];
  grants: VaultGrant[];
  protection: VaultProtection;
}

/* Fields a Bot may ask to be filled ----------------------------------------- */

const ADDRESS_FIELDS = ["line1", "line2", "city", "region", "postalCode", "country"] as const;

export const VAULT_FIELDS = {
  login: ["username", "password"],
  card: ["number", "securityCode", "holderName", "expiry", "expMonth", "expYear", ...ADDRESS_FIELDS],
  contact: ["name", "email", "phone", ...ADDRESS_FIELDS],
} as const satisfies Record<VaultKind, readonly string[]>;

export function isVaultKind(value: unknown): value is VaultKind {
  return typeof value === "string" && (VAULT_KINDS as readonly string[]).includes(value);
}

export function isVaultField(kind: VaultKind, field: unknown): field is string {
  return typeof field === "string" && (VAULT_FIELDS[kind] as readonly string[]).includes(field);
}

/* Cards ---------------------------------------------------------------------- */

export function cardDigits(value: string): string {
  return value.replace(/[\s-]/g, "");
}

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

export function cardBrand(digits: string): CardBrand {
  const two = Number(digits.slice(0, 2));
  const three = Number(digits.slice(0, 3));
  const four = Number(digits.slice(0, 4));
  if (digits.startsWith("4")) return "visa";
  if ((two >= 51 && two <= 55) || (four >= 2221 && four <= 2720)) return "mastercard";
  if (two === 34 || two === 37) return "amex";
  if (digits.startsWith("6011") || two === 65 || (three >= 644 && three <= 649)) return "discover";
  if ((three >= 300 && three <= 305) || two === 36 || two === 38) return "diners";
  if (four >= 3528 && four <= 3589) return "jcb";
  if (two === 62) return "unionpay";
  return "unknown";
}

/* Reading input -------------------------------------------------------------- */

function fail(message: string): never {
  throw new BotError("invalid", message);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${what} must be an object.`);
  return value as Record<string, unknown>;
}

function line(value: unknown, what: string, max: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) fail(`${what} is required.`);
    return "";
  }
  if (typeof value !== "string") fail(`${what} must be text.`);
  const clean = cleanBotLine(value);
  if (required && !clean) fail(`${what} is required.`);
  if (clean.length > max) fail(`${what} is too long (at most ${max} characters).`);
  return clean;
}

function notes(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") fail("Notes must be text.");
  const clean = cleanBotText(value);
  if (clean.length > VAULT_LIMITS.notes) fail(`Notes are too long (at most ${VAULT_LIMITS.notes} characters).`);
  return clean;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9+()\-.\s]{3,40}$/;

function email(value: unknown, what: string): string {
  const text = line(value, what, VAULT_LIMITS.email);
  if (text && !EMAIL.test(text)) fail(`${what} is not an email address.`);
  return text;
}

function phone(value: unknown, what: string): string {
  const text = line(value, what, VAULT_LIMITS.phone);
  if (text && !PHONE.test(text)) fail(`${what} is not a phone number.`);
  return text;
}

function list(value: unknown, what: string, max: number, each: (item: unknown) => string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${what} must be a list.`);
  if (value.length > max) fail(`${what} can have at most ${max} entries.`);
  const out: string[] = [];
  for (const item of value) {
    const text = each(item);
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function address(value: unknown, what: string): VaultAddress {
  if (value === undefined || value === null) return emptyAddress();
  const source = record(value, what);
  const out = emptyAddress();
  for (const key of ADDRESS_KEYS) out[key] = key === "phone" ? phone(source[key], `${what} phone`) : line(source[key], `${what} ${key}`, VAULT_LIMITS.line);
  return out;
}

function secretText(value: unknown, what: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") fail(`${what} must be text.`);
  if (value.length > max) fail(`${what} is too long (at most ${max} characters).`);
  if (/[\u0000\r\n]/.test(value)) fail(`${what} cannot contain a line break.`);
  return value;
}

function whole(value: unknown, what: string): number {
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isInteger(n)) fail(`${what} must be a whole number.`);
  return n;
}

/** What `parseVaultInput` gives: the plain fields, and any secret that was supplied (a missing one means "keep"). */
export interface VaultDraft {
  kind: VaultKind;
  id: string | undefined;
  title: string;
  notes: string;
  data: Record<string, unknown>;
  secrets: Partial<Record<VaultSecretName, string>>;
}

/**
 * Check what the Vault page (or anything else) submitted. Creating needs the secret (password, card number);
 * updating may leave it out to keep what is saved. Throws `BotError` with a reason a person can read.
 */
export function parseVaultInput(input: unknown, mode: "create" | "update", now: Date = new Date()): VaultDraft {
  const source = record(input, "The item");
  if (!isVaultKind(source.kind)) fail("The item must be a login, a card or a contact.");
  const id = typeof source.id === "string" && source.id ? source.id : undefined;
  if (mode === "update" && !id) fail("Say which item to change.");
  const base = { kind: source.kind, id, title: line(source.title, "The name", VAULT_LIMITS.title, true), notes: notes(source.notes) };
  switch (source.kind) {
    case "login": {
      const password = secretText(source.password, "The password", VAULT_LIMITS.password);
      if (mode === "create" && !password) fail("A login needs a password.");
      const sites = list(source.sites, "Sites", VAULT_LIMITS.sites, (site) => {
        const host = normalizeSite(site);
        if (!host) fail(`"${typeof site === "string" ? cleanBotLine(site).slice(0, 80) : ""}" is not a site a login can be saved for.`);
        return host;
      });
      if (sites.length === 0) fail("A login needs at least one site, so it is only ever used where it belongs.");
      return {
        ...base,
        data: { username: line(source.username, "The username", VAULT_LIMITS.username, true), sites },
        secrets: password ? { password } : {},
      };
    }
    case "card": {
      const rawNumber = secretText(source.number, "The card number", 40);
      let number: string | undefined;
      if (rawNumber !== undefined) {
        number = cardDigits(rawNumber);
        if (!/^\d{12,19}$/.test(number) || !luhnValid(number)) fail("That is not a valid card number.");
      }
      if (mode === "create" && !number) fail("A card needs its number.");
      const code = secretText(source.securityCode, "The security code", 8);
      if (code !== undefined && !/^\d{3,4}$/.test(code)) fail("The security code is 3 or 4 digits.");
      const expMonth = whole(source.expMonth, "The expiry month");
      let expYear = whole(source.expYear, "The expiry year");
      if (expYear >= 0 && expYear < 100) expYear += 2000;
      if (expMonth < 1 || expMonth > 12) fail("The expiry month is 1 to 12.");
      if (expYear < now.getFullYear() - 1 || expYear > now.getFullYear() + 30) fail("That expiry year is not one a card has.");
      const billing = address(source.billingAddress, "The billing address");
      return {
        ...base,
        data: {
          expMonth,
          expYear,
          holderName: line(source.holderName, "The cardholder name", VAULT_LIMITS.title),
          billingAddress: isEmptyAddress(billing) ? null : billing,
          ...(number ? { brand: cardBrand(number), last4: number.slice(-4) } : {}),
        },
        secrets: { ...(number ? { number } : {}), ...(code ? { securityCode: code } : {}) },
      };
    }
    case "contact": {
      const where = address(source.address, "The address");
      const primary = email(source.email, "The email");
      const emails = list(source.emails, "Emails", VAULT_LIMITS.emails, (value) => email(value, "An email"));
      const phones = list(source.phones, "Phone numbers", VAULT_LIMITS.phones, (value) => phone(value, "A phone number"));
      if (!primary && emails.length === 0 && phones.length === 0 && !where.line1) fail("A contact needs an email, a phone number or an address.");
      return {
        ...base,
        data: {
          address: where,
          defaultShipping: source.defaultShipping === true,
          email: primary,
          emails: emails.filter((value) => value !== primary),
          phones,
        },
        secrets: {},
      };
    }
    default: {
      const unhandled: never = source.kind;
      return fail(`Unhandled item kind: ${String(unhandled)}`);
    }
  }
}

/* Views ---------------------------------------------------------------------- */

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function storedAddress(value: unknown): VaultAddress {
  const out = emptyAddress();
  if (typeof value !== "object" || value === null) return out;
  for (const key of ADDRESS_KEYS) out[key] = text((value as Record<string, unknown>)[key]);
  return out;
}

/** The item as a person sees it: no secret, only whether one is saved. */
export function viewOf(item: StoredVaultItem): VaultItem {
  const base = { id: item.id, title: item.title, notes: item.notes, createdAt: item.createdAt, updatedAt: item.updatedAt };
  const d = item.data;
  switch (item.kind) {
    case "login":
      return { ...base, kind: "login", username: text(d.username), sites: strings(d.sites), hasPassword: Boolean(item.secrets.password) };
    case "card": {
      const brand = (CARD_BRANDS as readonly string[]).includes(text(d.brand)) ? (text(d.brand) as CardBrand) : "unknown";
      const billing = storedAddress(d.billingAddress);
      return {
        ...base,
        kind: "card",
        brand,
        last4: text(d.last4),
        expMonth: typeof d.expMonth === "number" ? d.expMonth : 0,
        expYear: typeof d.expYear === "number" ? d.expYear : 0,
        holderName: text(d.holderName),
        billingAddress: d.billingAddress ? billing : null,
        hasSecurityCode: Boolean(item.secrets.securityCode),
      };
    }
    case "contact":
      return {
        ...base,
        kind: "contact",
        address: storedAddress(d.address),
        defaultShipping: d.defaultShipping === true,
        email: text(d.email),
        emails: strings(d.emails),
        phones: strings(d.phones),
      };
    default: {
      const unhandled: never = item.kind;
      throw new Error(`Unhandled item kind: ${String(unhandled)}`);
    }
  }
}

/** Whether a value read from disk is an item this version can use. Anything else is ignored rather than trusted. */
export function isStoredVaultItem(value: unknown): value is StoredVaultItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id !== "" &&
    isVaultKind(v.kind) &&
    typeof v.title === "string" &&
    typeof v.notes === "string" &&
    typeof v.createdAt === "number" &&
    typeof v.updatedAt === "number" &&
    typeof v.data === "object" &&
    v.data !== null &&
    typeof v.secrets === "object" &&
    v.secrets !== null
  );
}

export function isVaultGrant(value: unknown): value is VaultGrant {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.botId === "string" && typeof v.itemId === "string" && typeof v.host === "string" && typeof v.grantedAt === "number";
}

/* Reading a field to fill it ------------------------------------------------- */

/**
 * The text to put in `field` of an item, or null when the item has none. `decrypt` turns saved cipher text into the
 * secret; a secret it cannot read gives null, never the cipher text.
 */
export function resolveVaultField(item: StoredVaultItem, field: string, decrypt: (stored: string) => string | null): string | null {
  if (!isVaultField(item.kind, field)) return null;
  const d = item.data;
  const secret = (name: VaultSecretName): string | null => {
    const stored = item.secrets[name];
    return stored ? decrypt(stored) : null;
  };
  const nonEmpty = (value: string): string | null => (value === "" ? null : value);
  if (item.kind === "login") {
    return field === "password" ? secret("password") : nonEmpty(text(d.username));
  }
  if (item.kind === "card") {
    const month = typeof d.expMonth === "number" ? d.expMonth : 0;
    const year = typeof d.expYear === "number" ? d.expYear : 0;
    switch (field) {
      case "number":
        return secret("number");
      case "securityCode":
        return secret("securityCode");
      case "holderName":
        return nonEmpty(text(d.holderName));
      case "expiry":
        return month && year ? `${String(month).padStart(2, "0")}/${String(year % 100).padStart(2, "0")}` : null;
      case "expMonth":
        return month ? String(month).padStart(2, "0") : null;
      case "expYear":
        return year ? String(year) : null;
      default:
        return nonEmpty(storedAddress(d.billingAddress)[field as keyof VaultAddress] ?? "");
    }
  }
  switch (field) {
    case "email":
      return nonEmpty(text(d.email) || strings(d.emails)[0] || "");
    case "phone":
      return nonEmpty(storedAddress(d.address).phone || strings(d.phones)[0] || "");
    default:
      return nonEmpty(storedAddress(d.address)[field as keyof VaultAddress] ?? "");
  }
}

/* Keeping secrets out of what a Bot reads ------------------------------------ */

/** The ways a saved secret can show up in a page or a tool result: a card number with or without separators. */
export function secretForms(name: VaultSecretName, value: string): string[] {
  if (name !== "number") return [value];
  const groups = (value.match(/.{1,4}/g) ?? [value]).slice();
  const amex = value.length === 15 ? [value.slice(0, 4), value.slice(4, 10), value.slice(10)] : groups;
  return [...new Set([value, groups.join(" "), groups.join("-"), amex.join(" "), amex.join("-")])];
}

export const REDACTED = "[hidden by Vault]";

/** A secret this short is only hidden when it stands alone in quotes, or ordinary words and digits would be mangled. */
const MIN_FREE_STANDING = 6;

/**
 * Replace every saved secret in `text` so it is not shown to a Bot. A secret of six characters or more is hidden
 * wherever it appears; a shorter one (a security code, a short password) only where it is a whole quoted
 * string, such as `value="123"`. It cannot catch a secret the page or a tool has transformed.
 */
export function redactSecrets(textIn: string, secrets: readonly string[]): string {
  if (!textIn || secrets.length === 0) return textIn;
  const ordered = [...new Set(secrets.filter((secret) => secret !== ""))].sort((a, b) => b.length - a.length);
  let out = textIn;
  for (const secret of ordered) {
    if (secret.length >= MIN_FREE_STANDING) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
      continue;
    }
    for (const quote of ['"', "'"]) {
      const quoted = `${quote}${secret}${quote}`;
      if (out.includes(quoted)) out = out.split(quoted).join(`${quote}${REDACTED}${quote}`);
    }
  }
  return out;
}
