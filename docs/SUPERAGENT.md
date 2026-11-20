# Superagent

Superagent is a proactive coding agent for **one GitHub repository**. It watches the repository for requests from people
you allow, decides which ones it may act on, and works each accepted request in its own git worktree, ending in a pull
request. Everything runs on your computer, inside Deyin, while the app is open. Desktop only.

It is **off by default**, and with an empty allow-list it never acts on anything.

The design follows [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
(MIT). The agents' instructions in `packages/superagent/prompts` and `packages/superagent/skills` are that project's
Markdown prompts, unchanged (see `packages/superagent/UPSTREAM-LICENSE`); Deyin adds a short _This installation_ section
after them that says what is different here (GitHub only, no Feishu, no images). The code around them is Deyin's own:
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

You can answer a few questions in chat, or fill in the page yourself. Both end in the same settings.

### In chat

Open Superagent and press **Start in chat** on the _Set up_ tab, or type `/superagent` in any chat. The assistant asks
one question at a time and fills in:

1. the repository to watch (it offers the one in the current workspace),
2. the GitHub accounts that may ask for work,
3. the agent's own GitHub account, signed in through GitHub (see below),
4. what to watch, and whether to **Observe first** or **Act on requests**.

It then checks that the agent account can push to the repository, shows the whole setup on one line, and switches
Superagent on only when you say yes. Rules, models, worker limits and instructions stay on the dashboard under
_Advanced_; the assistant does not change them.

**A token is never typed into chat.** None of the assistant's tools (`superagent_status`, `superagent_configure`,
`superagent_connect_github`, `superagent_verify`, `superagent_set_state`, `superagent_disconnect`) has a parameter that
could carry one, and each refuses an argument it does not declare. If you paste a token anyway, the assistant is told
not to use it, and you should revoke it: it is now in that conversation.

**Signing the agent account in.** When this build includes Deyin's GitHub OAuth app, the assistant shows a one-time code
and a link (GitHub's _device flow_). Open the link in a private window signed in as the **agent** account, enter the
code and authorize. Deyin collects the token directly from GitHub and stores it exactly like a pasted one: encrypted, and
never shown to a model. Two things to know:

- An OAuth app's token has GitHub's `repo` scope, which covers every repository the account can reach, and it has no
  expiry of its own. What limits it is the account, so keep the agent account dedicated and invite it only to the repository it
  works on. A fine-grained token (below) is limited to one repository in the token itself.
- The agent's account must not be your own: it may not be on the allowed list, so you could never ask it for anything.

Without an OAuth app in the build, the assistant says so and sends you to the dashboard to paste a token instead.

_For maintainers:_ register a GitHub OAuth App (Settings → Developer settings → OAuth Apps), tick **Enable Device
Flow**, and set its client id as `BUNDLED_CLIENT_ID` in `apps/desktop/src/main/superagent/github-device-flow.ts`. The
client id is public, and the flow has no client secret. A fork can instead set `DEYIN_GITHUB_CLIENT_ID`.

### By hand

1. **Create a GitHub account for the agent.** Use a dedicated account, not your own, so its activity is attributed to it
   and its access can be limited to the one repository. Invite it to the repository with write access.
2. **Create a token for that account.** A fine-grained personal access token on the repository with _Contents_,
   _Issues_ and _Pull requests_ set to **read and write**.
3. **Open Superagent** in the sidebar, choose the _Set up_ tab, paste the token and press **Connect**. Deyin checks it
   with GitHub and shows the account it belongs to. A token GitHub rejects is not kept.
4. **Set the repository** (`owner/name`) and choose what to watch (issues, pull requests, comments).
5. **List who may ask.** Add GitHub logins to _Allowed accounts_, one per line. The agent's own account cannot be on the
   list.
6. **Choose the mode** under _How it acts_. Start in Observe (below).
7. **Save**, then switch **On**. The _Needs setup_ banner lists whatever is still missing.

Everything else is under _Advanced_, which opens by itself when the policy in it is not at its defaults: how often GitHub
is polled, the branch prefix, _Trusted bots_ (read as context but never a request), what counts as a request, the rules
(each is plain text that says what the agent may take on, and where it stops; two are provided, copy fixes and visual
fixes), the models, the workers and the instructions.

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
  tools are confined to the worktree, but a shell command is not. _Blocked commands_ (Settings → Advanced → Workers) is a
  best-effort screen of commands the shell refuses to start; it is **not a security boundary**: `python3 -c`,
  `busybox rm`, `$(which rm)` and many other spellings get past it. If you do not trust the people on the allow-list, or
  the contents of the repository (a worker reads both, and an instruction hidden in an issue can steer it), run Deyin in
  a VM or as a dedicated user.
- Workers get file, search, git, shell, web fetch and search, and to-do tools. They do not get the browser, computer use,
  MCP servers, your memory, or tools that need a person to answer. The orchestrator gets only its own `orchestrator_*`
  tools: it can read the thread, but not run a command or touch a file.
- The agent account's token is stored **encrypted** with the operating system's secret store (Electron `safeStorage`),
  in a file readable only by you. On Linux without a keyring it falls back to a plain file with the same permissions,
  and says so. It is never logged, never shown again, and never put in a prompt. It reaches only the worker's shell, as
  `GH_TOKEN`/`GITHUB_TOKEN`, so that `git` and `gh` can act as the agent. Because the shell has it, **a worker can use
  it**, so give the token access to this one repository and nothing else. If a command prints the token, Deyin replaces
  it with `[REDACTED]` before the model or the stored conversation sees it (also in its Base64 and URL-encoded forms).
  The worker's shell starts without the credential-looking variables of Deyin's own environment (names containing
  `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `SSH_AUTH_SOCK` and similar); a credential kept under a plain name is not
  recognized.
- **`git` and `gh` must be on your `PATH`.** The _Needs setup_ list tells you if one is missing.
- The agent ignores its own messages, so it cannot trigger itself.
- The repository cannot be changed while tickets are open. Reset Superagent to start over.
- The model for assessment and for workers can be set separately; by default both use the model chosen in the app. What
  people write on GitHub (issues, comments, pull request text) is sent to that model, like any other prompt.
- The agent clones the repository over **HTTPS** with its token. If you point Superagent at a local checkout, give it an
  HTTPS `origin`: with an SSH `origin` a worker would push with your own keys, not the agent account's token.
- When a person writes on a thread a ticket follows, the message goes to that ticket's worker, which decides whether it
  is theirs. The orchestrator is told, and may stop the ticket if the person asks to stop; it cannot accept or redirect that
  message. Ask for new work in a new message after a stop.

Not in this version: CI results arriving as messages (a worker can read them with `gh pr checks`), Feishu or other chat
channels, agents editing their own settings or prompts, and reading images from messages.

## Files

Under Deyin's data folder, in `superagent/`: `settings.json` (settings, no secrets), `state.json` (tickets, decisions, messages;
a `.bak` copy is kept), `repos/` (the agent's own clone of the repository, unless you set a local
checkout), `work/` (worktrees, unless you set a directory), `sessions/` (each agent's conversation), and `token.json` (the
encrypted token). **Reset** deletes the tickets and conversations and returns the settings to their defaults; the token stays, and
worktrees on disk are left for you to remove.
