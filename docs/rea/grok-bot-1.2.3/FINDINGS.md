# Grok Bot 1.2.3: reverse-engineering findings

Deyin Bot is a functional re-implementation of the product shape documented here. This directory is the
specification it was built against. It holds interface metadata only (names, field numbers, enum values,
tool-name sets). No Grok Bot source, UI copy, or assets are copied into Deyin.

## Provenance

| Item | Value |
| --- | --- |
| Artifact | `grok-bot_1.2.3_amd64.deb` (Linux x64), 117,301,248 bytes |
| URL | `https://downloads.cursor.com/grokbot/stable/a5927fa2ba82336a29f9343babd28b4c903abbb2/linux/x64/grok-bot_1.2.3_amd64.deb` |
| Server ETag / Last-Modified | `d1f6d13e5758780218fbe61875be77b8-14` / Wed, 18 Nov 2026 06:57:53 GMT |
| App identity (`app.asar` `package.json`) | `name: sand`, `productName: Grok Bot`, `version: 1.2.3`, `sandTrack: stable`, `sandBuiltAt: 2026-11-18T06:49:25.556Z` |
| Retrieved | 2026-11-19 |
| Tooling | REA 6.9.0 (`rea-agents`, Node 24.22.3), `@electron/asar`, `recover-contract.mjs` in this directory |
| Docs cross-checked | `docs.x.ai/grok-bot/*` (overview, how-grok-bot-works, bots, skills-routines-and-automations, computer-and-apps) |

The installer and the extracted tree were deleted after analysis. To reproduce:

```bash
ar x grok-bot_1.2.3_amd64.deb && tar -xf data.tar.xz
npx @electron/asar extract "opt/Grok Bot/resources/app.asar" asar
node recover-contract.mjs asar ./out        # byte-identical to the JSON files here
rea analyze-javascript-application asar/dist/renderer --artifact-format directory \
    --detail summary --evidence_output ./evidence --view '{"kind":"javascript-routes","collection":"routes"}'
```

## What was recovered

| File | Contents | Count |
| --- | --- | --- |
| `proto-services.json` | RPC services and methods (`aiserver.v1.*`) | 9 services, 778 methods |
| `grokbot-methods.txt` | `GrokBotService` methods, sorted | 528 |
| `proto-shapes.json` | Protobuf message descriptors: `no name type` per field | 2,928 |
| `proto-enums.json` | Protobuf enums with values | 414 |
| `connector-readonly-tools.json` | Per-connector read-only tool sets (Gmail 9, Calendar 7, Drive 18) | 3 |
| `avatar-palette.json` | Bot avatar vocabulary read from the bundled renderer: shapes, default shape pool, colors, and expression states (grouped) | 25 shapes (8 default), 11 colors, 5 state groups (17 lifecycle states) |

> **Intentional divergence — avatars.** `avatar-palette.json` is evidence of what Grok Bot ships, not a spec for Deyin. Deyin Bot draws its own avatars: 10 brand-tinted forms, a 12-color palette and an orbit mark (core, ring, travelling dot) instead of a face. No shape name, color id or color value is shared with the recovered palette (`packages/host-core/test/bot-avatar.test.ts` fails if one is). Ids from before the redesign are mapped to their closest equivalent when a Bot is read, so existing Bots keep a stable look.

## Architecture as shipped

- Electron desktop client over a protobuf RPC backend (`aiserver.v1.GrokBotService`, `SandBoxService`).
  The renderer is a React SPA; the main process holds credentials, connectors and the local-tool channel.
- All Bot state (identity, memory, routines, transcripts) is server-side. The desktop is a thin client.
- Execution happens on a **shared per-user computer** (`SandBoxService`: browser, filesystem, terminal).
  Bots share it: "when one Bot signs in to a site, your other Bots are signed in too".
- A user's own machine can join as an execution target (`GrokBotUserComputerHello { label, local_root,
  terminals_folder, standing, supervised, capabilities }`). That is the seam Deyin generalizes to
  "run on a server you own".
- `GrokBotAgentHarnessKind` is `BOX | TEMPORAL`; Deyin maps this to `local | server`.

## Product surface (from chunk inventory and feature flags)

Bot roster/detail/sharing (`bot-manage-*`, `bot-share-*`, `team-bot-*`), routines
(`bot-manage-automation-*`, `automation-detail-panel`), Auto Review (`auto-review-selector`,
`sand-auto-review-instructions`), Vault (`vault-card-*`, `grok-bot-vault-login-dialogs`), teach-by-demonstration
(`teach-recording-controls`), marketplace (`shared-bots-browse`, `marketplace-*`), Slack/Teams/iMessage surfaces,
voice calls, shopping/travel commerce stages, library/files, onboarding, billing.

## Decisions that follow from the findings

1. **Bots share a computer, not one each.** Deyin Bot models a *runtime* that many Bots attach to.
2. **Permissions are three-layer**: per-tool `always_allow | needs_approval | blocked`, connector `reads`/`writes`
   defaults, then plain-English allow/block instructions evaluated by Auto Review. Block beats allow.
3. **Approval modes** are `auto_review | read_only | run_everything`; automation runs never prompt (they deny).
4. **Credentials never reach the model.** Vault entries fill into pages; the model only sees that a login exists.
5. **Memory is per-Bot**, with a small shared set (name, time zone).

## Deliberate divergences

Local-first execution; a user-owned server instead of a vendor cloud computer; no vendor account requirement;
a designated **primary** Bot is modelled explicitly; Deyin Conductor (external-CLI pipelines) is a separate
product, not a Bot mode. See `docs/PARITY-GROK-BOT.md` for the per-surface audit.

## Limits of this analysis

- REA's `javascript-routes` view returned empty: the renderer is a SPA without a static route table. Surface
  inventory therefore comes from chunk names, feature flags and the protobuf contract, not from routes.
- Message shapes give field names, numbers and scalar/message kinds. Nested message and enum types are
  referenced by `#n` index and were resolved by name where needed, not exhaustively.
- Behavior (timing, error text, ordering guarantees) was not observed at runtime: the app was never executed
  and needs a paid vendor account to sign in. Anything not in the contract or the public docs is unverified.
- The English UI strings are inline in the bundle and were read for vocabulary only. They are intentionally
  not stored here.
