/**
 * Starter pipelines for Conductor. A template fixes the shape (stages, roles,
 * hand-offs, prompts) and leaves two things open: which agent runs each stage,
 * which comes from the user's role preferences at the moment the template is
 * used, and the goal, which is either written into the prompts or left as
 * `{{inputs.goal}}` for a pipeline that is always started from chat.
 *
 * Browser-safe (no `node:` imports): the pipelines page offers these as its
 * starting points and the authoring skill reads the same data, so the two never
 * describe different pipelines.
 */
import type { ConductorRole, ConductorWorkflowDefinition, WorkflowStageDefinition } from "./types.js";

/** Marks where a template's prompts take the user's goal. */
export const CONDUCTOR_TEMPLATE_GOAL_MARKER = "{{goal}}";
const GOAL_MARKER = CONDUCTOR_TEMPLATE_GOAL_MARKER;

export interface ConductorTemplateStage {
  id: string;
  name: string;
  role: ConductorRole;
  systemPrompt: string;
  userPromptTemplate: string;
  /**
   * Run in an isolated git worktree. A stage that edits code needs it, and so
   * does one that must see an earlier stage's code (it starts from that stage's
   * branch). Only a read-only stage that works on the live tree turns it off.
   */
  isolate: boolean;
}

export interface ConductorPipelineTemplate {
  id: string;
  name: string;
  /** One sentence: what the pipeline is for and how work is handed along. */
  summary: string;
  /** Whether the prompts take a goal; false for pipelines that act on the repository as it is. */
  takesGoal: boolean;
  stages: ConductorTemplateStage[];
}

export const CONDUCTOR_PIPELINE_TEMPLATES: readonly ConductorPipelineTemplate[] = [
  {
    id: "plan-build-review",
    name: "Plan, Build, Review",
    summary: "One agent plans the change, another builds it in an isolated worktree, a third reviews the result.",
    takesGoal: true,
    stages: [
      {
        id: "plan",
        name: "Plan",
        role: "plan",
        isolate: false,
        systemPrompt:
          "You are a principal engineer. Research the codebase and write a concrete implementation plan. You do not modify files.",
        userPromptTemplate: `Objective:\n${GOAL_MARKER}\n\nResearch the codebase and write a plan: the files to change, the approach, the edge cases, and how to verify the result.`,
      },
      {
        id: "build",
        name: "Build",
        role: "code",
        isolate: true,
        systemPrompt:
          "You are a careful software engineer. Follow the existing conventions of the codebase and leave no regressions.",
        userPromptTemplate:
          "Implement this plan.\n\n=== PLAN ===\n{{stage.plan.output}}\n===========\n\nAdd or update tests, make sure the project builds, and make sure the tests pass.",
      },
      {
        id: "review",
        name: "Review",
        role: "review",
        isolate: true,
        systemPrompt:
          "You are a senior reviewer. Report concrete problems only: bugs, missing cases, missing tests and regressions.",
        userPromptTemplate:
          "Review this change against the plan. If you find no problems, say so plainly.\n\n=== PLAN ===\n{{stage.plan.output}}\n\n=== CHANGES ===\n{{stage.build.diff}}",
      },
    ],
  },
  {
    id: "fix-and-verify",
    name: "Fix and verify",
    summary: "One agent fixes a bug and adds a regression test, another checks the fix by running the project's tests.",
    takesGoal: true,
    stages: [
      {
        id: "fix",
        name: "Fix",
        role: "code",
        isolate: true,
        systemPrompt: "You are a careful software engineer. Find the root cause and make the smallest correct change.",
        userPromptTemplate: `Fix this problem:\n${GOAL_MARKER}\n\nFind the root cause, fix it, and add a regression test that fails without the fix.`,
      },
      {
        id: "verify",
        name: "Verify",
        role: "test",
        isolate: true,
        systemPrompt: "You verify changes by running them. You report results honestly, including what you could not check.",
        userPromptTemplate:
          "Check that this fix works.\n\n=== CHANGES ===\n{{stage.fix.diff}}\n\nRun the project's build and tests. Report what you ran, what passed, and anything that fails or is not covered.",
      },
    ],
  },
  {
    id: "review-changes",
    name: "Review current changes",
    summary: "One agent reviews the uncommitted changes in the repository and reports problems by severity.",
    takesGoal: false,
    stages: [
      {
        id: "review",
        name: "Review",
        role: "review",
        isolate: false,
        systemPrompt:
          "You are a senior reviewer. Report concrete problems only, with the file and line, and order them by severity. You do not modify files.",
        userPromptTemplate:
          "Review the uncommitted changes in this repository (start from `git diff HEAD`). Look for bugs, edge cases, missing tests, security problems and regressions. If you find none, say so plainly.",
      },
    ],
  },
  {
    id: "docs-refresh",
    name: "Docs refresh",
    summary: "One agent finds documentation that no longer matches the code, another rewrites it in an isolated worktree.",
    takesGoal: false,
    stages: [
      {
        id: "audit",
        name: "Audit",
        role: "review",
        isolate: false,
        systemPrompt:
          "You compare documentation with the code it describes. You cite the doc and the code for every mismatch. You do not modify files.",
        userPromptTemplate:
          "Find places where the documentation (README, docs/, code comments that document behavior) no longer matches the code. List each mismatch with the doc location, what it says, and what the code actually does.",
      },
      {
        id: "update",
        name: "Update docs",
        role: "docs",
        isolate: true,
        systemPrompt: "You are a technical writer. Keep the existing tone and structure, and change only what is wrong.",
        userPromptTemplate:
          "Fix every mismatch in this audit. Change documentation only, not code.\n\n=== AUDIT ===\n{{stage.audit.output}}",
      },
    ],
  },
];

export function findConductorTemplate(id: string): ConductorPipelineTemplate | undefined {
  return CONDUCTOR_PIPELINE_TEMPLATES.find((template) => template.id === id);
}

export interface InstantiateConductorTemplateOptions {
  /** The agent for each stage's role; the caller resolves it from the user's preferences. */
  agentForRole: (role: ConductorRole) => string;
  /**
   * The user's goal, written into the prompts as plain text. Leave it out for a
   * reusable pipeline: the prompts then read `{{inputs.goal}}`, which is only
   * filled when a run is started from chat with a goal.
   */
  goal?: string;
  /** Pipeline id; "" lets the editor derive one from the name on save. Defaults to the template id. */
  id?: string;
  /** Creation time in milliseconds; defaults to now. */
  now?: number;
}

/** The standard watchdog every template stage runs under. */
const WATCHDOG = { timeoutMs: 900_000, stallThresholdMs: 120_000, onStallAction: "alert-user" } as const;

/** A runnable pipeline from a template: agents chosen by role, the goal filled in. */
export function instantiateConductorTemplate(
  template: ConductorPipelineTemplate,
  options: InstantiateConductorTemplateOptions,
): ConductorWorkflowDefinition {
  const now = options.now ?? Date.now();
  const goalText = options.goal?.trim() ? options.goal.trim() : "{{inputs.goal}}";
  const stages: WorkflowStageDefinition[] = template.stages.map((stage) => ({
    id: stage.id,
    name: stage.name,
    role: stage.role,
    agentId: options.agentForRole(stage.role),
    systemPrompt: stage.systemPrompt,
    userPromptTemplate: stage.userPromptTemplate.split(GOAL_MARKER).join(goalText),
    worktree: { isolate: stage.isolate },
    watchdog: { ...WATCHDOG },
  }));
  return {
    id: options.id ?? template.id,
    name: template.name,
    description: template.summary,
    stages,
    schedule: { enabled: false },
    createdAt: now,
    updatedAt: now,
  };
}
