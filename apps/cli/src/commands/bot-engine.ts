import { defineCommand } from "citty";
import { ENGINE_DEFAULT_PORT } from "@deyin/host-core";
import { engineStatus, serveBotEngine } from "@deyin/bot-engine";
import { VERSION } from "../version.js";

const shared = {
  home: { type: "string", description: "The engine's folder (default ~/.deyin-bot)" },
  port: { type: "string", description: `Port on the server's loopback (default ${ENGINE_DEFAULT_PORT})` },
  "token-file": { type: "string", description: "Where the key is (default <home>/token)" },
} as const;

function portFrom(value: unknown): number | undefined {
  const port = Number(value);
  return typeof value === "string" && Number.isInteger(port) && port >= 0 && port <= 65535 ? port : undefined;
}

function textFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export const botEngineCommand = defineCommand({
  meta: { name: "bot-engine", description: "The Deyin Bot engine: keeps Bots' files, commands and routines on this machine for the desktop app" },
  subCommands: {
    serve: defineCommand({
      meta: { name: "serve", description: "Run the engine until stopped (listens on this machine's loopback only)" },
      args: { ...shared, deyin: { type: "string", description: "The deyin command agents run with (default: this one)" } },
      async run({ args }) {
        const home = textFrom(args.home);
        const port = portFrom(args.port);
        const tokenFile = textFrom(args["token-file"]);
        const deyin = textFrom(args.deyin);
        process.exitCode = await serveBotEngine({
          version: VERSION,
          ...(home ? { home } : {}),
          ...(port !== undefined ? { port } : {}),
          ...(tokenFile ? { tokenFile } : {}),
          ...(deyin ? { deyin } : {}),
        });
      },
    }),
    status: defineCommand({
      meta: { name: "status", description: "Ask the running engine how it is" },
      args: shared,
      async run({ args }) {
        const home = textFrom(args.home);
        const port = portFrom(args.port);
        const tokenFile = textFrom(args["token-file"]);
        const result = await engineStatus({
          ...(home ? { home } : {}),
          ...(port !== undefined ? { port } : {}),
          ...(tokenFile ? { tokenFile } : {}),
        });
        if (!result.ok) {
          console.error(result.error);
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify(result.status, null, 2));
      },
    }),
  },
});
