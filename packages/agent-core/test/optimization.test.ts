import assert from "node:assert/strict";
import { test } from "node:test";
import { ContentCompressor, compressCode, compressJSON, compressToolOutput } from "../src/compression.js";
import { countTokens, truncateToTokens } from "../src/tokenizer.js";
import { buildWireMessages, toWireMessages } from "../src/wire.js";
import { scoreMessageImportance } from "../src/compaction.js";

test("compressCode strips block comments and blank lines", () => {
 const src = `function hi() {\n  /* noise */\n  return 1;\n\n\n}\n`;
 const res = compressCode(src, { mode: "balanced" });
 assert.ok(!res.compressed.includes("noise"));
 assert.ok(res.compressed.includes("return 1"));
 assert.ok(res.tokensRemoved >= 0);
});

test("compressCode preserves C/C++ preprocessor directives", () => {
 const src = `#include <stdio.h>\n#define FOO 1\n#ifdef BAR\nint x = 0;\n#endif\n// real comment\nint main() { return 0; }\n`;
 const balanced = compressCode(src, { mode: "balanced" });
 assert.ok(balanced.compressed.includes("#include <stdio.h>"), "balanced must keep #include");
 assert.ok(balanced.compressed.includes("#define FOO 1"), "balanced must keep #define");
 assert.ok(balanced.compressed.includes("#ifdef BAR"), "balanced must keep #ifdef");
 assert.ok(!balanced.compressed.includes("real comment"), "balanced should strip line comments");
 const aggressive = compressCode(src, { mode: "aggressive" });
 assert.ok(aggressive.compressed.includes("#include <stdio.h>"), "aggressive must keep #include");
 assert.ok(aggressive.compressed.includes("#define FOO 1"), "aggressive must keep #define");
});

test("compressJSON removes nulls", () => {
  const res = compressJSON(JSON.stringify({ a: 1, b: null, c: 2 }), { mode: "balanced" });
  assert.equal(res.compressed, '{"a":1,"c":2}');
});

test("compressToolOutput strips ANSI and dedupes", () => {
  const out = "\u001b[31merror\u001b[0m\nline\nline\nline\nok";
  const res = compressToolOutput(out, "bash", { mode: "balanced" });
  assert.ok(!res.compressed.includes("\u001b"));
  assert.ok(res.compressed.includes("duplicate"));
});

test("preserveErrors keeps early error lines in long noisy logs", () => {
  // Flood with error-hint lines so important.length >= budget and the
  // non-preserve path falls back to last-N (dropping the early ERROR).
  const lines: string[] = ["ERROR: boom at start"];
  for (let i = 0; i < 200; i++) lines.push(`noise line ${i}`);
  for (let i = 0; i < 200; i++) lines.push(`ERROR: filler ${i}`);
  const out = lines.join("\n");
  const withFlag = compressToolOutput(out, "bash", { mode: "balanced", preserveErrors: true });
  assert.ok(withFlag.compressed.includes("ERROR: boom at start"), "preserveErrors must keep early error");
  const without = compressToolOutput(out, "bash", { mode: "balanced", preserveErrors: false });
  assert.equal(without.compressed.includes("ERROR: boom at start"), false, "without preserveErrors last-N may drop early error");
});

test("tokenizer counts and truncates", () => {
  const n = countTokens("hello world");
  assert.ok(n >= 2);
  const t = truncateToTokens("one two three four five", 2);
  assert.ok(countTokens(t) <= 2);
});

test("wire compression is opt-in", () => {
 const messages = [
 { role: "system" as const, content: "sys" },
 { role: "tool" as const, toolCallId: "1", toolName: "bash", content: "\u001b[31mx\u001b[0m" },
 ];
 const plain = toWireMessages(messages);
 assert.equal((plain[1] as { content: string }).content.includes("\u001b"), true);

 const built = buildWireMessages(messages, { enableCompression: true, compressionMode: "balanced" });
 assert.equal((built.messages[1] as { content: string }).content.includes("\u001b"), false);
 assert.ok(built.compression);
 assert.ok(built.compression!.originalTokens > 0);
 assert.ok(built.compression!.compressedTokens <= built.compression!.originalTokens);
});

test("anthropic cache_control on last system message", () => {
  const wire = toWireMessages(
    [
      { role: "system", content: "stable instructions ".repeat(20) },
      { role: "user", content: "hi" },
    ],
    { enablePromptCaching: true, provider: "anthropic" },
  );
  const sys = wire[0] as { content: unknown };
  assert.ok(Array.isArray(sys.content));
  const block = (sys.content as { cache_control?: { type: string } }[])[0]!;
  assert.equal(block.cache_control?.type, "ephemeral");
});

test("importance scoring prefers errors", () => {
  const msgs = [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: "do thing" },
    { role: "tool" as const, toolCallId: "1", toolName: "bash", content: "ERROR: boom" },
  ];
  const errScore = scoreMessageImportance(msgs[2]!, 2, 3);
  const userScore = scoreMessageImportance(msgs[1]!, 1, 3);
  assert.ok(errScore > userScore);
});

test("ContentCompressor detectContentType", () => {
  const c = new ContentCompressor();
  assert.equal(c.detectContentType('{"a":1}'), "json");
  assert.equal(c.detectContentType("export function x() {}"), "code");
});
