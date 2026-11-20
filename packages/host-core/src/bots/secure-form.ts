import { cleanBotLine } from "./types.js";

/**
 * A Secure Form: when a Bot needs something a person has not saved in the Vault (a one-time code, a password
 * for a site they do not keep), it asks for it in a card. What the person types goes to the page and nowhere
 * else — it is never given to the model, and is not kept. Pure checks for the request and the answer.
 */

export const SECURE_FORM_LIMITS = Object.freeze({
  fields: 8,
  title: 120,
  reason: 300,
  label: 80,
  id: 40,
  value: 2048,
});

export interface SecureFormField {
  id: string;
  label: string;
  /** Typed as a password: hidden on screen. */
  secret: boolean;
}

export interface SecureFormRequest {
  title: string;
  reason: string;
  /** Where the values will be typed, so the person can see before they agree. */
  host: string;
  fields: SecureFormField[];
}

/** The page elements the fields go into, by the id the person's answer uses. */
export type SecureFormTargets = Record<string, string>;

const FIELD_ID = /^[A-Za-z0-9_-]{1,40}$/;
/** Ids that would not be an ordinary key on a plain object. */
const RESERVED_IDS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const REF = /^e\d+$/;

function text(value: unknown, what: string, max: number, required: boolean): string {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${what} is required.`);
    return "";
  }
  if (typeof value !== "string") throw new Error(`${what} must be text.`);
  const clean = cleanBotLine(value);
  if (required && !clean) throw new Error(`${what} is required.`);
  if (clean.length > max) throw new Error(`${what} is too long (at most ${max} characters).`);
  return clean;
}

/**
 * Check what a Bot asked for. `host` is where it will be typed. Throws `Error` with a message the Bot can act on.
 * Returns the request to show, and which page element each field goes into.
 */
export function parseSecureForm(args: Record<string, unknown>, host: string): { request: SecureFormRequest; targets: SecureFormTargets } {
  const title = text(args.title, "title", SECURE_FORM_LIMITS.title, true);
  const reason = text(args.reason, "reason", SECURE_FORM_LIMITS.reason, false);
  const fields = args.fields;
  if (!Array.isArray(fields) || fields.length === 0) throw new Error("fields must list at least one field.");
  if (fields.length > SECURE_FORM_LIMITS.fields) throw new Error(`Ask for at most ${SECURE_FORM_LIMITS.fields} fields at a time.`);
  const out: SecureFormField[] = [];
  const targets: SecureFormTargets = {};
  for (const entry of fields) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("Each field must be an object with id, label and ref.");
    const field = entry as Record<string, unknown>;
    const id = typeof field.id === "string" ? field.id : "";
    if (!FIELD_ID.test(id) || RESERVED_IDS.has(id)) throw new Error("A field id is 1 to 40 letters, digits, - or _.");
    if (Object.hasOwn(targets, id)) throw new Error(`The field id "${id}" is used twice.`);
    const ref = typeof field.ref === "string" ? field.ref : "";
    if (!REF.test(ref)) throw new Error(`Field "${id}" needs a ref from browser_snapshot (like e12).`);
    targets[id] = ref;
    out.push({ id, label: text(field.label, `The label of field "${id}"`, SECURE_FORM_LIMITS.label, true), secret: field.secret === true });
  }
  return { request: { title, reason, host, fields: out }, targets };
}

/**
 * What the person typed, kept to the fields that were asked for: nothing extra, nothing that is not text, nothing
 * oversized. Returns null for a cancelled form, or one with no usable value at all.
 */
export function cleanSecureFormAnswer(request: SecureFormRequest, values: unknown): Record<string, string> | null {
  if (typeof values !== "object" || values === null || Array.isArray(values)) return null;
  const source = values as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const field of request.fields) {
    if (!Object.hasOwn(source, field.id)) continue;
    const value = source[field.id];
    if (typeof value !== "string" || value === "" || value.length > SECURE_FORM_LIMITS.value) continue;
    out[field.id] = value;
  }
  return Object.keys(out).length === 0 ? null : out;
}
