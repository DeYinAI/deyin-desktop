#!/usr/bin/env node
// A stand-in for the `deyin` agent, for testing the Bot engine without a model. What it does depends on a word in the
// prompt it is given on stdin, and what it was started with is written to FAKE_LOG_DIR for the test to read back.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  console.log("deyin 9.9.9");
  process.exit(0);
}
if (argv[0] === "whoami") {
  if (process.env.FAKE_SIGNED_OUT === "1") {
    console.log("Not signed in. Run `deyin login`.");
    process.exit(2);
  }
  console.log("tester");
  process.exit(0);
}
if (argv[0] !== "run") {
  console.error(`unknown command ${argv[0]}`);
  process.exit(64);
}

const log = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const done = (finalText, reason = "completed") => log({ type: "result", finalText, reason });

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (stdin += chunk));
process.stdin.on("end", () => {
  const dir = process.env.FAKE_LOG_DIR ?? process.cwd();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `run-${process.pid}.json`), JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid, stdin }));

  if (stdin.includes("SLEEP")) {
    writeFileSync(join(dir, "sleeping.pid"), String(process.pid));
    setTimeout(() => {}, 60_000);
    return;
  }
  if (stdin.includes("FAIL")) {
    console.error("boom happened");
    process.exit(1);
  }
  if (stdin.includes("AUTH")) {
    console.error("not signed in");
    process.exit(2);
  }
  if (stdin.includes("WRITE")) writeFileSync("made-by-agent.txt", "hi");
  if (stdin.includes("SPOOF")) log({ type: "engine-exit", code: 0, timedOut: false, aborted: false });
  if (stdin.includes("NOISE")) {
    process.stdout.write("not json at all\n");
    const half = JSON.stringify({ type: "text-delta", delta: "split across two writes" });
    process.stdout.write(half.slice(0, 10));
    setTimeout(() => {
      process.stdout.write(`${half.slice(10)}\n`);
      done("noisy");
    }, 50);
    return;
  }
  if (stdin.includes("SLOW")) {
    setTimeout(() => done("slow done"), 400);
    return;
  }
  if (stdin.includes("STEPS")) {
    log({ type: "text-delta", delta: "partial" });
    done("partial", "max-steps");
    return;
  }
  log({ type: "text-delta", delta: "thinking" });
  done(`echo: ${stdin.trim()}`);
});
