import assert from "node:assert/strict";
import { test } from "node:test";
import { parseServerIdentity } from "../src/account.js";

test("parseServerIdentity returns null when the block is absent or empty", () => {
  assert.equal(parseServerIdentity(undefined), null);
  assert.equal(parseServerIdentity(null as never), null);
  assert.equal(parseServerIdentity({}), null);
  assert.equal(parseServerIdentity({ tenant: "", org: "", role: "", policies: [] }), null);
});

test("parseServerIdentity parses a full block", () => {
  const identity = parseServerIdentity({
    tenant: "default",
    org: "personal",
    role: "owner",
    policies: ["models:invoke", "tickets:manage"],
  });
  assert.deepEqual(identity, {
    tenant: "default",
    org: "personal",
    role: "owner",
    policies: ["models:invoke", "tickets:manage"],
  });
});

test("parseServerIdentity drops non-string policies and blanks", () => {
  const identity = parseServerIdentity({
    tenant: "default",
    policies: ["a", 42, null, "b"] as never,
  });
  assert.equal(identity?.tenant, "default");
  assert.deepEqual(identity?.policies, ["a", "b"]);
});
