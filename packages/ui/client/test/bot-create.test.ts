import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES, BOT_LIMITS, defaultBotAvatar } from "@deyin/host-core/shared";
import { BotAvatarPicker } from "../src/bots/BotAvatarPicker.js";
import { BotCreateDialog } from "../src/bots/BotCreateDialog.js";

const noop = () => undefined;

function picker(over: { shape?: (typeof BOT_AVATAR_SHAPES)[number]; color?: (typeof BOT_AVATAR_COLORS)[number]["id"]; disabled?: boolean } = {}): string {
  return renderToStaticMarkup(
    createElement(BotAvatarPicker, {
      shape: over.shape ?? BOT_AVATAR_SHAPES[0]!,
      color: over.color ?? BOT_AVATAR_COLORS[0]!.id,
      name: "Ada",
      disabled: over.disabled,
      onChange: noop,
    }),
  );
}

function dialog(seed = "fixed-seed"): string {
  const created = async () => ({ ok: false as const, error: "unused", code: "invalid" as const });
  return renderToStaticMarkup(createElement(BotCreateDialog, { onCreate: created, onCreated: noop, onCancel: noop, seed }));
}

const radios = (html: string): string[] => html.match(/<button[^>]*role="radio"[^>]*>/g) ?? [];

test("the picker offers every shape and every color, as two labelled radio groups", () => {
  const html = picker();
  assert.match(html, /role="radiogroup" aria-label="Shape"/);
  assert.match(html, /role="radiogroup" aria-label="Color"/);
  assert.equal(radios(html).length, BOT_AVATAR_SHAPES.length + BOT_AVATAR_COLORS.length);
  assert.equal(BOT_AVATAR_SHAPES.length, 10);
  assert.equal(BOT_AVATAR_COLORS.length, 12);
});

test("exactly one shape and one color are checked, and they are the current ones", () => {
  const shape = BOT_AVATAR_SHAPES[7]!;
  const color = BOT_AVATAR_COLORS[3]!;
  const checked = radios(picker({ shape, color: color.id })).filter((tag) => tag.includes('aria-checked="true"'));
  assert.equal(checked.length, 2);
  assert.ok(checked.some((tag) => tag.includes(`aria-label="${shape}"`)));
  assert.ok(checked.some((tag) => tag.includes(`aria-label="${color.label}"`)));
});

test("each color swatch is painted with its own color value", () => {
  const html = picker();
  for (const color of BOT_AVATAR_COLORS) assert.ok(html.includes(`background:${color.value}`), color.id);
});

test("a disabled picker disables every choice", () => {
  const tags = radios(picker({ disabled: true }));
  assert.equal(tags.length, BOT_AVATAR_SHAPES.length + BOT_AVATAR_COLORS.length);
  assert.ok(tags.every((tag) => tag.includes("disabled")));
});

test("an enabled picker disables none", () => {
  assert.ok(radios(picker()).every((tag) => !tag.includes("disabled")));
});

test("the dialog is a modal labelled by its title", () => {
  const html = dialog();
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-labelledby="bot-create-title"/);
  assert.match(html, /<h2 id="bot-create-title"[^>]*>New Bot</);
});

test("the name and label inputs are labelled and the name is first", () => {
  const html = dialog();
  assert.match(html, /<label[^>]*for="bot-create-name"[^>]*>Name</);
  assert.match(html, /<label[^>]*for="bot-create-label"[^>]*>Label</);
  assert.ok(html.indexOf('id="bot-create-name"') < html.indexOf('id="bot-create-label"'));
});

test("the name and label boxes stop typing where the store would refuse, not at some other number", () => {
  const html = dialog();
  assert.match(html, new RegExp(`id="bot-create-name"[^>]*maxLength="${BOT_LIMITS.name}"`));
  assert.match(html, new RegExp(`id="bot-create-label"[^>]*maxLength="${BOT_LIMITS.title}"`));
  assert.notEqual(BOT_LIMITS.name, BOT_LIMITS.title, "the two limits differ, so a swapped pair is noticed");
});

test("create is blocked until the Bot has a name", () => {
  const html = dialog();
  assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Create Bot</);
});

test("the dialog starts on the avatar its seed picks, so a given seed is stable", () => {
  const expected = defaultBotAvatar("fixed-seed");
  const checked = radios(dialog("fixed-seed")).filter((tag) => tag.includes('aria-checked="true"'));
  assert.ok(checked.some((tag) => tag.includes(`aria-label="${expected.shape}"`)));
  assert.equal(dialog("fixed-seed"), dialog("fixed-seed"));
});

test("the error region exists up front but is hidden until something fails", () => {
  assert.match(dialog(), /<p class="bot-create__error hint--bad" role="alert" hidden=""><\/p>/);
});

test("cancel is offered next to create", () => {
  assert.match(dialog(), /<button type="button"[^>]*>Cancel</);
});
