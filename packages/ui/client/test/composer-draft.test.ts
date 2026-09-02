import assert from "node:assert/strict";
import { test } from "node:test";
import { DraftKeeper, emptyComposerDraft } from "../src/composer-draft.js";

const draft = (input: string) => ({
  ...emptyComposerDraft(),
  input,
  attachments: [{ ref: "file://x" } as never],
});

test("swap archives the outgoing draft and restores the incoming one", () => {
  const k = new DraftKeeper();
  k.save("a", draft("hello a"));
  const restored = k.swap("b", draft("typed in b"), "a");
  assert.equal(restored.input, "hello a");
  // The draft typed in b was archived under b.
  assert.equal(k.get("b").input, "typed in b");
});

test("restore returns a fresh copy, not the stored arrays", () => {
  const k = new DraftKeeper();
  const saved = draft("x");
  k.save("a", saved);
  const first = k.get("a");
  first.attachments.pop();
  assert.equal(k.get("a").attachments.length, 1, "mutating a restored draft must not touch the store");
});

test("null thread ids: saves are dropped, restores are empty", () => {
  const k = new DraftKeeper();
  k.save(null, draft("no thread"));
  assert.deepEqual(k.get(null), emptyComposerDraft());
  assert.deepEqual(k.swap(null, draft("orphan"), "a"), emptyComposerDraft());
});

test("unknown thread restores empty; known thread without a draft restores empty", () => {
  const k = new DraftKeeper();
  assert.deepEqual(k.get("never-seen"), emptyComposerDraft());
});

test("re-saving the same thread overwrites the previous draft", () => {
  const k = new DraftKeeper();
  k.save("a", draft("one"));
  k.save("a", draft("two"));
  assert.equal(k.get("a").input, "two");
});
