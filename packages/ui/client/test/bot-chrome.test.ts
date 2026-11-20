import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultBotAvatar, type DeyinBot } from "@deyin/host-core/shared";
import { BotChatHeader } from "../src/bots/BotChatHeader.js";
import { BotHome } from "../src/bots/BotHome.js";

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
