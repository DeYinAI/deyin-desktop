# Using the Coordinator

When to enable the two-model planner/executor and how to configure it.

## When to use the planner

Enable **Settings → Coordinator** when:

- You regularly ask for multi-file refactors or migrations
- Tasks are ambiguous ("should we use Redis or Postgres?")
- Work is high-risk (auth, security, production schema changes)
- You want research + structured plan before edits

**Skip the planner** when:

- Fixing a typo or single file
- Using Plan or Ask composer modes (coordinator is agent-only)
- You need maximum speed on trivial tasks

## Setup

1. Turn on **Coordinator** feature flag.
2. Pick a **planner model** different from your executor (e.g. fast/cheap model for planning, capable model for execution).
3. Choose **routing policy**:
   - **Conservative** — fewer planner calls; good for daily driver
   - **Balanced** — default
   - **Aggressive** — more planning on moderate tasks

## What you'll see

- **Phase events** in the transcript: routing → planning → executing
- **Coordinator routing** cards with route + reason
- On planner failure: automatic fallback to executor-only

## Tips

- Planner uses **read-only tools** — it won't edit files directly
- Executor receives a structured handoff; it may re-verify assumptions
- Planner session is **isolated** — won't break executor prefix cache
- Say "plan first" for approval-only plans without immediate execution

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Never see planner | Check flag, planner model ≠ executor, agent mode |
| Too much planning | Conservative policy |
| Too little planning | Aggressive policy or explicit "plan first" |
| Fallbacks in log | Check planner model API access |

See [COORDINATOR.md](../COORDINATOR.md) for routing rules.
