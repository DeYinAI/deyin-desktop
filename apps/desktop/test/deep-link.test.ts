import assert from "node:assert/strict";
import { test } from "node:test";
import { templateLink, type BotTemplate } from "@deyin/host-core";
import { MAX_IMPORT_LINK, PendingImport, routeDeepLink } from "../src/main/deep-link.js";

const TEMPLATE: BotTemplate = {
  format: "deyin.bot-template",
  version: 1,
  name: "Scribe",
  title: "",
  description: "",
  role: "assistant",
  purpose: "",
  publicDescription: "",
  skills: [],
  routines: [],
};

test("a shared Bot goes to the person to look at, with the link as it came", () => {
  const link = templateLink(TEMPLATE)!;
  assert.deepEqual(routeDeepLink(link), { kind: "bot-import", link });
  assert.deepEqual(routeDeepLink(`  ${link}\n`), { kind: "bot-import", link });
  assert.equal(routeDeepLink(link.replace("deyin://", "DEYIN://"))?.kind, "bot-import", "the scheme's case does not matter");
  assert.equal(routeDeepLink("deyin://bot/import")?.kind, "bot-import", "an empty offer still goes to the person, who is told it carries nothing");
});

test("every other link is the sign-in handler's, as before", () => {
  for (const url of ["deyin://auth/callback?code=abc&state=xyz", "deyin://oauth?x=1", "deyin://bot/other", "deyin://bots/import", "deyin://bot/importer?t=x"]) {
    assert.deepEqual(routeDeepLink(url), { kind: "auth", url }, url);
  }
});

test("nothing, or a link too long to be one made by Deyin, goes nowhere", () => {
  assert.equal(routeDeepLink(undefined), null);
  assert.equal(routeDeepLink(""), null);
  const huge = `deyin://bot/import?t=${"A".repeat(MAX_IMPORT_LINK)}`;
  assert.equal(routeDeepLink(huge), null);
  const justFits = `deyin://bot/import?t=${"A".repeat(MAX_IMPORT_LINK - "deyin://bot/import?t=".length)}`;
  assert.equal(justFits.length, MAX_IMPORT_LINK);
  assert.equal(routeDeepLink(justFits)?.kind, "bot-import");
});

test("a link that arrives before the window is ready waits, is handed over once, and a newer one replaces an older", () => {
  const pending = new PendingImport();
  assert.equal(pending.take(), null);
  pending.offer("deyin://bot/import?t=one");
  pending.offer("deyin://bot/import?t=two");
  assert.equal(pending.take(), "deyin://bot/import?t=two");
  assert.equal(pending.take(), null);
});
