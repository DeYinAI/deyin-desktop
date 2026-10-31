# Superagent

Superagent is a proactive coding agent for **one GitHub repository**. It watches the repository for requests from people
you allow, decides which ones it may act on, and works each accepted request in its own git worktree, ending in a pull
request. Everything runs on your computer, inside Deyin, while the app is open. Desktop only.

It is **off by default**, and with an empty allow-list it never acts on anything.

The design follows [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
(MIT). The agents' instructions in `packages/superagent/prompts` and `packages/superagent/skills` are that project's
Markdown prompts, unchanged (see `packages/superagent/UPSTREAM-LICENSE`). The code around them is Deyin's own:
`packages/superagent` (the engine, GitHub client, store and prompts, with no dependency on Electron) and
`apps/desktop/src/main/superagent` (the desktop side: it runs the agents on Deyin's own agent loop).

## How a request becomes a pull request

```
GitHub ──poll──▶ messages ──▶ policy ──▶ assessment ──▶ ticket ──▶ worker (worktree) ──▶ pull request
                               │            │                          │
                       who may ask,     the orchestrator          one git worktree
                       what counts      agent reads the           and one session
                       as a request     thread and decides        per ticket
```

1. **Poll.** Every _Check GitHub every_ seconds Deyin reads new issues, pull requests and comments from the repository,
   as the agent's own account.
2. **Policy.** A message is a request only if its author is on the allow-list. If it addresses the agent (an
   `@mention` of its account) it is an **explicit** request in every mode. Otherwise the _What counts as a request_
   table decides whether it is ignored, treated as a request, or left for the agent to judge.
3. **Assessment.** The _orchestrator_ agent reads the thread and either accepts the request (opening a ticket under one
   of your rules), asks a question, answers, or leaves it alone.
4. **Work.** A _worker_ agent gets its own worktree and branch (`agent/…`), makes the change, and opens a pull request.
   You review and merge it; Superagent never merges.
5. **Conversation.** Replies on GitHub go out from the agent's account. If a worker needs an answer it asks on the
   thread, and your reply is delivered to it.

## Setting up

1. **Create a GitHub account for the agent.** Use a dedicated account, not your own, so its activity is attributed to it
   and its access can be limited to the one repository.
2. **Create a token for that account.** A fine-grained personal access token on the repository with _Contents_,
   _Issues_ and _Pull requests_ set to **read and write**.
3. **Open Superagent** in the sidebar, choose the _Set up_ tab, paste the token and press **Connect**. Deyin checks it
   with GitHub and shows the account it belongs to. A token GitHub rejects is not kept.
4. **Set the repository** (`owner/name`) and choose what to watch (issues, pull requests, comments).
5. **List who may ask.** Add GitHub logins to _Allowed accounts_, one per line. The agent's own account cannot be on the
   list. _Trusted bots_ are read as context but never act as a request.
6. **Review the rules.** Each rule is plain text that says what the agent may take on, and where it stops. Two are
   provided (copy fixes and visual fixes); edit them, turn them off, or add your own.
7. **Save**, then switch **On**. The _Needs setup_ banner lists whatever is still missing.

Start in **Observe** mode. It reads everything and records, under _Recent decisions_, what it _would_ have taken on,
without acting. When those decisions match what you would have wanted, switch the mode to **Auto**.

| Mode          | What it does                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| Mentions only | Acts only when an allowed account addresses the agent directly. Nothing else is assessed.                      |
| Observe       | Mentions as above. Other messages are assessed and recorded as "would accept", without acting.                 |
| Auto          | Mentions, and other requests the agent judges to fall within your rules.                                       |

**Pause** keeps everything but stops new work. **Off** stops all running work.

## The Activity tab

- **Tickets** are listed with the ones that need a person first: a question to answer, a blocked worker, a pull request
  that could not be delivered, a failure. Open one to see its conversation, the worker's reports, its branch and
  worktree. You can stop a ticket, or retry or resume one.
- **Waiting for assessment** shows messages queued for the orchestrator.
- **Recent decisions** shows what was accepted or ignored and why. A message ignored only because of Observe mode can be
  assessed again.
- **Replies on GitHub** shows what the agent posted, or failed to.

## What it can and cannot do

- Workers run **as you, with your environment**, in a worktree of the repository. Deyin does not sandbox them. File
  tools are confined to the worktree, but a shell command is not. _Blocked commands_ (Settings → Workers) is a
  best-effort screen of commands the shell refuses to start; it is **not a security boundary**. If you do not trust the
  people on the allow-list, or the contents of the repository, run Deyin in a VM or as a dedicated user.
- Workers get file, search, git, shell, web fetch and search, and to-do tools. They do not get the browser, computer use,
  MCP servers, your memory, or tools that need a person to answer. The orchestrator gets only its own `orchestrator_*`
  tools: it can read the thread, but not run a command or touch a file.
- The agent account's token is stored **encrypted** with the operating system's secret store (Electron `safeStorage`),
  in a file readable only by you. On Linux without a keyring it falls back to a plain file with the same permissions,
  and says so. The token is never logged, never sent to a model, and never shown again; it reaches only the worker's
  shell, as `GH_TOKEN`/`GITHUB_TOKEN`, so that `git` and `gh` can act as the agent.
- **`git` and `gh` must be on your `PATH`.** The _Needs setup_ list tells you if one is missing.
- The agent ignores its own messages, so it cannot trigger itself.
- The repository cannot be changed while tickets are open. Reset Superagent to start over.
- The model for assessment and for workers can be set separately; by default both use the model chosen in the app.

Not in this version: reading CI results, Feishu or other chat channels, agents editing their own settings or prompts,
and reading images from messages.

## Files

Under Deyin's data folder, in `superagent/`: `settings.json` (settings, no secrets), `state.json` (tickets, decisions,
conversations; a `.bak` copy is kept), `repos/` (the agent's own clone of the repository, unless you set a local
checkout), `work/` (worktrees, unless you set a directory), `sessions/` (each agent's conversation), and `token.json` (the
encrypted token). **Reset** deletes the tickets and conversations and returns the settings to their defaults; the token stays, and
worktrees on disk are left for you to remove.
