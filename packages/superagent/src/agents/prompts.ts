/**
 * Composes each role's system prompt from the upstream markdown (verbatim, embedded by scripts/embed-prompts.mjs), the team's
 * editable sections, and sections this deployment generates: execution environment and policy.
 */
import { fill } from "../core/text.js";
import type { Settings } from "../settings.js";
import { policyVersion } from "../policy.js";
import { PROMPT_DATA } from "../prompts-data.js";

export type Role = "orchestrator" | "worker";

const part = (name: string): string => {
  const text = PROMPT_DATA[name];
  if (text === undefined) throw new Error(`Missing embedded prompt "${name}"`);
  return text;
};

/** The skill's text without its YAML front matter. */
const skillBody = (name: string): string => part(name).replace(/^---\n[\s\S]*?\n---\n?/, "").trim();

const TEAM = [
  { key: "communication", heading: "Communication" },
  { key: "scope", heading: "Ticket scope" },
  { key: "delivery", heading: "Delivery requirements" },
] as const;

const ENVIRONMENT_HEADING =
  "Execution environment (from this installation's settings; it takes precedence over any repository or account named elsewhere in these instructions; an empty value means that part is not configured here). The prepare command of a ticket directory reads the same variables:";
const POLICY_HEAD =
  "## Policy\nPolicy version {version}; accept mode {mode}. The accept mode and the rules decide proactive candidates only: an explicit request is routed as dispatch says, in any mode and whatever the rules.";

/** What differs here from the deployment the upstream text was written for: only the facts this installation changes. */
const INSTALLATION_HEAD =
  "## This installation\nGitHub is the only Source and Channel here. Feishu is not configured: there is no lark-cli and no Feishu skill, so ignore the instructions above that concern Feishu, and read and reply through GitHub. The GitHub skill above is the only skill; there is no skills command.";
const INSTALLATION_CHECKS =
  "Check results and CI status are not delivered to you as messages; read them when you need them, with gh (for example gh pr checks) or the github/pulls/<number>/checks resource.";
const INSTALLATION_IMAGES = "Images cannot be read here: orchestrator_eval_read refuses an image, so judge from the text and say so when an image might have held the answer.";

/** The Installation section for a role. */
export const installationSection = (role: Role): string => [INSTALLATION_HEAD, INSTALLATION_CHECKS, ...(role === "orchestrator" ? [INSTALLATION_IMAGES] : [])].join(" ");

export interface EnvVariable { key: string; value: string; description: string }

export interface EnvironmentInput {
  settings: Settings;
  /** The agent account; empty strings until it is known. */
  agent: { login: string; email: string };
  ticket?: { id: string; name: string; directory: string };
  /** The ticket's origin thread, when it is a GitHub issue or PR. */
  origin?: { number: number; isPr: boolean };
}

/** The variables a worker's shell and prompt see; credentials are never among them. */
export function environmentVariables(input: EnvironmentInput): EnvVariable[] {
  const { settings, agent, ticket, origin } = input;
  const vars: EnvVariable[] = [];
  if (ticket) {
    vars.push(
      { key: "DSH_SUPERAGENT_DIR", value: ticket.directory, description: "This ticket's directory; the executor Session works in it" },
      { key: "DSH_SUPERAGENT_NAME", value: ticket.name, description: "The ticket's short name, also its directory's name" },
      { key: "DSH_SUPERAGENT_TICKET", value: ticket.id, description: "The ticket id" },
    );
  }
  vars.push(
    { key: "DSH_SUPERAGENT_BLOCKED_COMMANDS", value: settings.executor.blockedCommands.join(" "), description: "Commands blocked in this execution environment, separated by spaces; never run them" },
    {
      key: "DSH_SUPERAGENT_GITHUB_REPOSITORY",
      value: settings.github.repository,
      description:
        "The repository this Source watches, as owner/name. A PR the agent opens here from a branch whose last path segment is DSH_SUPERAGENT_NAME (for example agent/$DSH_SUPERAGENT_NAME) binds to the ticket",
    },
    {
      key: "DSH_SUPERAGENT_GITHUB_ACCOUNT",
      value: agent.login,
      description: "The agent's GitHub account. gh is signed in to it; use gh for every GitHub operation except auto-merge, and never another account or credential",
    },
    {
      key: "DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL",
      value: agent.email,
      description:
        "Commit email of the agent's account. git has no identity here: commit as the author these instructions name, or as the agent's account with this email when they name none",
    },
  );
  if (ticket) {
    vars.push(
      { key: "DSH_SUPERAGENT_GITHUB_NUMBER", value: origin ? String(origin.number) : "", description: "Number of the Issue or PR that started the ticket; empty when the ticket did not start on GitHub" },
      { key: "DSH_SUPERAGENT_GITHUB_PR_HEAD", value: origin?.isPr ? `refs/pull/${origin.number}/head` : "", description: "Head ref refs/pull/<number>/head of the PR that started the ticket; empty when it was not a PR" },
    );
  }
  return vars;
}

const environmentLines = (variables: readonly EnvVariable[]): string => variables.map((item) => `- ${item.key} = ${JSON.stringify(item.value)}: ${item.description}.`).join("\n");

/** The shell environment for a worker: the documented variables, plus what gh and git need to act as the agent account. */
export function workerShellEnvironment(variables: readonly EnvVariable[], credentials: { token: string; login: string; email: string }): Record<string, string> {
  const env: Record<string, string> = Object.fromEntries(variables.map((item) => [item.key, item.value]));
  return {
    ...env,
    GH_TOKEN: credentials.token,
    GITHUB_TOKEN: credentials.token,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: credentials.login,
    GIT_AUTHOR_EMAIL: credentials.email,
    GIT_COMMITTER_NAME: credentials.login,
    GIT_COMMITTER_EMAIL: credentials.email,
    // git over https authenticates with the same token, through an inline credential helper that reads it from the environment.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f',
  };
}

/** The Policy section the orchestrator judges proactive candidates by, one line per enabled rule. */
export function policySection(settings: Settings): string {
  const line = (text: string) => text.replace(/\s*\n\s*/g, " ");
  const rules = settings.policy.rules.filter((rule) => rule.enabled).map(({ id, name, instruction }) => `- ${line(name)} (${id}): ${line(instruction)}`);
  const head = fill(POLICY_HEAD, { version: policyVersion(settings), mode: settings.eval.mode });
  return rules.length ? `${head} The enabled rules, by name and id:\n${rules.join("\n")}` : `${head} No rule is enabled: a proactive candidate can only be ignored.`;
}

/** The role's system prompt: fixed upstream sections, team sections, environment and, for the orchestrator, policy. */
export function composePrompt(role: Role, input: EnvironmentInput): string {
  const { settings } = input;
  const guide = (name: string) => `## ${name}\n${part(name)}`;
  const team = TEAM.map(({ key, heading }) => {
    const text = settings.prompts[key].trim() || part(`team/${key}`);
    return `## ${heading}\n${text}`;
  });
  const sections = [
    part("shared"),
    part(role),
    ...team,
    guide("subscriptions"),
    guide("replies"),
    guide(role === "orchestrator" ? "dispatch" : "work"),
    ...(role === "orchestrator" ? [part("admission")] : []),
    `${part("handoff")}\n${part(`handoff-${role}`)}`,
    // The GitHub skill documents the github/... resources and how workers use gh; both roles read it.
    `## GitHub skill\n${skillBody("skill/github")}\n\n## CLI usage\n${part("cli")}`,
    installationSection(role),
    `${ENVIRONMENT_HEADING}\n${environmentLines(environmentVariables(input))}`,
    ...(role === "orchestrator" ? [policySection(settings)] : []),
  ];
  return sections.filter(Boolean).join("\n\n");
}
