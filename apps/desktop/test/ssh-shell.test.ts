import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";
import { after, test } from "node:test";
import { BotError } from "@deyin/host-core";
import { sshShell } from "../src/main/bots/engine/ssh-shell.js";
const { Client } = ssh2;
import { FakeServer } from "./helpers/fake-server.js";
import { startSshServer, type TestSshServer } from "./helpers/ssh-server.js";

const cleanups: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function connected(): Promise<{ client: InstanceType<typeof Client>; server: TestSshServer; fake: FakeServer }> {
  const fake = new FakeServer();
  const server = await startSshServer({ env: fake.env, cwd: fake.home });
  const client = new Client();
  await new Promise<void>((resolve, reject) => {
    client.once("ready", resolve).once("error", reject).connect({ host: "127.0.0.1", port: server.port, username: server.username, password: server.password });
  });
  cleanups.push(async () => {
    client.end();
    await server.close();
    fake.destroy();
  });
  return { client, server, fake };
}

test("a script runs in a login shell on the server and its output and exit code come back", async () => {
  const { client, server, fake } = await connected();
  const shell = sshShell(client);
  const result = await shell.run('echo "home=$HOME"; echo oops >&2; exit 3');
  assert.deepEqual({ code: result.code, stdout: result.stdout.trim(), stderr: result.stderr.trim() }, { code: 3, stdout: `home=${fake.home}`, stderr: "oops" });
  assert.match(server.execs[0] ?? "", /^bash -lc '/);
});

test("stdin reaches the script and is closed afterwards, so a reader does not wait", async () => {
  const { client } = await connected();
  const shell = sshShell(client);
  const result = await shell.run("cat", { stdin: "line one\nline two" });
  assert.equal(result.stdout, "line one\nline two");
  const none = await shell.run("cat; echo done");
  assert.equal(none.stdout.trim(), "done", "no stdin given: it still ends");
});

test("a script with quotes, newlines and dollar signs arrives as written", async () => {
  const { client } = await connected();
  const shell = sshShell(client);
  const script = `x='it'"'"'s'\nprintf '%s|%s\\n' "$x" '$HOME "quoted" \`tick\`'`;
  const result = await shell.run(script);
  assert.equal(result.stdout.trim(), `it's|$HOME "quoted" \`tick\``);
});

test("output is passed on as it arrives, from both streams", async () => {
  const { client } = await connected();
  const shell = sshShell(client);
  const seen: string[] = [];
  await shell.run("echo first; sleep 0.2; echo second >&2; sleep 0.2; echo third", { onOutput: (chunk) => seen.push(chunk) });
  const text = seen.join("");
  assert.ok(text.includes("first") && text.includes("second") && text.includes("third"));
  assert.ok(seen.length >= 3, "in more than one piece");
});

test("only the end of very long output is kept", async () => {
  const { client } = await connected();
  const shell = sshShell(client);
  const result = await shell.run("i=0; while [ $i -lt 40 ]; do head -c 10000 /dev/zero | tr '\\0' 'a'; i=$((i+1)); done; echo END");
  assert.ok(result.stdout.length <= 256 * 1024, `kept ${result.stdout.length}`);
  assert.ok(result.stdout.endsWith("END\n"));
});

test("stopping a script closes it and says it was stopped", async () => {
  const { client } = await connected();
  const shell = sshShell(client);
  const controller = new AbortController();
  const running = shell.run("echo started; sleep 30", { signal: controller.signal, onOutput: () => controller.abort() });
  await assert.rejects(running, (error) => error instanceof BotError && /Stopped/.test(error.message));
  await assert.rejects(shell.run("echo never", { signal: controller.signal }), (error) => error instanceof BotError && /Stopped/.test(error.message));
});

test("a connection that drops mid-script is reported, not read as success", async () => {
  const { client, server } = await connected();
  const shell = sshShell(client);
  const running = shell.run("echo started; sleep 30", { onOutput: () => server.dropConnections() });
  await assert.rejects(running, (error) => error instanceof BotError && /dropped/.test(error.message));
});

test("a server that will not run the command is a message, not a hang", async () => {
  const { client } = await connected();
  client.end();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(sshShell(client).run("echo hi"), (error) => error instanceof BotError && /would not run/.test(error.message));
});

test("scratch dirs are cleaned up", () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-shell-"));
  mkdirSync(join(dir, "x"));
  rmSync(dir, { recursive: true, force: true });
});
