import { normalizeSite } from "./vault-sites.js";

/**
 * Logins kept in 1Password, as the `op` command describes them. Pure parsing and checks; the command itself is run
 * by the desktop app. Nothing here holds a password for longer than a call: `parseOnePasswordCredential` hands
 * back what it was given, and the caller decides where it goes.
 */

/** A login in 1Password, without any secret. */
export interface OnePasswordLogin {
  id: string;
  title: string;
  username: string;
  /** The hosts it is saved for, from the item's web addresses. */
  sites: string[];
}

/** What can be filled from a 1Password login. */
export const ONE_PASSWORD_FIELDS = ["username", "password"] as const;
export type OnePasswordField = (typeof ONE_PASSWORD_FIELDS)[number];

export const ONE_PASSWORD_LIMITS = {
  /** Logins shown to a Bot at once. */
  listed: 50,
  /** Characters kept of a title or a user name. */
  text: 120,
  /** Sites kept per login. */
  sites: 8,
} as const;

/** The ids `op` makes: letters and digits. Anything else could be taken for an option when passed on, so it is refused. */
const ITEM_ID = /^[A-Za-z0-9]{8,64}$/;

export function isOnePasswordId(value: unknown): value is string {
  return typeof value === "string" && ITEM_ID.test(value);
}

export function isOnePasswordField(value: unknown): value is OnePasswordField {
  return typeof value === "string" && (ONE_PASSWORD_FIELDS as readonly string[]).includes(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown, max: number = ONE_PASSWORD_LIMITS.text): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/** The hosts an item's `urls` name, each once, in the order given. */
function sitesOf(urls: unknown): string[] {
  if (!Array.isArray(urls)) return [];
  const found: string[] = [];
  for (const entry of urls) {
    const host = normalizeSite(record(entry)?.href);
    if (host && !found.includes(host)) found.push(host);
    if (found.length >= ONE_PASSWORD_LIMITS.sites) break;
  }
  return found;
}

/** The output of `op item list --categories Login --format json`. Entries that are not logins or have no id are skipped. */
export function parseOnePasswordLogins(stdout: string): OnePasswordLogin[] {
  const parsed = parseJson(stdout);
  if (!Array.isArray(parsed)) return [];
  const logins: OnePasswordLogin[] = [];
  for (const entry of parsed) {
    const item = record(entry);
    if (!item || !isOnePasswordId(item.id)) continue;
    if (typeof item.category === "string" && item.category.toUpperCase() !== "LOGIN") continue;
    const title = text(item.title);
    if (!title) continue;
    logins.push({ id: item.id, title, username: text(item.additional_information), sites: sitesOf(item.urls) });
  }
  return logins;
}

/** What fills a login: from the output of `op item get --format json`, the field marked as the user name and the one marked as the password. */
export function parseOnePasswordCredential(stdout: string): Record<OnePasswordField, string | null> {
  const none = { username: null, password: null };
  const fields = record(parseJson(stdout))?.fields;
  if (!Array.isArray(fields)) return none;
  const pick = (purpose: string): string | null => {
    for (const entry of fields) {
      const field = record(entry);
      if (field && field.purpose === purpose && typeof field.value === "string" && field.value !== "") return field.value;
    }
    return null;
  };
  return { username: pick("USERNAME"), password: pick("PASSWORD") };
}
