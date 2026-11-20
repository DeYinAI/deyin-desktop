import type { ToolContext, ToolDefinition } from "@deyin/agent-core";
import { ONE_PASSWORD_FIELDS, ONE_PASSWORD_LIMITS, isOnePasswordField, isOnePasswordId, matchingSite, pageHost, type OnePasswordField, type OnePasswordLogin } from "@deyin/host-core/shared";
import { NO_SUCH_LOGIN, type OnePasswordPort } from "./onepassword.js";
import { REF, hostOfPage, notFillable, pickSurface, refProp, surfaceProp, type Args, type VaultToolDeps } from "./vault-tools.js";

/**
 * The tools a Bot uses to sign in with a login kept in 1Password, after the Vault has nothing for the site and before
 * it falls back to asking the person in a Secure Form. Like the Vault's, the model names a login and the page
 * elements; the host reads the password from 1Password at that moment and types it in. Unlike the Vault's, nothing is
 * remembered: 1Password's own approval is the person's, and this app asks them again on every use. A run nobody is
 * watching (a routine) therefore never fills from 1Password.
 */

export interface OnePasswordToolDeps extends Pick<VaultToolDeps, "botId" | "pages" | "ask" | "hide"> {
  onePassword: OnePasswordPort;
}

const MAX_FIELDS = ONE_PASSWORD_FIELDS.length;

function describeLogin(login: OnePasswordLogin): string {
  return `- id ${login.id} — "${login.title}"${login.username ? ` · user ${login.username}` : ""} · sites ${login.sites.length > 0 ? login.sites.join(", ") : "none saved"}`;
}

/* onepassword_list -------------------------------------------------------- */

async function listLogins(deps: OnePasswordToolDeps, args: Args): Promise<string> {
  const site = typeof args.site === "string" && args.site.trim() ? args.site.trim() : undefined;
  const target = site ? (pageHost(site) ?? pageHost(`https://${site}`)) : null;
  if (site && !target) throw new Error("site must be a web address or a host name, like github.com.");
  const logins = (await deps.onePassword.logins()).filter((login) => !target || matchingSite(login.sites, `https://${target}`) !== null);
  if (logins.length === 0) {
    return `${site ? "1Password has no login saved for that site." : "1Password has no logins."} Use request_takeover or secure_form_fill if a person has to provide it.`;
  }
  const lines = logins.slice(0, ONE_PASSWORD_LIMITS.listed).map(describeLogin);
  if (logins.length > ONE_PASSWORD_LIMITS.listed) lines.push(`…and ${logins.length - ONE_PASSWORD_LIMITS.listed} more. Pass site to narrow it.`);
  return `${lines.join("\n")}\nUse onepassword_fill with an id. You are never shown passwords; they go straight into the page.`;
}

/* onepassword_fill -------------------------------------------------------- */

interface FillRequest {
  entry: string;
  fields: Array<{ ref: string; field: OnePasswordField }>;
  submit: boolean;
}

function parseFill(args: Args): FillRequest {
  const entry = typeof args.entry === "string" ? args.entry : "";
  if (!isOnePasswordId(entry)) throw new Error(NO_SUCH_LOGIN);
  const raw = args.fields;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("fields must list at least one { ref, field }.");
  if (raw.length > MAX_FIELDS) throw new Error(`Fill at most ${MAX_FIELDS} fields at a time.`);
  const fields = raw.map((item): { ref: string; field: OnePasswordField } => {
    const candidate = typeof item === "object" && item !== null ? (item as Args) : {};
    const ref = typeof candidate.ref === "string" ? candidate.ref : "";
    if (!REF.test(ref)) throw new Error(`A ref from browser_snapshot is needed for each field (like e12); got ${JSON.stringify(ref).slice(0, 40)}.`);
    if (!isOnePasswordField(candidate.field)) {
      throw new Error(`"${String(candidate.field).slice(0, 40)}" is not something 1Password can fill here. The fields are: ${ONE_PASSWORD_FIELDS.join(", ")}.`);
    }
    return { ref, field: candidate.field };
  });
  return { entry, fields, submit: args.submit === true };
}

async function fillFromOnePassword(deps: OnePasswordToolDeps, args: Args, ctx: ToolContext): Promise<string> {
  const request = parseFill(args);
  const source = pickSurface(deps, args);
  const before = await hostOfPage(source, ctx);
  if (!before.host) throw new Error(notFillable(before.url));

  const login = (await deps.onePassword.logins()).find((candidate) => candidate.id === request.entry);
  if (!login) throw new Error(NO_SUCH_LOGIN);
  // Only where the login belongs. Unlike the Vault, a page that is not one of its sites is never offered to a person.
  if (matchingSite(login.sites, before.url) === null) {
    throw new Error(`"${login.title}" is not saved for ${before.host} in 1Password, so it was not filled. Use onepassword_list with site to find the right login.`);
  }
  if (!deps.ask) throw new Error(`Using "${login.title}" from 1Password on ${before.host} needs a person's agreement, and nobody is here. It was not filled.`);
  const answer = await deps.ask({
    once: true,
    summary: `Use "${login.title}" from 1Password on ${before.host}`,
    reason: `The Bot wants to sign in to ${before.host} with "${login.title}" from your 1Password. It never sees the password; it goes straight into the page. This is asked every time.`,
  });
  if (answer === "deny") throw new Error(`The person did not allow using "${login.title}" on ${before.host}. Do not try again; ask them what to do instead.`);

  // Read every value before touching the page, and hide them before they are anywhere: a missing one is reported without a half-filled form.
  const credential = await deps.onePassword.credential(login.id);
  const values = request.fields.map(({ ref, field }) => ({ ref, field, value: credential[field] }));
  const missing = values.filter((entry) => entry.value === null).map((entry) => entry.field);
  if (missing.length > 0) throw new Error(`"${login.title}" has no ${missing.join(", ")} in 1Password.`);
  if (deps.hide) for (const entry of values) if (entry.field === "password" && entry.value) deps.hide(entry.value);

  const filled = await source.withPage(ctx, async (page) => {
    // The page can move while a person is deciding; what they agreed to was this host.
    if (pageHost(await page.url()) !== before.host) throw new Error("The page changed while waiting, so nothing was filled. Check the page and try again.");
    const done: string[] = [];
    for (const { ref, field, value } of values) {
      try {
        await page.fill(ref, value ?? "");
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        // The page error is not attached as the cause: it can carry the value that was being filled in.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`${done.length > 0 ? `Filled ${done.join(", ")}, but ` : ""}could not fill ${field} into ${ref}: ${why}`);
      }
      done.push(field);
    }
    if (request.submit) await page.submit();
    return done;
  });
  return `Filled ${filled.join(", ")} from "${login.title}" in 1Password on ${before.host}${request.submit ? " and pressed Enter" : ""}. The values are not shown to you. Take a snapshot to see what the page did.`;
}

/* The tools --------------------------------------------------------------- */

export function createOnePasswordTools(deps: OnePasswordToolDeps): ToolDefinition[] {
  // A tool's failure is a result the model can read, never an exception.
  const wrap = async (fn: () => Promise<string>): Promise<string> => {
    try {
      return await fn();
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  return [
    {
      name: "onepassword_list",
      description:
        "List logins in the person's 1Password: the id to use, the user name and the sites each is saved for. Passwords are never shown. Pass `site` to see only the logins saved for it. Use this when the Vault has nothing for the site; if neither has it, ask with secure_form_fill.",
      tier: "read",
      parameters: { type: "object", properties: { site: { type: "string", description: "A site or page address; shows the logins saved for it." } } },
      summarize: (args) => `list 1Password logins${typeof args.site === "string" ? ` for ${args.site}` : ""}`,
      execute: (args) => wrap(() => listLogins(deps, args)),
    },
    {
      name: "onepassword_fill",
      description:
        "Sign in with a login from 1Password, without seeing it. Give the `entry` id (from onepassword_list) and, for each field, the element `ref` (from browser_snapshot) and which `field` goes in it: username or password. The page must be https and one of the login's saved sites. The person is asked every time. Never type a password yourself.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: {
          entry: { type: "string", description: "1Password login id from onepassword_list." },
          fields: {
            type: "array",
            items: {
              type: "object",
              properties: { ref: refProp, field: { type: "string", enum: [...ONE_PASSWORD_FIELDS], description: "Which part of the login goes into the element." } },
              required: ["ref", "field"],
            },
          },
          submit: { type: "boolean", description: "Press Enter after filling." },
          ...surfaceProp(deps),
        },
        required: ["entry", "fields"],
      },
      summarize: () => "sign in with a 1Password login",
      execute: (args, ctx) => wrap(() => fillFromOnePassword(deps, args, ctx)),
    },
  ];
}
