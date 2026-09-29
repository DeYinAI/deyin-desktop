import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext } from "../src/context.js";
import { createCliServer, maxStepsFromBody } from "../src/server.js";

test("a request's maxSteps: a number caps, null means unlimited, anything else defers to the server", () => {
  assert.equal(maxStepsFromBody(8), 8);
  assert.equal(maxStepsFromBody(null), null, "explicit null must survive as unlimited, not become 'unset'");
  for (const untrusted of [undefined, "8", {}, [], true]) {
    assert.equal(maxStepsFromBody(untrusted), undefined, `${JSON.stringify(untrusted)} is not a cap`);
  }
});

test("serve exposes health and enforces an optional bearer token", async () => {
  const server = createCliServer(createContext({ cwd: process.cwd() }), { authToken: "test-token" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.equal(typeof address, "object");
  const port = (address as { port: number }).port;
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(denied.status, 401);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: "Bearer test-token" } });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { ok: boolean }).ok, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
