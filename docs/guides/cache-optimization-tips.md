# Cache Optimization Tips

Best practices for ≥80% prefix cache hit rate in Deyin agent sessions.

## Do

1. **Keep MCP stable** — Connect servers at session start; avoid toggling mid-conversation.
2. **Stay in one mode** — Mode switches rebuild the system prompt. Use plan mode deliberately, then return to agent.
3. **Let compaction work** — Soft warnings at 50% are free; hard compaction at 60–80% is expected on long threads.
4. **Enable cache optimizations** — Settings → Prefix cache → on (default).
5. **Monitor hit rate** — TopBar turns green at your target threshold (default 80%).
6. **Use DeepSeek or OpenAI-compatible providers** — Full prefix cache + diagnostics; others degrade gracefully.

## Avoid

1. **Adding/removing tools mid-session** — Invalidates `toolsHash`.
2. **Frequent skill/plugin toggles** — Changes system prompt bytes.
3. **Huge tool result dumps** — Triggers early compaction; snip rewrites old tool content (`log_rewrite`).
4. **Disabling prompt caching** — Unless debugging provider issues.

## When hit rate drops temporarily

After **compaction** (`log_rewrite`), the next 1–2 turns may show lower hit rate while the new prefix stabilizes. This is normal.

After **system** or **tools** invalidation, investigate with Settings → Prefix cache → Invalidation history.

## Advanced

- Run cache guard in CI: `npm test -- src/cache/__tests__/cache-guard.test.ts`
- Compare `prefixHash` across turns in developer diagnostics
- Tune warning/target thresholds for your provider pricing model

See [CACHE_ARCHITECTURE.md](../CACHE_ARCHITECTURE.md) for architecture details.
