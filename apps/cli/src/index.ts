#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import type { DeyinCliConfigFile } from "@deyin/agent-core";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/auth.js";
import { agentsCommand, modelsCommand, sessionsCommand, usageCommand } from "./commands/info.js";
import { createContext } from "./context.js";
import { EXIT_ERROR, EXIT_INTERRUPT, runHeadless } from "./headless.js";
import { errorLine } from "./output.js";
import { upgradeCommand } from "./upgrade.js";
import { VERSION } from "./version.js";

const sharedArgs = {
  model: { type: "string", alias: "m", description: "Model id (see `deyin models`)" },
  agent: { type: "string", alias: "a", description: "Agent: build, plan, or a custom agent" },
  cwd: { type: "string", alias: "C", description: "Workspace directory (defaults to the current directory)" },
  "max-steps": { type: "string", description: "Cap agent loop steps for one run" },
} as const;

function overridesFrom(args: Record<string, unknown>): Partial<DeyinCliConfigFile> {
  const overrides: Partial<DeyinCliConfigFile> = {};
  if (typeof args.model === "string" && args.model) overrides.model = args.model;
  if (typeof args.agent === "string" && args.agent) overrides.agent = args.agent;
  const maxSteps = Number(args["max-steps"]);
  if (Number.isFinite(maxSteps) && maxSteps > 0) overrides.maxSteps = maxSteps;
  return overrides;
}

async function readPipedStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function headlessWithSigint(run: (signal: AbortSignal) => Promise<number>): Promise<never> {
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on("SIGINT", onSigint);
  let code: number;
  try {
    code = await run(controller.signal);
  } catch (err) {
    errorLine(err instanceof Error ? err.message : String(err));
    code = EXIT_ERROR;
  } finally {
    process.off("SIGINT", onSigint);
  }
  process.exitCode = controller.signal.aborted ? EXIT_INTERRUPT : code;
  process.exit(process.exitCode);
}

const run = defineCommand({
  meta: { name: "run", description: "Run one prompt non-interactively (for scripts and CI)" },
  args: {
    ...sharedArgs,
    prompt: { type: "positional", required: false, description: "The prompt (or pipe it on stdin / use -p)" },
    p: { type: "string", description: "Prompt text (alternative to the positional)" },
    json: { type: "boolean", description: "Emit NDJSON events on stdout" },
    yes: { type: "boolean", alias: "y", description: "Allow every tool without asking (headless default is deny)" },
    continue: { type: "boolean", alias: "c", description: "Continue the latest session for this workspace" },
    resume: { type: "string", description: "Resume a specific session id" },
  },
  async run({ args }) {
    const stdinText = await readPipedStdin();
    const prompt = [typeof args.p === "string" ? args.p : "", typeof args.prompt === "string" ? args.prompt : "", stdinText]
      .filter(Boolean)
      .join("\n\n");
    if (!prompt) {
      errorLine("no prompt. Pass one as an argument, with -p, or pipe it on stdin.");
      process.exit(EXIT_ERROR);
    }
    const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined, overrides: overridesFrom(args) });
    await headlessWithSigint((signal) =>
      runHeadless({
        ctx,
        prompt,
        json: Boolean(args.json),
        yes: Boolean(args.yes),
        continueLast: Boolean(args.continue),
        resumeId: typeof args.resume === "string" && args.resume ? args.resume : undefined,
        signal,
      }),
    );
  },
});

const resume = defineCommand({
  meta: { name: "resume", description: "Resume a session in the TUI (no id: pick from a list)" },
  args: {
    ...sharedArgs,
    id: { type: "positional", required: false, description: "Session id (see `deyin sessions`)" },
  },
  async run({ args }) {
    const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined, overrides: overridesFrom(args) });
    const { launchTui } = await import("./tui/run.js");
    const id = typeof args.id === "string" && args.id ? args.id : undefined;
    process.exitCode = await launchTui(ctx, id ? { resumeId: id } : { openSessionPicker: true });
  },
});

function simple(name: string, description: string, handler: (ctx: ReturnType<typeof createContext>) => Promise<number>) {
  return defineCommand({
    meta: { name, description },
    args: { cwd: sharedArgs.cwd },
    async run({ args }) {
      const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
      process.exitCode = await handler(ctx);
    },
  });
}

const SUBCOMMAND_NAMES = new Set([
  "run",
  "resume",
  "login",
  "logout",
  "whoami",
  "models",
  "agents",
  "usage",
  "sessions",
  "upgrade",
]);

const main = defineCommand({
  meta: {
    name: "deyin",
    version: VERSION,
    description: "Deyin: an agentic coding CLI. Run with no arguments for the interactive TUI.",
  },
  args: {
    ...sharedArgs,
    prompt: { type: "string", alias: "p", description: "Run headless with this prompt instead of the TUI" },
    json: { type: "boolean", description: "With -p: emit NDJSON events" },
    yes: { type: "boolean", alias: "y", description: "With -p: allow every tool without asking" },
    continue: { type: "boolean", alias: "c", description: "Continue the latest session for this workspace" },
    resume: { type: "string", description: "Resume a specific session id" },
  },
  subCommands: {
    run,
    resume,
    login: defineCommand({
      meta: { name: "login", description: "Sign in with Openference (device flow; --browser for loopback)" },
      args: { browser: { type: "boolean", description: "Use the browser loopback flow instead of the device flow" } },
      async run({ args }) {
        process.exitCode = await loginCommand(createContext(), { browser: Boolean(args.browser) });
      },
    }),
    logout: simple("logout", "Sign out and delete stored credentials", logoutCommand),
    whoami: simple("whoami", "Show the signed-in account", whoamiCommand),
    models: simple("models", "List available models", modelsCommand),
    agents: simple("agents", "List agents (build, plan, custom)", agentsCommand),
    usage: simple("usage", "Show local usage statistics", usageCommand),
    sessions: simple("sessions", "List saved sessions", sessionsCommand),
    upgrade: defineCommand({
      meta: { name: "upgrade", description: "Update deyin to the latest release" },
      async run() {
        process.exitCode = await upgradeCommand();
      },
    }),
  },
  async run({ args, rawArgs }) {
    // citty invokes the parent run() after a subcommand too; mirror its dispatch
    // detection and bail out when a subcommand already handled this invocation.
    const firstPositional = rawArgs.find((a) => !a.startsWith("-"));
    if (firstPositional && SUBCOMMAND_NAMES.has(firstPositional)) return;

    const overrides = overridesFrom(args);
    const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
    const promptFlag = typeof args.prompt === "string" ? args.prompt : "";
    const stdinText = await readPipedStdin();
    const prompt = [promptFlag, stdinText].filter(Boolean).join("\n\n");

    // Headless when a prompt was provided (flag or pipe), or when there is no TTY to draw on.
    if (prompt) {
      const ctx = createContext({ cwd, overrides });
      await headlessWithSigint((signal) =>
        runHeadless({
          ctx,
          prompt,
          json: Boolean(args.json),
          yes: Boolean(args.yes),
          continueLast: Boolean(args.continue),
          resumeId: typeof args.resume === "string" && args.resume ? args.resume : undefined,
          signal,
        }),
      );
      return;
    }
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      errorLine("no TTY and no prompt. Use `deyin run \"...\"`, -p, or pipe a prompt on stdin.");
      process.exit(EXIT_ERROR);
    }

    const ctx = createContext({ cwd, overrides });
    const { launchTui } = await import("./tui/run.js");
    process.exitCode = await launchTui(ctx, {
      continueLast: Boolean(args.continue),
      resumeId: typeof args.resume === "string" && args.resume ? args.resume : undefined,
    });
  },
});

void runMain(main);
