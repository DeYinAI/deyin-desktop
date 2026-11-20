import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultBotAvatar, missingTranslations, translate, type DeyinBot } from "@deyin/host-core/shared";
import { BotChatHeader } from "../src/bots/BotChatHeader.js";
import { BotEmptyState } from "../src/bots/BotEmptyState.js";
import { BotHome } from "../src/bots/BotHome.js";
import { EMPTY_COPY, HEADER_CHIP_LIMIT, STARTERS, emptyKindOf, headerChips, withStarter } from "../src/bots/botStarters.js";

const noop = () => undefined;

function bot(over: Partial<DeyinBot> = {}): DeyinBot {
  const avatar = defaultBotAvatar("ada");
  return {
    id: "ada", name: "Ada", handle: "ada", description: "", title: "Research assistant", avatarShape: avatar.shape, avatarColor: avatar.color,
    avatarVersion: 1, createdAt: 1, updatedAt: 1, harness: "local", role: "assistant", visibility: "owner", kind: "agent", memberBotIds: [],
    autoReview: { approvalMode: "auto_review" }, isPrimary: false, archived: false, ...over,
  };
}

const header = (b: DeyinBot) => renderToStaticMarkup(createElement(BotChatHeader, { bot: b, onDetails: noop, onNewConversation: noop }));
const home = (n: number) => renderToStaticMarkup(createElement(BotHome, { activeCount: n, onCreate: noop }));

test("the chat header names the Bot and its label", () => {
  const html = header(bot());
  assert.match(html, /bot-chat-header__name">Ada</);
  assert.match(html, /bot-chat-header__title">Research assistant</);
});

test("a Bot with no label shows no empty label element", () => {
  assert.doesNotMatch(header(bot({ title: "" })), /bot-chat-header__title/);
});

test("the header offers Details and New conversation", () => {
  const html = header(bot());
  assert.match(html, />Details</);
  assert.match(html, />New conversation</);
});

test("an archived Bot cannot start a new conversation but its details stay reachable", () => {
  const html = header(bot({ archived: true }));
  assert.match(html, /<button[^>]*disabled=""[^>]*>New conversation</);
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Details</);
});

test("the header escapes the Bot's name", () => {
  assert.doesNotMatch(header(bot({ name: "<script>x</script>" })), /<script>/);
});

test("with no Bots the home screen invites the first one", () => {
  const html = home(0);
  assert.match(html, />No Bots yet</);
  assert.match(html, /persistent assistant with its own memory and files/);
  assert.match(html, />Create Bot</);
});

test("with Bots the home screen asks which to open", () => {
  const html = home(2);
  assert.match(html, />Your Bots</);
  assert.match(html, /Pick a Bot to chat with, or create a new one\./);
  assert.doesNotMatch(html, /No Bots yet/);
});

test("the home offers to discover and to add a shared Bot only where those exist", () => {
  const plain = home(1);
  assert.doesNotMatch(plain, /Discover Bots|Add a shared Bot/);
  const rich = renderToStaticMarkup(createElement(BotHome, { activeCount: 0, onCreate: noop, onBrowse: noop, onImport: noop }));
  assert.match(rich, /<button[^>]*>Discover Bots<\/button>/);
  assert.match(rich, /<button[^>]*>Add a shared Bot<\/button>/);
  const onlyBrowse = renderToStaticMarkup(createElement(BotHome, { activeCount: 0, onCreate: noop, onBrowse: noop }));
  assert.match(onlyBrowse, /Discover Bots/);
  assert.doesNotMatch(onlyBrowse, /Add a shared Bot/);
});

/* A Bot's empty conversation, and the chips above the primary Bot's ---------------------- */

const emptyState = (b: DeyinBot) => renderToStaticMarkup(createElement(BotEmptyState, { bot: b, onStarter: noop }));

test("what a Bot's empty conversation says depends on whether it has a job, is primary, or is a room", () => {
  assert.equal(emptyKindOf(bot()), "fresh");
  assert.equal(emptyKindOf(bot({ purpose: "  " })), "fresh", "blank is no job");
  assert.equal(emptyKindOf(bot({ purpose: "Find sources." })), "ready");
  assert.equal(emptyKindOf(bot({ isPrimary: true })), "primary");
  assert.equal(emptyKindOf(bot({ isPrimary: true, purpose: "Coordinate." })), "primary", "primary wins over having a job");
  assert.equal(emptyKindOf(bot({ kind: "room", memberBotIds: ["a", "b"] })), "room");
});

test("a Bot with no job is asked for one, by name, with openings that put the first words in the box", () => {
  const html = emptyState(bot({ name: "Ada" }));
  assert.match(html, />Give Ada a job</);
  assert.match(html, /It remembers, so you only say it once\./);
  for (const label of ["Give it a job", "Set a rule", "Set up a routine"]) assert.match(html, new RegExp(`<button[^>]*>${label}</button>`));
  assert.doesNotMatch(html, /what are we building/);
});

test("a Bot with a job is ready, and the primary Bot is told to start by saying what the person works on", () => {
  assert.match(emptyState(bot({ name: "Ada", purpose: "Find sources." })), />Ada is ready</);
  const primary = emptyState(bot({ name: "Bill", isPrimary: true }));
  assert.match(primary, />Bill is your primary Bot</);
  for (const label of ["Set up my Bots", "What&#x27;s new\\?", "Set a rule"]) assert.match(primary, new RegExp(`<button[^>]*>${label}</button>`));
});

test("a room's empty conversation says how to ask one Bot or everyone", () => {
  const html = emptyState(bot({ kind: "room", memberBotIds: ["a", "b"], name: "Standup" }));
  assert.match(html, />Talk to the room</);
  assert.match(html, /Write @ and a Bot&#x27;s name to ask that Bot/);
  assert.match(html, /<button[^>]*>Start a standup<\/button>/);
});

test("an archived Bot's openings are off, and the name is escaped", () => {
  assert.match(emptyState(bot({ archived: true })), /<button[^>]*disabled=""[^>]*>Give it a job</);
  assert.doesNotMatch(emptyState(bot({ name: "<script>x</script>" })), /<script>/);
});

test("an opening goes after what is already typed, and on its own when the box is empty", () => {
  assert.equal(withStarter("", "Your job is to "), "Your job is to ");
  assert.equal(withStarter("   ", "Your job is to "), "Your job is to ");
  assert.equal(withStarter("Hello ", "Your job is to "), "Hello Your job is to ");
});

test("every opening has words in every language, and the starter text is not the label", () => {
  const keys = Object.values(EMPTY_COPY).flatMap((copy) => [copy.title, copy.body]);
  const starters = Object.values(STARTERS).flat();
  for (const locale of ["en", "zh", "de"] as const) {
    for (const key of [...keys, ...starters.flatMap((s) => [s.label, s.text])]) {
      assert.ok(!missingTranslations(locale).includes(key), `${locale} has ${key}`);
      assert.notEqual(translate(locale, key), key, `${locale} ${key} is real text`);
    }
  }
  for (const starter of starters) assert.notEqual(translate("en", starter.label), translate("en", starter.text));
});

const primaryBot = bot({ id: "bill", handle: "bill", name: "Bill", isPrimary: true });
const others = (n: number) => Array.from({ length: n }, (_, i) => bot({ id: `b${i}`, handle: `b${i}`, name: `B${i}`, updatedAt: 10 + i }));

test("the primary Bot's header shows its other Bots as chips that mention them, newest first and capped", () => {
  const chips = headerChips(primaryBot, [], [primaryBot, ...others(9)]);
  assert.equal(chips.length, HEADER_CHIP_LIMIT);
  assert.equal(chips[0]!.id, "b8");
  const html = renderToStaticMarkup(createElement(BotChatHeader, { bot: primaryBot, onDetails: noop, onNewConversation: noop, members: chips, onMention: noop }));
  assert.match(html, /<ul class="bot-chat-header__members"[^>]*aria-label="Your other Bots"/);
  assert.match(html, /aria-label="Mention B8"/);
  assert.equal(html.match(/aria-label="Mention /g)?.length, HEADER_CHIP_LIMIT);
});

test("only a room or the primary Bot has chips; any other Bot has none, even if handed some", () => {
  const plain = bot({ id: "ada" });
  assert.deepEqual(headerChips(plain, [], [plain, ...others(3)]), []);
  assert.doesNotMatch(renderToStaticMarkup(createElement(BotChatHeader, { bot: plain, onDetails: noop, onNewConversation: noop, members: others(2), onMention: noop })), /bot-chat-header__members/);
  const room = bot({ id: "r", kind: "room", memberBotIds: ["b0", "b1"] });
  assert.deepEqual(headerChips(room, others(2), [room, ...others(2)]).map((b) => b.id), ["b0", "b1"], "a room keeps its members in its own order");
});

/* The introduction to a primary Bot ------------------------------------------------------ */

test("with no primary Bot the home introduces one and offers to make it", () => {
  const html = renderToStaticMarkup(createElement(BotHome, { activeCount: 0, onCreate: noop, onCreatePrimary: noop }));
  assert.match(html, />Introducing your primary Bot</);
  assert.match(html, /main point of contact/);
  assert.match(html, /<button[^>]*btn--primary[^>]*>Create primary Bot<\/button>/);
  assert.match(html, /<button[^>]*btn--outline[^>]*>Create Bot<\/button>/, "the introduction is the main way in, so a plain Bot is the quieter one");
  assert.doesNotMatch(html, /<select|Make primary/, "there is nothing to pick from: any Bot that exists is already the primary one");
});

test("with a primary Bot the home opens to it and has no introduction", () => {
  const html = renderToStaticMarkup(createElement(BotHome, { activeCount: 2, onCreate: noop, primary: { id: "bill", name: "Bill" }, onOpenPrimary: noop, onCreatePrimary: noop }));
  assert.match(html, /<button[^>]*btn--primary[^>]*>Chat with Bill<\/button>/);
  assert.doesNotMatch(html, /Introducing your primary Bot|Create primary Bot/);
  assert.match(html, /<button[^>]*btn--outline[^>]*>Create Bot<\/button>/);
});

test("without the primary Bot calls the home is exactly what it was", () => {
  const html = home(2);
  assert.doesNotMatch(html, /primary Bot|Chat with|Make primary|<select/);
  assert.match(html, /<button[^>]*btn--primary[^>]*>Create Bot<\/button>/);
});

test("the primary Bot's name on the home is escaped", () => {
  const html = renderToStaticMarkup(createElement(BotHome, { activeCount: 1, onCreate: noop, primary: { id: "x", name: "<script>x</script>" }, onOpenPrimary: noop }));
  assert.doesNotMatch(html, /<script>/);
});

test("the primary introduction has words in every language", () => {
  for (const locale of ["zh", "de"] as const) {
    assert.deepEqual(missingTranslations(locale).filter((key) => key.startsWith("bot.primary.") || key.startsWith("bot.empty.") || key.startsWith("bot.starter.")), [], locale);
  }
});
