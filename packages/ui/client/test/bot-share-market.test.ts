import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CATALOG_CATEGORIES, defaultBotAvatar, missingTranslations, type CatalogCard, type DeyinBot, type ExportedTemplate, type ImportedBot, type TemplateSummary } from "@deyin/host-core/shared";
import { BotImportView, type ImportStep } from "../src/bots/BotImportDialog.js";
import { BotMarketplacePanel, type MarketState } from "../src/bots/BotMarketplace.js";
import { BotSharePanel } from "../src/bots/BotShare.js";
import {
  CATEGORY_FILTERS,
  categoryArg,
  categoryKey,
  comesWithLine,
  getKey,
  importBlocked,
  importedLines,
  pastedProblem,
  summaryCounts,
} from "../src/bots/botTemplates.js";

const noop = () => undefined;
const MODEL = { model: "m", providerId: "openference" };
const NO_MODEL = { model: "", providerId: "" };

function bot(over: Partial<DeyinBot> = {}): DeyinBot {
  const avatar = defaultBotAvatar("ada");
  return {
    id: "ada",
    name: "Ada",
    handle: "ada",
    description: "",
    title: "",
    avatarShape: avatar.shape,
    avatarColor: avatar.color,
    avatarVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    harness: "local",
    role: "analyst",
    purpose: "",
    visibility: "owner",
    kind: "agent",
    memberBotIds: [],
    autoReview: { approvalMode: "auto_review" },
    isPrimary: false,
    archived: false,
    ...over,
  };
}

function summary(over: Partial<TemplateSummary> = {}): TemplateSummary {
  return { name: "Ada", title: "Research assistant", description: "Reads papers", skills: [], routines: [], ...over };
}

function card(over: Partial<CatalogCard> = {}): CatalogCard {
  return { id: "researcher", name: "Researcher", title: "Finds sources", blurb: "Reads the web and reports back.", category: "research", tags: [], skills: 2, routines: 1, have: false, ...over };
}

function imported(over: Partial<ImportedBot> = {}): ImportedBot {
  return { bot: bot({ name: "Ada Copy" }), skills: 0, routines: 0, warnings: [], ...over };
}

test("pasting nothing is a problem; anything else can be looked at", () => {
  assert.equal(pastedProblem(""), "bot.share.problem.empty");
  assert.equal(pastedProblem(" \n\t"), "bot.share.problem.empty");
  assert.equal(pastedProblem("deyin://bot/import?t=abc"), null);
});

test("a Bot with routines needs a model to run them on; one without does not", () => {
  assert.equal(importBlocked(0, NO_MODEL), null);
  assert.equal(importBlocked(1, MODEL), null);
  assert.equal(importBlocked(1, NO_MODEL), "bot.share.problem.noModel");
  assert.equal(importBlocked(2, { model: "m", providerId: "" }), "bot.share.problem.noModel");
  assert.equal(importBlocked(2, { model: "", providerId: "p" }), "bot.share.problem.noModel");
});

test("what a Bot comes with is said in the right number", () => {
  assert.equal(comesWithLine({ skills: 0, routines: 0 }).key, "bot.share.comesWithNothing");
  assert.deepEqual(comesWithLine({ skills: 1, routines: 0 }), { key: "bot.share.comesWithSkill", vars: { skills: 1 } });
  assert.deepEqual(comesWithLine({ skills: 3, routines: 0 }), { key: "bot.share.comesWithSkills", vars: { skills: 3 } });
  assert.deepEqual(comesWithLine({ skills: 0, routines: 1 }), { key: "bot.share.comesWithRoutine", vars: { routines: 1 } });
  assert.deepEqual(comesWithLine({ skills: 0, routines: 4 }), { key: "bot.share.comesWithRoutines", vars: { routines: 4 } });
  assert.deepEqual(comesWithLine({ skills: 1, routines: 1 }), { key: "bot.share.comesWithBoth", vars: { skills: 1, routines: 1 } });
  assert.deepEqual(summaryCounts(summary({ skills: [{ name: "a", description: "" }], routines: [{ name: "r", scheduled: true }, { name: "s", scheduled: false }] })), { skills: 1, routines: 2 });
});

test("after an import the Bot's name is said, and what came with it only when something did", () => {
  assert.deepEqual(importedLines(imported()), [{ key: "bot.share.addedPlain", vars: { name: "Ada Copy" } }]);
  const lines = importedLines(imported({ skills: 1, routines: 2 }));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { key: "bot.share.addedPlain", vars: { name: "Ada Copy" } });
  assert.deepEqual(lines[1], { key: "bot.share.comesWithBoth", vars: { skills: 1, routines: 2 } });
  assert.equal(importedLines(imported({ skills: 1 }))[1]?.key, "bot.share.comesWithSkill", "one skill is not “1 skills”");
});

test("the category filters are all and each category, and 'all' asks the host for no category", () => {
  assert.deepEqual(CATEGORY_FILTERS, ["all", ...CATALOG_CATEGORIES]);
  assert.equal(categoryArg("all"), undefined);
  for (const category of CATALOG_CATEGORIES) assert.equal(categoryArg(category), category);
  assert.equal(new Set(CATEGORY_FILTERS.map(categoryKey)).size, CATEGORY_FILTERS.length);
});

test("a starter already made says 'another', the first time says 'get'", () => {
  assert.equal(getKey({ have: false }), "bot.market.get");
  assert.equal(getKey({ have: true }), "bot.market.getAnother");
});

test("every sharing and marketplace string exists in every language", () => {
  for (const locale of ["zh", "de"] as const) {
    assert.deepEqual(missingTranslations(locale).filter((key) => key.startsWith("bot.share.") || key.startsWith("bot.market.")), [], locale);
  }
});

/* The share panel ------------------------------------------------------------------ */

function exported(over: Partial<ExportedTemplate> = {}): ExportedTemplate {
  return { text: '{"kind":"deyin.bot-template"}', link: "deyin://bot/import?t=abc", summary: summary({ skills: [{ name: "a", description: "d" }] }), warnings: [], ...over };
}

function renderShare(over: Partial<Parameters<typeof BotSharePanel>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(BotSharePanel, { exported: null, includeRoutines: false, busy: false, error: null, copied: null, onIncludeRoutines: noop, onShare: noop, onCopy: noop, onClose: noop, ...over }),
  );
}

test("before sharing, the panel says what travels and offers to make a link; routines are opt-in", () => {
  const html = renderShare();
  assert.match(html, /Share this Bot/);
  assert.match(html, /never travel/);
  assert.match(html, /<input type="checkbox"(?![^>]*checked)[^>]*\/>/);
  assert.match(html, />Make a link</);
  assert.doesNotMatch(html, /Copy text/);
  assert.match(renderShare({ includeRoutines: true }), /<input type="checkbox"[^>]*checked=""/);
});

test("while making, the button and the checkbox are off", () => {
  const html = renderShare({ busy: true });
  assert.match(html, /<button[^>]*disabled=""[^>]*>Making…</);
  assert.match(html, /<input type="checkbox"[^>]*disabled=""/);
});

test("once made, the link, the text and what it carries are shown with copy buttons", () => {
  const html = renderShare({ exported: exported() });
  assert.match(html, /Comes with 1 skill\./);
  assert.match(html, /id="share-link"[^>]*readonly=""/);
  assert.match(html, /value="deyin:\/\/bot\/import\?t=abc"/);
  assert.match(html, />Copy link</);
  assert.match(html, />Copy text</);
  assert.doesNotMatch(html, />Make a link</);
});

test("a Bot too big for a link says so, and offers only the text", () => {
  const html = renderShare({ exported: exported({ link: null }) });
  assert.match(html, /too big for a link\. Share the text instead\./);
  assert.doesNotMatch(html, />Copy link</);
  assert.match(html, />Copy text</);
});

test("what could not travel is said, and what was copied is announced", () => {
  const html = renderShare({ exported: exported({ warnings: ["Its routine “digest” needs a server."] }), copied: "link" });
  assert.match(html, /hint--bad">Its routine “digest” needs a server\./);
  assert.match(html, /role="status"[^>]*>Link copied\./);
  assert.match(renderShare({ exported: exported(), copied: "text" }), /Text copied\./);
  assert.match(renderShare({ exported: exported(), copied: "failed" }), /Couldn&#x27;t copy\./);
  assert.doesNotMatch(renderShare({ exported: exported(), copied: null }), /copied\.|Couldn&#x27;t copy/);
});

test("a refusal is shown as an alert", () => {
  assert.match(renderShare({ error: "That Bot is gone." }), /role="alert"[^>]*>That Bot is gone\./);
});

test("shared text is escaped, never taken as markup", () => {
  const html = renderShare({ exported: exported({ text: "</textarea><script>alert(1)</script>" }) });
  assert.doesNotMatch(html, /<script>/);
});

/* The import dialog ---------------------------------------------------------------- */

function renderImport(over: Partial<Parameters<typeof BotImportView>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(BotImportView, {
      text: "",
      state: { step: "paste" } satisfies ImportStep,
      busy: false,
      error: null,
      defaults: MODEL,
      onText: noop,
      onPreview: noop,
      onBack: noop,
      onAdd: noop,
      onOpen: noop,
      onClose: noop,
      ...over,
    }),
  );
}

test("the first step asks for a link or text and cannot go on while it is empty", () => {
  const html = renderImport();
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="bot-import-title"/);
  assert.match(html, /Add a shared Bot/);
  assert.match(html, /id="bot-import-text"/);
  assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Look at it</);
  assert.doesNotMatch(renderImport({ text: "deyin://bot/import?t=abc" }), /<button type="submit"[^>]*disabled=""/);
});

test("a link that arrived is in the box already, ready to be looked at", () => {
  const html = renderImport({ text: "deyin://bot/import?t=abc" });
  assert.match(html, /deyin:\/\/bot\/import\?t=abc<\/textarea>/);
});

test("the preview shows what the Bot carries before anything is added, with the safety promise", () => {
  const html = renderImport({
    state: {
      step: "preview",
      summary: summary({ skills: [{ name: "weekly-report", description: "Write it" }], routines: [{ name: "Digest", scheduled: true }, { name: "Cleanup", scheduled: false }] }),
    },
  });
  assert.match(html, /<h3[^>]*>Ada<\/h3>/);
  assert.match(html, /Research assistant/);
  assert.match(html, /Reads papers/);
  assert.match(html, /Comes with skills \(1\) and routines \(2\)\./);
  assert.match(html, /bot-panel__name">weekly-report</);
  assert.match(html, /runs on a schedule/);
  assert.match(html, /runs when you ask/);
  assert.match(html, /no memory, no files and no permissions to use your Vault/);
  assert.match(html, /<button type="submit"[^>]*>Add this Bot</);
  assert.match(html, />Back</);
});

test("a Bot with routines cannot be added until a model is chosen, and the reason is shown", () => {
  const state: ImportStep = { step: "preview", summary: summary({ routines: [{ name: "Digest", scheduled: true }] }) };
  const blocked = renderImport({ state, defaults: NO_MODEL });
  assert.match(blocked, /Choose a model in the chat box first\./);
  assert.match(blocked, /<button type="submit"[^>]*disabled=""[^>]*>Add this Bot</);
  const open = renderImport({ state, defaults: MODEL });
  assert.doesNotMatch(open, /Choose a model/);
  assert.doesNotMatch(open, /<button type="submit"[^>]*disabled=""/);
  const plain = renderImport({ state: { step: "preview", summary: summary() }, defaults: NO_MODEL });
  assert.doesNotMatch(plain, /<button type="submit"[^>]*disabled=""/, "a Bot with no routines needs no model");
});

test("a preview's words are escaped, never taken as markup", () => {
  const html = renderImport({ state: { step: "preview", summary: summary({ name: "<img src=x onerror=alert(1)>", description: "<script>x</script>" }) } });
  assert.doesNotMatch(html, /<img|<script>/);
});

test("when added, the name and what came with it are said, routines are said to be paused, warnings shown", () => {
  const html = renderImport({ state: { step: "done", result: imported({ skills: 2, routines: 1, warnings: ["A skill was renamed."] }) } });
  assert.match(html, /Added Ada Copy\./);
  assert.match(html, /Comes with skills \(2\) and routines \(1\)\./);
  assert.match(html, /Its routines are paused/);
  assert.match(html, /hint--bad">A skill was renamed\./);
  assert.match(html, />Open it</);
  assert.match(html, />Done</);
  const plain = renderImport({ state: { step: "done", result: imported() } });
  assert.match(plain, /Added Ada Copy\./);
  assert.doesNotMatch(plain, /Its routines are paused|Comes with/);
});

test("a refusal is shown, and while working nothing can be pressed twice", () => {
  assert.match(renderImport({ error: "That is not a Bot." }), /role="alert"[^>]*>That is not a Bot\./);
  assert.match(renderImport({ error: null }), /role="alert" hidden=""/);
  const busy = renderImport({ busy: true, text: "x" });
  assert.match(busy, /<textarea id="bot-import-text"[^>]*disabled=""/);
  assert.match(busy, /<button type="submit"[^>]*disabled=""[^>]*>Looking…</);
});

/* The marketplace ------------------------------------------------------------------ */

function renderMarket(over: Partial<Parameters<typeof BotMarketplacePanel>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(BotMarketplacePanel, {
      state: { status: "ready", listing: { forYou: [], browse: [card()] } } satisfies MarketState,
      query: "",
      category: "all",
      busyId: null,
      notice: null,
      added: null,
      needsModel: false,
      onQuery: noop,
      onCategory: noop,
      onGet: noop,
      onOpen: noop,
      onImport: noop,
      onBack: noop,
      ...over,
    }),
  );
}

test("the marketplace lists starters with what each comes with, and has a way back and a way to add a shared Bot", () => {
  const html = renderMarket();
  assert.match(html, /Discover Bots/);
  assert.match(html, />Add a shared Bot</);
  assert.match(html, /bot-panel__name">Researcher</);
  assert.match(html, /Reads the web and reports back\./);
  assert.match(html, /Comes with skills \(2\) and routines \(1\)\./);
  assert.match(html, />Get this Bot</);
  assert.match(html, /bot-panel__badge">Research</);
  assert.doesNotMatch(html, /For you/, "nothing is picked for the person when nothing matches");
});

test("each category is a pressable filter, the chosen one pressed", () => {
  const html = renderMarket({ category: "dev" });
  assert.match(html, /aria-pressed="true"[^>]*>Development</);
  assert.match(html, /aria-pressed="false"[^>]*>All</);
  assert.equal(html.match(/aria-pressed=/g)?.length, CATEGORY_FILTERS.length);
});

test("a starter already made says so and offers another", () => {
  const html = renderMarket({ state: { status: "ready", listing: { forYou: [], browse: [card({ have: true })] } } });
  assert.match(html, />Get another</);
  assert.match(html, /You already have one made from this\./);
});

test("starters picked for the person come first in their own section", () => {
  const html = renderMarket({ state: { status: "ready", listing: { forYou: [card({ id: "a", name: "Picked" })], browse: [card({ id: "b", name: "Other" })] } } });
  assert.match(html, /aria-label="For you"/);
  assert.ok(html.indexOf("Picked") < html.indexOf("Other"));
});

test("no match is said, loading and failure are said", () => {
  assert.match(renderMarket({ state: { status: "ready", listing: { forYou: [], browse: [] } } }), /No starters match that\./);
  assert.match(renderMarket({ state: { status: "loading" } }), /role="status"[^>]*>Loading starters…/);
  const failed = renderMarket({ state: { status: "error", error: "ipc closed" } });
  assert.match(failed, /role="alert"[^>]*>Couldn&#x27;t load the starters\. ipc closed/);
  assert.doesNotMatch(failed, /Get this Bot/);
});

test("while one starter is added, every Get is off and the one being added says so", () => {
  const html = renderMarket({ state: { status: "ready", listing: { forYou: [], browse: [card({ id: "a", name: "A" }), card({ id: "b", name: "B" })] } }, busyId: "a" });
  assert.equal((html.match(/<button[^>]*disabled=""[^>]*>(Get this Bot|Adding…)</g) ?? []).length, 2);
  assert.match(html, />Adding…</);
  assert.match(html, />Get this Bot</);
});

test("after adding, the Bot's name, what came with it, and a way to open it are shown", () => {
  const html = renderMarket({ added: imported({ skills: 2, routines: 1 }) });
  assert.match(html, /Added Ada Copy\. Comes with skills \(2\) and routines \(1\)\./);
  assert.match(html, />Open it</);
  assert.doesNotMatch(renderMarket(), />Open it</);
});

test("when a starter's routines need a model, the person is told what to do, and a refusal is an alert", () => {
  assert.match(renderMarket({ needsModel: true }), /Choose a model in the chat box first\./);
  assert.doesNotMatch(renderMarket({ needsModel: false }), /Choose a model/);
  assert.match(renderMarket({ notice: "That starter is gone." }), /role="alert"[^>]*>That starter is gone\./);
});

test("a starter's words are escaped, never taken as markup", () => {
  const html = renderMarket({ state: { status: "ready", listing: { forYou: [], browse: [card({ name: "<img src=x onerror=alert(1)>", blurb: "<script>x</script>" })] } } });
  assert.doesNotMatch(html, /<img|<script>/);
});
