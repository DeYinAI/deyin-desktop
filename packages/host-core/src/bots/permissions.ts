import { BotError, type BotApprovalMode } from "./types.js";

/**
 * What a Bot may do with a tool, in three layers (the Grok Bot model):
 *   1. a per-tool permission inside a scope (`always_allow | needs_approval | blocked`), with `reads` and
 *      `writes` defaults for tools that have none of their own;
 *   2. an approval mode (`auto_review | read_only | run_everything`), which each Bot carries on its own record;
 *   3. plain-English allow and block instructions that a reviewer applies to anything that needs approval.
 * Everything here is data and pure functions. Deciding a call is in `review.ts`.
 */

export const TOOL_PERMISSIONS = ["always_allow", "needs_approval", "blocked"] as const;
export type ToolPermission = (typeof TOOL_PERMISSIONS)[number];

export const PERMISSION_LIMITS = Object.freeze({
  /** Allow instructions and block instructions are each capped at this many. */
  instructions: 20,
  instructionLength: 500,
  scopes: 50,
  toolsPerScope: 200,
  nameLength: 120,
});

/** Where a tool's permission lives: an MCP server's tools share a scope; every other tool is `local`. */
export const LOCAL_SCOPE = "local";

export interface ToolScopePolicy {
  /** Tool name (without any `mcp__server__` prefix) -> its permission. */
  tools: Record<string, ToolPermission>;
  /** What a read-only tool in this scope gets when it has no entry of its own. */
  reads?: ToolPermission;
  /** The same for a tool that can change something. */
  writes?: ToolPermission;
}

export interface AutoReviewSettings {
  /** Whether the reviewer applies the instructions below. Off, anything needing approval asks. */
  enabled: boolean;
  allowInstructions: string[];
  blockInstructions: string[];
}

export interface BotPermissionSettings {
  autoReview: AutoReviewSettings;
  scopes: Record<string, ToolScopePolicy>;
}

export const EMPTY_PERMISSIONS: BotPermissionSettings = Object.freeze({
  autoReview: Object.freeze({ enabled: true, allowInstructions: [], blockInstructions: [] }),
  scopes: Object.freeze({}),
}) as BotPermissionSettings;

/* Names ------------------------------------------------------------------- */

const MCP_PREFIX = "mcp__";
/** Keys that must never be used as a record key from untrusted input. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** `mcp__gmail__read_email` -> `{ scope: "gmail", tool: "read_email" }`; any other tool is in `local`. */
export function splitToolName(name: string): { scope: string; tool: string } {
  if (name.startsWith(MCP_PREFIX)) {
    const rest = name.slice(MCP_PREFIX.length);
    const at = rest.indexOf("__");
    if (at > 0 && at < rest.length - 2) return { scope: rest.slice(0, at), tool: rest.slice(at + 2) };
  }
  return { scope: LOCAL_SCOPE, tool: name };
}

function cleanKey(value: unknown, what: string): string {
  if (typeof value !== "string") throw new BotError("invalid", `${what} must be text.`);
  const key = value.trim();
  if (!key) throw new BotError("invalid", `${what} cannot be empty.`);
  if (key.length > PERMISSION_LIMITS.nameLength) throw new BotError("invalid", `${what} is too long.`);
  if (/[\u0000-\u001f\u007f]/.test(key)) throw new BotError("invalid", `${what} has characters it cannot contain.`);
  if (FORBIDDEN_KEYS.has(key)) throw new BotError("invalid", `${what} is not a name that can be used.`);
  return key;
}

/* Which tools only read -------------------------------------------------- */

/**
 * Tools the REA found to be read-only for the connectors Grok Bot ships with (Gmail, Google Calendar, Google
 * Drive). They apply to an MCP server whose name says which connector it is; any other server's tools are
 * treated as able to change something until its `reads` default or a per-tool permission says otherwise.
 */
const READONLY_CONNECTOR_TOOLS: ReadonlyArray<{ keyword: string; tools: ReadonlySet<string> }> = [
  {
    keyword: "gmail",
    tools: new Set(["get_me", "list_labels", "list_send_as", "search_emails", "read_email", "get_thread", "list_drafts", "get_draft", "list_filters"]),
  },
  {
    keyword: "calendar",
    tools: new Set(["list_calendars", "list_events", "search_events", "get_event", "list_event_instances", "check_availability", "suggest_time"]),
  },
  {
    keyword: "drive",
    tools: new Set([
      "search", "list_folder", "list_recent_files", "read_file", "export_file", "download_file", "get_file_metadata", "get_file_permissions",
      "list_comments", "docs_read_document", "docs_find_text", "sheets_get_spreadsheet", "sheets_read_range", "slides_read_presentation",
      "slides_read_slide", "slides_get_slide_thumbnail", "slides_read_slide_layout", "slides_check_contrast",
    ]),
  },
];

/** Whether a tool can only read. Built-in tools say so through their tier; connector tools through the recovered lists. */
export function isReadOnlyTool(tool: { name: string; tier?: string }): boolean {
  const { scope, tool: bare } = splitToolName(tool.name);
  if (scope === LOCAL_SCOPE) return tool.tier === "read" || tool.tier === "interaction";
  const server = scope.toLowerCase();
  return READONLY_CONNECTOR_TOOLS.some((entry) => server.includes(entry.keyword) && entry.tools.has(bare));
}

/* Reading and changing settings ------------------------------------------ */

function isPermission(value: unknown): value is ToolPermission {
  return typeof value === "string" && (TOOL_PERMISSIONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanInstructions(value: unknown, what: string, strict: boolean): string[] {
  if (!Array.isArray(value)) {
    if (strict) throw new BotError("invalid", `${what} must be a list.`);
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      if (strict) throw new BotError("invalid", `${what} must be text.`);
      continue;
    }
    const text = entry.trim().replace(/\s+/g, " ");
    if (!text || out.includes(text)) continue;
    if (text.length > PERMISSION_LIMITS.instructionLength) {
      if (strict) throw new BotError("invalid", `Each instruction can be at most ${PERMISSION_LIMITS.instructionLength} characters.`);
      continue;
    }
    out.push(text);
  }
  if (out.length > PERMISSION_LIMITS.instructions) {
    if (strict) throw new BotError("limit", `You can have at most ${PERMISSION_LIMITS.instructions} ${what.toLowerCase()}.`);
    return out.slice(0, PERMISSION_LIMITS.instructions);
  }
  return out;
}

function cleanScope(raw: unknown): ToolScopePolicy {
  const tools: Record<string, ToolPermission> = {};
  let reads: ToolPermission | undefined;
  let writes: ToolPermission | undefined;
  if (isRecord(raw)) {
    if (isRecord(raw.tools)) {
      for (const [name, permission] of Object.entries(raw.tools)) {
        if (FORBIDDEN_KEYS.has(name) || !name || name.length > PERMISSION_LIMITS.nameLength || !isPermission(permission)) continue;
        if (Object.keys(tools).length >= PERMISSION_LIMITS.toolsPerScope) break;
        tools[name] = permission;
      }
    }
    if (isPermission(raw.reads)) reads = raw.reads;
    if (isPermission(raw.writes)) writes = raw.writes;
  }
  return { tools, ...(reads ? { reads } : {}), ...(writes ? { writes } : {}) };
}

/** Read stored settings, dropping anything that does not fit rather than refusing to start. */
export function normalizePermissions(raw: unknown): BotPermissionSettings {
  const source = isRecord(raw) ? raw : {};
  const review = isRecord(source.autoReview) ? source.autoReview : {};
  const scopes: Record<string, ToolScopePolicy> = {};
  if (isRecord(source.scopes)) {
    for (const [scope, policy] of Object.entries(source.scopes)) {
      if (FORBIDDEN_KEYS.has(scope) || !scope || scope.length > PERMISSION_LIMITS.nameLength) continue;
      if (Object.keys(scopes).length >= PERMISSION_LIMITS.scopes) break;
      scopes[scope] = cleanScope(policy);
    }
  }
  return {
    autoReview: {
      enabled: review.enabled !== false,
      allowInstructions: cleanInstructions(review.allowInstructions, "Allow instructions", false),
      blockInstructions: cleanInstructions(review.blockInstructions, "Block instructions", false),
    },
    scopes,
  };
}

/** What a caller may change in one call. Every part is optional; `null` removes a permission. */
export interface PermissionSettingsPatch {
  autoReview?: Partial<AutoReviewSettings>;
  tool?: { scope: string; tool: string; permission: ToolPermission | null };
  defaults?: { scope: string; reads?: ToolPermission | null; writes?: ToolPermission | null };
}

function permissionOrNull(value: unknown, what: string): ToolPermission | null {
  if (value === null) return null;
  if (isPermission(value)) return value;
  throw new BotError("invalid", `${what} must be one of ${TOOL_PERMISSIONS.join(", ")}.`);
}

function withScope(settings: BotPermissionSettings, scope: string): ToolScopePolicy {
  const existing = Object.hasOwn(settings.scopes, scope) ? settings.scopes[scope]! : undefined;
  if (!existing && Object.keys(settings.scopes).length >= PERMISSION_LIMITS.scopes) {
    throw new BotError("limit", `You can have permissions for at most ${PERMISSION_LIMITS.scopes} tool groups.`);
  }
  return existing ?? { tools: {} };
}

function pruned(policy: ToolScopePolicy): ToolScopePolicy | null {
  return Object.keys(policy.tools).length === 0 && policy.reads === undefined && policy.writes === undefined ? null : policy;
}

/** Apply a patch from an untrusted caller, refusing anything malformed. Returns new settings; the input is not changed. */
export function updatePermissions(current: BotPermissionSettings, patchInput: unknown): BotPermissionSettings {
  if (!isRecord(patchInput)) throw new BotError("invalid", "The changes must be an object.");
  const next: BotPermissionSettings = {
    autoReview: { ...current.autoReview },
    scopes: { ...current.scopes },
  };

  if (patchInput.autoReview !== undefined) {
    if (!isRecord(patchInput.autoReview)) throw new BotError("invalid", "The auto review settings must be an object.");
    const patch = patchInput.autoReview;
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== "boolean") throw new BotError("invalid", "Auto review must be on or off.");
      next.autoReview.enabled = patch.enabled;
    }
    if (patch.allowInstructions !== undefined) next.autoReview.allowInstructions = cleanInstructions(patch.allowInstructions, "Allow instructions", true);
    if (patch.blockInstructions !== undefined) next.autoReview.blockInstructions = cleanInstructions(patch.blockInstructions, "Block instructions", true);
  }

  if (patchInput.tool !== undefined) {
    if (!isRecord(patchInput.tool)) throw new BotError("invalid", "The tool change must be an object.");
    const scope = cleanKey(patchInput.tool.scope, "The tool group");
    const tool = cleanKey(patchInput.tool.tool, "The tool name");
    const permission = permissionOrNull(patchInput.tool.permission, "The permission");
    const policy = withScope(next, scope);
    const tools = { ...policy.tools };
    if (permission === null) delete tools[tool];
    else {
      if (!Object.hasOwn(tools, tool) && Object.keys(tools).length >= PERMISSION_LIMITS.toolsPerScope) {
        throw new BotError("limit", `A tool group can have permissions for at most ${PERMISSION_LIMITS.toolsPerScope} tools.`);
      }
      tools[tool] = permission;
    }
    const updated = pruned({ ...policy, tools });
    if (updated) next.scopes[scope] = updated;
    else delete next.scopes[scope];
  }

  if (patchInput.defaults !== undefined) {
    if (!isRecord(patchInput.defaults)) throw new BotError("invalid", "The default change must be an object.");
    const scope = cleanKey(patchInput.defaults.scope, "The tool group");
    const policy: ToolScopePolicy = { ...withScope(next, scope) };
    for (const kind of ["reads", "writes"] as const) {
      if (patchInput.defaults[kind] === undefined) continue;
      const permission = permissionOrNull(patchInput.defaults[kind], `The ${kind} default`);
      if (permission === null) delete policy[kind];
      else policy[kind] = permission;
    }
    const updated = pruned(policy);
    if (updated) next.scopes[scope] = updated;
    else delete next.scopes[scope];
  }

  return next;
}

/** "Always allow" from an approval card: the tool's permission becomes `always_allow`. */
export function rememberAlwaysAllow(current: BotPermissionSettings, toolName: string): BotPermissionSettings {
  const { scope, tool } = splitToolName(toolName);
  return updatePermissions(current, { tool: { scope, tool, permission: "always_allow" } });
}

/** A tool's permission and whether a person set it (a tool entry or a scope default) or it is the built-in default. */
export function resolveToolPermission(
  settings: BotPermissionSettings,
  tool: { name: string; tier?: string },
): { permission: ToolPermission; explicit: boolean } {
  const { scope, tool: bare } = splitToolName(tool.name);
  const policy = Object.hasOwn(settings.scopes, scope) ? settings.scopes[scope] : undefined;
  const own = policy && Object.hasOwn(policy.tools, bare) ? policy.tools[bare] : undefined;
  if (own) return { permission: own, explicit: true };
  const read = isReadOnlyTool(tool);
  const fallback = read ? policy?.reads : policy?.writes;
  if (fallback) return { permission: fallback, explicit: true };
  return { permission: read ? "always_allow" : "needs_approval", explicit: false };
}

/** The permission a tool has: its own entry, else its scope's reads/writes default, else the built-in default. */
export function toolPermissionFor(settings: BotPermissionSettings, tool: { name: string; tier?: string }): ToolPermission {
  return resolveToolPermission(settings, tool).permission;
}

/**
 * What a Bot's rules ask for that a server cannot give. A server runs the agent without a person to ask and
 * without the app's reviewer, so the only thing it can honor is the mode: read-only, or everything. A Bot set to
 * run everything, with tools blocked or set to ask first, would run exactly those tools; that is refused, with
 * the way out. Returns null when nothing would be lost (read-only and Auto Review both run read-only there).
 */
export function serverRuleConflict(settings: BotPermissionSettings, mode: BotApprovalMode): string | null {
  if (mode !== "run_everything") return null;
  const holds = (permission: ToolPermission | undefined): boolean => permission !== undefined && permission !== "always_allow";
  const restricted =
    settings.autoReview.blockInstructions.length > 0 ||
    Object.values(settings.scopes).some(
      (scope) => holds(scope.reads) || holds(scope.writes) || Object.values(scope.tools).some((permission) => holds(permission)),
    );
  if (!restricted) return null;
  return "This Bot has tools blocked or set to ask first, and a server cannot ask anyone or hold back one tool at a time. Set the Bot to Read only, or clear those rules, to run it on a server.";
}
