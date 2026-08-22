# Evidence & Delivery Mode

Delivery mode adds production-ready quality gates to the agent loop. Every workspace mutation must be tied to todos with acceptance criteria, and every step must be signed off with verifiable evidence before the agent can finalize a turn.

## When to use delivery mode

Use **Delivery** in the composer mode switcher when:

- Shipping production code that must be verified before declaring done
- You want the agent to run tests/checks and record sign-offs per todo step
- False-positive "done" responses would harm trust in the workflow

**Agent** mode remains the default for fast iteration without evidence gates.

## Workflow

1. **Plan todos with criteria** — Call `todo_write` with stable `id`, `content`, `status`, and `acceptanceCriteria` on each step.
2. **Implement** — Mark a step `in_progress`, make edits (`write`/`edit`/`bash`). Mutations are recorded in the evidence ledger.
3. **Verify** — Run the acceptance command with `bash` (e.g. `npm test`, `pnpm lint`).
4. **Sign off** — Call `complete_step` with:
   - `step_id` — must match a todo id
   - `verification_command` — must match a successful bash run in this session
   - `diff_summary` — what changed
   - `review_notes` — optional quality notes
5. **Complete todos** — Update `todo_write` to mark the step `completed`.
6. **Finish** — Only after all active todos are completed and signed off can the agent end the turn without a gate rejection.

## Readiness gates

| Gate | Trigger | Requirement |
|------|---------|-------------|
| Mutation | `write`, `edit`, `delete`, `notebook_edit`, non-verification `bash` | At least one active todo with `acceptanceCriteria` |
| Finalization | Model returns text without tool calls | All todos signed off via `complete_step`, no unverified mutations, all todos `completed` |
| Premature done | Final text matches completion phrases | Same as finalization |

Gate failures appear in the chat timeline as **Delivery gate** cards and are injected back into the transcript as user reminders so the model can recover.

## complete_step tool

```json
{
  "step_id": "implement-auth",
  "verification_command": "npm test -- auth.test.ts",
  "diff_summary": "Added session middleware and unit tests",
  "review_notes": "Edge case: expired tokens return 401"
}
```

Validation rules:

- `step_id` must exist in the current todo list (not cancelled)
- `verification_command` must match a recent successful `bash` invocation
- Step must not already be signed off
- Evidence ledger must be enabled (delivery mode)

## Evidence ledger

The ledger tracks three evidence kinds per session:

- **mutation** — file edits and side-effect bash commands
- **verification** — test/lint/build bash commands
- **sign_off** — `complete_step` receipts

The ledger persists on the desktop thread session across turns. Switching from delivery to agent mode preserves evidence; gates are only enforced while delivery mode is active.

## API reference

Core modules live in `packages/agent-core/src/evidence/`:

- `EvidenceLedger` — record and query evidence
- `checkMutationReadiness(todos)` — pre-mutation gate
- `checkFinalizationReadiness(todos, ledger)` — pre-done gate
- `blockPrematureCompletion(text, todos, ledger)` — detect early "done" language

Enable gates in `runAgent`:

```typescript
await runAgent({
  evidenceGatesEnabled: options.mode === "delivery",
  evidenceLedger: session.evidenceLedger ?? new EvidenceLedger(),
  // ...
});
```

## Settings (Phase 7)

Configure in **Settings → Advanced agent features → Delivery & evidence**:

| Setting | Default | Purpose |
|---------|---------|---------|
| `enableDeliveryMode` | off | Show Delivery in composer + enforce gates |
| `evidenceRequireAcceptanceCriteria` | on | Mutation gate |
| `evidenceStrictFinalization` | on | Block done until sign-offs complete |

## Observability

- Gate rejections appear as **Delivery gate** cards in chat
- Logged to `deyin.log` as `[evidence-gate] code: message`
- Weekly metrics: rejections vs sign-offs in Settings stats
- Rejection log in developer diagnostics (when exposed per thread)

## Tutorial

Step-by-step walkthrough: [guides/evidence-workflow-tutorial.md](./guides/evidence-workflow-tutorial.md)

## Troubleshooting

| Error | Fix |
|-------|-----|
| `no_todos` | Call `todo_write` before editing files |
| `no_acceptance_criteria` | Add `acceptanceCriteria` to each active todo |
| `verification_command not found` | Run the exact command with `bash` first |
| `unsigned_steps` | Call `complete_step` for each open todo |
| `unverified_mutations` | Sign off steps that produced file changes |

## Related

- Agent profile: `DELIVERY_AGENT` in `packages/agent-core/src/agents.ts`
- Architecture: [CACHE_ARCHITECTURE.md](./CACHE_ARCHITECTURE.md)
