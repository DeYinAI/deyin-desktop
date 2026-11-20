#!/usr/bin/env node
// What the fake `deyin bot-engine serve` runs: the real engine, with the fake agent behind it. Arguments are the ones the
// installer's scripts pass: serve --port N --home H --token-file T
import { fileURLToPath } from "node:url";
import { serveBotEngine } from "@deyin/bot-engine";

const FAKE_AGENT = fileURLToPath(new URL("../../../../packages/bot-engine/test/helpers/fake-deyin.mjs", import.meta.url));
// Started as `deyin bot-engine serve ...`, so the process list shows the same words the real one does.
const args = process.argv.slice(2).filter((word, index) => !(index === 0 && word === "bot-engine"));
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
if (args[0] !== "serve") {
  console.error(`unknown engine command ${args[0]}`);
  process.exit(64);
}
process.exitCode = await serveBotEngine({
  version: "1.2.3",
  home: flag("home"),
  port: Number(flag("port")),
  tokenFile: flag("token-file"),
  deyin: { command: process.execPath, args: [FAKE_AGENT] },
});
