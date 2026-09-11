#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import type { DeyinCliConfigFile } from "@deyin/agent-core";
import { initUserAgent } from "@deyin/host-core";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/auth.js";
import { agentsCommand, capabilitiesCommand, checkpointListCommand, checkpointRevertCommand, deleteSessionCommand, exportSessionCommand, forkSessionCommand, importSessionCommand, mcpAddCommand, memoryCommand, mcpListCommand, modelsCommand, sessionsCommand, usageCommand } from "./commands/info.js";
import {
  subagentsCreateCommand,
  subagentsDeleteCommand,
  subagentsEditCommand,
  subagentsListCommand,
  subagentsRunCommand,
  subagentsTryCommand,
} from "./commands/subagents.js";
import { createContext, flushCliStorage } from "./context.js";
import { EXIT_ERROR, EXIT_INTERRUPT, runHeadless } from "./headless.js";
import { errorLine, dim, red } from "./output.js";
import { pluginInstallCommand, pluginsListCommand, pluginUninstallCommand } from "./commands/plugins.js";
import { upgradeCommand } from "./upgrade.js";
import { VERSION } from "./version.js";
import { serveCli } from "./server.js";

// One User-Agent identity for every outbound CLI request (providers, GitHub, search).
initUserAgent("cli", VERSION);

const sharedArgs = {
  model: { type: "string", alias: "m", description: "Model id (see `deyin models`)" },
  agent: { type: "string", alias: "a", description: "Agent: build, plan, or a custom agent" },
  cwd: { type: "string", alias: "C", description: "Workspace directory (defaults to the current directory)" },
  "max-steps": { type: "string", description: "Cap agent loop steps for one run" },
  trust: { type: "boolean", description: "Trust workspace hooks and MCP configuration for this run" },
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
  // process.exit() skips beforeExit, so drain queued writes explicitly first.
  await flushCliStorage();
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
        trustWorkspace: Boolean(args.trust),
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
    process.exitCode = await launchTui(ctx, id ? { resumeId: id, trustWorkspace: Boolean(args.trust) } : { openSessionPicker: true, trustWorkspace: Boolean(args.trust) });
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
  "session",
  "fork",
  "export",
  "import",
  "upgrade",
  "serve",
  "subagent",
  "memory",
  "capabilities",
  "mcp",
  "plugin",
  "checkpoint",
]);

const SUBAGENT_SUBCOMMANDS = new Set(["list", "create", "edit", "delete", "run", "try"]);

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
    sessions: defineCommand({
      meta: { name: "sessions", description: "List saved sessions" },
      args: {
        cwd: sharedArgs.cwd,
        "max-count": { type: "string", description: "Limit to the N most recent sessions" },
        format: { type: "string", description: "Output format: table or json" },
      },
      async run({ args }) {
        const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
        const maxCount = Number(args["max-count"]);
        process.exitCode = await sessionsCommand(ctx, {
          maxCount: Number.isFinite(maxCount) && maxCount > 0 ? maxCount : undefined,
          format: typeof args.format === "string" ? args.format : undefined,
        });
      },
    }),
    session: defineCommand({
      meta: { name: "session", description: "List or delete saved sessions" },
      args: { cwd: sharedArgs.cwd },
      subCommands: {
        list: defineCommand({
          meta: { name: "list", description: "List saved sessions" },
          args: {
            cwd: sharedArgs.cwd,
            "max-count": { type: "string", description: "Limit to the N most recent sessions" },
            format: { type: "string", description: "Output format: table or json" },
          },
          async run({ args }) {
            const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
            const maxCount = Number(args["max-count"]);
            process.exitCode = await sessionsCommand(ctx, {
              maxCount: Number.isFinite(maxCount) && maxCount > 0 ? maxCount : undefined,
              format: typeof args.format === "string" ? args.format : undefined,
            });
          },
        }),
        delete: defineCommand({
          meta: { name: "delete", description: "Delete a saved session" },
          args: {
            cwd: sharedArgs.cwd,
            id: { type: "positional", required: true, description: "Session id" },
            yes: { type: "boolean", alias: "y", description: "Confirm deletion" },
          },
          async run({ args }) {
            const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
            process.exitCode = await deleteSessionCommand(ctx, typeof args.id === "string" ? args.id : undefined, Boolean(args.yes));
          },
        }),
      },
      async run({ rawArgs }) {
        const firstPositional = rawArgs.find((a) => !a.startsWith("-"));
        if (firstPositional === "list" || firstPositional === "delete") return;
        console.error(`${red("usage:")} deyin session <list|delete> ...`);
        process.exitCode = 1;
      },
    }),
    fork: defineCommand({
      meta: { name: "fork", description: "Fork a saved session transcript" },
      args: {
        cwd: sharedArgs.cwd,
        id: { type: "positional", required: true, description: "Session id (see `deyin sessions`)" },
        "at-seq": { type: "string", description: "Copy only through this transcript event sequence" },
      },
      async run({ args }) {
        const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
        process.exitCode = await forkSessionCommand(
          ctx,
          typeof args.id === "string" ? args.id : undefined,
          typeof args["at-seq"] === "string" ? args["at-seq"] : undefined,
        );
      },
    }),
    "export": defineCommand({
      meta: { name: "export", description: "Export a session as JSON" },
      args: {
        cwd: sharedArgs.cwd,
        id: { type: "positional", required: false, description: "Session id (defaults to the latest for this workspace)" },
        output: { type: "string", alias: "o", description: "Write JSON to this file instead of stdout" },
      },
      async run({ args }) {
        const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
        process.exitCode = await exportSessionCommand(
          ctx,
          typeof args.id === "string" ? args.id : undefined,
          typeof args.output === "string" ? args.output : undefined,
        );
      },
    }),
    "import": defineCommand({
      meta: { name: "import", description: "Import a DeYin session JSON export" },
      args: {
        cwd: sharedArgs.cwd,
        file: { type: "positional", required: true, description: "Path to a session JSON export" },
      },
      async run({ args }) {
        const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
        process.exitCode = await importSessionCommand(ctx, typeof args.file === "string" ? args.file : undefined);
      },
    }),
    memory: defineCommand({
      meta: { name: "memory", description: "List or search saved background memories" },
      args: {
        cwd: sharedArgs.cwd,
        query: { type: "positional", required: false, description: "Optional search query" },
      },
      async run({ args }) {
        const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
        process.exitCode = await memoryCommand(ctx, typeof args.query === "string" ? args.query : undefined);
      },
    }),
    checkpoint: defineCommand({
      meta: { name: "checkpoint", description: "List or revert durable file-mutation checkpoints" },
      args: { cwd: sharedArgs.cwd },
      subCommands: {
        list: defineCommand({
          meta: { name: "list", description: "List checkpoints recorded by agent runs" },
          args: {
            cwd: sharedArgs.cwd,
            id: { type: "positional", required: false, description: "Session id (defaults to the latest)" },
            format: { type: "string", description: "Output format: table or json" },
          },
          async run({ args }) {
            const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
            process.exitCode = await checkpointListCommand(
              ctx,
              typeof args.id === "string" ? args.id : undefined,
              typeof args.format === "string" ? args.format : undefined,
            );
          },
        }),
        revert: defineCommand({
          meta: { name: "revert", description: "Revert a run's file changes" },
          args: {
            cwd: sharedArgs.cwd,
            id: { type: "positional", required: false, description: "Session id (defaults to the latest)" },
            checkpoint: { type: "positional", required: true, description: "Checkpoint/run id" },
            yes: { type: "boolean", alias: "y", description: "Confirm the revert" },
            path: { type: "string", description: "Only revert these comma-separated paths" },
          },
          async run({ args }) {
            const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
            process.exitCode = await checkpointRevertCommand(
              ctx,
              typeof args.id === "string" ? args.id : undefined,
              typeof args.checkpoint === "string" ? args.checkpoint : undefined,
              Boolean(args.yes),
              typeof args.path === "string" ? args.path : undefined,
            );
          },
        }),
      },
      async run({ args, rawArgs }) {
        const firstPositional = rawArgs.find((a) => !a.startsWith("-"));
        if (firstPositional === "list" || firstPositional === "revert") return;
        const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
        process.exitCode = await checkpointListCommand(ctx);
      },
    }),
    capabilities: defineCommand({
      meta: { name: "capabilities", description: "List skills, commands, subagents, hooks, plugins and MCP servers" },
      args: { cwd: sharedArgs.cwd, trust: sharedArgs.trust },
      async run({ args }) {
        const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
        process.exitCode = await capabilitiesCommand(ctx, Boolean(args.trust));
      },
    }),
    mcp: defineCommand({
      meta: { name: "mcp", description: "List effective MCP server definitions" },
      args: { cwd: sharedArgs.cwd, trust: sharedArgs.trust },
      subCommands: {
        list: defineCommand({
          meta: { name: "list", description: "List effective MCP server definitions" },
          args: { cwd: sharedArgs.cwd, trust: sharedArgs.trust },
          async run({ args }) {
            const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
            process.exitCode = await mcpListCommand(ctx, Boolean(args.trust));
          },
        }),
        add: defineCommand({
          meta: { name: "add", description: "Add an MCP server to user or workspace config" },
          args: {
            cwd: sharedArgs.cwd,
            name: { type: "positional", required: true, description: "Server name" },
            command: { type: "string", description: "stdio command" },
            args: { type: "string", description: "Comma-separated stdio arguments" },
            url: { type: "string", description: "SSE or Streamable HTTP endpoint" },
            type: { type: "string", description: "Remote transport: sse or http" },
            global: { type: "boolean", alias: "g", description: "Write to ~/.deyin/mcp.json" },
          },
          async run({ args }) {
            const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
            process.exitCode = await mcpAddCommand(ctx, {
              name: typeof args.name === "string" ? args.name : undefined,
              command: typeof args.command === "string" ? args.command : undefined,
              args: typeof args.args === "string" ? args.args : undefined,
              url: typeof args.url === "string" ? args.url : undefined,
              type: typeof args.type === "string" ? args.type : undefined,
              global: Boolean(args.global),
            });
          },
        }),
      },
      async run({ args, rawArgs }) {
        const firstPositional = rawArgs.find((a) => !a.startsWith("-"));
        if (firstPositional === "list" || firstPositional === "add") return;
        const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
        process.exitCode = await mcpListCommand(ctx, Boolean(args.trust));
      },
    }),
    plugin: defineCommand({
      meta: { name: "plugin", description: "List, install and uninstall capability plugins" },
      args: { cwd: sharedArgs.cwd },
      subCommands: {
        list: defineCommand({
          meta: { name: "list", description: "List installed plugins" },
          args: { cwd: sharedArgs.cwd },
          async run({ args }) {
            const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
            process.exitCode = await pluginsListCommand(ctx);
          },
        }),
        install: defineCommand({
          meta: { name: "install", description: "Install a plugin from GitHub" },
          args: {
            cwd: sharedArgs.cwd,
            source: { type: "positional", required: true, description: "owner/repo, owner/repo@ref, or a GitHub URL" },
          },
          async run({ args }) {
            const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
            process.exitCode = await pluginInstallCommand(ctx, typeof args.source === "string" ? args.source : undefined);
          },
        }),
        uninstall: defineCommand({
          meta: { name: "uninstall", description: "Remove an installed plugin" },
          args: {
            cwd: sharedArgs.cwd,
            name: { type: "positional", required: true, description: "Installed plugin name" },
            yes: { type: "boolean", alias: "y", description: "Confirm uninstall" },
          },
          async run({ args }) {
            const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
            process.exitCode = await pluginUninstallCommand(ctx, typeof args.name === "string" ? args.name : undefined, Boolean(args.yes));
          },
        }),
      },
      async run({ rawArgs }) {
        const firstPositional = rawArgs.find((a) => !a.startsWith("-"));
        if (firstPositional && new Set(["list", "install", "uninstall"]).has(firstPositional)) return;
        console.error(`${red("usage:")} deyin plugin <list|install|uninstall> ...`);
        process.exitCode = 1;
      },
    }),
    subagent: defineCommand({
      meta: { name: "subagent", description: "List, create, edit, delete and run subagents (shared with the desktop app)" },
      args: { cwd: sharedArgs.cwd },
      subCommands: {
        list: simple("list", "List subagents", subagentsListCommand),
        create: defineCommand({
          meta: { name: "create", description: "Create a subagent definition (.deyin/agents/<name>.md)" },
          args: {
            ...sharedArgs,
            name: { type: "positional", required: true, description: "Subagent name (kebab-case)" },
            description: { type: "string", required: true, description: "Delegation description (the model picks subagents by it)" },
            prompt: { type: "string", description: "System prompt body" },
            "prompt-file": { type: "string", description: "Read the prompt body from a file (- for stdin)" },
            model: { type: "string", description: "Model id, or omit to inherit the caller's" },
            effort: { type: "string", description: "Reasoning effort: low | medium | high" },
            "max-steps": { type: "string", description: "Step cap for subagent runs" },
            readonly: { type: "boolean", description: "Deny write/edit and gate bash behind approval" },
            background: { type: "boolean", description: "Return immediately from the task tool; surface when done" },
            tools: { type: "string", description: "Comma-separated tool allowlist (e.g. read,grep,glob,ls)" },
            scope: { type: "string", description: "project (default, cwd/.deyin/agents) or global (~/.deyin/agents)" },
          },
          async run({ args }) {
            const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
            process.exitCode = await subagentsCreateCommand(ctx, args as never);
          },
        }),
        edit: defineCommand({
          meta: { name: "edit", description: "Edit a custom subagent's fields (built-ins are read-only)" },
          args: {
            ...sharedArgs,
            name: { type: "positional", required: true, description: "Subagent name" },
            description: { type: "string", description: "New delegation description" },
            prompt: { type: "string", description: "New prompt body" },
            "prompt-file": { type: "string", description: "Read the new prompt body from a file" },
            model: { type: "string", description: "Model id (empty clears)" },
            effort: { type: "string", description: "Reasoning effort (empty clears)" },
            "max-steps": { type: "string", description: "Step cap (empty clears)" },
            readonly: { type: "boolean", description: "Deny write/edit and gate bash" },
            background: { type: "boolean", description: "Run in the background" },
            tools: { type: "string", description: "Tool allowlist (empty clears)" },
          },
          async run({ args }) {
            const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
            process.exitCode = await subagentsEditCommand(ctx, args as never);
          },
        }),
        delete: defineCommand({
          meta: { name: "delete", description: "Delete a custom subagent definition" },
          args: {
            ...sharedArgs,
            name: { type: "positional", required: true, description: "Subagent name" },
            yes: { type: "boolean", description: "Confirm deletion" },
          },
          async run({ args }) {
            const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
            process.exitCode = await subagentsDeleteCommand(ctx, args as never);
          },
        }),
        run: defineCommand({
          meta: { name: "run", description: "Run a subagent headlessly with the normal permission policy" },
          args: {
            ...sharedArgs,
            name: { type: "positional", required: true, description: "Subagent name" },
            task: { type: "positional", required: true, description: "The task to delegate" },
            model: { type: "string", description: "Model override (\"providerId::modelId\" or bare id)" },
            "max-steps": { type: "string", description: "Cap this run's steps" },
            yes: { type: "boolean", alias: "y", description: "Skip permission prompts" },
            dir: { type: "string", description: "Run in this directory (defaults to cwd)" },
          },
          async run({ args }) {
            const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
            process.exitCode = await subagentsRunCommand(ctx, args as never);
          },
        }),
        try: defineCommand({
          meta: { name: "try", description: "Preview a subagent in read-only mode (writes denied, bash asks)" },
          args: {
            ...sharedArgs,
            name: { type: "positional", required: true, description: "Subagent name" },
            task: { type: "positional", required: true, description: "The task to delegate" },
            model: { type: "string", description: "Model override" },
            "max-steps": { type: "string", description: "Cap this run's steps" },
            dir: { type: "string", description: "Run in this directory (defaults to cwd)" },
          },
          async run({ args }) {
            const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
            process.exitCode = await subagentsTryCommand(ctx, args as never);
          },
        }),
      },
      async run({ rawArgs }) {
        const firstPositional = rawArgs.find((a) => !a.startsWith("-"));
        if (firstPositional && SUBAGENT_SUBCOMMANDS.has(firstPositional)) return;
        console.error(`${red("usage:")} deyin subagent <list|create|edit|delete|run|try> ...`);
        console.error(dim("Run \`deyin subagent create --help\` for the create options."));
        process.exitCode = 1;
      },
    }),
    upgrade: defineCommand({
      meta: { name: "upgrade", description: "Update deyin to the latest release" },
      async run() {
        process.exitCode = await upgradeCommand();
      },
    }),
    serve: defineCommand({
      meta: { name: "serve", description: "Start a localhost HTTP agent API" },
      args: {
        cwd: sharedArgs.cwd,
        port: { type: "string", description: "Listen port (default 7789)" },
        hostname: { type: "string", description: "Listen address (default 127.0.0.1)" },
        token: { type: "string", description: "Require this Bearer token for requests" },
      },
      async run({ args }) {
        const ctx = createContext({ cwd: typeof args.cwd === "string" ? args.cwd : undefined });
        const port = Number(args.port);
        process.exitCode = await serveCli(ctx, {
          port: Number.isInteger(port) && port >= 0 ? port : undefined,
          hostname: typeof args.hostname === "string" ? args.hostname : undefined,
          authToken: typeof args.token === "string" ? args.token : undefined,
        });
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
          trustWorkspace: Boolean(args.trust),
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
      trustWorkspace: Boolean(args.trust),
    });
  },
});

void runMain(main);
