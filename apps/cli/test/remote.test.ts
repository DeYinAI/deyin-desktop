import assert from "node:assert/strict";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { runRemote } from "../src/remote.js";

function capture(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let value = "";
  stream.on("data", (chunk: Buffer) => (value += chunk.toString("utf8")));
  return { stream, text: () => value };
}

test("remote run forwards streamed server events and bearer auth", async () => {
  let requestBody = "";
  let auth = "";
  const server = createServer(async (req, res) => {
    auth = req.headers.authorization ?? "";
    for await (const chunk of req) requestBody += String(chunk);
    res.writeHead(200, { "content-type": "application/x-ndjson", "x-deyin-exit-code": "0" });
    res.end('{"type":"text-delta","delta":"remote answer"}\n{"type":"result","reason":"completed"}\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const out = capture();
  const events: unknown[] = [];
  try {
    const code = await runRemote({
      url: `http://127.0.0.1:${address.port}`,
      prompt: "remote prompt",
      yes: true,
      token: "secret",
      stdout: out.stream,
      stderr: capture().stream,
      onEvent: (event) => events.push(event),
    });
    assert.equal(code, 0);
    assert.equal(out.text(), "remote answer");
    assert.equal(auth, "Bearer secret");
    assert.deepEqual(events.map((event) => (event as { type: string }).type), ["text-delta", "result"]);
    assert.deepEqual(JSON.parse(requestBody), { prompt: "remote prompt", yes: true, continueLast: false, fork: false });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
