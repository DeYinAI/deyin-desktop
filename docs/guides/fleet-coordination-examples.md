# Fleet Coordination Examples

Real-world scenarios for the `fleet` tool with write-path claims.

## Example 1: Parallel module migration

**Goal**: Migrate `legacy/` imports to `modern/` in three packages without file conflicts.

```json
{
  "tasks": [
    {
      "profile": "explorer",
      "prompt": "Migrate legacy imports in packages/auth/src to modern paths",
      "write_paths": ["packages/auth/src"]
    },
    {
      "profile": "explorer",
      "prompt": "Migrate legacy imports in packages/api/src",
      "write_paths": ["packages/api/src"]
    },
    {
      "profile": "explorer",
      "prompt": "Migrate legacy imports in packages/ui/src",
      "write_paths": ["packages/ui/src"]
    }
  ]
}
```

Each task owns a disjoint directory — preflight passes, writers run in parallel.

## Example 2: Read-heavy fleet (no write_paths)

**Goal**: Explore three areas concurrently.

```json
{
  "tasks": [
    { "profile": "explorer", "prompt": "Map auth flow", "read_only": true },
    { "profile": "explorer", "prompt": "Map billing flow", "read_only": true },
    { "profile": "explorer", "prompt": "Map notification flow", "read_only": true }
  ]
}
```

Readers don't need claims; they share concurrency slots without write conflicts.

## Example 3: Background test run

```json
{
  "tool": "task",
  "arguments": {
    "profile": "test-runner",
    "prompt": "Run full test suite and list failures",
    "is_background": true
  }
}
```

Continue working; collect results with `wait` or on the next turn via completion notes.

## Example 4: Conflict (intentional failure)

```json
{
  "tasks": [
    { "prompt": "Edit shared config", "write_paths": ["src/config.ts"] },
    { "prompt": "Also edit shared config", "write_paths": ["src/config.ts"] }
  ]
}
```

Preflight returns error — agent must repartition (e.g. split by section or serialize).

## Anti-patterns

- Omitting `write_paths` on two writers → second claims whole workspace → conflict
- Using globs in paths → validation error
- Nested fleet from within fleet task → concurrency fail-fast

Enable fleet: **Settings → Fleet & scheduler → Fleet orchestration**.

See [FLEET_ORCHESTRATION.md](../FLEET_ORCHESTRATION.md).
