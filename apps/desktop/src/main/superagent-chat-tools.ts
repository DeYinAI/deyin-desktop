/**
 * Chat tools for setting up Superagent: read what is missing, save the few settings a first run needs, connect the agent's
 * GitHub account, check its access, and switch it on. They back the `setup-superagent` skill (`/superagent`).
 *
 * Nothing here accepts or returns a token. The account is connected through GitHub's device flow (the user approves in their
 * browser and the token goes straight into the encrypted store) or by the user pasting a token into the dashboard's masked
 * field. A test walks every schema below and fails if a parameter could carry a secret.
 */
import type { ToolDefinition } from "@deyin/agent-core";
import type { SuperagentReply, SuperagentVerification } from "@deyin/contract";
import type { Settings, SuperagentView } from "@deyin/superagent";
import type { DeviceAuthorization } from "./superagent/github-device-flow.js";
import type { DeviceFlowOutcome } from "./superagent/service.js";

/** The slice of `SuperagentService` the chat tools use. */
export interface SuperagentChatPort {
  current(): SuperagentReply;
  saveSettings(raw: unknown, baseRevision: number): Promise<SuperagentReply>;
  verify(): Promise<SuperagentReply<SuperagentVerification>>;
  clearToken(): Promise<SuperagentReply>;
  /** True when this build has a registered GitHub OAuth app, so the device flow can run. */
  deviceFlowAvailable(): boolean;
  beginDeviceFlow(): Promise<SuperagentReply<DeviceAuthorization>>;
  finishDeviceFlow(): Promise<SuperagentReply<DeviceFlowOutcome>>;
}

type RunState = "on" | "paused" | "off";
type AcceptMode = Settings["eval"]["mode"];

const RUN_STATES: readonly RunState[] = ["on", "paused", "off"];
const ACCEPT_MODES: readonly AcceptMode[] = ["off", "observe", "auto"];
const CONNECT_ACTIONS = ["start", "finish"] as const;
type ConnectAction = (typeof CONNECT_ACTIONS)[number];
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPOSITORY_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i;

/** Where a user pastes a token when the device flow is not available. */
const TOKEN_FIELD = "More → Superagent → Set up tab → Agent account → GitHub token (then Connect)";

class ToolInputError extends Error {}

function runStateOf(settings: Pick<Settings, "enabled" | "paused">): RunState {
  if (!settings.enabled) return "off";
  return settings.paused ? "paused" : "on";
}

function withRunState(settings: Settings, state: RunState): Settings {
  switch (state) {
    case "on":
      return { ...settings, enabled: true, paused: false };
    case "paused":
      return { ...settings, enabled: true, paused: true };
    case "off":
      return { ...settings, enabled: false, paused: false };
    default: {
      const never: never = state;
      throw new Error(`Unhandled run state ${String(never)}`);
    }
  }
}

function unwrap<T>(reply: SuperagentReply<T>): T {
  if (!reply.ok) throw new ToolInputError(reply.error);
  return reply.value;
}

/** Runs a tool body, turning failures into the `ERROR: …` text the model reads (the agent loop expects a string, not a throw). */
async function guarded(body: () => Promise<string>): Promise<string> {
  try {
    return await body();
  } catch (error) {
    return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function watching(settings: Settings): string[] {
  const { observeIssues, observePulls, observeComments } = settings.github;
  return [observeIssues ? "issues" : "", observePulls ? "pull requests" : "", observeComments ? "comments" : ""].filter(Boolean);
}

/** A compact, token-free picture of the setup, in the order the interview asks about it. */
function describe(view: SuperagentView, deviceFlow: boolean): string {
  const { status, settings } = view;
  const allowed = settings.policy.sources.github?.allowed ?? [];
  return JSON.stringify(
    {
      ready: status.ready,
      stillNeeded: status.gaps,
      state: runStateOf(settings),
      mode: settings.eval.mode,
      repository: settings.github.repository || null,
      agentAccount: status.account ? `@${status.account.login}` : null,
      accountError: status.accountError,
      watching: watching(settings),
      allowedAccounts: allowed.map((entry) => entry.id),
      enabledRules: settings.policy.rules.filter((rule) => rule.enabled).map((rule) => rule.name),
      workers: status.workers,
      lastPoll: status.poll,
      githubSignInAvailable: deviceFlow,
    },
    null,
    2,
  );
}

function stringList(value: unknown, field: string): string[] {
  const items = typeof value === "string" ? value.split(/[\s,]+/) : value;
  if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) throw new ToolInputError(`${field} must be a list of GitHub usernames`);
  return items.map((item) => (item as string).trim()).filter(Boolean);
}

/** `@Alice`, `alice` and ` alice ` are one account; GitHub logins are case-insensitive, so the first spelling wins. */
function parseLogins(value: unknown): string[] {
  const seen = new Set<string>();
  const logins: string[] = [];
  for (const raw of stringList(value, "allowed_accounts")) {
    const login = raw.replace(/^@/, "");
    if (!LOGIN.test(login)) throw new ToolInputError(`"${raw}" is not a GitHub username (letters, digits and hyphens only)`);
    if (seen.has(login.toLowerCase())) continue;
    seen.add(login.toLowerCase());
    logins.push(login);
  }
  return logins;
}

/** Accepts `owner/name` or a github.com URL; the settings schema has the final say on the shape. */
function parseRepository(value: unknown): string {
  if (typeof value !== "string") throw new ToolInputError("repository must be text like owner/name");
  const trimmed = value.trim();
  return REPOSITORY_URL.exec(trimmed)?.[1] ?? trimmed;
}

function booleanField(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ToolInputError(`${key} must be true or false`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const match = allowed.find((candidate) => candidate === value);
  if (!match) throw new ToolInputError(`${field} must be one of: ${allowed.join(", ")}`);
  return match;
}

/** What `superagent_configure` was asked to change, applied to a copy of the saved settings. */
function applyChanges(current: Settings, args: Record<string, unknown>, agentLogin: string | undefined): { next: Settings; changes: string[] } {
  const changes: string[] = [];
  let next = current;

  if (args.repository !== undefined) {
    const repository = parseRepository(args.repository);
    next = { ...next, github: { ...next.github, repository } };
    changes.push(`repository → ${repository || "(none)"}`);
  }

  if (args.allowed_accounts !== undefined) {
    const logins = parseLogins(args.allowed_accounts);
    if (agentLogin && logins.some((login) => login.toLowerCase() === agentLogin.toLowerCase())) {
      throw new ToolInputError(`@${agentLogin} is the agent's own account and cannot also be allowed to ask it for work; allow the people who will file requests instead`);
    }
    const source = next.policy.sources.github ?? { allowed: [], bots: [], admission: {} };
    next = { ...next, policy: { ...next.policy, sources: { ...next.policy.sources, github: { ...source, allowed: logins.map((id) => ({ id })) } } } };
    changes.push(`allowed accounts → ${logins.length ? logins.map((login) => `@${login}`).join(", ") : "(none)"}`);
  }

  const watch = { observeIssues: booleanField(args, "watch_issues"), observePulls: booleanField(args, "watch_pull_requests"), observeComments: booleanField(args, "watch_comments") };
  const watchLabels = { observeIssues: "issues", observePulls: "pull requests", observeComments: "comments" } as const;
  for (const key of Object.keys(watch) as Array<keyof typeof watch>) {
    const value = watch[key];
    if (value === undefined) continue;
    next = { ...next, github: { ...next.github, [key]: value } };
    changes.push(`watch ${watchLabels[key]} → ${value ? "on" : "off"}`);
  }

  if (args.mode !== undefined) {
    const mode = oneOf(args.mode, ACCEPT_MODES, "mode");
    next = { ...next, eval: { ...next.eval, mode } };
    changes.push(`mode → ${mode}`);
  }

  if (changes.length === 0) {
    throw new ToolInputError("Nothing to change: pass at least one of repository, allowed_accounts, watch_issues, watch_pull_requests, watch_comments, mode");
  }
  return { next, changes };
}

function modeNote(mode: AcceptMode): string {
  switch (mode) {
    case "off":
      return "Mode is mentions only: it acts only when an allowed account addresses the agent directly, and assesses nothing else.";
    case "observe":
      return "Mode is observe: an allowed account that addresses the agent directly still gets work done; every other message is only assessed and recorded as \"would accept\", without acting. Switch to auto once those decisions match what the user would have wanted.";
    case "auto":
      return "Mode is auto: it acts on direct mentions and on other requests it judges to fall within the rules.";
    default: {
      const never: never = mode;
      throw new Error(`Unhandled mode ${String(never)}`);
    }
  }
}

export function createSuperagentChatTools(port: SuperagentChatPort): ToolDefinition[] {
  const statusTool: ToolDefinition = {
    name: "superagent_status",
    description:
      "Read Superagent's setup: whether it can run, what is still needed, the watched repository, the agent's GitHub account, who may ask it for work, what it watches, its mode and run state. Call this first and again after every change. Never includes a token.",
    tier: "read",
    parameters: { type: "object", properties: {} },
    summarize: () => "read Superagent setup",
    neverElide: true,
    execute: () => guarded(async () => describe(unwrap(port.current()), port.deviceFlowAvailable())),
  };

  const configureTool: ToolDefinition = {
    name: "superagent_configure",
    description:
      "Save Superagent settings. Pass only what the user told you; everything else keeps its value. The agent's own account cannot be on the allowed list. Advanced settings (rules, models, workers, instructions) are edited in the dashboard, not here.",
    tier: "write",
    parameters: {
      type: "object",
      properties: {
        repository: { type: "string", description: "The repository to watch, as owner/name (a github.com URL is accepted)." },
        allowed_accounts: {
          type: "array",
          items: { type: "string" },
          description: "GitHub usernames whose requests the agent may act on. Replaces the whole list. These are the people, never the agent's own account.",
        },
        watch_issues: { type: "boolean", description: "Read new issues." },
        watch_pull_requests: { type: "boolean", description: "Read pull requests." },
        watch_comments: { type: "boolean", description: "Read comments on issues and pull requests." },
        mode: {
          type: "string",
          enum: [...ACCEPT_MODES],
          description:
            "off = mentions only (acts only when an allowed account addresses the agent). observe = also assesses other messages and records what it would accept, without acting on them. auto = also acts on other requests that fit the rules. Use auto only after the user confirmed it.",
        },
      },
    },
    summarize: (args) => `configure Superagent (${Object.keys(args).join(", ") || "no changes"})`,
    execute: (args) =>
      guarded(async () => {
        const view = unwrap(port.current());
        const { next, changes } = applyChanges(view.settings, args, view.status.account?.login);
        const saved = unwrap(await port.saveSettings(next, view.settingsRevision));
        return `OK: saved.\n- ${changes.join("\n- ")}\n\n${describe(saved, port.deviceFlowAvailable())}`;
      }),
  };

  const connectTool: ToolDefinition = {
    name: "superagent_connect_github",
    description:
      "Connect the agent's GitHub account without handling a token. action \"start\" returns a one-time code and a link: show both to the user, then ask them to approve while signed in as the AGENT account (a private window helps). When they confirm, call with action \"finish\". If sign-in is unavailable the result says so and tells you where the user pastes a token themselves. Never ask for a token in chat.",
    tier: "write",
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: [...CONNECT_ACTIONS], description: "start: get the code and link. finish: after the user approved." } },
      required: ["action"],
    },
    summarize: (args) => `connect GitHub (${typeof args.action === "string" ? args.action : "?"})`,
    execute: (args) =>
      guarded(async () => {
        const action: ConnectAction = oneOf(args.action, CONNECT_ACTIONS, "action");
        switch (action) {
          case "start":
            return await startConnect(port);
          case "finish":
            return await finishConnect(port);
          default: {
            const never: never = action;
            throw new Error(`Unhandled action ${String(never)}`);
          }
        }
      }),
  };

  const verifyTool: ToolDefinition = {
    name: "superagent_verify",
    description: "Check the stored GitHub account against the watched repository: who it is and whether it can push branches. Use it after connecting and before switching Superagent on.",
    tier: "read",
    parameters: { type: "object", properties: {} },
    summarize: () => "verify Superagent's GitHub access",
    execute: () =>
      guarded(async () => {
        const { login, canPush, repository } = unwrap(await port.verify());
        return canPush
          ? `OK: @${login} can push to ${repository}.`
          : `WARNING: @${login} can see ${repository} but cannot push to it, so workers could not open pull requests. The account needs write access to the repository (a collaborator, or a token with Contents: read and write).`;
      }),
  };

  const stateTool: ToolDefinition = {
    name: "superagent_set_state",
    description:
      "Switch Superagent on, pause it, or turn it off. \"on\" is refused until setup is complete. In observe mode it only records what it would take on; in auto mode it acts. Confirm with the user before turning it on.",
    tier: "write",
    parameters: {
      type: "object",
      properties: { state: { type: "string", enum: [...RUN_STATES], description: "on, paused (keeps its tickets, stops polling) or off." } },
      required: ["state"],
    },
    summarize: (args) => `set Superagent ${typeof args.state === "string" ? args.state : "?"}`,
    execute: (args) =>
      guarded(async () => {
        const state = oneOf(args.state, RUN_STATES, "state");
        const view = unwrap(port.current());
        if (state !== "off" && !view.status.ready) {
          return `ERROR: Superagent cannot run yet. Still needed:\n- ${view.status.gaps.join("\n- ")}`;
        }
        const saved = unwrap(await port.saveSettings(withRunState(view.settings, state), view.settingsRevision));
        const notes = [modeNote(saved.settings.eval.mode)];
        if (state === "on" && watching(saved.settings).length === 0) notes.push("Nothing is being watched yet, so it will not see any request: turn on at least one of issues, pull requests or comments.");
        return `OK: Superagent is ${state}.\n${notes.join("\n")}`;
      }),
  };

  const disconnectTool: ToolDefinition = {
    name: "superagent_disconnect",
    description: "Delete the stored GitHub token and stop Superagent's running tickets. Use it to switch to a different agent account or to take access away.",
    tier: "write",
    parameters: { type: "object", properties: {} },
    summarize: () => "disconnect Superagent's GitHub account",
    execute: () =>
      guarded(async () => {
        unwrap(await port.clearToken());
        return "OK: the GitHub token was deleted. Superagent cannot act until an account is connected again.";
      }),
  };

  return [statusTool, configureTool, connectTool, verifyTool, stateTool, disconnectTool].map(strict);
}

const SECRET_NAME = /token|secret|password|passwd|credential|api_?key|\bpat\b/i;

/**
 * Refuses an argument the tool does not declare, by name and never by value. A model that sends a `token` argument must be told
 * plainly that it went nowhere, not have it quietly ignored while it believes the account is connected.
 */
function strict(tool: ToolDefinition): ToolDefinition {
  const declared = Object.keys(tool.parameters.properties);
  return {
    ...tool,
    execute: (args, ctx) => {
      const unknown = Object.keys(args).filter((name) => !declared.includes(name));
      if (unknown.length === 0) return tool.execute(args, ctx);
      if (unknown.some((name) => SECRET_NAME.test(name))) {
        return Promise.resolve(
          `ERROR: ${tool.name} does not take a token, password or key, and nothing was stored. Never put one in chat: connect the account with superagent_connect_github, or have the user paste a token into the masked field at ${TOKEN_FIELD}.`,
        );
      }
      return Promise.resolve(`ERROR: ${tool.name} does not take: ${unknown.join(", ")}. It takes: ${declared.join(", ") || "no arguments"}.`);
    },
  };
}

async function startConnect(port: SuperagentChatPort): Promise<string> {
  const view = unwrap(port.current());
  const account = view.status.account;
  if (account) return `Already connected as @${account.login}. If that is not the dedicated agent account, call superagent_disconnect first.`;
  if (!port.deviceFlowAvailable()) {
    return [
      "UNAVAILABLE: signing in with GitHub is not set up in this build.",
      `Tell the user to create a token for the agent account (GitHub → Settings → Developer settings → Fine-grained tokens; repository access: only the watched repository; permissions: Contents, Issues, Pull requests = read and write), then paste it into the masked field at ${TOKEN_FIELD}.`,
      "Never ask them to paste it in chat. When they say it is done, call superagent_status to confirm the account appears.",
    ].join("\n");
  }
  const { userCode, verificationUri, expiresInSeconds } = unwrap(await port.beginDeviceFlow());
  const minutes = Math.max(1, Math.round(expiresInSeconds / 60));
  return [
    `Show the user this code and link: code ${userCode}, link ${verificationUri} (valid about ${minutes} minutes).`,
    "They must open it signed in as the AGENT account, not their own: a private window is the easy way. GitHub will ask them to enter the code and authorize.",
    'Then ask them with ask_question (it needs two options: "I approved it" and "That did not work"), and when they confirm call superagent_connect_github with action "finish".',
  ].join("\n");
}

async function finishConnect(port: SuperagentChatPort): Promise<string> {
  const outcome = unwrap(await port.finishDeviceFlow());
  if (outcome.pending) return 'PENDING: GitHub has not received an approval yet. Ask the user to finish at the link, then call action "finish" again, or call action "start" for a fresh code.';
  const login = outcome.view.status.account?.login;
  if (!login) return "ERROR: GitHub approved the request but the account could not be read. Call superagent_status, or try action \"start\" again.";
  const allowed = outcome.view.settings.policy.sources.github?.allowed ?? [];
  const clash = allowed.some((entry) => entry.id.toLowerCase() === login.toLowerCase());
  return [
    `OK: connected as @${login}.`,
    "Confirm with the user that @" + login + " is the dedicated agent account and not their own. If it is their own, call superagent_disconnect and start over with the right account.",
    ...(clash ? [`@${login} is on the allowed list, which is not permitted: remove it with superagent_configure.`] : []),
  ].join("\n");
}
