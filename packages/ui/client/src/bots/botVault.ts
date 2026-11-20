import type { BotResult, DeyinApi } from "@deyin/contract";
import {
  VAULT_KINDS,
  VAULT_LIMITS,
  type CardBrand,
  type DeyinBot,
  type MessageKey,
  type VaultAddress,
  type VaultCard,
  type VaultGrant,
  type VaultItem,
  type VaultKind,
  type VaultSnapshot,
} from "@deyin/host-core/shared";

/** The Vault calls the page needs. Absent where there is no desktop host (the web build). */
export type VaultApi = NonNullable<DeyinApi["vault"]>;

/* Form -------------------------------------------------------------------- */

/** An address as typed: every part is text, and an untouched one is "". */
export type AddressForm = Record<keyof VaultAddress, string>;

export function emptyAddressForm(): AddressForm {
  return { name: "", line1: "", line2: "", city: "", region: "", postalCode: "", country: "", phone: "" };
}

/**
 * Everything the add and edit form holds, for every kind at once, as text. Secrets (`password`, `number`,
 * `securityCode`) start empty even when editing: the Vault never sends them back, and an empty one means "keep it".
 */
export interface VaultForm {
  /** "" while adding. */
  id: string;
  kind: VaultKind;
  title: string;
  notes: string;
  username: string;
  password: string;
  /** One site per line (or comma separated). */
  sites: string;
  number: string;
  securityCode: string;
  expMonth: string;
  expYear: string;
  holderName: string;
  billing: AddressForm;
  email: string;
  /** One address per line. */
  emails: string;
  /** One number per line. */
  phones: string;
  address: AddressForm;
  defaultShipping: boolean;
  /** What is already saved, only to tell the person ("saved — leave blank to keep"). */
  saved: { password: boolean; securityCode: boolean; last4: string };
}

export function emptyVaultForm(kind: VaultKind): VaultForm {
  return {
    id: "",
    kind,
    title: "",
    notes: "",
    username: "",
    password: "",
    sites: "",
    number: "",
    securityCode: "",
    expMonth: "",
    expYear: "",
    holderName: "",
    billing: emptyAddressForm(),
    email: "",
    emails: "",
    phones: "",
    address: emptyAddressForm(),
    defaultShipping: false,
    saved: { password: false, securityCode: false, last4: "" },
  };
}

function addressForm(address: VaultAddress | null): AddressForm {
  return address ? { ...address } : emptyAddressForm();
}

/** The form for changing `item`: everything it shows, and no secret. */
export function formFromItem(item: VaultItem): VaultForm {
  const form: VaultForm = { ...emptyVaultForm(item.kind), id: item.id, title: item.title, notes: item.notes };
  switch (item.kind) {
    case "login":
      return { ...form, username: item.username, sites: item.sites.join("\n"), saved: { password: item.hasPassword, securityCode: false, last4: "" } };
    case "card":
      return {
        ...form,
        expMonth: item.expMonth ? String(item.expMonth) : "",
        expYear: item.expYear ? String(item.expYear) : "",
        holderName: item.holderName,
        billing: addressForm(item.billingAddress),
        saved: { password: false, securityCode: item.hasSecurityCode, last4: item.last4 },
      };
    case "contact":
      return { ...form, email: item.email, emails: item.emails.join("\n"), phones: item.phones.join("\n"), address: addressForm(item.address), defaultShipping: item.defaultShipping };
    default: {
      const unhandled: never = item;
      throw new Error(`Unhandled item: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Lines or comma-separated values, trimmed, without blanks. */
export function splitList(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function hasText(value: string): boolean {
  return value.trim() !== "";
}

function trimmed(address: AddressForm): AddressForm {
  const out = emptyAddressForm();
  for (const key of Object.keys(out) as Array<keyof AddressForm>) out[key] = address[key].trim();
  return out;
}

/**
 * What stops the form being saved, as a message key, or null. The host checks everything again and is the
 * authority; this only keeps the Save button honest about what is obviously missing.
 */
export function vaultFormProblem(form: VaultForm): MessageKey | null {
  if (!hasText(form.title)) return "vault.err.title";
  const adding = form.id === "";
  switch (form.kind) {
    case "login":
      if (!hasText(form.username)) return "vault.err.username";
      if (splitList(form.sites).length === 0) return "vault.err.sites";
      if (adding && form.password === "") return "vault.err.password";
      return null;
    case "card":
      if (adding && !hasText(form.number)) return "vault.err.number";
      if (!hasText(form.expMonth) || !hasText(form.expYear)) return "vault.err.expiry";
      return null;
    case "contact":
      if (!hasText(form.email) && splitList(form.emails).length === 0 && splitList(form.phones).length === 0 && !hasText(form.address.line1)) return "vault.err.contact";
      return null;
    default: {
      const unhandled: never = form.kind;
      throw new Error(`Unhandled kind: ${String(unhandled)}`);
    }
  }
}

/** What to send the host for `form`. A secret left empty is left out, so the host keeps what it has. */
export function vaultPayload(form: VaultForm): Record<string, unknown> {
  const base = { ...(form.id ? { id: form.id } : {}), kind: form.kind, title: form.title.trim(), notes: form.notes.trim() };
  switch (form.kind) {
    case "login":
      return { ...base, username: form.username.trim(), sites: splitList(form.sites), ...(form.password !== "" ? { password: form.password } : {}) };
    case "card":
      return {
        ...base,
        ...(hasText(form.number) ? { number: form.number.trim() } : {}),
        ...(hasText(form.securityCode) ? { securityCode: form.securityCode.trim() } : {}),
        expMonth: form.expMonth.trim(),
        expYear: form.expYear.trim(),
        holderName: form.holderName.trim(),
        billingAddress: trimmed(form.billing),
      };
    case "contact":
      return {
        ...base,
        email: form.email.trim(),
        emails: splitList(form.emails),
        phones: splitList(form.phones),
        address: trimmed(form.address),
        defaultShipping: form.defaultShipping,
      };
    default: {
      const unhandled: never = form.kind;
      throw new Error(`Unhandled kind: ${String(unhandled)}`);
    }
  }
}

/** How much each text box may hold, so the form stops typing where the host would refuse. */
export const FORM_LIMITS = {
  title: VAULT_LIMITS.title,
  notes: VAULT_LIMITS.notes,
  username: VAULT_LIMITS.username,
  password: VAULT_LIMITS.password,
  line: VAULT_LIMITS.line,
  email: VAULT_LIMITS.email,
} as const;

/* What the list shows ----------------------------------------------------- */

const BRAND_NAMES: Record<CardBrand, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
  unknown: "Card",
};

function addressLine(address: VaultAddress): string {
  return [address.line1, address.city, address.region, address.postalCode, address.country].filter((part) => part !== "").join(", ");
}

/** Which of a contact's ways of being reached comes first: an email, else a phone number, else the address. */
function contactLead(item: Extract<VaultItem, { kind: "contact" }>): "email" | "phone" | "address" {
  return item.email ? "email" : item.phones.length > 0 ? "phone" : "address";
}

/** The one line that says which item this is: who a login is for, which card, how to reach a contact. */
export function itemHeadline(item: VaultItem): string {
  switch (item.kind) {
    case "login":
      return item.username;
    case "card":
      return `${BRAND_NAMES[item.brand]} •••• ${item.last4}`;
    case "contact": {
      const lead = contactLead(item);
      return lead === "email" ? item.email : lead === "phone" ? (item.phones[0] ?? "") : addressLine(item.address);
    }
    default: {
      const unhandled: never = item;
      throw new Error(`Unhandled item: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** The lines under the headline: a login's sites, a card's holder, a contact's other details. */
export function itemDetails(item: VaultItem): string[] {
  switch (item.kind) {
    case "login":
      return [item.sites.join(", ")];
    case "card":
      return item.holderName ? [item.holderName] : [];
    case "contact": {
      const lead = contactLead(item);
      const where = addressLine(item.address);
      return [...(lead !== "address" && where ? [where] : []), ...item.emails, ...(lead === "phone" ? item.phones.slice(1) : item.phones)];
    }
    default: {
      const unhandled: never = item;
      throw new Error(`Unhandled item: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** A card's expiry as MM/YY. */
export function cardExpiry(card: VaultCard): string {
  if (!card.expMonth || !card.expYear) return "";
  return `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear % 100).padStart(2, "0")}`;
}

/** Whether a card has expired: a card is good through the end of its expiry month. */
export function cardExpired(card: VaultCard, now: Date): boolean {
  if (!card.expMonth || !card.expYear) return false;
  const year = now.getFullYear();
  return card.expYear < year || (card.expYear === year && card.expMonth < now.getMonth() + 1);
}

export interface VaultGroup {
  kind: VaultKind;
  items: VaultItem[];
}

/** The items by kind, in the order logins, cards, contacts; a kind with nothing in it is left out. */
export function groupItems(items: readonly VaultItem[]): VaultGroup[] {
  return VAULT_KINDS.map((kind) => ({ kind, items: items.filter((item) => item.kind === kind) })).filter((group) => group.items.length > 0);
}

export interface GrantRow {
  botId: string;
  /** The Bot's name, or "a deleted Bot" text is the caller's to supply when it is not known. */
  botName: string | null;
  host: string;
  grantedAt: number;
}

/** Who may use `itemId`, and where, newest first. A Bot that is no longer on the roster has a null name. */
export function grantRows(grants: readonly VaultGrant[], itemId: string, bots: readonly Pick<DeyinBot, "id" | "name">[]): GrantRow[] {
  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  return grants
    .filter((grant) => grant.itemId === itemId)
    .map((grant) => ({ botId: grant.botId, botName: names.get(grant.botId) ?? null, host: grant.host, grantedAt: grant.grantedAt }))
    .sort((a, b) => b.grantedAt - a.grantedAt);
}

/* Talking to the host ----------------------------------------------------- */

export type VaultOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run a Vault call and give back its value or the reason it was refused, never a throw. */
export async function attemptVault<T>(run: () => Promise<BotResult<T>>): Promise<VaultOutcome<T>> {
  try {
    const result = await run();
    return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error };
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
}

export async function attemptVaultLoad(api: Pick<VaultApi, "get">): Promise<VaultOutcome<VaultSnapshot>> {
  try {
    return { ok: true, value: await api.get() };
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
}
