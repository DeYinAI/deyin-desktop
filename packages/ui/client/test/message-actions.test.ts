/**
 * Message action row contract: which controls each message type offers, and how
 * an unavailable Branch presents. A regression here silently drops Copy or
 * leaves a dead Branch looking clickable, which markup assertions catch cheaply.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageActions } from "../src/components/MessageActions.js";
import { I18nProvider } from "../src/i18n.js";

function render(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(createElement(I18nProvider, { language: "en" }, node));
}

function labels(markup: string): string[] {
  return [...markup.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]!);
}

test("assistant row offers copy, both ratings, then branch in that order", () => {
  const markup = render(
    createElement(MessageActions, {
      text: "hello",
      feedback: undefined,
      onFeedback: () => {},
      onFork: () => {},
    }),
  );
  assert.deepEqual(labels(markup), [
    "Copy message",
    "Good response",
    "Bad response",
    "Fork chat from here",
  ]);
});

test("a recorded rating is pressed and offers to remove itself", () => {
  const up = render(
    createElement(MessageActions, { text: "hi", feedback: "up", onFeedback: () => {} }),
  );
  assert.match(up, /aria-pressed="true"/);
  assert.deepEqual(labels(up), ["Copy message", "Remove rating", "Bad response"]);

  const down = render(
    createElement(MessageActions, { text: "hi", feedback: "down", onFeedback: () => {} }),
  );
  assert.deepEqual(labels(down), ["Copy message", "Good response", "Remove rating"]);
});

test("empty text drops Copy instead of rendering a no-op control", () => {
  const markup = render(createElement(MessageActions, { text: "  ", feedback: undefined }));
  assert.equal(labels(markup).length, 0);
});

test("user row copies and edits, and never offers ratings or branch", () => {
  const markup = render(
    createElement(MessageActions, { text: "why?", onEdit: () => {}, onFork: () => {} }),
  );
  assert.deepEqual(labels(markup), ["Copy message", "Edit message", "Fork chat from here"]);
});

test("unavailable branch stays focusable, inert, and explains itself", () => {
  const reason = "Available only on the last message of a completed turn";
  const markup = render(
    createElement(MessageActions, { text: "hi", onFork: () => {}, forkUnavailableReason: reason }),
  );
  // aria-disabled rather than `disabled`: a natively disabled button stops
  // delivering the hover/focus events that carry the explanation.
  assert.match(markup, /aria-disabled="true"/);
  assert.match(markup, /data-unavailable="true"/);
  assert.doesNotMatch(markup, /\sdisabled=""/);
  assert.ok(labels(markup).includes("Fork chat from here"));
  assert.match(markup, new RegExp(`title="${reason}"`));
});

test("an available branch carries no unavailable markers", () => {
  const markup = render(createElement(MessageActions, { text: "hi", onFork: () => {} }));
  assert.doesNotMatch(markup, /aria-disabled/);
  assert.doesNotMatch(markup, /data-unavailable/);
});

test("every glyph is drawn at 16px, and the two ratings are different shapes", () => {
  const markup = render(
    createElement(MessageActions, {
      text: "hello",
      feedback: undefined,
      onFeedback: () => {},
      onEdit: () => {},
      onFork: () => {},
    }),
  );
  const sizes = [...markup.matchAll(/<svg[^>]*\swidth="(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(sizes, ["16", "16", "16", "16", "16"], "a smaller glyph is too faint to read at this stroke");
  // Dislike is the like glyph flipped, not a second hand-drawn copy that can drift.
  const buttons = markup.split("<button").slice(1);
  const like = buttons.find((b) => b.includes('aria-label="Good response"')) ?? "";
  const dislike = buttons.find((b) => b.includes('aria-label="Bad response"')) ?? "";
  assert.ok(!like.includes("scale(1 -1)"), "like is drawn upright");
  assert.ok(dislike.includes("scale(1 -1)"), "dislike is the flipped glyph");
});
