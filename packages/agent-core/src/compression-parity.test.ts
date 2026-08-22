/**
 * Parity test: TS compressToolOutput vs the native Rust port.
 * Verifies the native fast path returns byte-identical output to the TS
 * implementation across content shapes and modes.
 *
 * Run: npx tsx src/compression-parity.test.ts
 * (wired into `pnpm --filter @deyin/agent-core test`)
 */
import { createRequire } from "node:module";
import { compressToolOutput } from "./compression.js";
import { nativeAvailable } from "./native.js";

interface NativeCore {
  available: boolean;
  compressWireText(content: string, mode: string): { compressed: string };
  compressWireTextEx(content: string, mode: string, toolName: string, preserveErrors: boolean): { compressed: string };
}

let napi: NativeCore | null = null;
try {
  napi = createRequire(import.meta.url)("@deyin/native-core") as NativeCore;
} catch {
  napi = null;
}

if (!nativeAvailable() || !napi?.available) {
  if (process.env.CI === "true") {
    console.error("Native module required in CI but unavailable");
    process.exit(1);
  }
  console.log("native module unavailable — parity test skipped (TS path still exercised)");
  process.exit(0);
}

const cases: [string, string, "aggressive" | "balanced" | "conservative"][] = [
  [
    "log-dupes",
    Array.from({ length: 60 }, (_, i) => `2026-08-22T15:00:0${i % 10}Z INFO line ${i < 10 ? `unique-${i}` : "same"}`).join("\n"),
    "balanced",
  ],
  ["errors", ["ERROR: disk full", "2026-08-22 INFO ok", "FATAL abort", ...Array(50).fill("WARN minor")].join("\n"), "balanced"],
  ["short", "just a short message\nwith two lines", "balanced"],
  ["long-lines", Array.from({ length: 5 }, (_, i) => `${"x".repeat(600)} end-${i}`).join("\n"), "balanced"],
  ["ansi", "\x1b[31mERROR\x1b[0m boom\n\x1b[32mok\x1b[0m\n" + "filler\n".repeat(60), "aggressive"],
  ["conservative-log", `2026-08-22 INFO start\n${"step\n".repeat(80)}2026-08-22 ERROR done`, "conservative"],
  ["empty", "", "balanced"],
  ["json-ish", '{"a":1,"b":[2,3]}\n{"a":1,"b":[2,3]}\nplain text line', "balanced"],
];

let pass = 0;
let fail = 0;
for (const [name, input, mode] of cases) {
  for (const [variant, opts, preserveErrors] of [
    ["default", { mode }, false],
    ["preserveErrors", { mode, preserveErrors: true }, true],
  ] as const) {
    const viaToolOutput = compressToolOutput(input, "bash", opts).compressed;
    const raw = napi.compressWireTextEx(input, mode, "bash", preserveErrors).compressed;
    const tag = `${name}:${variant}`;
    if (viaToolOutput === raw) {
      pass += 1;
      console.log(`[${tag}] PASS (${raw.length} chars)`);
    } else {
      fail += 1;
      console.log(`[${tag}] MISMATCH toolOutput=${viaToolOutput.length} raw=${raw.length}`);
      console.log(`  toolOutput: ${JSON.stringify(viaToolOutput.slice(0, 200))}`);
      console.log(`  raw:        ${JSON.stringify(raw.slice(0, 200))}`);
    }
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
