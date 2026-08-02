# Evidence Workflow Tutorial

Step-by-step guide to Delivery mode with evidence gates.

## Prerequisites

1. Enable **Settings → Delivery & evidence → Delivery mode**
2. Open a workspace with tests or lint commands
3. Switch composer to **Delivery** mode

## Step 1: Create todos with acceptance criteria

Ask the agent (or it will be prompted):

> Add user settings page with tests

The agent should call `todo_write`:

```json
{
  "todos": [
    {
      "id": "settings-ui",
      "content": "Add settings page component",
      "status": "pending",
      "acceptanceCriteria": "pnpm test -- settings.test.tsx passes"
    },
    {
      "id": "settings-route",
      "content": "Wire settings route",
      "status": "pending",
      "acceptanceCriteria": "pnpm lint passes on changed files"
    }
  ]
}
```

**Gate**: Without todos + criteria, `write`/`edit` mutations are blocked.

## Step 2: Implement a step

Agent marks step `in_progress` and edits files. Mutations are recorded in the evidence ledger.

## Step 3: Verify

Agent runs the acceptance command:

```bash
pnpm test -- settings.test.tsx
```

Successful `bash` runs are recorded as verifications.

## Step 4: Sign off

Agent calls `complete_step`:

```json
{
  "step_id": "settings-ui",
  "verification_command": "pnpm test -- settings.test.tsx",
  "diff_summary": "Added SettingsPage.tsx and unit tests",
  "review_notes": "Covers empty state"
}
```

## Step 5: Complete todos

Update `todo_write` to mark step `completed`.

## Step 6: Finish all steps

Repeat for each todo. **Finalization gate** blocks "done" text until:

- Every active todo has `complete_step` sign-off
- All todos are `completed`
- No unverified mutations remain

## Common gate errors

| Error | Recovery |
|-------|----------|
| `no_todos` | Call `todo_write` first |
| `no_acceptance_criteria` | Add criteria to each todo |
| `verification_command not found` | Run exact command with bash |
| `unsigned_steps` | Call `complete_step` |
| Premature "all done" text | Complete remaining sign-offs |

## Settings

- **Require acceptance criteria** — mutation gate (recommended)
- **Strict finalization** — blocks done until all evidence complete

## When not to use Delivery

Fast iteration, spikes, and exploratory edits — use **Agent** mode instead.

See [EVIDENCE_DELIVERY.md](../EVIDENCE_DELIVERY.md) for API reference.
