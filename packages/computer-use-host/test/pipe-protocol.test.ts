import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRpcRequest, parseRpcLine } from "../src/host-api.js";

test("JSON-RPC wire format", () => {
  const line = formatRpcRequest({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
  assert.equal(line, '{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}\n');
  const res = parseRpcLine('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
  assert.deepEqual(res?.result, { ok: true });
});
