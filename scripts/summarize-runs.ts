#!/usr/bin/env tsx
/**
 * Aggregate run-summary records from session logs so workloads can be scored
 * from disk instead of scraping stdout. Every run journals one
 * `{ kind: "run-summary", summary: RunSummary }` lifecycle record into its
 * session JSONL (desktop, CLI headless, and CLI TUI all append it).
 *
 * Usage:
 *   tsx scripts/summarize-runs.ts [--json] [sessionsDir]
 *
 * Default sessionsDir: ~/.deyin/sessions
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface SummaryRecord {
  steps: number;
  toolCalls: number;
  callsByTool: Record<string, number>;
  deniedCalls: number;
  failedCalls: number;
  duplicateResults: number;
  loopGuardTrips: number;
  compactionPasses: number;
  promptTokens: number;
  cachedPromptTokens: number;
  cacheHitRate: number;
}

interface SessionSummaries {
  id: string;
  updatedAt: string;
  summaries: SummaryRecord[];
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const dirArg = args.find((a) => !a.startsWith("-"));
const sessionsDir = dirArg ?? join(homedir(), ".deyin", "sessions");

function collectSummaries(file: string): SummaryRecord[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: SummaryRecord[] = [];
  for (const line of raw.split("\n")) {
    // Cheap pre-filter: summaries are rare, transcripts are huge. A message
    // quoting the literal still gets filtered by the record-type check below.
    if (!line.includes('"run-summary"')) continue;
    try {
      const record = JSON.parse(line) as { type?: string; event?: { kind?: string; summary?: SummaryRecord } };
      if (record.type === "lifecycle" && record.event?.kind === "run-summary" && record.event.summary) {
        out.push(record.event.summary);
      }
    } catch {
      // torn line from a crash mid-append
    }
  }
  return out;
}

let entries: string[];
try {
  entries = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
} catch {
  console.error(`error: cannot read sessions dir: ${sessionsDir}`);
  process.exit(1);
}

const sessions: SessionSummaries[] = [];
for (const entry of entries) {
  const file = join(sessionsDir, entry);
  const summaries = collectSummaries(file);
  if (summaries.length === 0) continue;
  let updatedAt = "";
  try {
    updatedAt = statSync(file).mtime.toISOString();
  } catch {
    /* keep empty */
  }
  sessions.push({ id: entry.replace(/\.jsonl$/, ""), updatedAt, summaries });
}
sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

const all = sessions.flatMap((s) => s.summaries);
const total = (pick: (s: SummaryRecord) => number): number => all.reduce((acc, s) => acc + (pick(s) || 0), 0);
const promptTokens = total((s) => s.promptTokens);
const cachedPromptTokens = total((s) => s.cachedPromptTokens);
const callsByTool = new Map<string, number>();
for (const s of all) {
  for (const [name, n] of Object.entries(s.callsByTool ?? {})) callsByTool.set(name, (callsByTool.get(name) ?? 0) + n);
}

if (asJson) {
  console.log(
    JSON.stringify(
      {
        sessionsDir,
        runs: all.length,
        totals: {
          steps: total((s) => s.steps),
          toolCalls: total((s) => s.toolCalls),
          deniedCalls: total((s) => s.deniedCalls),
          failedCalls: total((s) => s.failedCalls),
          duplicateResults: total((s) => s.duplicateResults),
          loopGuardTrips: total((s) => s.loopGuardTrips),
          compactionPasses: total((s) => s.compactionPasses),
          promptTokens,
          cachedPromptTokens,
          cacheHitRate: promptTokens > 0 ? cachedPromptTokens / promptTokens : 0,
        },
        callsByTool: Object.fromEntries([...callsByTool.entries()].sort((a, b) => b[1] - a[1])),
        perSession: sessions.map((s) => ({ id: s.id, updatedAt: s.updatedAt, runs: s.summaries.length })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (all.length === 0) {
  console.log(`No run-summary records found in ${sessionsDir}`);
  console.log("(Runs started before this feature landed, or the directory is empty.)");
  process.exit(0);
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
console.log(`Run summaries in ${sessionsDir}`);
console.log("");
const header = ["session", "runs", "steps", "tools", "denied", "failed", "dupes", "guards", "cache"].join(" | ");
console.log(header);
console.log("-".repeat(header.length));
for (const s of sessions) {
  const t = (pick: (x: SummaryRecord) => number): number => s.summaries.reduce((acc, x) => acc + (pick(x) || 0), 0);
  const p = s.summaries.reduce((acc, x) => acc + (x.promptTokens || 0), 0);
  const c = s.summaries.reduce((acc, x) => acc + (x.cachedPromptTokens || 0), 0);
  console.log(
    [
      s.id.slice(0, 18),
      s.summaries.length,
      t((x) => x.steps),
      t((x) => x.toolCalls),
      t((x) => x.deniedCalls),
      t((x) => x.failedCalls),
      t((x) => x.duplicateResults),
      t((x) => x.loopGuardTrips),
      p > 0 ? pct(c / p) : "-",
    ].join(" | "),
  );
}
console.log("-".repeat(header.length));
console.log(
  [
    `TOTAL (${all.length} runs)`,
    all.length,
    total((s) => s.steps),
    total((s) => s.toolCalls),
    total((s) => s.deniedCalls),
    total((s) => s.failedCalls),
    total((s) => s.duplicateResults),
    total((s) => s.loopGuardTrips),
    promptTokens > 0 ? pct(cachedPromptTokens / promptTokens) : "-",
  ].join(" | "),
);
console.log("");
console.log("Calls by tool:");
for (const [name, n] of [...callsByTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${name}: ${n}`);
}
