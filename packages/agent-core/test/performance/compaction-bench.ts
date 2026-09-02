/**
 * Two-arm compaction benchmark, modeled on Reasonix's CompactionBench.
 *
 * The **cost arm** prices maintenance passes offline and deterministically: which
 * action the policy picks per scenario, what a prune reclaims, that a second
 * pass is idempotent, and that the verbatim-tail budget scales with the window.
 * The **fidelity arm** checks the fold plumbing end to end with an injected
 * summarizer (the `complete` seam — no network): a deliberately lossy stub that
 * only reads the end of the region must still land verbatim in the briefing,
 * and the pinned prefix and verbatim tail must come through untouched.
 *
 * The fidelity number that matters here is *mechanism preservation*: everything
 * the summarizer actually said must survive the fold. Raw recall is reported for
 * context but is a property of the stub, not of the compaction code.
 */

import {
  applyPrune,
  decideCompaction,
  foldRegion,
  planPrune,
  selectRegion,
  SUMMARY_OUTPUT_MAX_TOKENS,
  tailBudgetFor,
} from "../../src/compaction.js";
import type { completeChat } from "../../src/stream.js";
import type { AgentMessage, WireTool } from "../../src/types.js";

type CompleteOpts = Parameters<typeof completeChat>[0];

// ---------------------------------------------------------------------------
// Synthetic transcripts. Uniform alphanumeric runs price at chars/4, so sizes
// below are exact in the estimator's units.
// ---------------------------------------------------------------------------

const SYSTEM = "You are a benchmark agent.";
const OPENING = "audit the workspace and report";

/** One read pair whose tool result is ~`resultTokens` tokens. */
function readPair(i: number, resultTokens: number, embed?: string): AgentMessage[] {
  const fact = embed ?? "";
  const content = `${fact}${"r".repeat(resultTokens * 4 - fact.length)}`;
  return [
    {
      role: "assistant" as const,
      content: "",
      toolCalls: [{ id: `call_${i}`, name: "read", arguments: JSON.stringify({ path: `f${i}.txt` }) }],
    },
    { role: "tool" as const, toolCallId: `call_${i}`, toolName: "read", content },
  ];
}

function transcript(pairs: number, resultTokens: number, embedFact?: (i: number) => string): AgentMessage[] {
  const messages: AgentMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: OPENING },
  ];
  for (let i = 0; i < pairs; i++) messages.push(...readPair(i, resultTokens, embedFact?.(i)));
  return messages;
}

// ---------------------------------------------------------------------------
// Cost arm
// ---------------------------------------------------------------------------

export interface CostRow {
  scenario: string;
  window: number;
  action: string;
  expected: string;
  pruneReclaimed: number;
  secondPassReclaimed: number;
  ok: boolean;
}

function runCostArm(): { rows: CostRow[]; tailBudgetsOk: boolean } {
  const rows: CostRow[] = [];

  const check = (scenario: string, window: number, messages: AgentMessage[], expected: string): CostRow => {
    const decision = decideCompaction({ messages, contextLength: window, trigger: "pressure" });
    let pruneReclaimed = 0;
    let secondPass = 0;
    if (decision.action === "prune") {
      pruneReclaimed = decision.plan.reclaimedTokens;
      applyPrune(messages, decision.plan);
      secondPass = planPrune(messages).reclaimedTokens;
    }
    return {
      scenario,
      window,
      action: decision.action,
      expected,
      pruneReclaimed,
      secondPassReclaimed: secondPass,
      ok: decision.action === expected && secondPass === 0,
    };
  };

  // Prune alone gets under the line: 34 oversized results in a 200k window —
  // the tail shelters 3, the middle 31 all shrink to the fixed cap.
  rows.push(check("prune-short-circuit", 200_000, transcript(34, 5_000), "prune"));
  // Prune cannot get under the line: 10 results in a 32k window stay over
  // COMPACT_RATIO even after every one is capped, so the fold must be chosen.
  rows.push(check("fold-required", 32_000, transcript(10, 5_000), "fold"));
  // Below the line: no mutation at all, the prefix stays cache-stable.
  rows.push(check("stand-down", 200_000, transcript(7, 5_000), "none"));

  // The tail scales with the window (min(16k, 25%)): a 32k model must not keep
  // half its window verbatim or there is nothing left to fold.
  const expectedBudgets: Array<[number, number]> = [
    [32_000, 8_000],
    [64_000, 16_000],
    [128_000, 16_384],
    [200_000, 16_384],
  ];
  const tailBudgetsOk = expectedBudgets.every(
    ([window, expected]) => tailBudgetFor(window) === expected,
  );

  return { rows, tailBudgetsOk };
}

// ---------------------------------------------------------------------------
// Fidelity arm
// ---------------------------------------------------------------------------

export interface FidelityResult {
  planted: number;
  survived: number;
  /** Pinned + verbatim-tail facts + exactly the facts the stub summarizer kept. */
  expectedSurvivors: number;
  /** Every verbatim-tail message object is still in the post-fold transcript. */
  tailImmune: boolean;
  /** The pinned prefix (system + opening user turn) survived untouched. */
  pinnedIntact: boolean;
  /** The fold request was the cache-aligned shape: real prefix + one instruction. */
  shapeOk: boolean;
}

const DUMMY_TOOLS: WireTool[] = [
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a file.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
];

async function runFidelityArm(): Promise<{ result: FidelityResult; passed: boolean }> {
  // 10 pairs in a 32k window force a fold. Each tool result carries one planted
  // fact; one more lives in the pinned opening turn.
  const factAt = (i: number): string =>
    `FACT-${String(i).padStart(2, "0")}: decision D${i} rotates the key every 30 days. `;
  const opening = { role: "user" as const, content: `${OPENING}\nFACT-OPEN: the workspace is the monorepo root. ` };
  const messages: AgentMessage[] = [
    { role: "system", content: SYSTEM },
    opening,
    ...Array.from({ length: 10 }, (_, i) => readPair(i, 4_000, factAt(i))).flat(),
  ];

  const region = selectRegion(messages, tailBudgetFor(32_000));
  const facts = ["FACT-OPEN", ...Array.from({ length: 10 }, (_, i) => `FACT-${String(i).padStart(2, "0")}`)];

  // The lossy stub: derives its briefing ONLY from the last 5 messages of the
  // replayed prefix (everything it was sent before the instruction). Whatever
  // it says must land verbatim — that is the plumbing under test.
  let shapeOk = true;
  const keptFacts = new Set<string>();
  const complete = async (opts: CompleteOpts): Promise<{ content: string; usage: null }> => {
    const instruction = opts.messages[opts.messages.length - 1]!;
    const prefix = opts.messages.slice(0, -1);
    shapeOk &&= instruction.role === "user" && instruction.content.startsWith("Compact the preceding conversation");
    shapeOk &&= prefix[0]!.role === "system" && prefix[0]!.content === SYSTEM;
    shapeOk &&= prefix.length === region.end;
    shapeOk &&= opts.maxTokens === SUMMARY_OUTPUT_MAX_TOKENS;
    shapeOk &&= opts.tools === DUMMY_TOOLS;
    for (const m of prefix.slice(-5)) {
      for (const f of facts) if (m.content.includes(f)) keptFacts.add(f);
    }
    // Joined bare (no ": <detail>") — the survival check must still find them,
    // which is the point: the briefing lands verbatim.
    return { content: [...keptFacts].join("\n"), usage: null };
  };

  const tailMessages = messages.slice(region.end);
  const tailFacts = facts.filter((f) => tailMessages.some((m) => m.content.includes(f)));

  const fold = await foldRegion({
    apiBaseUrl: "http://bench.invalid",
    token: "bench",
    model: "bench-model",
    messages,
    region,
    tools: DUMMY_TOOLS,
    complete,
  });

  const pinnedIntact = messages[0]!.role === "system" && messages[0]!.content === SYSTEM && messages[1] === opening;
  // Non-vacuous: the very objects captured before the fold must still be on the
  // surface afterwards, byte-for-byte.
  const tailImmune =
    tailMessages.length > 0 && tailMessages.every((m) => messages.includes(m));

  if (fold.droppedMessages === 0) {
    return {
      result: { planted: facts.length, survived: 0, expectedSurvivors: -1, tailImmune, pinnedIntact, shapeOk },
      passed: false,
    };
  }

  const survived = facts.filter((f) => messages.some((m) => m.content.includes(f)));
  const expected = new Set<string>(["FACT-OPEN", ...tailFacts, ...keptFacts]);

  const result: FidelityResult = {
    planted: facts.length,
    survived: survived.length,
    expectedSurvivors: expected.size,
    tailImmune,
    pinnedIntact,
    shapeOk,
  };
  return { result, passed: shapeOk && tailImmune && pinnedIntact && survived.length === expected.size };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface CompactionBenchmarkResult {
  name: "compaction-benchmark";
  passed: boolean;
  cost: { rows: CostRow[]; tailBudgetsOk: boolean };
  fidelity: FidelityResult;
}

export async function runCompactionBenchmark(): Promise<CompactionBenchmarkResult> {
  const cost = runCostArm();
  const { result: fidelity, passed: fidelityPassed } = await runFidelityArm();
  const passed =
    cost.tailBudgetsOk && cost.rows.every((r) => r.ok) && fidelityPassed;
  return { name: "compaction-benchmark", passed, cost, fidelity };
}

const isMain = process.argv[1]?.endsWith("compaction-bench.ts");

if (isMain) {
  const bench = await runCompactionBenchmark();
  console.log("Compaction benchmark (cost arm)");
  console.log("");
  for (const r of bench.cost.rows) {
    console.log(
      `  ${r.ok ? "PASS" : "FAIL"}  ${r.scenario} (window ${r.window}): action=${r.action} expected=${r.expected}` +
        (r.pruneReclaimed ? `, prune reclaimed ${r.pruneReclaimed} tok, second pass ${r.secondPassReclaimed}` : ""),
    );
  }
  console.log(`  ${bench.cost.tailBudgetsOk ? "PASS" : "FAIL"}  tail budgets scale with the window`);
  console.log("");
  console.log("Compaction benchmark (fidelity arm)");
  console.log("");
  console.log(
    `  ${bench.passed ? "PASS" : "FAIL"}  ${bench.fidelity.survived}/${bench.fidelity.planted} facts survived ` +
      `(expected ${bench.fidelity.expectedSurvivors}; tail immune=${bench.fidelity.tailImmune}, ` +
      `pinned intact=${bench.fidelity.pinnedIntact}, shape ok=${bench.fidelity.shapeOk})`,
  );
  console.log("");
  process.exit(bench.passed ? 0 : 1);
}
