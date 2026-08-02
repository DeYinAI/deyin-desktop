import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { SecurityFindingsReport } from "../shared/types.js";

function safeSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`Invalid ${label}.`);
  }
  return trimmed;
}

/** Persists security scan reports per thread under userData/security-findings/. */
export class SecurityFindingsStore {
  private root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(this.root, { recursive: true });
  }

  private filePath(threadId: string): string {
    const safeThread = safeSegment(threadId, "thread id");
    return join(this.root, `${safeThread}.json`);
  }

  listFindings(threadId: string): SecurityFindingsReport | null {
    const file = this.filePath(threadId);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as SecurityFindingsReport;
    } catch {
      return null;
    }
  }

  saveReport(threadId: string, report: SecurityFindingsReport): SecurityFindingsReport {
    const file = this.filePath(threadId);
    writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
    return report;
  }

  mergeReport(threadId: string, incoming: SecurityFindingsReport): SecurityFindingsReport {
    const existing = this.listFindings(threadId);
    const merged = existing
      ? {
          ...incoming,
          findings: dedupeFindings([...existing.findings, ...incoming.findings]),
          sources: [...new Set([...(existing.sources ?? []), ...(incoming.sources ?? [])])],
        }
      : incoming;
    return this.saveReport(threadId, merged);
  }

  clearFindings(threadId: string): void {
    const file = this.filePath(threadId);
    if (existsSync(file)) unlinkSync(file);
  }
}

function dedupeFindings<T extends { ruleId: string; message: string; location?: { file?: string; line?: number } }>(
  findings: T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const f of findings) {
    const key = `${f.ruleId}|${f.location?.file ?? ""}|${f.location?.line ?? 0}|${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
