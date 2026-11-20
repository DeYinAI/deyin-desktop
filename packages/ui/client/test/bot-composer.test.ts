import assert from "node:assert/strict";
import { test } from "node:test";
import { BOT_APPROVAL_MODES, missingTranslations, translate, type BotApprovalMode, type DeyinBot, type MessageKey } from "@deyin/host-core/shared";
import { botComposerChrome } from "../src/bots/botComposer.js";

const en = (key: MessageKey): string => translate("en", key);
const noop = (): void => undefined;

function bot(patch: { name?: string; kind?: DeyinBot["kind"]; isPrimary?: boolean; mode?: BotApprovalMode } = {}) {
  return {
    name: patch.name ?? "Maya",
    kind: patch.kind ?? "agent",
    isPrimary: patch.isPrimary ?? false,
    autoReview: { approvalMode: patch.mode ?? "auto_review" },
  } as Pick<DeyinBot, "name" | "kind" | "isPrimary" | "autoReview">;
}

test("a plain Bot's box invites a message to it by name", () => {
  assert.equal(botComposerChrome(bot({ name: "Ada" }), false, en, noop).placeholder, "Message Ada…");
});

test("the primary Bot's box mentions @ only once it has other Bots to reach", () => {
  assert.equal(botComposerChrome(bot({ isPrimary: true }), true, en, noop).placeholder, "Message Maya, or write @ to reach another Bot");
  assert.equal(botComposerChrome(bot({ isPrimary: true }), false, en, noop).placeholder, "Message Maya…");
});

test("a room's box says @ speaks to one of its Bots, and a room is never taken for a primary", () => {
  assert.equal(botComposerChrome(bot({ name: "Launch", kind: "room", isPrimary: true }), true, en, noop).placeholder, "Message Launch, or write @ to speak to one Bot");
});

test("none of a coding session's words are left in a Bot's box", () => {
  for (const chrome of [botComposerChrome(bot(), false, en, noop), botComposerChrome(bot({ isPrimary: true }), true, en, noop)]) {
    assert.doesNotMatch(chrome.placeholder, /files|commands|codebase|follow-up|workspace/i);
    assert.doesNotMatch(chrome.approvalLabel, /Full access/);
  }
});

test("the chip says the Bot's own approval mode, in the words its details use", () => {
  const labels = BOT_APPROVAL_MODES.map((mode) => botComposerChrome(bot({ mode }), false, en, noop).approvalLabel);
  assert.deepEqual(labels, ["Auto Review", "Read only", "Run everything"]);
  assert.deepEqual(
    BOT_APPROVAL_MODES.map((mode) => botComposerChrome(bot({ mode }), false, en, noop).approvalIcon),
    ["hand", "eye", "shield"],
  );
});

test("only a mode where nothing asks is drawn as a warning", () => {
  assert.deepEqual(
    BOT_APPROVAL_MODES.map((mode) => botComposerChrome(bot({ mode }), false, en, noop).approvalWarn),
    [false, false, true],
  );
});

test("the chip's hover text names the Bot and says where the mode is changed", () => {
  assert.equal(botComposerChrome(bot({ name: "Ada" }), false, en, noop).approvalTitle, "How Ada asks before it acts. Click to change it in the Bot's details.");
});

test("clicking the chip hands over to the caller", () => {
  let opened = 0;
  botComposerChrome(bot(), false, en, () => (opened += 1)).onOpenApproval();
  assert.equal(opened, 1);
});

test("a name with markup stays text", () => {
  const chrome = botComposerChrome(bot({ name: "<b>x</b>" }), false, en, noop);
  assert.equal(chrome.placeholder, "Message <b>x</b>…", "the box is a plain attribute, so React escapes it; nothing here builds HTML");
});

test("the box words exist in every language", () => {
  for (const locale of ["zh", "de"] as const) {
    assert.deepEqual(missingTranslations(locale).filter((key) => key.startsWith("bot.composer.")), [], locale);
  }
});
