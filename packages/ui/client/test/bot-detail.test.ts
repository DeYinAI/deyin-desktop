import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BOT_LIMITS, defaultBotAvatar, missingTranslations, type BotMemoryFactView, type DeyinBot } from "@deyin/host-core/shared";
import { ConfirmDialogProvider } from "../src/components/ConfirmDialog.js";
import { BotDetailView } from "../src/bots/BotDetailView.js";
import type { SurfacesApi } from "../src/bots/botSurfaces.js";
import { BotMemoryPanel, type MemoryState } from "../src/bots/BotMemoryList.js";
import { createBotsClient } from "../src/bots/botsClient.js";
import type { FilesApi } from "../src/bots/botFiles.js";
import type { SkillsApi } from "../src/bots/botSkills.js";
import type { TeachApi } from "../src/bots/botTeach.js";
import type { TemplatesApi } from "../src/bots/botTemplates.js";

const { actions } = createBotsClient(undefined);
const noop = () => undefined;

function bot(over: Partial<DeyinBot> = {}): DeyinBot {
  const avatar = defaultBotAvatar("ada");
  return {
    id: "ada",
    name: "Ada",
    handle: "ada",
    description: "Reads papers",
    title: "Research assistant",
    avatarShape: avatar.shape,
    avatarColor: avatar.color,
    avatarVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    harness: "local",
    role: "analyst",
    purpose: "Summarise new papers.",
    visibility: "owner",
    kind: "agent",
    memberBotIds: [],
    autoReview: { approvalMode: "auto_review" },
    isPrimary: false,
    archived: false,
    ...over,
  };
}

function detail(b: DeyinBot | null): string {
  return renderToStaticMarkup(createElement(ConfirmDialogProvider, null, createElement(BotDetailView, { bot: b, actions, onBack: noop, onDeleted: noop })));
}

test("a Bot that no longer exists says so and still offers the way back", () => {
  const html = detail(null);
  assert.match(html, /This Bot no longer exists\./);
  assert.match(html, /Back to chat/);
  assert.doesNotMatch(html, /<form/);
});

test("the form shows the Bot's saved values", () => {
  const html = detail(bot());
  assert.match(html, /id="bot-detail-name"[^>]*value="Ada"/);
  assert.match(html, /id="bot-detail-label"[^>]*value="Research assistant"/);
  assert.match(html, /id="bot-detail-role"[^>]*value="analyst"/);
  assert.match(html, /<textarea id="bot-detail-description"[^>]*>Reads papers<\/textarea>/);
  assert.match(html, /<textarea id="bot-detail-purpose"[^>]*>Summarise new papers\.<\/textarea>/);
});

test("the handle is shown with its @ and cannot be edited", () => {
  const html = detail(bot());
  const input = html.match(/<input id="bot-detail-handle"[^>]*>/)?.[0] ?? "";
  assert.match(input, /value="@ada"/);
  assert.match(input, /readonly=""/);
  assert.match(html, /Used to mention this Bot as @handle\./);
});

test("field length limits come from the host's limits", () => {
  const html = detail(bot());
  assert.match(html, new RegExp(`id="bot-detail-name"[^>]*maxLength="${BOT_LIMITS.name}"`));
  assert.match(html, new RegExp(`id="bot-detail-label"[^>]*maxLength="${BOT_LIMITS.title}"`));
  assert.match(html, new RegExp(`id="bot-detail-role"[^>]*maxLength="${BOT_LIMITS.role}"`));
  assert.match(html, new RegExp(`id="bot-detail-description"[^>]*maxLength="${BOT_LIMITS.description}"`));
  assert.match(html, new RegExp(`id="bot-detail-purpose"[^>]*maxLength="${BOT_LIMITS.purpose}"`));
});

test("every field is labelled and the standing instructions carry their hint", () => {
  const html = detail(bot());
  for (const id of ["name", "label", "handle", "role", "description", "purpose"]) assert.match(html, new RegExp(`<label[^>]*for="bot-detail-${id}"`), id);
  assert.match(html, /aria-describedby="bot-detail-purpose-hint"/);
  assert.match(html, /id="bot-detail-purpose-hint"[^>]*>What this Bot is for\./);
});

test("saving is off until something changes", () => {
  assert.match(detail(bot()), /<button type="submit"[^>]*disabled=""[^>]*>Save changes</);
});

test("the upload input accepts PNG, JPEG and WebP and never SVG", () => {
  const accept = detail(bot()).match(/<input[^>]*type="file"[^>]*accept="([^"]*)"/)?.[1];
  assert.equal(accept, "image/png,image/jpeg,image/webp");
});

test("'Use shape instead' only appears when a picture is set", () => {
  assert.doesNotMatch(detail(bot()), /Use shape instead/);
  assert.match(detail(bot({ avatarUrl: "data:image/png;base64,AAAA" })), /Use shape instead/);
});

test("an active, non-primary Bot can be made primary, archived or deleted", () => {
  const html = detail(bot());
  assert.match(html, />Make primary</);
  assert.match(html, />Archive</);
  assert.doesNotMatch(html, />Restore</);
  assert.match(html, /btn--danger"[^>]*>Delete Bot</);
});

test("the primary Bot is not offered 'Make primary' again", () => {
  assert.doesNotMatch(detail(bot({ isPrimary: true })), />Make primary</);
});

test("an archived Bot says so, offers Restore instead of Archive, and cannot be made primary", () => {
  const html = detail(bot({ archived: true }));
  assert.match(html, /This Bot is archived\. Restore it to chat with it\./);
  assert.match(html, />Restore</);
  assert.doesNotMatch(html, />Archive</);
  assert.doesNotMatch(html, />Make primary</);
});

test("the page carries the memory section and the manage section", () => {
  const html = detail(bot());
  assert.match(html, /aria-label="Memory"/);
  assert.match(html, /aria-label="Manage"/);
  assert.match(html, /An archived Bot keeps its memory and conversations but cannot chat\./);
});

test("a Bot's text is escaped in the form", () => {
  const html = detail(bot({ name: '"><script>alert(1)</script>', description: "</textarea><script>x</script>" }));
  assert.doesNotMatch(html, /<script>/);
});

// ---- memory panel ----

function fact(over: Partial<BotMemoryFactView> = {}): BotMemoryFactView {
  return { id: "f1", name: "tone", title: "Tone", description: "Prefers short answers", type: "feedback", shared: false, revision: 1, updatedAt: "2026-01-01T00:00:00.000Z", body: "", ...over };
}

function panel(state: MemoryState, notice: string | null = null): string {
  return renderToStaticMarkup(createElement(BotMemoryPanel, { state, notice, onToggleShare: noop, onForget: noop }));
}

test("memory loading is announced as loading, not as empty", () => {
  const html = panel({ status: "loading" });
  assert.match(html, /Loading memory…/);
  assert.doesNotMatch(html, /Nothing remembered yet/);
});

test("a memory load failure shows the reason in an alert and not an empty list", () => {
  const html = panel({ status: "error", error: "disk full" });
  assert.match(html, /role="alert"[^>]*>Could not load this Bot&#x27;s memory\. disk full</);
  assert.doesNotMatch(html, /Nothing remembered yet/);
});

test("no facts says nothing is remembered yet", () => {
  assert.match(panel({ status: "ready", facts: [] }), /Nothing remembered yet\./);
});

test("a private fact shows its title, type, privacy, description and both actions", () => {
  const html = panel({ status: "ready", facts: [fact()] });
  assert.match(html, /bot-memory__title">Tone</);
  assert.match(html, />Feedback</);
  assert.match(html, />Private</);
  assert.match(html, /Prefers short answers/);
  assert.match(html, />Share with all Bots</);
  assert.match(html, />Forget</);
});

test("a shared fact is marked shared and offers 'Make private'", () => {
  const html = panel({ status: "ready", facts: [fact({ shared: true })] });
  assert.match(html, /bot-memory__badge bot-memory__badge--shared">Shared with all Bots</);
  assert.match(html, />Make private</);
  assert.doesNotMatch(html, />Share with all Bots<\/button>/);
});

test("a fact with no title falls back to its name", () => {
  assert.match(panel({ status: "ready", facts: [fact({ title: "", name: "tone-note" })] }), /bot-memory__title">tone-note</);
});

test("each fact type has its own label", () => {
  const html = panel({ status: "ready", facts: (["user", "feedback", "project", "reference"] as const).map((type) => fact({ id: type, type })) });
  for (const label of ["About you", "Feedback", "Project", "Reference"]) assert.match(html, new RegExp(`>${label}<`), label);
});

test("a refusal from a memory change is announced", () => {
  assert.match(panel({ status: "ready", facts: [fact()] }, "That memory is gone."), /role="alert"[^>]*>That memory is gone\./);
});

test("fact text is escaped", () => {
  const html = panel({ status: "ready", facts: [fact({ title: "<img src=x onerror=1>", description: "<b>hi</b>" })] });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<b>hi/);
});

test("the Routines section appears between memory and manage when automations are available, and is absent otherwise", () => {
  const routines = { api: {} as never, defaults: { model: "m", providerId: "openference" } };
  const withRoutines = renderToStaticMarkup(
    createElement(ConfirmDialogProvider, null, createElement(BotDetailView, { bot: bot(), actions, routines, onBack: noop, onDeleted: noop })),
  );
  assert.match(withRoutines, /aria-label="Routines"/);
  assert.ok(withRoutines.indexOf('aria-label="Routines"') > withRoutines.indexOf("bot-memory"));
  assert.ok(withRoutines.indexOf('aria-label="Routines"') < withRoutines.indexOf("bot-detail__manage"));
  assert.doesNotMatch(detail(bot()), /aria-label="Routines"/);
});

test("the Vault section is there only where there is a Vault to open", () => {
  const withVault = (onOpenVault?: () => void): string =>
    renderToStaticMarkup(createElement(ConfirmDialogProvider, null, createElement(BotDetailView, { bot: bot(), actions, onOpenVault, onBack: noop, onDeleted: noop })));
  assert.doesNotMatch(detail(bot()), /Open the Vault/);
  const html = withVault(noop);
  assert.match(html, /<section class="bot-vault-link" aria-label="Vault">/);
  assert.match(html, /A Bot never sees them\./);
  assert.match(html, /<button type="button" class="btn btn--outline">Open the Vault<\/button>/);
});

test("the Vault section has text in every language", () => {
  for (const locale of ["zh", "de"] as const) {
    assert.deepEqual(missingTranslations(locale).filter((key) => key.startsWith("bot.detail.") && /vault/i.test(key)), [], locale);
  }
});

/** A host that fails the test if rendering reaches for it: a page must not call out while it is drawn. */
function untouchedHost<T extends object>(): T {
  return new Proxy({} as T, {
    get(_target, property) {
      throw new Error(`rendering called the host: ${String(property)}`);
    },
  });
}

function detailWith(b: DeyinBot, extra: { skills?: { api: SkillsApi; teach?: TeachApi }; files?: FilesApi; templates?: TemplatesApi }): string {
  return renderToStaticMarkup(createElement(ConfirmDialogProvider, null, createElement(BotDetailView, { bot: b, actions, onBack: noop, onDeleted: noop, ...extra })));
}

test("a Bot's page shows skills, files and sharing when the host has them, and none of them when it does not", () => {
  const without = detail(bot());
  for (const heading of ["Skills", "Files", "Share this Bot"]) assert.doesNotMatch(without, new RegExp(`<h3[^>]*>${heading}</h3>`));
  const withAll = detailWith(bot(), { skills: { api: untouchedHost<SkillsApi>(), teach: untouchedHost<TeachApi>() }, files: untouchedHost<FilesApi>(), templates: untouchedHost<TemplatesApi>() });
  for (const heading of ["Skills", "Files", "Share this Bot"]) assert.match(withAll, new RegExp(`<h3[^>]*>${heading}</h3>`));
  assert.match(withAll, /Teach by showing/);
  const noTeach = detailWith(bot(), { skills: { api: untouchedHost<SkillsApi>() } });
  assert.match(noTeach, /<h3[^>]*>Skills<\/h3>/);
  assert.doesNotMatch(noTeach, /Teach by showing/, "without a browser to watch there is nothing to teach in");
});

test("a room has no skills or sharing of its own, but has a folder for its Bots' work", () => {
  const html = detailWith(bot({ kind: "room" }), { skills: { api: untouchedHost<SkillsApi>() }, files: untouchedHost<FilesApi>(), templates: untouchedHost<TemplatesApi>() });
  for (const heading of ["Skills", "Share this Bot"]) assert.doesNotMatch(html, new RegExp(`<h3[^>]*>${heading}</h3>`));
  assert.match(html, /<h3[^>]*>Files<\/h3>/);
});

test("the Connections section sits after Routines, and only where there is a host for it and routines to hand messages to", () => {
  const routines = { api: untouchedHost<never>(), defaults: { model: "m", providerId: "openference" } };
  const connections = untouchedHost<SurfacesApi>();
  const render = (b: DeyinBot, extra: { routines?: typeof routines; connections?: SurfacesApi }): string =>
    renderToStaticMarkup(createElement(ConfirmDialogProvider, null, createElement(BotDetailView, { bot: b, actions, onBack: noop, onDeleted: noop, ...extra })));
  const both = render(bot(), { routines, connections });
  assert.match(both, /aria-label="Connections"/);
  assert.match(both, /Loading connections…/);
  assert.ok(both.indexOf('aria-label="Connections"') > both.indexOf('aria-label="Routines"'));
  assert.ok(both.indexOf('aria-label="Connections"') < both.indexOf("bot-detail__manage"));
  assert.doesNotMatch(render(bot(), { routines }), /aria-label="Connections"/);
  assert.doesNotMatch(render(bot(), { connections }), /aria-label="Connections"/);
  assert.doesNotMatch(render(bot({ kind: "room" }), { routines, connections }), /aria-label="Connections"/);
});
