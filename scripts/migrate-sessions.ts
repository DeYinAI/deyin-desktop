#!/usr/bin/env tsx
/**
 * Migrate session JSONL files to v2 metadata (prefix_hash, cache_stats).
 *
 * Usage:
 *   tsx scripts/migrate-sessions.ts [--dry-run] [sessionsDir]
 *
 * Default sessionsDir: ~/.deyin/sessions
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { backfillSessionDirectory } from "../packages/agent-core/src/migration/backfill.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dirArg = args.find((a) => !a.startsWith("-"));
const sessionsDir = dirArg ?? join(homedir(), ".deyin", "sessions");

if (!existsSync(sessionsDir)) {
  console.log("No sessions to migrate");
  process.exit(0);
}

console.log(`Migrating sessions in ${sessionsDir}${dryRun ? " (dry run)" : ""}...`);

const summary = backfillSessionDirectory(sessionsDir, { dryRun });

console.log(JSON.stringify(summary, null, 2));

if (summary.errors.length > 0) {
  process.exit(1);
}

console.log(`Done: ${summary.migrated} migrated, ${summary.skipped} skipped, ${summary.total} total.`);
