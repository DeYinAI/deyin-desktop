import assert from "node:assert/strict";
import { test } from "node:test";
import {
 buildDeyinUserAgent,
 deyinUserAgent,
 initUserAgent,
 resetUserAgentForTest,
} from "../src/user-agent.js";

test("initUserAgent stores the UA and deyinUserAgent returns it", () => {
 const ua = initUserAgent("desktop", "1.2.3");
 assert.equal(ua, deyinUserAgent());
 assert.match(ua, /^Deyin\/1\.2\.3 \(desktop; /);
});

test("re-initialization overwrites the stored UA", () => {
 initUserAgent("cli", "0.1.0");
 assert.match(deyinUserAgent(), /^Deyin\/0\.1\.0 \(cli; /);
 initUserAgent("web-server", "0.2.0");
 assert.match(deyinUserAgent(), /^Deyin\/0\.2\.0 \(web-server; /);
});

test("uninitialized calls produce a well-formed, stable fallback", () => {
 resetUserAgentForTest();
 const ua = deyinUserAgent();
 assert.match(ua, /^Deyin\/0\.0\.0 \(unknown; (Windows|macOS|Linux|browser); (node\/\d+\.\d+|browser)\)$/);
 assert.equal(deyinUserAgent(), ua);
});

test("format is product/version (surface; platform; runtime)", () => {
 const ua = buildDeyinUserAgent("cli", "0.1.1");
 assert.match(ua, /^Deyin\/0\.1\.1 \(cli; (Windows|macOS|Linux); node\/\d+\.\d+\)$/);
});
