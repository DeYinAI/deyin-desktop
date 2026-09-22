import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { git, runGit } from "../host/git.js";
import type {
  BotElicitationRequest,
  BotStageProgress,
  BotStageStatus,
  BotWorkflowDefinition,
  BotWorkflowRunState,
} from "../types.js";
import { interpolatePrompt, type InterpolationContext } from "./interpolator.js";

export type WorkflowEventType =
  | "workflow:started"
  | "stage:started"
  | "stage:heartbeat"
  | "stage:stalled"
  | "stage:completed"
  | "stage:failed"
  | "workflow:completed"
  | "workflow:aborted";

export interface WorkflowEvent {
  type: WorkflowEventType;
  runId: string;
  workflowId: string;
  stageId?: string;
  progress?: BotStageProgress;
  state?: BotWorkflowRunState;
  message?: string;
  error?: string;
}

export type ExternalAgentRunner = (options: {
  agentId: string;
  prompt: string;
  cwd: string;
  model?: string;
  timeoutMs?: number;
  stallThresholdMs?: number;
  onRawLine?: (line: string) => void;
  onStall?: (inactiveMs: number) => void;
  onElicitation?: (request: BotElicitationRequest) => Promise<string>;
  signal?: AbortSignal;
}) => Promise<{
  ok: boolean;
  error?: string;
  outputText: string;
  artifacts?: Array<{ name: string; path: string; stageId: string; content?: string }>;
}>;

export interface WorkflowExecutionOptions {
  workflow: BotWorkflowDefinition;
  workspaceRoot: string;
  runId?: string;
  inputs?: Record<string, string>;
  keepWorktrees?: boolean;
  runner: ExternalAgentRunner;
  onEvent?: (event: WorkflowEvent) => void;
  onElicitation?: (request: BotElicitationRequest) => Promise<string>;
}

export class BotWorkflowEngine {
  private activeRuns = new Map<string, { abortController: AbortController; state: BotWorkflowRunState }>();

  async execute(options: WorkflowExecutionOptions): Promise<BotWorkflowRunState> {
    const runId = options.runId ?? randomUUID();
    const abortController = new AbortController();
    const isGit = await git.isRepo(options.workspaceRoot).catch(() => false);
    const createdWorktrees: string[] = [];
    const createdBranches: string[] = [];

    const initialStages: BotStageProgress[] = options.workflow.stages.map((s) => ({
      stageId: s.id,
      stageName: s.name,
      agentId: s.agentId,
      status: "queued" as BotStageStatus,
      elapsedMs: 0,
      heartbeatCount: 0,
      toolCallsCount: 0,
      linesProduced: 0,
    }));

    const state: BotWorkflowRunState = {
      runId,
      workflowId: options.workflow.id,
      workflowName: options.workflow.name,
      status: "running",
      currentStageIndex: 0,
      stages: initialStages,
      startedAt: Date.now(),
      totalElapsedMs: 0,
    };

    this.activeRuns.set(runId, { abortController, state });

    const emit = (event: WorkflowEvent) => {
      options.onEvent?.(event);
    };

    emit({ type: "workflow:started", runId, workflowId: options.workflow.id, state });

    const interpContext: InterpolationContext = {
      stages: {},
      artifacts: [],
      inputs: options.inputs,
      workspaceRoot: options.workspaceRoot,
    };

    let previousBranch: string | undefined;

    try {
      for (let i = 0; i < options.workflow.stages.length; i++) {
        if (abortController.signal.aborted) {
          state.status = "aborted";
          break;
        }

        const stage = options.workflow.stages[i]!;
        state.currentStageIndex = i;
        const stageProgress = state.stages[i]!;
        stageProgress.status = "running";
        stageProgress.startedAt = Date.now();

        emit({
          type: "stage:started",
          runId,
          workflowId: options.workflow.id,
          stageId: stage.id,
          progress: stageProgress,
          state,
        });

        // Setup worktree isolation if git is present
        let executionCwd = options.workspaceRoot;
        let worktreeRelPath: string | undefined;
        let branchName: string | undefined;

        if (isGit && stage.worktree?.isolate !== false) {
          branchName = stage.worktree?.branchNamePattern
            ? stage.worktree.branchNamePattern.replace("{{stage.id}}", stage.id).replace("{{run.id}}", runId.slice(0, 8))
            : `bot/${stage.id}-${runId.slice(0, 8)}`;

          worktreeRelPath = join(".deyin", "worktrees", runId.slice(0, 8), stage.id);
          const fullWorktreePath = join(options.workspaceRoot, worktreeRelPath);

          mkdirSync(join(options.workspaceRoot, ".deyin", "worktrees", runId.slice(0, 8)), { recursive: true });

          const baseArgs = ["worktree", "add", worktreeRelPath, "-b", branchName];
          if (previousBranch) {
            baseArgs.push(previousBranch);
          }

          const wtRes = await runGit(options.workspaceRoot, baseArgs).catch((err: any) => ({ ok: false, stderr: err?.message, stdout: "" }));
          if (wtRes && wtRes.ok) {
            createdWorktrees.push(worktreeRelPath);
            createdBranches.push(branchName);
            executionCwd = fullWorktreePath;
            stageProgress.worktreePath = fullWorktreePath;
            stageProgress.branchName = branchName;
          } else {
            const errMsg = wtRes?.stderr || wtRes?.stdout || "Failed to create isolated git worktree";
            stageProgress.status = "failed";
            stageProgress.error = errMsg;
            state.status = "failed";
            state.error = errMsg;
            emit({
              type: "stage:failed",
              runId,
              workflowId: options.workflow.id,
              stageId: stage.id,
              progress: stageProgress,
              error: errMsg,
              state,
            });
            break;
          }
        }

        // Interpolate user prompt with prior context
        const renderedPrompt = interpolatePrompt(stage.userPromptTemplate, interpContext);
        const fullPrompt = stage.systemPrompt ? `${stage.systemPrompt}\n\nTask:\n${renderedPrompt}` : renderedPrompt;

        // Execute via runner
        let lastHeartbeatEmit = 0;
        const runnerRes = await options.runner({
          agentId: stage.agentId,
          prompt: fullPrompt,
          cwd: executionCwd,
          model: stage.modelOverride,
          timeoutMs: stage.watchdog?.timeoutMs,
          stallThresholdMs: stage.watchdog?.stallThresholdMs,
          onRawLine: () => {
            stageProgress.linesProduced++;
            stageProgress.heartbeatCount++;
            stageProgress.lastHeartbeatAt = Date.now();
            stageProgress.elapsedMs = Date.now() - (stageProgress.startedAt ?? Date.now());
            if (stageProgress.status === "stalled") {
              stageProgress.status = "running";
              if (state.status === "stalled") {
                state.status = "running";
              }
            }
            const now = Date.now();
            if (now - lastHeartbeatEmit >= 1000) {
              lastHeartbeatEmit = now;
              emit({
                type: "stage:heartbeat",
                runId,
                workflowId: options.workflow.id,
                stageId: stage.id,
                progress: stageProgress,
              });
            }
          },
          onStall: (inactiveMs) => {
            stageProgress.status = "stalled";
            state.status = "stalled";
            emit({
              type: "stage:stalled",
              runId,
              workflowId: options.workflow.id,
              stageId: stage.id,
              progress: stageProgress,
              message: `Stage stalled after ${Math.round(inactiveMs / 1000)}s of silence.`,
            });
          },
          onElicitation: options.onElicitation,
          signal: abortController.signal,
        });

        stageProgress.finishedAt = Date.now();
        stageProgress.elapsedMs = stageProgress.finishedAt - (stageProgress.startedAt ?? Date.now());
        stageProgress.outputSummary = runnerRes.outputText;

        if (abortController.signal.aborted || state.status === "aborted") {
          stageProgress.status = "aborted";
          state.status = "aborted";
          break;
        }

        if (!runnerRes.ok) {
          stageProgress.status = "failed";
          stageProgress.error = runnerRes.error;
          state.status = "failed";
          state.error = runnerRes.error;
          emit({
            type: "stage:failed",
            runId,
            workflowId: options.workflow.id,
            stageId: stage.id,
            progress: stageProgress,
            error: runnerRes.error,
            state,
          });
          break;
        }

        // Stage succeeded!
        stageProgress.status = "completed";

        // Commit worktree changes if dirty
        let stageDiff = "";
        if (isGit && executionCwd !== options.workspaceRoot) {
          await runGit(executionCwd, ["add", "-A"]).catch(() => null);
          const statusRes = await runGit(executionCwd, ["status", "--porcelain"]).catch(() => null);
          let committed = false;
          if (statusRes?.stdout?.trim()) {
            const commitRes = await runGit(executionCwd, ["commit", "-m", `bot(${stage.id}): ${stage.name}`]).catch(() => null);
            committed = commitRes?.ok ?? false;
          }
          if (committed) {
            const diffRes = await runGit(executionCwd, ["diff", "HEAD~1"]).catch(() => null);
            if (diffRes?.ok && diffRes.stdout) {
              stageDiff = diffRes.stdout;
            }
          } else {
            const headDiff = await runGit(executionCwd, ["diff", "HEAD"]).catch(() => null);
            if (headDiff?.ok && headDiff.stdout) {
              stageDiff = headDiff.stdout;
            } else if (previousBranch && previousBranch !== branchName) {
              const branchDiff = await runGit(executionCwd, ["diff", `${previousBranch}..HEAD`]).catch(() => null);
              if (branchDiff?.ok && branchDiff.stdout) {
                stageDiff = branchDiff.stdout;
              }
            }
          }
          previousBranch = branchName;
        }

        // Collect generated artifacts
        interpContext.stages[stage.id] = {
          output: runnerRes.outputText,
          diff: stageDiff,
          branch: branchName,
        };

        if (runnerRes.artifacts && Array.isArray(runnerRes.artifacts)) {
          for (const art of runnerRes.artifacts) {
            interpContext.artifacts.push(art);
          }
        }

        if (stage.outputArtifactPatterns) {
          let totalBytes = 0;
          for (const pattern of stage.outputArtifactPatterns) {
            if (totalBytes >= 250_000) break;
            const artifactFiles = findMatchingFiles(executionCwd, pattern, 20);
            for (const file of artifactFiles) {
              if (totalBytes >= 250_000) break;
              try {
                const fullP = join(executionCwd, file);
                const content = readFileSync(fullP, "utf8");
                const capped = content.length < 50_000 ? content : content.slice(0, 50_000) + "\n... (truncated)";
                totalBytes += capped.length;
                interpContext.artifacts.push({
                  name: file,
                  path: fullP,
                  stageId: stage.id,
                  content: capped,
                });
              } catch {}
            }
          }
        }

        emit({
          type: "stage:completed",
          runId,
          workflowId: options.workflow.id,
          stageId: stage.id,
          progress: stageProgress,
          state,
        });
      }

      if (state.status === "running") {
        state.status = "completed";
      }
    } catch (err: any) {
      state.status = "failed";
      state.error = err.message;
    } finally {
      state.finishedAt = Date.now();
      state.totalElapsedMs = state.finishedAt - state.startedAt;
      this.activeRuns.delete(runId);

      // Clean up ephemeral worktree checkouts to free disk and prevent worktree locks
      if (isGit && !options.keepWorktrees) {
        for (const rel of createdWorktrees) {
          await runGit(options.workspaceRoot, ["worktree", "remove", "--force", rel]).catch(() => null);
        }
        if (state.status === "aborted" || state.status === "failed") {
          for (const branch of createdBranches) {
            await runGit(options.workspaceRoot, ["branch", "-D", branch]).catch(() => null);
          }
        }
      }

      if (state.status === "aborted") {
        emit({ type: "workflow:aborted", runId, workflowId: options.workflow.id, state, message: "Workflow execution was aborted." });
      } else {
        emit({
          type: "workflow:completed",
          runId,
          workflowId: options.workflow.id,
          state,
          error: state.error,
        });
      }
    }

    return state;
  }

  abort(runId: string): boolean {
    const active = this.activeRuns.get(runId);
    if (!active) return false;
    active.abortController.abort();
    active.state.status = "aborted";
    return true;
  }

  async mergeWorktree(workspaceRoot: string, branchName: string): Promise<{ ok: boolean; message: string }> {
    const isGit = await git.isRepo(workspaceRoot).catch(() => false);
    if (!isGit) return { ok: false, message: "Not a git repository." };

    const mergeRes = await runGit(workspaceRoot, ["merge", "--no-ff", branchName, "-m", `Merge bot branch ${branchName}`]);
    if (!mergeRes.ok) {
      return { ok: false, message: mergeRes.stderr || "Merge conflict occurred." };
    }
    return { ok: true, message: `Successfully merged ${branchName}` };
  }
}

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
  ".pdf", ".zip", ".tar", ".gz", ".7z",
  ".wasm", ".node", ".exe", ".dll", ".so", ".dylib",
  ".bin", ".mp3", ".mp4", ".mov",
]);

function isBinaryFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function findMatchingFiles(dir: string, pattern: string, maxFiles = 20): string[] {
  const results: string[] = [];
  const cleanPattern = pattern.replace(/^\*\*\//, "").replace(/\*.*$/, "");

  function walk(current: string) {
    if (results.length >= maxFiles) return;
    if (!existsSync(current)) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "out" || entry === "build" || entry === ".next") continue;
      const full = join(current, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (stat.isFile()) {
          if (isBinaryFile(full)) continue;
          const rel = relative(dir, full).replace(/\\/g, "/");
          if (cleanPattern.length === 0 || rel.includes(cleanPattern) || rel.endsWith(pattern.replace(/^\*\./, "."))) {
            results.push(rel);
          }
        }
      } catch {}
    }
  }

  walk(dir);
  return results;
}
