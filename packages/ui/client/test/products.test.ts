import assert from "node:assert/strict";
import test from "node:test";
import { PRODUCT_IDS } from "@deyin/host-core/shared";
import type { Project, Thread } from "@deyin/host-core/shared";
import {
  PRODUCTS,
  PRODUCT_PLACES_KEY,
  availableProducts,
  coerceProduct,
  isProductView,
  loadProductPlaces,
  parseProductPlaces,
  productOfThread,
  productOfView,
  rememberPlace,
  resolveProductSwitch,
  restorableView,
  saveProductPlaces,
} from "../src/products.js";
import type { View } from "../src/views.js";

function thread(id: string, patch: Partial<Thread> = {}): Thread {
  return { id, title: id, updatedAt: 1, events: [], ...patch };
}

function project(id: string, threads: Thread[]): Project {
  return { id, name: id, root: `/work/${id}`, threads };
}

const ALL_VIEWS: View[] = [
  "workspace",
  "settings",
  "upgrade",
  "automations",
  "plugins",
  "superagent",
  "conductor",
  "workflows",
  "bot",
  "botDetail",
  "botMarket",
];

test("the registry describes every product and the ids match", () => {
  assert.deepEqual([...PRODUCT_IDS], ["code", "bot", "conductor"]);
  for (const id of PRODUCT_IDS) {
    const product = PRODUCTS[id];
    assert.equal(product.id, id);
    assert.ok(product.views.includes(product.homeView), `${id} opens on one of its own views`);
    assert.ok(product.chatModes.length > 0, `${id} offers a composer mode`);
  }
});

test("no view is claimed by two products", () => {
  const owners = new Map<View, string>();
  for (const id of PRODUCT_IDS) {
    for (const view of PRODUCTS[id].views) {
      assert.equal(owners.get(view), undefined, `${view} is owned twice`);
      owners.set(view, id);
    }
  }
});

test("product-owned views map to their product and shared views keep the current one", () => {
  for (const view of ALL_VIEWS) {
    for (const current of PRODUCT_IDS) {
      const got = productOfView(view, current);
      if (isProductView(view)) {
        const owner = PRODUCT_IDS.find((id) => (PRODUCTS[id].views as readonly View[]).includes(view));
        assert.equal(got, owner, `${view} is owned by ${owner}`);
      } else {
        assert.equal(got, current, `opening ${view} must not leave ${current}`);
      }
    }
  }
});

test("a thread belongs to Bot when it has a botId, to Conductor in conductor mode, otherwise to Code", () => {
  assert.equal(productOfThread({ mode: "agent" }), "code");
  assert.equal(productOfThread({}), "code");
  assert.equal(productOfThread({ mode: "plan" }), "code");
  assert.equal(productOfThread({ mode: "conductor" }), "conductor");
  assert.equal(productOfThread({ mode: "agent", botId: "b1" }), "bot");
  assert.equal(productOfThread({ mode: "conductor", botId: "b1" }), "bot", "a Bot's thread stays Bot's");
});

test("a chat-only host offers only Deyin Code", () => {
  assert.deepEqual(availableProducts(false).map((p) => p.id), ["code", "bot", "conductor"]);
  assert.deepEqual(availableProducts(true).map((p) => p.id), ["code"]);
});

test("coerceProduct falls back to Code for unknown ids and for products the host cannot run", () => {
  assert.equal(coerceProduct("bot", false), "bot");
  assert.equal(coerceProduct("conductor", false), "conductor");
  assert.equal(coerceProduct("bot", true), "code");
  assert.equal(coerceProduct("nope", false), "code");
  assert.equal(coerceProduct(undefined, false), "code");
  assert.equal(coerceProduct(7, false), "code");
});

test("each product's composer modes never overlap another's default", () => {
  assert.deepEqual(PRODUCTS.code.chatModes, ["agent", "plan", "ask", "delivery"]);
  assert.deepEqual(PRODUCTS.conductor.chatModes, ["conductor"]);
  assert.ok(!PRODUCTS.code.chatModes.includes("conductor"));
  assert.ok(!PRODUCTS.bot.chatModes.includes("conductor"));
});

test("switching back to a product restores the thread and view the user left", () => {
  const projects = [
    project("p1", [
      thread("code-old", { updatedAt: 10 }),
      thread("code-new", { updatedAt: 90 }),
      thread("run-1", { mode: "conductor", updatedAt: 50 }),
      thread("bot-chat", { botId: "b1", updatedAt: 70 }),
    ]),
  ];
  let places = rememberPlace({}, "code", { view: "workspace", projectId: "p1", threadId: "code-old" });
  places = rememberPlace(places, "conductor", { view: "workflows", projectId: "p1", threadId: "run-1" });

  const back = resolveProductSwitch("code", places, projects, "p1");
  assert.equal(back.threadId, "code-old", "the remembered thread wins over the newest one");
  assert.equal(back.view, "workspace");

  const conductor = resolveProductSwitch("conductor", places, projects, "p1");
  assert.equal(conductor.threadId, "run-1");
  assert.equal(conductor.view, "workflows", "Conductor reopens on the page it was left on");
  assert.equal(conductor.composerMode, "conductor");
});

test("with nothing remembered a product opens its newest thread in the current project", () => {
  const projects = [
    project("p1", [thread("c-old", { updatedAt: 5 }), thread("c-new", { updatedAt: 20 })]),
    project("p2", [thread("c-other", { updatedAt: 99 })]),
  ];
  assert.equal(resolveProductSwitch("code", {}, projects, "p1").threadId, "c-new");
  assert.equal(resolveProductSwitch("code", {}, projects, "p2").threadId, "c-other");
  assert.equal(resolveProductSwitch("code", {}, projects, null).threadId, "c-other", "no current project: newest anywhere");
});

test("a product with no threads opens its home with no thread", () => {
  const projects = [project("p1", [thread("only-code")])];
  const bot = resolveProductSwitch("bot", {}, projects, "p1");
  assert.equal(bot.threadId, null);
  assert.equal(bot.view, "bot");
  assert.equal(bot.projectId, "p1", "keeps the current project so the shell stays anchored");
  assert.equal(bot.composerMode, "agent");

  const conductor = resolveProductSwitch("conductor", {}, projects, null);
  assert.equal(conductor.threadId, null);
  assert.equal(conductor.view, "conductor");
  assert.equal(conductor.projectId, null);
});

test("a remembered thread that was archived, deleted or moved to another product is not trusted", () => {
  const projects = [
    project("p1", [
      thread("archived", { archived: true, updatedAt: 99 }),
      thread("fallback", { updatedAt: 3 }),
      thread("now-conductor", { mode: "conductor", updatedAt: 50 }),
    ]),
  ];
  for (const stale of ["archived", "gone", "now-conductor"]) {
    const places = rememberPlace({}, "code", { view: "workspace", projectId: "p1", threadId: stale });
    const target = resolveProductSwitch("code", places, projects, "p1");
    assert.equal(target.threadId, "fallback", `stale ${stale} falls back to a live Code thread`);
  }
});

test("a remembered view the product does not own is replaced by its home view", () => {
  const places = { code: { view: "bot" as const, projectId: null, threadId: null } };
  assert.equal(resolveProductSwitch("code", places, [], null).view, "workspace");
});

test("the composer mode follows the restored thread when the product offers it", () => {
  const projects = [project("p1", [thread("planning", { mode: "plan" }), thread("asking", { mode: "ask", updatedAt: 9 })])];
  const places = rememberPlace({}, "code", { view: "workspace", projectId: "p1", threadId: "planning" });
  assert.equal(resolveProductSwitch("code", places, projects, "p1").composerMode, "plan");
  assert.equal(resolveProductSwitch("code", {}, projects, "p1").composerMode, "ask");
  assert.equal(resolveProductSwitch("code", {}, [], null).composerMode, "agent", "an empty Code shell starts in Agent mode");
});

test("a Bot's threads are only offered to Deyin Bot", () => {
  const projects = [project("p1", [thread("c", { updatedAt: 1 }), thread("chat-with-bot", { botId: "b9", updatedAt: 5 })])];
  assert.equal(resolveProductSwitch("bot", {}, projects, "p1").threadId, "chat-with-bot");
  assert.equal(resolveProductSwitch("code", {}, projects, "p1").threadId, "c");
});

test("rememberPlace returns the same object when nothing changed, so persistence is not retriggered", () => {
  const first = rememberPlace({}, "code", { view: "workspace", projectId: "p1", threadId: "t" });
  const again = rememberPlace(first, "code", { view: "workspace", projectId: "p1", threadId: "t" });
  assert.equal(again, first);
  const moved = rememberPlace(first, "code", { view: "workspace", projectId: "p1", threadId: "u" });
  assert.notEqual(moved, first);
  assert.equal(first.code?.threadId, "t", "the previous map is not mutated");
});

test("parseProductPlaces keeps valid entries and drops malformed ones", () => {
  assert.deepEqual(parseProductPlaces(null), {});
  assert.deepEqual(parseProductPlaces(""), {});
  assert.deepEqual(parseProductPlaces("{not json"), {});
  assert.deepEqual(parseProductPlaces("[]"), {});
  assert.deepEqual(parseProductPlaces("7"), {});
  const parsed = parseProductPlaces(
    JSON.stringify({
      code: { view: "workspace", projectId: "p1", threadId: "t1" },
      conductor: { view: "bot", projectId: "p1", threadId: "t2" },
      bot: { view: "botDetail", projectId: 4, threadId: "" },
      mystery: { view: "workspace", projectId: null, threadId: null },
    }),
  );
  assert.deepEqual(parsed, {
    code: { view: "workspace", projectId: "p1", threadId: "t1" },
    bot: { view: "botDetail", projectId: null, threadId: null },
  });
});

test("places round-trip through storage and a failing store never throws", () => {
  const data = new Map<string, string>();
  const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  const places = rememberPlace({}, "conductor", { view: "workflows", projectId: "p2", threadId: "run" });
  saveProductPlaces(store, places);
  assert.ok(data.has(PRODUCT_PLACES_KEY));
  assert.deepEqual(loadProductPlaces(store), places);

  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("full");
    },
  };
  assert.deepEqual(loadProductPlaces(broken), {});
  assert.doesNotThrow(() => saveProductPlaces(broken, places));
});

test("a Bot's details page and the marketplace are not places to come back to; every other view is", () => {
  assert.equal(restorableView("botDetail"), "bot");
  assert.equal(restorableView("botMarket"), "bot");
  for (const view of ["workspace", "conductor", "workflows", "bot"] as const) assert.equal(restorableView(view), view);
  for (const id of PRODUCT_IDS) {
    for (const view of PRODUCTS[id].views) {
      assert.ok(PRODUCTS[id].views.includes(restorableView(view)), `${view} reopens inside ${id}`);
    }
  }
});

test("the marketplace is Deyin Bot's, and opening a panel from it returns to the Bot's chat", () => {
  assert.equal(productOfView("botMarket", "code"), "bot");
  assert.ok(PRODUCTS.bot.views.includes("botMarket"));
  assert.equal(isProductView("botMarket"), true);
});
