import assert from "node:assert/strict";
import test from "node:test";
import { ExternalAgentDetector } from "../src/main/external-agents/detector.js";
import { ExternalAgentService } from "../src/main/external-agents/service.js";

test("ExternalAgentDetector scans system and detects installed/missing tools safely", async () => {
  const detector = new ExternalAgentDetector();
  const agents = await detector.detectAll(true);

  assert.ok(Array.isArray(agents));
  assert.ok(agents.length >= 4);

  const ids = agents.map((a) => a.id);
  assert.ok(ids.includes("codex"));
  assert.ok(ids.includes("claude"));
  assert.ok(ids.includes("opencode"));
  assert.ok(ids.includes("zcode"));

  for (const agent of agents) {
    assert.ok(typeof agent.installed === "boolean");
    assert.ok(typeof agent.name === "string");
    assert.ok(Array.isArray(agent.availableModels));
    assert.ok(agent.availableModels.length > 0);
  }
});

test("ExternalAgentDetector testAgent returns informative status", async () => {
  const detector = new ExternalAgentDetector();
  const testRes = await detector.testAgent("non-existent-agent");
  assert.equal(testRes.ok, false);
  assert.match(testRes.message, /not recognized/);
});

test("ExternalAgentService abort and nudge handle non-existent runs gracefully", () => {
  const service = new ExternalAgentService();
  assert.equal(service.abortRun("invalid-run-id"), false);
  assert.equal(service.nudgeRun("invalid-run-id"), false);
});
