import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOT_CATALOG,
  CATALOG_CATEGORIES,
  CATALOG_ORIGIN_PREFIX,
  catalogEntry,
  catalogOriginOf,
  forYou,
  isCatalogCategory,
  searchCatalog,
  type CatalogEntry,
} from "../src/bots/catalog.js";
import { parseBotTemplate, stringifyBotTemplate, templateLink } from "../src/bots/template.js";

const ids = (entries: readonly CatalogEntry[]) => entries.map((entry) => entry.id);

/* The shipped starters ------------------------------------------------------------- */

test("the four recovered example Bots are shipped, rewritten, each under its own Deyin name", () => {
  const derived = BOT_CATALOG.filter((entry) => entry.derivedFrom).map((entry) => [entry.derivedFrom, entry.template.name]);
  assert.deepEqual(derived, [
    ["Overheard", "Standup Scribe"],
    ["Tradbot", "Market Watcher"],
    ["Meeting Recap Deck", "Meeting Recap"],
    ["Pitch Deck Coach", "Pitch Coach"],
  ]);
  for (const [from, to] of derived) assert.notEqual(from, to, "none is shipped under the recovered name");
});

test("every starter is a real template: it survives being written out and read back, and has what a Bot needs", () => {
  assert.ok(BOT_CATALOG.length >= 6);
  for (const entry of BOT_CATALOG) {
    const read = parseBotTemplate(stringifyBotTemplate(entry.template));
    assert.deepEqual(read, entry.template, entry.id);
    assert.ok(entry.template.purpose.length > 200, `${entry.id} says what the Bot is for`);
    assert.ok(entry.template.skills.length >= 1, `${entry.id} has a skill`);
    assert.ok(entry.blurb.length > 20 && entry.blurb.length <= 160, `${entry.id}'s listing is one sentence`);
    assert.ok(entry.tags.length >= 4, entry.id);
    assert.ok(isCatalogCategory(entry.category), entry.id);
    assert.ok(entry.template.avatarShape && entry.template.avatarColor, `${entry.id} has its own look`);
  }
});

test("catalog ids are unique and safe to keep on a Bot, and names do not collide", () => {
  assert.equal(new Set(ids(BOT_CATALOG)).size, BOT_CATALOG.length);
  assert.equal(new Set(BOT_CATALOG.map((entry) => entry.template.name)).size, BOT_CATALOG.length);
  for (const entry of BOT_CATALOG) assert.match(entry.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
});

test("no starter can spend money, send anything out, post publicly or sign in anywhere by itself, and says so in its own words", () => {
  for (const entry of BOT_CATALOG) {
    assert.match(entry.template.purpose, /never spend money, send a message or email on someone's behalf, post anything publicly, or sign in anywhere/, entry.id);
  }
  const market = catalogEntry("market-watcher")!;
  assert.match(market.template.purpose, /never place, prepare or confirm a trade/);
  assert.match(market.template.purpose, /not give personal financial advice/);
});

test("a starter's routines are sensible: none is tighter than the allowed spacing, each says what it does, and the cron is a real one", () => {
  for (const entry of BOT_CATALOG) {
    for (const routine of entry.template.routines) {
      assert.ok(routine.prompt.length > 30, `${entry.id}: ${routine.name}`);
      if (routine.schedule.kind === "cron") {
        const fields = routine.schedule.expression.split(" ");
        assert.ok(fields.length === 5, routine.schedule.expression);
        assert.ok(!/^\*(\/[1-4])?$/.test(fields[0]!), `${entry.id}: not every minute`);
        assert.ok(/^\d+$/.test(fields[0]!) && /^\d+$/.test(fields[1]!), `${entry.id}: at a stated time, once a day`);
      }
    }
  }
});

test("a starter's skills can be followed: each has steps, and the routines that use a skill name one it has", () => {
  for (const entry of BOT_CATALOG) {
    for (const skill of entry.template.skills) assert.match(skill.body, /\n1\. /, `${entry.id}/${skill.name} has numbered steps`);
    for (const routine of entry.template.routines) {
      const named = /\b([a-z]+(?:-[a-z]+)+) skill\b/.exec(routine.prompt)?.[1];
      if (named) assert.ok(entry.template.skills.some((skill) => skill.name === named), `${entry.id}: ${routine.name} names ${named}`);
    }
  }
});

test("a starter fits in a link or is told it does not: the answer is the same every time", () => {
  for (const entry of BOT_CATALOG) {
    const first = templateLink(entry.template);
    assert.equal(templateLink(entry.template), first, entry.id);
    if (first) assert.deepEqual(parseBotTemplate(first), entry.template, entry.id);
  }
});

test("a starter can be found by id, and an id that is not one is not found", () => {
  assert.equal(catalogEntry("pitch-coach")?.template.name, "Pitch Coach");
  assert.equal(catalogEntry("nope"), undefined);
  assert.equal(catalogEntry(""), undefined);
});

test("a Bot made from a starter says which, and a Bot that was not has nothing to say", () => {
  assert.equal(CATALOG_ORIGIN_PREFIX, "catalog:");
  assert.equal(catalogOriginOf("catalog:pitch-coach"), "pitch-coach");
  assert.equal(catalogOriginOf("bot_123"), undefined);
  assert.equal(catalogOriginOf(undefined), undefined);
  assert.equal(catalogOriginOf(""), undefined);
  assert.equal(catalogOriginOf("catalog:"), "");
  assert.equal(catalogOriginOf("xcatalog:pitch-coach"), undefined);
});

test("categories are a closed set", () => {
  for (const category of CATALOG_CATEGORIES) assert.equal(isCatalogCategory(category), true);
  for (const bad of ["", "Work", "misc", 1, null, undefined]) assert.equal(isCatalogCategory(bad), false, String(bad));
  for (const entry of BOT_CATALOG) assert.ok((CATALOG_CATEGORIES as readonly string[]).includes(entry.category));
  for (const category of CATALOG_CATEGORIES) assert.ok(BOT_CATALOG.some((entry) => entry.category === category), `${category} is not empty`);
});

/* Browse ---------------------------------------------------------------------------- */

test("browsing with nothing typed shows everything, and a category narrows it", () => {
  assert.deepEqual(ids(searchCatalog(BOT_CATALOG, "")), ids(BOT_CATALOG));
  assert.deepEqual(ids(searchCatalog(BOT_CATALOG, "   ")), ids(BOT_CATALOG));
  assert.deepEqual(ids(searchCatalog(BOT_CATALOG, "", "dev")), ["release-notes-writer", "bug-report-triager"]);
  assert.deepEqual(ids(searchCatalog(BOT_CATALOG, "", "research")), ["market-watcher"]);
});

test("a search finds a Bot by its name, its listing or a tag, and every word typed has to match", () => {
  assert.deepEqual(ids(searchCatalog(BOT_CATALOG, "standup")), ["standup-scribe"]);
  assert.deepEqual(ids(searchCatalog(BOT_CATALOG, "STANDUP")), ["standup-scribe"], "case does not matter");
  assert.deepEqual(ids(searchCatalog(BOT_CATALOG, "investor")), ["pitch-coach"], "a tag");
  assert.deepEqual(ids(searchCatalog(BOT_CATALOG, "changelog git")), ["release-notes-writer"], "both words");
  assert.deepEqual(ids(searchCatalog(BOT_CATALOG, "changelog pitch")), [], "one word that matches nothing rules it out");
  assert.deepEqual(ids(searchCatalog(BOT_CATALOG, "zzzz")), []);
  assert.deepEqual(ids(searchCatalog(BOT_CATALOG, "notes", "dev")), ["release-notes-writer"], "a search within a category");
  assert.deepEqual(ids(searchCatalog(BOT_CATALOG, "standup", "dev")), []);
});

test("searching punctuation or very short words does not match everything by accident", () => {
  assert.deepEqual(ids(searchCatalog(BOT_CATALOG, "!!!")), ids(BOT_CATALOG), "nothing searchable typed is the same as nothing typed");
  assert.deepEqual(ids(searchCatalog(BOT_CATALOG, "a")), ids(BOT_CATALOG), "one-letter words are ignored");
  assert.deepEqual(ids(searchCatalog(BOT_CATALOG, "a standup")), ["standup-scribe"]);
});

/* For You ------------------------------------------------------------------------------ */

test("For You puts what the person does not have first, and keeps the catalog's order when nothing else separates them", () => {
  assert.deepEqual(ids(forYou(BOT_CATALOG, { have: new Set(), interests: [] })), ids(BOT_CATALOG));
  const withTwo = forYou(BOT_CATALOG, { have: new Set(["standup-scribe", "pitch-coach"]), interests: [] });
  assert.deepEqual(ids(withTwo).slice(-2), ["standup-scribe", "pitch-coach"], "what they already have goes last, in catalog order");
  assert.deepEqual(ids(withTwo).slice(0, 4), ["market-watcher", "meeting-recap", "release-notes-writer", "bug-report-triager"]);
});

test("For You puts what overlaps with what the person's own Bots are for ahead of the rest", () => {
  const dev = forYou(BOT_CATALOG, { have: new Set(), interests: ["Release helper", "Writes changelog notes from git commits"] });
  assert.equal(dev[0]!.id, "release-notes-writer");
  const finance = forYou(BOT_CATALOG, { have: new Set(), interests: ["Follows markets and stocks, writes a daily brief"] });
  assert.equal(finance[0]!.id, "market-watcher");
});

test("something they have already never beats something new, however well it matches", () => {
  const list = forYou(BOT_CATALOG, { have: new Set(["release-notes-writer"]), interests: ["release changelog git commits notes versions"] });
  assert.equal(list.at(-1)!.id, "release-notes-writer");
  assert.notEqual(list[0]!.id, "release-notes-writer");
});

test("the same Bots always give the same list, and the catalog itself is never reordered", () => {
  const before = ids(BOT_CATALOG);
  const signals = { have: new Set(["pitch-coach"]), interests: ["deck", "notes"] };
  assert.deepEqual(ids(forYou(BOT_CATALOG, signals)), ids(forYou(BOT_CATALOG, signals)));
  assert.deepEqual(ids(BOT_CATALOG), before);
  assert.equal(forYou(BOT_CATALOG, signals).length, BOT_CATALOG.length, "nothing is dropped");
  assert.deepEqual(forYou([], signals), []);
});
