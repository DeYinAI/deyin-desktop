/**
 * What "1:1 with Grok Bot" is checked against.
 *
 * Three tables, all verified by `bot-parity.test.ts` and rendered into `docs/PARITY-GROK-BOT.md`:
 *
 *  - `ENUMS`: recovered enums Deyin relies on, with the Deyin constant they map to. Every recovered value must be
 *    accounted for, either as the same word or as a stated difference.
 *  - `SHAPES`: recovered message shapes, field by field. Every recovered field is either a field of the Deyin type
 *    (a key the compiler checks) or a stated gap. A field Grok Bot has that nobody classified fails the test.
 *  - `SURFACES`: the product surfaces, each Done / Foundation / Not built / Deliberately different, with the files
 *    that carry it (the test fails if one of them is gone).
 *
 * Nothing here copies Grok Bot source, copy or assets: it records interface names and our answer to each.
 */
import {
  BOT_APPROVAL_MODES,
  BOT_HARNESSES,
  BOT_KINDS,
  BOT_VISIBILITIES,
  type DeyinBot,
} from "../../src/bots/types.js";
import { TOOL_PERMISSIONS } from "../../src/bots/permissions.js";
import { VAULT_KINDS, type VaultCard, type VaultContact, type VaultLogin } from "../../src/bots/vault.js";
import { SKILL_AUTHORS, type BotSkill, type SkillRevision } from "../../src/bots/skills.js";
import { FILE_SCOPES } from "../../src/bots/panel-view.js";
import type { RuntimeFileEntry } from "../../src/bots/runtime.js";

/* Enums ----------------------------------------------------------------------------- */

export interface EnumParity {
  /** The recovered enum name in `proto-enums.json`. */
  recovered: string;
  /** Deyin's constant, as an array of its values. */
  ours: readonly string[];
  /** Where the recovered name differs from ours: recovered value -> our value. Every other value is lower-cased as is. */
  rename?: Readonly<Record<string, string>>;
  /** Recovered values Deyin does not have, each with why. */
  absent?: Readonly<Record<string, string>>;
  /** A difference that is deliberate rather than a gap. */
  note?: string;
}

export const ENUMS: readonly EnumParity[] = [
  { recovered: "GrokBotApprovalMode", ours: BOT_APPROVAL_MODES },
  { recovered: "GrokBotToolPermission", ours: TOOL_PERMISSIONS },
  { recovered: "GrokBotVaultItemKind", ours: VAULT_KINDS },
  { recovered: "GrokBotAgentKind", ours: BOT_KINDS },
  { recovered: "GrokBotSkillRevisionAuthor", ours: SKILL_AUTHORS },
  {
    recovered: "GrokBotAgentVisibility",
    ours: BOT_VISIBILITIES,
    note: "Both values exist so Bots exported from Grok Bot keep their meaning, but Deyin has no teams: `team` is refused when set.",
  },
  {
    recovered: "GrokBotAgentHarnessKind",
    ours: BOT_HARNESSES,
    rename: { BOX: "local", TEMPORAL: "server" },
    note: "Deliberately different. Grok Bot's two harnesses are two of its own clouds; Deyin's two are this computer and a server the person owns. The two-valued choice on the Bot is the same.",
  },
  {
    recovered: "GrokBotAgentFileStore",
    ours: FILE_SCOPES,
    rename: { USER: "library" },
    note: "A Bot's own folder, and a library on this computer that every Bot can be given files from.",
  },
];

/* Shapes ---------------------------------------------------------------------------- */

export type Gap = { gap: "not-built" | "different"; why: string };
export type FieldAnswer<T> = { ours: keyof T & string } | Gap;
export type ShapeAnswer<T> = Readonly<Record<string, FieldAnswer<T>>>;

export interface ShapeParity<T = unknown> {
  recovered: string;
  /** What Deyin calls its counterpart. */
  oursName: string;
  /** Every field of the recovered message, by its snake_case name, answered. */
  fields: ShapeAnswer<T>;
  /** Fields of the Deyin type that the recovered message has no counterpart for. */
  additions: readonly (keyof T & string)[];
  /** Every key of the Deyin type, so a field added to it must be placed in `fields` or `additions` (the compiler checks the list is complete). */
  allKeys: Readonly<Record<keyof T & string, true>>;
}

const noTeams: Gap = { gap: "not-built", why: "Deyin has no teams." };
const noVoice: Gap = { gap: "not-built", why: "No voice calls or spoken replies." };
const notShared: Gap = { gap: "not-built", why: "A Bot is shared by a template link; there is no public listing or access list." };

const botShape: ShapeParity<DeyinBot> = {
  recovered: "GrokBotAgent",
  oursName: "DeyinBot",
  fields: {
    id: { ours: "id" },
    legacy_agent_id: { ours: "legacyBotId" },
    name: { ours: "name" },
    description: { ours: "description" },
    title: { ours: "title" },
    avatar_shape: { ours: "avatarShape" },
    avatar_color: { ours: "avatarColor" },
    avatar_version: { ours: "avatarVersion" },
    avatar_url: { ours: "avatarUrl" },
    created_at_ms: { ours: "createdAt" },
    updated_at_ms: { ours: "updatedAt" },
    agent_id: { gap: "different", why: "One id; Grok Bot keeps a second for its transcript service." },
    harness: { ours: "harness" },
    role: { ours: "role" },
    visibility: { ours: "visibility" },
    team_id: noTeams,
    viewer_is_owner: { gap: "different", why: "There is one person, so every Bot is theirs." },
    viewer_session_id: { gap: "different", why: "Conversations are Deyin threads, found by the Bot's id." },
    kind: { ours: "kind" },
    member_agent_ids: { ours: "memberBotIds" },
    owner_display_name: noTeams,
    people: { gap: "not-built", why: "A room holds Bots, not other people." },
    published_at: notShared,
    team_default_for_viewer: noTeams,
    voice_id: noVoice,
    voice_speed: noVoice,
    voice_language: noVoice,
    viewer_can_manage: { gap: "different", why: "There is one person, so they can manage every Bot." },
    drafting_disabled: { gap: "not-built", why: "Drafts in public (X) always wait for the person; there is no switch to drop that." },
    routine_policy: { ours: "routinePolicy" },
    viewer_access: notShared,
    access_grants_only: notShared,
    viewer_allowed_actions: notShared,
    suggestions: { gap: "not-built", why: "No suggestion chips on the Bot home." },
    access_owner_only: notShared,
    shared_with_others: notShared,
    auto_review: { ours: "autoReview" },
    public_description: { ours: "publicDescription" },
    purpose: { ours: "purpose" },
    origin: { gap: "not-built", why: "Where a Bot came from is kept as `legacyBotId` for imports only." },
  },
  additions: ["handle", "hostId", "isPrimary", "archived"],
  allKeys: {
    id: true,
    legacyBotId: true,
    name: true,
    handle: true,
    description: true,
    title: true,
    avatarShape: true,
    avatarColor: true,
    avatarUrl: true,
    avatarVersion: true,
    createdAt: true,
    updatedAt: true,
    harness: true,
    hostId: true,
    role: true,
    visibility: true,
    kind: true,
    memberBotIds: true,
    purpose: true,
    publicDescription: true,
    autoReview: true,
    routinePolicy: true,
    isPrimary: true,
    archived: true,
  },
};

const loginShape: ShapeParity<VaultLogin> = {
  recovered: "GrokBotVaultCredential",
  oursName: "VaultLogin / VaultCard / VaultContact",
  fields: {
    id: { ours: "id" },
    title: { ours: "title" },
    username: { ours: "username" },
    notes: { ours: "notes" },
    sites: { ours: "sites" },
    created_at_ms: { ours: "createdAt" },
    updated_at_ms: { ours: "updatedAt" },
    card: { gap: "different", why: "A card is an item of its own (`kind: card`), not a login with a card inside." },
    kind: { ours: "kind" },
    contact: { gap: "different", why: "A contact is an item of its own (`kind: contact`)." },
    managed_by: { gap: "not-built", why: "No items managed by a Bot's own mailbox." },
  },
  additions: ["hasPassword"],
  allKeys: { id: true, title: true, notes: true, createdAt: true, updatedAt: true, kind: true, username: true, sites: true, hasPassword: true },
};

const cardShape: ShapeParity<VaultCard> = {
  recovered: "GrokBotVaultCard",
  oursName: "VaultCard",
  fields: {
    brand: { ours: "brand" },
    last4: { ours: "last4" },
    exp_month: { ours: "expMonth" },
    exp_year: { ours: "expYear" },
    holder_name: { ours: "holderName" },
    billing_address: { ours: "billingAddress" },
    billing_address_id: { gap: "different", why: "The billing address is kept inside the card, not as a reference to another item." },
    nickname: { gap: "different", why: "The item's title is the nickname." },
  },
  additions: ["id", "title", "notes", "createdAt", "updatedAt", "kind", "hasSecurityCode"],
  allKeys: {
    id: true,
    title: true,
    notes: true,
    createdAt: true,
    updatedAt: true,
    kind: true,
    brand: true,
    last4: true,
    expMonth: true,
    expYear: true,
    holderName: true,
    billingAddress: true,
    hasSecurityCode: true,
  },
};

const contactShape: ShapeParity<VaultContact> = {
  recovered: "GrokBotVaultContact",
  oursName: "VaultContact",
  fields: {
    address: { ours: "address" },
    default_shipping: { ours: "defaultShipping" },
    email: { ours: "email" },
    more: { gap: "different", why: "Extra emails and phone numbers are plain lists on the contact (`emails`, `phones`)." },
  },
  additions: ["id", "title", "notes", "createdAt", "updatedAt", "kind", "emails", "phones"],
  allKeys: { id: true, title: true, notes: true, createdAt: true, updatedAt: true, kind: true, address: true, defaultShipping: true, email: true, emails: true, phones: true },
};

const skillShape: ShapeParity<BotSkill> = {
  recovered: "GrokBotAgentSkill",
  oursName: "BotSkill",
  fields: {
    id: { gap: "different", why: "A skill is found by its name, which is unique within a Bot." },
    name: { ours: "name" },
    description: { ours: "description" },
    body: { ours: "body" },
    source: { ours: "origin" },
  },
  additions: ["version", "updatedAt", "bytes"],
  allKeys: { name: true, description: true, origin: true, version: true, updatedAt: true, bytes: true, body: true },
};

const revisionShape: ShapeParity<SkillRevision> = {
  recovered: "GrokBotSkillRevision",
  oursName: "SkillRevision",
  fields: {
    id: { ours: "id" },
    skill: { ours: "skill" },
    at_ms: { ours: "atMs" },
    author: { ours: "author" },
    content: { ours: "content" },
    description: { ours: "description" },
    result_version: { ours: "resultVersion" },
    created: { ours: "created" },
    rolled_back: { ours: "rolledBack" },
  },
  additions: [],
  allKeys: { id: true, skill: true, atMs: true, author: true, content: true, description: true, resultVersion: true, created: true, rolledBack: true },
};

const fileShape: ShapeParity<RuntimeFileEntry> = {
  recovered: "GrokBotAgentFile",
  oursName: "RuntimeFileEntry",
  fields: {
    name: { ours: "name" },
    path: { ours: "path" },
    size_bytes: { ours: "size" },
    content_type: { gap: "different", why: "Files are text; the kind is `file` or `directory`, and the type follows the name." },
    updated_at_ms: { ours: "modifiedAt" },
    etag: { gap: "not-built", why: "Writes replace the file whole; there is no conditional write." },
  },
  additions: ["kind"],
  allKeys: { name: true, path: true, kind: true, size: true, modifiedAt: true },
};

export const SHAPES: readonly ShapeParity<never>[] = [botShape, loginShape, cardShape, contactShape, skillShape, revisionShape, fileShape] as unknown as readonly ShapeParity<never>[];

/* Product surfaces ------------------------------------------------------------------ */

export type SurfaceStatus = "done" | "foundation" | "not-built" | "different";

export interface SurfaceRow {
  surface: string;
  status: SurfaceStatus;
  /** Repository paths that carry it. Every one must exist. Empty only for a surface that is not built. */
  evidence: readonly string[];
  note: string;
}

const BOTS = "packages/host-core/src/bots";
const MAIN = "apps/desktop/src/main/bots";
const UI = "packages/ui/client/src/bots";

export const SURFACES: readonly SurfaceRow[] = [
  { surface: "Product switcher: Deyin Code / Deyin Bot / Deyin Conductor, each with its own shell", status: "done", evidence: ["packages/ui/client/src/products.ts", "packages/ui/client/src/components/ProductSwitcher.tsx"], note: "Conductor's internal `bot` ids were renamed to `conductor`, with a migration for saved data." },
  { surface: "Bot entity, roster, detail page, create / edit / archive", status: "done", evidence: [`${BOTS}/types.ts`, `${BOTS}/store.ts`, `${UI}/BotHome.tsx`, `${UI}/BotRosterList.tsx`, `${UI}/BotDetailView.tsx`, `${UI}/BotCreateDialog.tsx`], note: "`isPrimary`, `handle`, `hostId` and `archived` are Deyin additions." },
  { surface: "Memory kept apart per Bot", status: "done", evidence: [`${BOTS}/memory.ts`, `${UI}/BotMemoryList.tsx`], note: "" },
  { surface: "Rooms (several Bots in one conversation)", status: "done", evidence: [`${BOTS}/room.ts`, `${BOTS}/store.ts`, `${MAIN}/room-run.ts`, `${MAIN}/run.ts`, `${UI}/botRoom.ts`, `${UI}/BotRoomDialog.tsx`, `${UI}/BotRoomMembers.tsx`, `${UI}/BotChatHeader.tsx`], note: "A room is two to eight Bots and a host that is told who they are. The host asks a Bot with the task tool when its @handle is written, and each Bot answers as itself, with its own persona, memory and skills. Members share the room's folder and permissions. A room always runs on this computer, and has no routines or connections of its own. Other people cannot be added: Deyin has one person." },
  { surface: "Avatars", status: "different", evidence: [`${BOTS}/avatar.ts`, `${BOTS}/avatar-image.ts`, `${UI}/BotAvatarPicker.tsx`, `${UI}/BotAvatarMaker.tsx`], note: "Deyin draws its own: ten forms and its own colors. No shape name, color id, label or value is shared with Grok Bot (a test fails if one is). A picture can also be uploaded, or made from a description with one of the person\'s own image models (the \"Generate\" tab); it is shown first and becomes the avatar only when the person uses it and saves." },
  { surface: "Routines (schedule, once, manual) over the existing automations", status: "done", evidence: [`${BOTS}/routines.ts`, `${UI}/BotRoutines.tsx`], note: "Event and webhook triggers arrive through Connections, which start a routine." },
  { surface: "Auto Review: three layers, read-only mode, run-everything mode", status: "done", evidence: [`${BOTS}/review.ts`, `${BOTS}/permissions.ts`, `${BOTS}/permissions-store.ts`, `${MAIN}/review-classifier.ts`, `${MAIN}/run-guard.ts`, `${UI}/BotPermissions.tsx`], note: "" },
  { surface: "Approval cards: Allow once / Always allow / Deny", status: "done", evidence: [`${MAIN}/permissions-handlers.ts`, `${MAIN}/tool-guard.ts`], note: "Uses Deyin's existing permission card." },
  { surface: "Vault: logins, cards, contacts, filled without the Bot seeing the secret", status: "done", evidence: [`${BOTS}/vault.ts`, `${BOTS}/vault-store.ts`, `${BOTS}/vault-sites.ts`, `${MAIN}/vault-tools.ts`, `${MAIN}/vault-redaction.ts`, `${UI}/VaultPanel.tsx`], note: "Secrets are encrypted by the operating system where it can; where it cannot, the page says they are only protected by file permissions." },
  { surface: "Secure Form and Take over", status: "done", evidence: [`${BOTS}/secure-form.ts`, `${MAIN}/secure-form-broker.ts`, `${MAIN}/takeover.ts`, `${UI}/SecureFormDialog.tsx`], note: "" },
  { surface: "Vault: 1Password as the place a login is looked for after the Vault", status: "foundation", evidence: [`${BOTS}/onepassword.ts`, `${MAIN}/onepassword.ts`, `${MAIN}/onepassword-tools.ts`, `${UI}/VaultPanel.tsx`], note: "Uses 1Password's own `op` command, so nothing of the person's 1Password is copied; it is off until switched on in the Vault page. The person is asked every time, there is no \"always allow\", and a routine never uses it. Tested against a stand-in `op` program, not a real 1Password account." },
  { surface: "A shared computer for a Bot, on this computer", status: "done", evidence: [`${BOTS}/runtime.ts`, `${BOTS}/runtime-fs.ts`], note: "" },
  { surface: "A shared computer on a server the person owns (`deyin-bot-engine`, installed over SSH)", status: "foundation", evidence: ["packages/bot-engine/src/engine.ts", `${MAIN}/engine/installer.ts`, `${MAIN}/engine/runtimes.ts`, `${UI}/ServersPanel.tsx`, `${UI}/BotPlacement.tsx`], note: "Deliberately different from Grok Bot's cloud computer. Tested against a real engine and a loopback SSH server, not a real remote host; the installer needs a `deyin` release that includes `bot-engine`. A server Bot has no browser or screen, so the Vault's fill tools and Take over do not apply to it." },
  { surface: "Skills with history and Put back", status: "done", evidence: [`${BOTS}/skills.ts`, `${BOTS}/skills-store.ts`, `${UI}/BotSkills.tsx`], note: "" },
  { surface: "Teach a task by showing it", status: "done", evidence: [`${BOTS}/teach.ts`, `${MAIN}/teach-capture.ts`, `${UI}/BotTeach.tsx`], note: "In-app browser only; not Chrome tabs or the computer-use screen." },
  { surface: "Files: a Bot's folder and a user library", status: "done", evidence: [`${MAIN}/files-handlers.ts`, `${UI}/BotFiles.tsx`], note: "Text files up to 2 MB." },
  { surface: "Templates, share link, import", status: "done", evidence: [`${BOTS}/template.ts`, `${UI}/BotShare.tsx`, `${UI}/BotImportDialog.tsx`, "apps/desktop/src/main/deep-link.ts"], note: "A template carries identity, words and skills, and routines only when chosen; never memory, files, Vault or permissions. A shared link never imports by itself." },
  { surface: "Marketplace: browse and for you", status: "different", evidence: [`${BOTS}/catalog.ts`, `${UI}/BotMarketplace.tsx`], note: "Six starters that ship with the app. There are no accounts, public listings or creators." },
  { surface: "Webhook into a routine", status: "done", evidence: [`${BOTS}/surfaces.ts`, `${MAIN}/surface-hub.ts`, `${UI}/BotConnections.tsx`], note: "Checked over a real connection on this computer. For a service outside it to call, the person gives it an https address from their own tunnel or proxy." },
  { surface: "Email into a routine", status: "foundation", evidence: [`${BOTS}/surface-email.ts`, `${MAIN}/surface-hub.ts`], note: "Reads a signed JSON post (plain or Postmark's shape) sent by a mail service or forwarder the person sets up; the sender is only as trustworthy as the allow list. There is no hosted address, and no mail goes out." },
  { surface: "Slack: direct messages and threads", status: "foundation", evidence: [`${BOTS}/surface-slack.ts`, `${MAIN}/surface-hub.ts`], note: "Events API with Slack's documented signature and shapes, not run against a real workspace." },
  { surface: "Microsoft Teams: direct messages and chats", status: "foundation", evidence: [`${BOTS}/surface-teams.ts`, `${MAIN}/surface-hub.ts`], note: "Bot Framework token checks and reply shape as documented, not run against a real tenant." },
  { surface: "@mentions of the Bot's X account, with every public reply approved by the person", status: "foundation", evidence: [`${BOTS}/surface-x.ts`, `${BOTS}/surface-store.ts`, `${MAIN}/surface-x-poller.ts`, `${MAIN}/surface-handlers.ts`, `${UI}/SurfaceOutbox.tsx`], note: "Polled every two minutes rather than pushed. Nothing is posted until a person approves that exact text; not run against the real X API." },
  { surface: "A mailbox of the Bot's own: address, search, send", status: "not-built", evidence: [], note: "Needs a domain and a mail provider." },
  { surface: "Texting, iMessage and phone-number linking", status: "not-built", evidence: [], note: "Needs a messaging line." },
  { surface: "Voice calls and meetings the Bot joins from a calendar", status: "not-built", evidence: [], note: "Needs a phone line and a calendar integration." },
  { surface: "Shopping, travel, cart, virtual cards and payments", status: "not-built", evidence: [], note: "Money movement is not shipped untested." },
  { surface: "First-party connectors (Gmail, Calendar, Drive)", status: "different", evidence: [], note: "Deyin's own MCP servers and plugins serve this; nothing was added for Bots." },
  { surface: "Teams, groups, admin controls, transfers and account migration", status: "not-built", evidence: [], note: "Deyin has no teams; `team` visibility is refused rather than faked." },
  { surface: "Usage breakdown, analytics, changelog and onboarding programs", status: "not-built", evidence: [], note: "Operator tooling for a hosted service." },
  { surface: "Mobile clients", status: "not-built", evidence: [], note: "There is no mobile codebase to extend." },
];
