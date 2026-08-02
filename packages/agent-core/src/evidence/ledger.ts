/**
 * Evidence ledger for delivery mode verification gates.
 *
 * Tracks mutations (file changes, bash side effects), verifications (test runs,
 * reviews, diffs), and sign-offs (complete_step receipts) per session.
 */

export type EvidenceKind = "mutation" | "verification" | "sign_off";

export interface EvidenceItem {
  id: string;
  type: EvidenceKind;
  timestamp: number;
  stepId?: string;
  toolName?: string;
  command?: string;
  paths?: string[];
  diffSummary?: string;
  reviewNotes?: string;
  verified: boolean;
}

/** Recent tool invocation recorded for complete_step validation. */
export interface ToolCallRecord {
  toolName: string;
  timestamp: number;
  command?: string;
  paths?: string[];
  ok: boolean;
}

export interface SignOffInput {
  stepId: string;
  verificationCommand: string;
  diffSummary: string;
  reviewNotes?: string;
}

export interface EvidenceSnapshot {
  items: EvidenceItem[];
  toolCalls: ToolCallRecord[];
}

const MUTATION_TOOLS = new Set(["write", "edit", "delete", "notebook_edit"]);
const VERIFICATION_COMMAND_RE =
  /\b(test|lint|typecheck|check|verify|build|npm run|pnpm run|yarn run|pytest|jest|vitest|go test|cargo test)\b/i;

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Normalize shell commands for fuzzy matching in complete_step validation. */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}

/** True when a recorded command plausibly matches the declared verification command. */
export function commandsMatch(recorded: string, declared: string): boolean {
  const a = normalizeCommand(recorded);
  const b = normalizeCommand(declared);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

export function isMutationTool(toolName: string): boolean {
  return MUTATION_TOOLS.has(toolName) || toolName === "bash";
}

export function looksLikeVerificationCommand(command: string): boolean {
  return VERIFICATION_COMMAND_RE.test(command);
}

/**
 * Per-session evidence ledger for delivery mode.
 * Serializable via toSnapshot/fromSnapshot for persistence across turns.
 */
export class EvidenceLedger {
  private items: EvidenceItem[] = [];
  private toolCalls: ToolCallRecord[] = [];
  /** Max recent tool calls retained for verification matching. */
  private readonly maxToolCalls: number;

  constructor(maxToolCalls = 200) {
    this.maxToolCalls = maxToolCalls;
  }

  recordMutation(input: { toolName: string; paths?: string[]; stepId?: string }): EvidenceItem {
    const item: EvidenceItem = {
      id: newId("mut"),
      type: "mutation",
      timestamp: Date.now(),
      toolName: input.toolName,
      paths: input.paths?.length ? [...input.paths] : undefined,
      stepId: input.stepId,
      verified: false,
    };
    this.items.push(item);
    return item;
  }

  recordVerification(input: { command: string; paths?: string[]; stepId?: string }): EvidenceItem {
    const item: EvidenceItem = {
      id: newId("ver"),
      type: "verification",
      timestamp: Date.now(),
      command: input.command,
      paths: input.paths?.length ? [...input.paths] : undefined,
      stepId: input.stepId,
      verified: true,
    };
    this.items.push(item);
    return item;
  }

  recordSignOff(input: SignOffInput): EvidenceItem {
    const item: EvidenceItem = {
      id: newId("sign"),
      type: "sign_off",
      timestamp: Date.now(),
      stepId: input.stepId,
      command: input.verificationCommand,
      diffSummary: input.diffSummary,
      reviewNotes: input.reviewNotes,
      verified: true,
    };
    this.items.push(item);
    return item;
  }

  recordToolCall(input: ToolCallRecord): void {
    this.toolCalls.push(input);
    if (this.toolCalls.length > this.maxToolCalls) {
      this.toolCalls.splice(0, this.toolCalls.length - this.maxToolCalls);
    }
  }

  /** Track a successful tool invocation and infer mutation/verification evidence. */
  observeToolCall(toolName: string, args: Record<string, unknown>, ok: boolean): void {
    const timestamp = Date.now();
    const command = typeof args.command === "string" ? args.command : undefined;
    const path = typeof args.path === "string" ? args.path : undefined;
    const paths = path ? [path] : undefined;

    this.recordToolCall({ toolName, timestamp, command, paths, ok });
    if (!ok) return;

    if (MUTATION_TOOLS.has(toolName)) {
      this.recordMutation({ toolName, paths });
      return;
    }

    if (toolName === "bash" && command) {
      if (looksLikeVerificationCommand(command)) {
        this.recordVerification({ command });
      } else {
        this.recordMutation({ toolName, paths: undefined });
      }
    }
  }

  getMutations(): EvidenceItem[] {
    return this.items.filter((i) => i.type === "mutation");
  }

  getVerifications(): EvidenceItem[] {
    return this.items.filter((i) => i.type === "verification");
  }

  getSignOffs(): EvidenceItem[] {
    return this.items.filter((i) => i.type === "sign_off");
  }

  hasSignOffForStep(stepId: string): boolean {
    return this.getSignOffs().some((s) => s.stepId === stepId);
  }

  /** Whether a verification command was executed recently (successful bash). */
  hasRecentVerification(command: string, withinMs = 30 * 60 * 1000): boolean {
    const cutoff = Date.now() - withinMs;
    const fromTools = this.toolCalls.some(
      (c) =>
        c.ok &&
        c.toolName === "bash" &&
        c.command &&
        c.timestamp >= cutoff &&
        commandsMatch(c.command, command),
    );
    if (fromTools) return true;
    return this.getVerifications().some(
      (v) => v.command && v.timestamp >= cutoff && commandsMatch(v.command, command),
    );
  }

  /** Mutations not yet covered by a sign-off for their step (or any sign-off). */
  unverifiedMutations(): EvidenceItem[] {
    const signedSteps = new Set(this.getSignOffs().map((s) => s.stepId).filter(Boolean));
    return this.getMutations().filter((m) => {
      if (m.stepId && signedSteps.has(m.stepId)) return false;
      // Global sign-offs after mutation timestamp also count.
      const covered = this.getSignOffs().some((s) => s.timestamp >= m.timestamp);
      return !covered;
    });
  }

  /** All steps with sign-offs recorded. */
  signedOffStepIds(): Set<string> {
    return new Set(this.getSignOffs().map((s) => s.stepId).filter((id): id is string => Boolean(id)));
  }

  toSnapshot(): EvidenceSnapshot {
    return {
      items: this.items.map((i) => ({ ...i, paths: i.paths ? [...i.paths] : undefined })),
      toolCalls: this.toolCalls.map((c) => ({ ...c })),
    };
  }

  static fromSnapshot(snapshot: EvidenceSnapshot | undefined | null): EvidenceLedger {
    const ledger = new EvidenceLedger();
    if (!snapshot) return ledger;
    ledger.items = snapshot.items.map((i) => ({ ...i, paths: i.paths ? [...i.paths] : undefined }));
    ledger.toolCalls = snapshot.toolCalls.map((c) => ({ ...c }));
    return ledger;
  }

  clearTurn(): void {
    // Preserve items and tool calls across turns; delivery mode is session-scoped.
  }
}
