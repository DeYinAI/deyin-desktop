import type { ToolContext, ToolDefinition } from "@deyin/agent-core";
import {
  VAULT_FIELDS,
  VAULT_KINDS,
  cleanSecureFormAnswer,
  isVaultField,
  isVaultKind,
  matchingSite,
  pageHost,
  parseSecureForm,
  type SecureFormRequest,
  type VaultItem,
} from "@deyin/host-core/shared";

/**
 * The tools a Bot uses to sign in and fill forms without being handed a secret. The model names a saved item
 * and the page elements to fill; the host reads the secret, checks the page is somewhere it belongs, gets a
 * person's agreement the first time, and types it in. What comes back says which fields were filled, never
 * their values.
 */

/** Where a Bot can be working in a browser. */
export const VAULT_SURFACES = ["browser", "chrome"] as const;
export type VaultSurface = (typeof VAULT_SURFACES)[number];

/** What a tool needs from a page: its address, typing into an element, and pressing Enter. */
export interface VaultPage {
  url(): Promise<string>;
  fill(ref: string, value: string): Promise<void>;
  submit(): Promise<void>;
}

export interface VaultPageSource {
  withPage<T>(ctx: ToolContext, fn: (page: VaultPage) => Promise<T>): Promise<T>;
}

/** The part of the Vault the tools use. `VaultStore` provides it. */
export interface VaultAccess {
  list(): VaultItem[];
  get(id: string): VaultItem | null;
  field(id: string, field: string): string | null;
  hasGrant(botId: string, itemId: string, host: string): boolean;
  grant(botId: string, itemId: string, host: string): void;
  addSite(id: string, site: string): boolean;
}

export type VaultAnswer = "allow" | "allow-always" | "deny";

export interface VaultApproval {
  /** Asked afresh every time: nothing is kept, so "always allow" has no place on the card. */
  once?: boolean;
  /** What the card says is being asked. */
  summary: string;
  reason: string;
}

export interface VaultToolDeps {
  vault: VaultAccess;
  botId: string;
  pages: Partial<Record<VaultSurface, VaultPageSource>>;
  /** Ask a person. Absent when nobody is there (a routine): anything that needs agreement is then refused. */
  ask?: (request: VaultApproval) => Promise<VaultAnswer>;
  /** Hand the browser to a person until they say they are done. Absent when nobody is there. */
  takeover?: (reason: string) => Promise<"done" | "declined">;
  /** Show a Secure Form and return what was typed, or null when it was cancelled. Absent when nobody is there. */
  secureForm?: (request: SecureFormRequest) => Promise<Record<string, string> | null>;
  /** Remember a value so it is hidden from everything the Bot reads for the rest of the run. */
  hide?: (value: string) => void;
}

export const REF = /^e\d+$/;
const MAX_FILL_FIELDS = 12;
const MAX_LISTED = 100;
const MAX_REASON = 300;

export type Args = Record<string, unknown>;

export const refProp = { type: "string", description: "Element ref from browser_snapshot (e.g. e12)." };

export function surfaceProp(deps: Pick<VaultToolDeps, "pages">): Record<string, unknown> {
  const available = VAULT_SURFACES.filter((surface) => deps.pages[surface]);
  return available.length > 1
    ? { surface: { type: "string", enum: available, description: `Which browser the page is open in. Default: ${available[0]}.` } }
    : {};
}

export function pickSurface(deps: Pick<VaultToolDeps, "pages">, args: Args): VaultPageSource {
  const available = VAULT_SURFACES.filter((surface) => deps.pages[surface]);
  const asked = typeof args.surface === "string" ? args.surface : undefined;
  const surface = asked ?? available[0];
  const source = VAULT_SURFACES.find((candidate) => candidate === surface);
  const page = source ? deps.pages[source] : undefined;
  if (!page) {
    throw new Error(available.length === 0 ? "No browser is available to fill. Turn on the browser or Chrome control first." : `surface must be one of: ${available.join(", ")}.`);
  }
  return page;
}

/** The page's origin for a message, without its path or query (which can carry tokens). */
function describePage(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "this page";
  }
}

function describeItem(item: VaultItem): string {
  switch (item.kind) {
    case "login":
      return `login · "${item.title}" · user ${item.username} · sites ${item.sites.join(", ")}`;
    case "card":
      return `card · "${item.title}" · ${item.brand} ending ${item.last4} · expires ${String(item.expMonth).padStart(2, "0")}/${String(item.expYear % 100).padStart(2, "0")}${item.holderName ? ` · ${item.holderName}` : ""}`;
    case "contact":
      return `contact · "${item.title}"${item.defaultShipping ? " · default shipping" : ""}`;
    default: {
      const unhandled: never = item;
      throw new Error(`Unhandled item: ${JSON.stringify(unhandled)}`);
    }
  }
}

export async function hostOfPage(source: VaultPageSource, ctx: ToolContext): Promise<{ url: string; host: string | null }> {
  const url = await source.withPage(ctx, (page) => page.url());
  return { url, host: pageHost(url) };
}

/** Why a page cannot be filled, as text for the Bot. */
export function notFillable(url: string): string {
  return `${describePage(url)} is not somewhere a saved credential can be filled in: it has to be an https page (or http on this computer).`;
}

/* vault_list -------------------------------------------------------------- */

function listVault(deps: VaultToolDeps, args: Args): string {
  const kind = args.kind === undefined ? undefined : isVaultKind(args.kind) ? args.kind : null;
  if (kind === null) throw new Error("kind must be login, card or contact.");
  const site = typeof args.site === "string" && args.site.trim() ? args.site.trim() : undefined;
  const target = site ? (pageHost(site) ?? pageHost(`https://${site}`)) : null;
  if (site && !target) throw new Error("site must be a web address or a host name, like github.com.");
  const items = deps.vault.list().filter((item) => {
    if (kind && item.kind !== kind) return false;
    // Asking about a site narrows logins to the ones saved for it; cards and contacts have no site.
    return !target || item.kind !== "login" || matchingSite(item.sites, `https://${target}`) !== null;
  });
  if (items.length === 0) {
    const none = site || kind ? "Nothing in the Vault matches." : "The Vault is empty.";
    return `${none} Use request_takeover or secure_form_fill if a person has to provide it.`;
  }
  const lines = items.slice(0, MAX_LISTED).map((item) => {
    const fields = (VAULT_FIELDS[item.kind] as readonly string[]).join(", ");
    return `- id ${item.id} — ${describeItem(item)} — fields: ${fields}`;
  });
  if (items.length > MAX_LISTED) lines.push(`…and ${items.length - MAX_LISTED} more. Pass kind or site to narrow it.`);
  return `${lines.join("\n")}\nUse vault_fill with an id. You are never shown passwords, card numbers or security codes; they go straight into the page.`;
}

/* vault_fill -------------------------------------------------------------- */

interface FillRequest {
  item: VaultItem;
  fields: Array<{ ref: string; field: string }>;
  submit: boolean;
}

function parseFill(deps: VaultToolDeps, args: Args): FillRequest {
  const id = typeof args.entry === "string" ? args.entry : "";
  const item = id ? deps.vault.get(id) : null;
  if (!item) throw new Error("No Vault item has that id. Call vault_list to see what is saved.");
  const raw = args.fields;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("fields must list at least one { ref, field }.");
  if (raw.length > MAX_FILL_FIELDS) throw new Error(`Fill at most ${MAX_FILL_FIELDS} fields at a time.`);
  const fields = raw.map((entry): { ref: string; field: string } => {
    const candidate = typeof entry === "object" && entry !== null ? (entry as Args) : {};
    const ref = typeof candidate.ref === "string" ? candidate.ref : "";
    if (!REF.test(ref)) throw new Error(`A ref from browser_snapshot is needed for each field (like e12); got ${JSON.stringify(ref).slice(0, 40)}.`);
    if (!isVaultField(item.kind, candidate.field)) {
      throw new Error(`"${String(candidate.field).slice(0, 40)}" is not a field of this ${item.kind}. Its fields are: ${VAULT_FIELDS[item.kind].join(", ")}.`);
    }
    return { ref, field: candidate.field };
  });
  return { item, fields, submit: args.submit === true };
}

/**
 * Whether the Bot may use `item` on `host`, asking a person when it has not been agreed. A login is also held to its
 * saved sites: a page that is not one of them is only filled when a person says so, and added only for "always".
 */
async function authorize(deps: VaultToolDeps, item: VaultItem, host: string, url: string): Promise<void> {
  const sites = item.kind === "login" ? item.sites : [];
  const offSite = item.kind === "login" && matchingSite(sites, url) === null;
  // An agreement to use an item on a page that belongs to it is kept; a page that does not belong is asked about every time.
  if (!offSite && deps.vault.hasGrant(deps.botId, item.id, host)) return;
  if (!deps.ask) {
    throw new Error(
      offSite
        ? `"${item.title}" is not saved for ${host}, so it was not filled. Nobody is here to agree to it.`
        : `Using "${item.title}" on ${host} needs a person's agreement, and nobody is here. It was not filled.`,
    );
  }
  const answer = await deps.ask({
    summary: `Use "${item.title}" on ${host}`,
    reason: offSite
      ? `"${item.title}" is saved for ${sites.join(", ")}, not ${host}. Only agree if you trust ${host}. "Always allow" also saves ${host} for this login and keeps the agreement for this Bot.`
      : `The Bot wants to fill "${item.title}" into ${host}. It never sees the ${item.kind === "card" ? "card number" : item.kind === "login" ? "password" : "details"}; they go straight into the page. "Always allow" keeps this for this Bot on ${host}.`,
  });
  if (answer === "deny") throw new Error(`The person did not allow using "${item.title}" on ${host}. Do not try again; ask them what to do instead.`);
  if (answer === "allow-always") {
    // A site is only added when the person chose to keep the agreement.
    if (offSite && !deps.vault.addSite(item.id, host)) throw new Error(`"${item.title}" could not be saved for ${host}, so it was not filled.`);
    deps.vault.grant(deps.botId, item.id, host);
  }
}

async function fillFromVault(deps: VaultToolDeps, args: Args, ctx: ToolContext): Promise<string> {
  const request = parseFill(deps, args);
  const { item } = request;
  // Read every value before touching the page: a missing one is reported without a half-filled form.
  const values = request.fields.map(({ ref, field }) => ({ ref, field, value: deps.vault.field(item.id, field) }));
  const missing = values.filter((entry) => entry.value === null).map((entry) => entry.field);
  if (missing.length > 0) throw new Error(`"${item.title}" has no ${missing.join(", ")} saved.`);

  const source = pickSurface(deps, args);
  const before = await hostOfPage(source, ctx);
  if (!before.host) throw new Error(notFillable(before.url));
  await authorize(deps, item, before.host, before.url);

  const filled: string[] = [];
  const done = await source.withPage(ctx, async (page) => {
    // The page can move while a person is deciding; what they agreed to was this host.
    const after = pageHost(await page.url());
    if (after !== before.host) throw new Error("The page changed while waiting, so nothing was filled. Check the page and try again.");
    for (const { ref, field, value } of values) {
      try {
        await page.fill(ref, value ?? "");
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        // The page error is not attached as the cause: it can carry the value that was being filled in.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`${filled.length > 0 ? `Filled ${filled.join(", ")}, but ` : ""}could not fill ${field} into ${ref}: ${why}`);
      }
      filled.push(field);
    }
    if (request.submit) await page.submit();
    return filled;
  });
  return `Filled ${done.join(", ")} from "${item.title}" on ${before.host}${request.submit ? " and pressed Enter" : ""}. The values are not shown to you. Take a snapshot to see what the page did.`;
}

/* request_takeover -------------------------------------------------------- */

async function handOver(deps: VaultToolDeps, args: Args): Promise<string> {
  const reason = typeof args.reason === "string" ? args.reason.replace(/\s+/g, " ").trim() : "";
  if (!reason) throw new Error("reason is required: say what the person needs to do.");
  const shown = reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON)}…` : reason;
  if (!deps.takeover) {
    throw new Error(`Nobody is here to take over, so this cannot go on. Stop and report that a person has to do this: ${shown}`);
  }
  const outcome = await deps.takeover(shown);
  return outcome === "done"
    ? "The person finished and handed the browser back. Take a fresh snapshot before going on; the page may have changed."
    : "The person did not take over. Do not carry on with this step; tell them what is still undone.";
}

/* secure_form_fill -------------------------------------------------------- */

async function fillSecureForm(deps: VaultToolDeps, args: Args, ctx: ToolContext): Promise<string> {
  if (!deps.secureForm) {
    throw new Error("Nobody is here to fill in a form, so this cannot go on. Stop and report what a person has to provide.");
  }
  const source = pickSurface(deps, args);
  const before = await hostOfPage(source, ctx);
  if (!before.host) throw new Error(notFillable(before.url));
  const { request, targets } = parseSecureForm(args, before.host);
  const typed = cleanSecureFormAnswer(request, await deps.secureForm(request));
  if (!typed) return "The person did not fill in the form. Do not carry on with this step; tell them what is still undone.";
  for (const value of Object.values(typed)) deps.hide?.(value);

  const labels: string[] = [];
  await source.withPage(ctx, async (page) => {
    if (pageHost(await page.url()) !== before.host) throw new Error("The page changed while the form was open, so nothing was filled. Check the page and ask again.");
    for (const field of request.fields) {
      const value = typed[field.id];
      const ref = targets[field.id];
      if (value === undefined || ref === undefined) continue;
      try {
        await page.fill(ref, value);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        // The page error is not attached as the cause: it can carry the value that was being filled in.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`${labels.length > 0 ? `Filled ${labels.join(", ")}, but ` : ""}could not fill ${field.label} into ${ref}: ${why}`);
      }
      labels.push(field.label);
    }
    if (args.submit === true) await page.submit();
  });
  return `Filled ${labels.join(", ")} on ${before.host}${args.submit === true ? " and pressed Enter" : ""}. What the person typed is not shown to you. Take a snapshot to see what the page did.`;
}

/* The tools --------------------------------------------------------------- */

export function createVaultTools(deps: VaultToolDeps): ToolDefinition[] {
  // A tool's failure is a result the model can read, never an exception.
  const wrap = async (fn: () => Promise<string> | string): Promise<string> => {
    try {
      return await fn();
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  const surface = surfaceProp(deps);

  return [
    {
      name: "vault_list",
      description:
        "List what the person has saved in their Vault: logins, cards and contacts, with the id to use and the fields each can fill. Passwords, card numbers and security codes are never shown. Pass `site` to see only the logins saved for it.",
      tier: "read",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...VAULT_KINDS], description: "Only this kind." },
          site: { type: "string", description: "A site or page address; shows the logins saved for it." },
        },
      },
      summarize: (args) => `list Vault${typeof args.site === "string" ? ` for ${args.site}` : ""}`,
      execute: (args) => wrap(() => listVault(deps, args)),
    },
    {
      name: "vault_fill",
      description:
        "Fill saved details into the form on the page that is open, without seeing them. Give the Vault `entry` id (from vault_list) and, for each field, the element `ref` (from browser_snapshot) and which saved `field` goes in it. The page must be https and, for a login, one of its saved sites; the first use on a site asks the person. Never type a password or card number yourself.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: {
          entry: { type: "string", description: "Vault item id from vault_list." },
          fields: {
            type: "array",
            items: {
              type: "object",
              properties: { ref: refProp, field: { type: "string", description: "Saved field: username, password, number, securityCode, expiry, email, line1…" } },
              required: ["ref", "field"],
            },
          },
          submit: { type: "boolean", description: "Press Enter after filling." },
          ...surface,
        },
        required: ["entry", "fields"],
      },
      summarize: (args) => {
        const item = typeof args.entry === "string" ? deps.vault.get(args.entry) : null;
        return `fill "${item?.title ?? "a saved item"}" into the page`;
      },
      execute: (args, ctx) => wrap(() => fillFromVault(deps, args, ctx)),
    },
    {
      name: "request_takeover",
      description:
        "Hand the browser to the person for something only they can do: single sign-on, a passkey, a CAPTCHA, a code sent to their phone. It waits until they say they are done. Say exactly what they need to do. Then take a fresh snapshot.",
      tier: "interaction",
      parameters: { type: "object", properties: { reason: { type: "string", description: "What the person needs to do, in one or two sentences." } }, required: ["reason"] },
      summarize: (args) => `ask the person to take over: ${String(args.reason ?? "").slice(0, 80)}`,
      execute: (args) => wrap(() => handOver(deps, args)),
    },
    {
      name: "secure_form_fill",
      description:
        "Ask the person for something that is not in the Vault (a one-time code, a password for a site they do not keep) in a private form, and type what they enter into the page. You never see what they type. Each field needs an element `ref` from browser_snapshot. The form shows the person which site it goes to.",
      tier: "interaction",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "What the form asks for, e.g. “Sign in to Example”." },
          reason: { type: "string", description: "Why it is needed." },
          fields: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Your own short id for the field." },
                label: { type: "string", description: "What the person sees, e.g. “Verification code”." },
                secret: { type: "boolean", description: "Hide what is typed." },
                ref: refProp,
              },
              required: ["id", "label", "ref"],
            },
          },
          submit: { type: "boolean", description: "Press Enter after filling." },
          ...surface,
        },
        required: ["title", "fields"],
      },
      summarize: (args) => `ask the person for ${String(args.title ?? "details").slice(0, 80)}`,
      execute: (args, ctx) => wrap(() => fillSecureForm(deps, args, ctx)),
    },
  ];
}
