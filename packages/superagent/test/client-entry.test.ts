import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/** The modules a file loads at run time: `import type` and `export type` are erased and do not count. */
function runtimeImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const match of source.matchAll(/^(?:import|export)\s+(type\s+)?(?:[^;]*?)\sfrom\s+"([^"]+)";/gm)) {
    if (!match[1]) found.push(match[2] ?? "");
  }
  for (const match of source.matchAll(/^import\s+"([^"]+)";/gm)) found.push(match[1] ?? "");
  return found;
}

test("the entry a UI imports loads no Node module, directly or through what it imports", () => {
  const seen = new Set<string>();
  const queue = [resolve(SRC, "client.ts")];
  const offenders: string[] = [];
  for (let file = queue.pop(); file; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of runtimeImports(file)) {
      if (specifier.startsWith("node:") || !specifier.startsWith(".")) {
        offenders.push(`${file.slice(SRC.length + 1)} imports ${specifier}`);
        continue;
      }
      const next = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
      assert.ok(existsSync(next), `${specifier} from ${file} does not resolve`);
      queue.push(next);
    }
  }
  assert.deepEqual(offenders, []);
  assert.ok(seen.size >= 2, "the walk reached the settings module");
});
