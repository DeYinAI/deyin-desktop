import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { TEACH_WORLD_ID, activeTeachTarget, teachTargetFromWebContents, type TeachWebContents } from "../src/main/bots/teach-electron.js";

class FakeWebContents extends EventEmitter {
  destroyed = false;
  url = "https://example.com/a";
  title = "A";
  readonly scripts: Array<{ world: number; code: string }> = [];
  constructor(readonly id: number) {
    super();
  }
  isDestroyed() {
    return this.destroyed;
  }
  getURL() {
    return this.url;
  }
  getTitle() {
    return this.title;
  }
  async executeJavaScriptInIsolatedWorld(world: number, scripts: Array<{ code: string }>) {
    for (const script of scripts) this.scripts.push({ world, code: script.code });
    return ["result"];
  }
}

const asWc = (wc: FakeWebContents) => wc as unknown as TeachWebContents;

test("a tab reports its address and title, and nothing once it is closed", () => {
  const wc = new FakeWebContents(7);
  const target = teachTargetFromWebContents(asWc(wc));
  assert.equal(target.id, 7);
  assert.equal(target.url(), "https://example.com/a");
  assert.equal(target.title(), "A");
  wc.destroyed = true;
  assert.equal(target.url(), "");
  assert.equal(target.title(), "");
});

test("a script runs in its own world, never the page's, and a closed tab refuses to run one", async () => {
  const wc = new FakeWebContents(1);
  const target = teachTargetFromWebContents(asWc(wc));
  assert.deepEqual(await target.run("1 + 1"), ["result"]);
  assert.deepEqual(wc.scripts, [{ world: TEACH_WORLD_ID, code: "1 + 1" }]);
  assert.ok(TEACH_WORLD_ID > 999, "not the page's world (0) or Electron's own (999)");
  wc.destroyed = true;
  await assert.rejects(() => target.run("x"), /The tab is closed/);
  assert.equal(wc.scripts.length, 1);
});

test("a page loading, or going somewhere else in the same document, is a navigation; a frame inside it is not", () => {
  const wc = new FakeWebContents(1);
  const target = teachTargetFromWebContents(asWc(wc));
  let heard = 0;
  const off = target.onNavigate(() => (heard += 1));
  wc.emit("dom-ready");
  wc.emit("did-navigate", {}, "https://example.com/b");
  wc.emit("did-navigate-in-page", {}, "https://example.com/b#x", true);
  assert.equal(heard, 3);
  wc.emit("did-navigate-in-page", {}, "https://example.com/frame", false);
  assert.equal(heard, 3, "a frame is not the page");
  off();
  wc.emit("dom-ready");
  wc.emit("did-navigate");
  wc.emit("did-navigate-in-page", {}, "x", true);
  assert.equal(heard, 3, "no longer listened to");
  for (const event of ["dom-ready", "did-navigate", "did-navigate-in-page"]) assert.equal(wc.listenerCount(event), 0, event);
});

test("the active tab is the same target each time, a new one when the person moves, and none when there is no tab", () => {
  const first = new FakeWebContents(1);
  const second = new FakeWebContents(2);
  const state: { current: FakeWebContents | null } = { current: first };
  const active = activeTeachTarget(() => (state.current ? asWc(state.current) : null));
  const one = active();
  assert.equal(active(), one, "the same tab is the same target, so moving can be told from staying");
  state.current = second;
  const two = active();
  assert.notEqual(two, one);
  assert.equal(two?.id, 2);
  state.current = first;
  assert.equal(active(), one);
  second.destroyed = true;
  state.current = second;
  assert.equal(active(), null, "a closed tab is no tab");
  state.current = null;
  assert.equal(active(), null);
});
