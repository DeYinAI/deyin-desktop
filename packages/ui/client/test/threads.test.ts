import assert from "node:assert/strict";
import test from "node:test";
import { looksLikePlan } from "../src/threads.js";

test("looksLikePlan rejects short conversational replies", () => {
  assert.equal(looksLikePlan("I'm MiniMax M3, developed by Mistral AI."), false);
});

test("looksLikePlan accepts create_plan frontmatter", () => {
  const plan = `---
name: "Fix plan streaming"
overview: "Route chat vs plan panel"
---

# Fix plan streaming

1. Add planArtifactRef
2. Sync planDocRef on plan-created
`;
  assert.equal(looksLikePlan(plan), true);
});

test("looksLikePlan accepts short structured plans with numbered steps", () => {
  const plan = `# Quick fix

1. Patch app.tsx
2. Add tests
3. Verify build
`;
  assert.equal(looksLikePlan(plan), true);
});
