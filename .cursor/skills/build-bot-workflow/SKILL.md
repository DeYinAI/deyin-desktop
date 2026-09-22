---
name: build-bot-workflow
description: Design, build, edit, and validate multi-agent orchestration bot workflows for Deyin Desktop directly via code and configuration files (.deyin/workflows/*.json). Use whenever the user asks to create, build, generate, configure, or modify an external bot or multi-agent workflow pipeline (e.g. chaining Claude, Codex, ZCode, OpenCode, or Cursor with specific models). Operates purely through direct file manipulation and code generation—never uses computer-use or browser automation.
---

# Build Bot Workflow (Deyin Multi-Agent Orchestrator)

This skill teaches the agent how to design, generate, edit, and validate multi-agent bot workflows for **Deyin Desktop** directly via code and JSON configuration files.

**CRITICAL RULE: NEVER use `computer-use` or browser automation to click UI buttons.** Deyin's workflow engine is file-first: writing or modifying `.deyin/workflows/<workflow-id>.json` causes Deyin Desktop to automatically discover, list, and make the workflow executable in the UI, Bot Mode HUD, and CLI.

---

## 1. File Storage Location & Auto-Discovery

All workflows live in the workspace root:
```
<workspaceRoot>/.deyin/workflows/<workflow-slug>.json
```

- When creating a workflow, ensure the directory exists: `mkdir -p .deyin/workflows`.
- `BotWorkflowsStore` in Deyin automatically monitors `.deyin/workflows/*.json`. Any valid JSON file placed here immediately appears in:
  1. **Left Sidebar**: Under "Saved Pipelines" in Bot Mode.
  2. **Telemetry HUD (BotFlowPanel)**: In the pipeline selector dropdown.
  3. **Workflows View**: In the full-window master-detail editor for 1-click execution or visual editing.
  4. **Chat Orchestrator**: Accessible to `@bot` delegation tools.

---

## 2. Complete Workflow JSON Schema

A valid workflow file must strictly conform to the `BotWorkflowDefinition` schema:

```json
{
  "id": "kebab-case-unique-id",
  "name": "Human-Readable Title",
  "description": "Short explanation of the pipeline's purpose and agent handoffs.",
  "createdAt": 1758547200000,
  "updatedAt": 1758547200000,
  "schedule": {
    "enabled": false,
    "cronExpression": "0 * * * *",
    "intervalMinutes": 60
  },
  "stages": [
    {
      "id": "stage-1-id",
      "name": "1. Stage Name",
      "agentId": "claude",
      "modelOverride": "opus-5.0",
      "systemPrompt": "Optional persona / role instructions for this stage.",
      "userPromptTemplate": "Task instructions. Can reference {{inputs.goal}}.",
      "worktree": {
        "isolate": true,
        "branchNamePattern": "bot/{{stage.id}}-{{run.id}}"
      },
      "watchdog": {
        "timeoutMs": 900000,
        "stallThresholdMs": 120000,
        "onStallAction": "alert-user"
      },
      "outputArtifactPatterns": ["**/*.md"]
    }
  ]
}
```

---

## 3. Supported Agents & Model Overrides

Deyin Desktop auto-detects and connects to local AI coding clients:

| `agentId` | Name | Protocol | Typical Models (`modelOverride`) | Best Used For |
|---|---|---|---|---|
| `claude` | Claude Code CLI | `headless-cli` | `opus-5.0`, `claude-4.6-sonnet`, `claude-4.5-opus`, `claude-3-7-sonnet` | High-level planning, deep architectural reasoning, refactoring |
| `codex` | OpenAI Codex CLI | `headless-cli` | `gpt-5.6-luna`, `gpt-5.3-codex`, `o3-mini`, `gpt-4o` | Reviewing specs, adversarial critique, unit test generation |
| `zcode` | ZCode / GLM Agent (Zed ACP) | `acp` | `glm-5.3-flash-high`, `glm-5.3`, `glm-5-turbo`, `glm-4.7` | High-throughput implementation, fast multi-file coding |
| `opencode` | OpenCode AI Agent | `acp` | `anthropic/claude-sonnet-4-20250514`, `openai/gpt-4o`, `local/llama3` | OSS/local model tasks, validation scripts |
| `cursor` | Cursor CLI | `headless-cli` | `auto`, `composer-2.5-fast`, `claude-4.6-sonnet` | Quick edits and workspace linting |

*Note: If the user provides a custom model name (e.g. "Opus 5.0", "gpt 5.6 luna", "glm 5.3 flash high"), preserve it accurately in `modelOverride`.*

---

## 4. Context & Variable Interpolation Syntax

Stages execute sequentially. Downstream stages receive outputs and artifacts from upstream stages via template expressions:

| Variable Template | Description | Example Usage |
|---|---|---|
| `{{inputs.<name>}}` | Inputs passed when triggering the pipeline | `{{inputs.goal}}` or `{{inputs.feature}}` |
| `{{stage.<id>.output}}` | Text output / summary produced by prior stage | `{{stage.plan.output}}` |
| `{{stage.<id>.diff}}` | Git diff produced by prior stage in its worktree | `{{stage.implement.diff}}` |
| `{{stage.<id>.branch}}` | Branch name where prior stage committed | `{{stage.implement.branch}}` |
| `{{artifacts}}` | Formatted contents of matched output artifacts | `Review these artifacts:\n{{artifacts}}` |
| `{{workspace.root}}` | Root directory path of active workspace | `{{workspace.root}}` |

---

## 5. Standard Pipeline Patterns

### Pattern A: Tri-Bot "Plan -> Review -> Implement" (Recommended)
1. **Stage 1 (Plan)**: `claude` (e.g. `opus-5.0`) explores the codebase and drafts a specification.
2. **Stage 2 (Review Plan)**: `codex` (e.g. `gpt-5.6-luna`) critiques the plan from Stage 1 (`{{stage.plan.output}}`), finding edge cases and missing security constraints.
3. **Stage 3 (Implement)**: `zcode` (e.g. `glm-5.3-flash-high`) writes code in an isolated git worktree according to the reviewed plan (`{{stage.review-plan.output}}`).

### Pattern B: Quad-Bot "Plan -> Spec -> Code -> Verify"
1. `claude` (Plan & Architecture)
2. `codex` (Test Specification & Acceptance Criteria)
3. `zcode` (Implementation in Isolated Worktree)
4. `opencode` (Test Execution & Assertion Verification)

---

## 6. Execution Procedure When Asked to Build a Workflow

When a user asks:
> *"Create a workflow: 1. Plan with claude opus 5.0, 2. review plan with codex gpt 5.6 luna, 3. implement with zcode glm 5.3 flash high"*

Follow these steps:

1. **Infer Workflow Parameters**:
   - Slug: Derive a clean kebab-case ID (e.g. `plan-review-implement`).
   - Title: Formulate a descriptive name.
   - Stages: Create clear stage IDs (`plan`, `review-plan`, `implement`).
   - Context passing: Ensure Stage 2 user prompt includes `{{stage.plan.output}}`, and Stage 3 includes `{{stage.review-plan.output}}`.
   - Worktree: Set `isolate: true` so changes are committed to a safe branch (`bot/<stage>-<runId>`).
   - Watchdog: Set standard timeouts (`timeoutMs: 900000`, `stallThresholdMs: 120000`).

2. **Generate the File Directly**:
   - Write to `.deyin/workflows/<id>.json`.
   - Use standard 2-space indentation.

3. **Respond to the User**:
   - Show the created file path.
   - Display the visual pipeline flow (Stage 1 -> Stage 2 -> Stage 3).
   - Inform the user that the pipeline is immediately loaded in Deyin Desktop under **Bot Mode > Workflows** and can be run with 1-click.
