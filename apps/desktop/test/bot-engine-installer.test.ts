import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { userInfo } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";
import { after, test } from "node:test";
import { BotError, generateEngineToken, type EngineStatus } from "@deyin/host-core";
import { EngineClient } from "../src/main/bots/engine/client.js";
import {
  installEngine,
  tailOf,
  uninstallEngine,
  type InstallOptions,
  type InstallProgress,
  type InstallRegistration,
  type InstallResult,
  type RemoteShell,
} from "../src/main/bots/engine/installer.js";
import { CRON_MARK } from "../src/main/bots/engine/install-scripts.js";
import { sshShell } from "../src/main/bots/engine/ssh-shell.js";
import { FakeServer, freePort, type FakeServerOptions } from "./helpers/fake-server.js";
import { startSshServer, type TestSshServer } from "./helpers/ssh-server.js";

const { Client } = ssh2;

const cleanups: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

interface Rig {
  fake: FakeServer;
  ssh: TestSshServer;
  shell: ReturnType<typeof sshShell>;
  port: number;
  token: string;
  progress: InstallProgress[];
  prompts: Array<{ url: string; code: string }>;
  registrations: InstallRegistration[];
  install(over?: Partial<InstallOptions>): Promise<InstallResult>;
  status(): Promise<EngineStatus>;
}

async function rig(options: FakeServerOptions = {}): Promise<Rig> {
  const fake = new FakeServer(options);
  const ssh = await startSshServer({ env: fake.env, cwd: fake.home });
  const client = new Client();
  await new Promise<void>((resolve, reject) => {
    client.once("ready", resolve).once("error", reject).connect({ host: "127.0.0.1", port: ssh.port, username: ssh.username, password: ssh.password });
  });
  cleanups.push(async () => {
    client.end();
    await ssh.close();
    fake.destroy();
  });
  const shell = sshShell(client);
  const port = await freePort();
  const token = generateEngineToken();
  const progress: InstallProgress[] = [];
  const prompts: Array<{ url: string; code: string }> = [];
  const registrations: InstallRegistration[] = [];
  const status = (): Promise<EngineStatus> => new EngineClient({ host: "127.0.0.1", port, token, label: "Test server" }).status();
  return {
    fake,
    ssh,
    shell,
    port,
    token,
    progress,
    prompts,
    registrations,
    status,
    install: (over = {}) =>
      installEngine({
        shell,
        token,
        port,
        onProgress: (p) => progress.push(p),
        onSignIn: (p) => prompts.push(p),
        register: (r) => registrations.push(r),
        verify: status,
        verifyAttempts: 60,
        verifyIntervalMs: 100,
        ...over,
      }),
  };
}

async function refused(promise: Promise<unknown>, pattern: RegExp): Promise<BotError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof BotError, `a BotError, got ${String(error)}`);
    assert.match(error.message, pattern);
    return error;
  }
  assert.fail("expected a refusal");
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const steps = (r: Rig): string[] => r.progress.map((p) => `${p.step}:${p.state}`);
const pidOf = (r: Rig, file: string): number => Number((r.fake.file(file) ?? "").trim());

test("a server that has everything gets the engine as a service, with the key kept private", async () => {
  const r = await rig();
  const result = await r.install();
  assert.equal(result.supervisor, "systemd");
  assert.equal(result.survivesReboot, true);
  assert.equal(result.version, "1.2.3");
  assert.equal(result.deyinVersion, "deyin 1.2.3");
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(steps(r), ["probe:running", "probe:done", "cli:skipped", "sign-in:skipped", "key:running", "key:done", "start:running", "start:done", "verify:running", "verify:done"]);
  assert.deepEqual(r.registrations, [{ port: r.port, token: r.token, supervisor: "systemd", survivesReboot: true }]);
  assert.equal((await r.status()).agent.signedIn, true, "the engine answers with the key, and its agent is signed in");

  const key = join(r.fake.home, ".deyin-bot", "token");
  assert.equal(r.fake.file(".deyin-bot/token"), r.token);
  assert.equal(statSync(key).mode & 0o777, 0o600, "the key is readable by its owner only");
  assert.equal(statSync(join(r.fake.home, ".deyin-bot")).mode & 0o777, 0o700);
  assert.ok(!r.ssh.execs.join("\n").includes(r.token), "the key never appears in a command, so never in a process list");

  const unit = r.fake.file(".config/systemd/user/deyin-bot-engine.service") ?? "";
  assert.ok(unit.includes(`--port ${r.port} `));
  assert.ok(unit.includes(`ExecStart=${join(r.fake.home, ".local/bin/deyin")} bot-engine serve`));
  assert.ok(unit.includes(`Environment="PATH=${r.fake.path}"`));
  assert.match(r.fake.file(".fake-systemd/calls") ?? "", /daemon-reload\nenable deyin-bot-engine\.service\nrestart deyin-bot-engine\.service\n/);
  assert.equal(r.fake.crontab(), undefined, "no cron entry when systemd keeps it running");
});

test("running setup again keeps one engine, the same key, and restarts it", async () => {
  const r = await rig();
  await r.install();
  const first = pidOf(r, ".fake-systemd/pid");
  assert.ok(alive(first));
  r.progress.length = 0;
  const again = await r.install();
  assert.equal(again.supervisor, "systemd");
  const second = pidOf(r, ".fake-systemd/pid");
  assert.notEqual(second, first);
  assert.equal(alive(first), false, "the old engine is gone");
  assert.ok(alive(second));
  assert.equal(r.fake.file(".deyin-bot/token"), r.token);
  assert.equal((await r.status()).version, "1.2.3");
  assert.equal(((r.fake.file(".fake-systemd/calls") ?? "").match(/restart/g) ?? []).length, 2);
});

test("with no systemd the engine runs in the background and comes back at reboot through cron", async () => {
  const r = await rig({ systemd: false });
  const result = await r.install();
  assert.equal(result.supervisor, "nohup");
  assert.equal(result.survivesReboot, true);
  assert.deepEqual(result.warnings, []);
  const pid = pidOf(r, ".deyin-bot/engine.pid");
  assert.ok(alive(pid), "the engine is running");
  assert.equal((await r.status()).version, "1.2.3");
  const lines = (r.fake.crontab() ?? "").split("\n").filter((l) => l.includes(CRON_MARK));
  assert.equal(lines.length, 1);
  assert.equal(lines[0], `@reboot sh '${join(r.fake.home, ".deyin-bot", "launch.sh")}' >> '${join(r.fake.home, ".deyin-bot", "engine.log")}' 2>&1 < /dev/null ${CRON_MARK}`);
  const launcher = r.fake.file(".deyin-bot/launch.sh") ?? "";
  assert.match(launcher, new RegExp(`exec '.*/deyin' bot-engine serve --port ${r.port} --home '.*/\\.deyin-bot' --token-file '.*/\\.deyin-bot/token'`));
  assert.equal(statSync(join(r.fake.home, ".deyin-bot", "launch.sh")).mode & 0o777, 0o700);
  assert.equal(r.fake.has(".config/systemd/user/deyin-bot-engine.service"), false);
});

test("setting up again with nohup replaces the engine and the cron line, and leaves other cron lines alone", async () => {
  const r = await rig({ systemd: false });
  await r.install();
  const existing = r.fake.crontab() ?? "";
  writeFileSync(join(r.fake.home, ".fake-crontab"), `0 3 * * * /usr/bin/backup\n${existing}30 4 * * * /usr/bin/other\n`);
  const first = pidOf(r, ".deyin-bot/engine.pid");
  await r.install();
  const second = pidOf(r, ".deyin-bot/engine.pid");
  assert.notEqual(second, first);
  assert.equal(alive(first), false);
  assert.ok(alive(second));
  const cron = r.fake.crontab() ?? "";
  assert.equal(cron.split("\n").filter((l) => l.includes(CRON_MARK)).length, 1, "still one engine line");
  assert.ok(cron.includes("0 3 * * * /usr/bin/backup\n"), "others kept");
  assert.ok(cron.includes("30 4 * * * /usr/bin/other\n"), "others kept");
});

test("a server that would stop the engine at logout runs it on its own and says how to fix that", async () => {
  const r = await rig({ lingerAllowed: false });
  const result = await r.install();
  assert.equal(result.supervisor, "nohup");
  assert.equal(result.survivesReboot, true, "cron brings it back");
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0]!.includes(`enable-linger ${userInfo().username}\``), result.warnings[0]);
  assert.match(r.fake.file(".fake-loginctl-calls") ?? "", /^enable-linger \S+\n$/, "it asked once to keep the user's services running");
  assert.ok(alive(pidOf(r, ".deyin-bot/engine.pid")));
  assert.equal(r.fake.has(".fake-systemd/pid"), false, "nothing was started under systemd");
});

test("a server whose systemd has no user manager is treated like one without systemd", async () => {
  const r = await rig({ noUserManager: true });
  const result = await r.install();
  assert.equal(result.supervisor, "nohup");
  assert.deepEqual(result.warnings, []);
});

test("with linger already on, the engine runs as a service without asking to change anything", async () => {
  const r = await rig({ lingerEnabled: true, lingerAllowed: false });
  const result = await r.install();
  assert.equal(result.supervisor, "systemd");
  assert.deepEqual(result.warnings, []);
  assert.equal(r.fake.has(".fake-loginctl-calls"), false, "nothing on the server's login settings was touched");
});

test("a server with neither systemd nor cron runs the engine but says it will not return after a restart", async () => {
  const r = await rig({ systemd: false, cron: false });
  const result = await r.install();
  assert.equal(result.supervisor, "nohup");
  assert.equal(result.survivesReboot, false);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /no cron/);
  assert.deepEqual(r.registrations[0]?.survivesReboot, false);
  assert.equal((await r.status()).version, "1.2.3");
});

test("switching from the background engine to a service stops the old one and its cron line", async () => {
  const r = await rig({ lingerAllowed: false });
  await r.install();
  const old = pidOf(r, ".deyin-bot/engine.pid");
  assert.ok(alive(old));
  writeFileSync(join(r.fake.home, ".fake-linger"), "yes");
  const result = await r.install();
  assert.equal(result.supervisor, "systemd");
  assert.equal(alive(old), false, "the background engine was stopped");
  assert.ok(!(r.fake.crontab() ?? "").includes(CRON_MARK), "and its cron line removed");
  assert.equal((await r.status()).version, "1.2.3");
});

test("deyin is installed first when the server has none", async () => {
  const r = await rig({ deyinInstalled: false });
  assert.equal(r.fake.has(".local/bin/deyin"), false);
  const result = await r.install();
  assert.ok(r.fake.has(".local/bin/deyin"));
  assert.equal(result.deyinVersion, "deyin 1.2.3");
  assert.ok(steps(r).includes("cli:running") && steps(r).includes("cli:done"));
  assert.ok(r.ssh.execs.some((c) => c.includes("curl -fsSL") && c.includes("https://cdn.deyin.ai/cli/install.sh") && c.includes("| bash")));
  assert.equal((await r.status()).version, "1.2.3");
});

test("a deyin that has no Bot engine is updated", async () => {
  const r = await rig({ botEngine: false });
  await r.install();
  assert.ok(steps(r).includes("cli:running"));
  assert.equal((await r.status()).version, "1.2.3");
});

test("a server with no deyin and no curl is told what to do and is left untouched", async () => {
  const r = await rig({ deyinInstalled: false, curl: false });
  await refused(r.install(), /no curl to do it with/);
  assert.equal(r.fake.has(".deyin-bot"), false, "no key placed");
  assert.deepEqual(r.registrations, []);
});

test("a download that still has no Bot engine is a clear message, with nothing started", async () => {
  const r = await rig({ botEngine: false, downloadHasBotEngine: false });
  await refused(r.install(), /does not include the Bot engine yet/);
  assert.equal(r.fake.has(".deyin-bot"), false);
  assert.deepEqual(r.registrations, []);
});

test("a server that is not signed in shows the person the link and code, then carries on once approved", async () => {
  const r = await rig({ signedIn: false });
  const result = await r.install();
  assert.deepEqual(r.prompts, [{ url: "https://openference.com/device?user_code=ABCD-EFGH", code: "ABCD-EFGH" }], "once, with no colour codes");
  assert.ok(steps(r).includes("sign-in:running") && steps(r).includes("sign-in:done"));
  assert.deepEqual(result.warnings, []);
  assert.equal((await r.status()).agent.signedIn, true);
});

test("a sign-in that is refused stops setup before anything is placed", async () => {
  const r = await rig({ signedIn: false, loginFails: true });
  await refused(r.install(), /Signing in on the server did not finish \(exit 1\):\n[\s\S]*access denied/);
  assert.equal(r.prompts.length, 1);
  assert.equal(r.fake.has(".deyin-bot"), false);
  assert.deepEqual(r.registrations, []);
});

test("a sign-in that finishes without the server being signed in is not trusted", async () => {
  const r = await rig({ signedIn: false, loginDoesNotStick: true });
  await refused(r.install(), /still is not signed in after the sign-in finished/);
  assert.equal(r.fake.has(".deyin-bot"), false);
});

test("switching from a service to the background engine stops and turns off the service first", async () => {
  const r = await rig({ lingerEnabled: true, lingerAllowed: false });
  await r.install();
  const old = pidOf(r, ".fake-systemd/pid");
  assert.ok(alive(old));
  rmSync(join(r.fake.home, ".fake-linger"));
  const result = await r.install();
  assert.equal(result.supervisor, "nohup");
  assert.equal(alive(old), false, "the service was stopped, so it does not hold the port or answer for the new engine");
  assert.equal(r.fake.has(".fake-systemd/enabled"), false, "and it will not start again at login");
  assert.ok(alive(pidOf(r, ".deyin-bot/engine.pid")));
  assert.equal((await r.status()).version, "1.2.3");
});

test("a deyin that is signed in but could not fetch its profile counts as signed in", async () => {
  const r = await rig({ whoamiExit: 1 });
  const result = await r.install();
  assert.ok(steps(r).includes("sign-in:skipped"));
  assert.deepEqual(r.prompts, [], "the person is not asked to sign in again");
  assert.equal(result.supervisor, "systemd");
});

test("a sign-in check that gives an answer nobody expected stops setup before anything is placed", async () => {
  const r = await rig({ whoamiExit: 3 });
  await refused(r.install(), /Could not check whether deyin is signed in on the server \(exit 3\)/);
  assert.equal(r.fake.has(".deyin-bot"), false);
  assert.deepEqual(r.registrations, []);
});

test("a download that fails stops setup with the reason, not with a claim that deyin is missing", async () => {
  const r = await rig({ deyinInstalled: false, curlFails: true });
  await refused(r.install(), /Installing deyin failed on the server \(exit 22\):\n[\s\S]*404/);
  assert.equal(r.fake.has(".deyin-bot"), false);
  assert.deepEqual(r.registrations, []);
});

test("a key that cannot be placed stops setup, says why, and starts nothing", async () => {
  const r = await rig();
  writeFileSync(join(r.fake.home, ".deyin-bot"), "a file where the engine's folder goes");
  await refused(r.install(), /Placing the key failed on the server \(exit 1\):\n[\s\S]*\.deyin-bot/);
  assert.deepEqual(r.registrations, []);
  assert.equal(r.fake.has(".fake-systemd/calls"), false, "no service was set up");
});

test("stopping while the engine is being started is honoured even though that step itself worked", async () => {
  const r = await rig();
  const controller = new AbortController();
  const shell: RemoteShell = {
    run: async (script, options) => {
      const result = await r.shell.run(script, options);
      if (script.includes("systemctl --user restart")) controller.abort();
      return result;
    },
  };
  await refused(r.install({ shell, signal: controller.signal }), /Setup was stopped/);
  assert.deepEqual(r.registrations, [], "an engine that setup was told to stop on is not recorded as ready");
});

test("a system that is not Linux or macOS is refused before anything runs on it", async () => {
  const r = await rig({ os: "FreeBSD" });
  await refused(r.install(), /Linux and macOS servers; this one reports FreeBSD/);
  assert.equal(r.ssh.execs.length, 1, "only the check ran");
});

test("macOS is accepted", async () => {
  const r = await rig({ os: "Darwin", systemd: false });
  const result = await r.install();
  assert.equal(result.supervisor, "nohup");
});

test("an engine that cannot start says why, using the engine's own log", async () => {
  const r = await rig({ systemd: false });
  const busy: Server = createServer((_req, res) => res.writeHead(404).end());
  await new Promise<void>((resolve) => busy.listen(r.port, "127.0.0.1", () => resolve()));
  cleanups.push(() => new Promise<void>((resolve) => busy.close(() => resolve())));
  const error = await refused(r.install({ verifyAttempts: 8, verifyIntervalMs: 50 }), /The engine did not answer after it was started/);
  assert.match(error.message, /The engine's log says:\n[\s\S]*EADDRINUSE/);
  assert.equal(r.registrations.length, 1, "it was recorded before it was checked");
});

test("the engine is asked again until it answers, and not for longer than the attempts allow", async () => {
  const r = await rig();
  const real = r.status;
  let calls = 0;
  const slept: number[] = [];
  const result = await r.install({
    verify: async () => {
      calls += 1;
      if (calls < 4) throw new Error("not yet");
      return real();
    },
    sleep: async (ms) => {
      slept.push(ms);
      await new Promise((resolve) => setTimeout(resolve, 150));
    },
    verifyIntervalMs: 250,
  });
  assert.equal(result.version, "1.2.3");
  assert.equal(calls, 4);
  assert.deepEqual(slept, [250, 250, 250]);

  const never = await rig({ systemd: false });
  let tries = 0;
  const naps: number[] = [];
  await refused(
    never.install({
      verify: async () => {
        tries += 1;
        throw new Error("still no");
      },
      sleep: async (ms) => {
        naps.push(ms);
      },
      verifyAttempts: 3,
    }),
    /did not answer after it was started: still no/,
  );
  assert.equal(tries, 3);
  assert.equal(naps.length, 2, "no wait after the last try");
});

test("an engine whose agent is missing or signed out is up, with a warning that Bots cannot run yet", async () => {
  const r = await rig();
  const real = await (async () => {
    await r.install();
    return r.status();
  })();
  const make = (agent: EngineStatus["agent"]) => async (): Promise<EngineStatus> => ({ ...real, agent });
  const signedOut = await r.install({ verify: make({ found: true, version: "1", signedIn: false }) });
  assert.deepEqual(signedOut.warnings, ["deyin on the server is not signed in, so Bots cannot run there yet."]);
  const missing = await r.install({ verify: make({ found: false, signedIn: false }) });
  assert.deepEqual(missing.warnings, ["The engine could not find deyin to run Bots with."]);
});

test("stopping setup part way says so and goes no further", async () => {
  const r = await rig({ signedIn: false });
  const controller = new AbortController();
  const running = r.install({ signal: controller.signal, onSignIn: () => controller.abort() });
  await refused(running, /Setup was stopped|Stopped/);
  assert.equal(r.fake.has(".deyin-bot"), false, "the key was not placed");
  assert.deepEqual(r.registrations, []);
  await refused(r.install({ signal: controller.signal }), /Setup was stopped/);
});

test("removing the engine stops it, forgets it and deletes its key, but keeps the Bots' files", async () => {
  const r = await rig();
  await r.install();
  const pid = pidOf(r, ".fake-systemd/pid");
  mkdirSync(join(r.fake.home, ".deyin-bot", "bots", "b1", "files"), { recursive: true });
  writeFileSync(join(r.fake.home, ".deyin-bot", "bots", "b1", "files", "keep.txt"), "mine");
  await uninstallEngine({ shell: r.shell, purge: false });
  assert.equal(alive(pid), false, "the engine is stopped");
  assert.equal(r.fake.has(".config/systemd/user/deyin-bot-engine.service"), false);
  assert.equal(r.fake.has(".deyin-bot/token"), false);
  assert.equal(r.fake.file(".deyin-bot/bots/b1/files/keep.txt"), "mine");
  await refused(r.status(), /Could not reach|did not answer|ECONNREFUSED/);
});

test("removing the engine with purge deletes the Bots' files as well", async () => {
  const r = await rig({ systemd: false });
  await r.install();
  const pid = pidOf(r, ".deyin-bot/engine.pid");
  mkdirSync(join(r.fake.home, ".deyin-bot", "bots", "b1"), { recursive: true });
  writeFileSync(join(r.fake.home, ".deyin-bot", "bots", "b1", "x"), "x");
  writeFileSync(join(r.fake.home, ".fake-crontab"), `0 3 * * * /usr/bin/backup\n${r.fake.crontab() ?? ""}`);
  await uninstallEngine({ shell: r.shell, purge: true });
  assert.equal(alive(pid), false);
  assert.equal(r.fake.has(".deyin-bot"), false);
  const cron = r.fake.crontab() ?? "";
  assert.ok(!cron.includes(CRON_MARK));
  assert.ok(cron.includes("0 3 * * * /usr/bin/backup"), "other cron lines stay");
});

test("removing an engine that was never installed is harmless", async () => {
  const r = await rig({ systemd: false, cron: false });
  await uninstallEngine({ shell: r.shell, purge: false });
  await uninstallEngine({ shell: r.shell, purge: true });
});

test("a stale process id in the pid file does not get an unrelated process killed", async () => {
  const r = await rig({ systemd: false });
  const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
  cleanups.push(() => void bystander.kill("SIGKILL"));
  mkdirSync(join(r.fake.home, ".deyin-bot"), { recursive: true });
  writeFileSync(join(r.fake.home, ".deyin-bot", "engine.pid"), String(bystander.pid));
  await r.install();
  assert.ok(alive(bystander.pid!), "the other process was left alone");
});

test("a unit that cannot be written stops setup at that step, not later at a vaguer one", async () => {
  const r = await rig();
  writeFileSync(join(r.fake.home, ".config"), "a file where the systemd folder goes");
  await refused(r.install(), /Starting the engine service failed on the server \(exit 1\):\n[\s\S]*\.config/);
  assert.deepEqual(r.registrations, [], "nothing was recorded as running");
});

test("a launcher that cannot be written stops setup at that step, and nothing is put in its place", async () => {
  const r = await rig({ systemd: false });
  mkdirSync(join(r.fake.home, ".deyin-bot", "launch.sh.new"), { recursive: true });
  await refused(r.install(), /Starting the engine failed on the server \(exit 1\):\n[\s\S]*launch\.sh\.new/);
  assert.deepEqual(r.registrations, []);
  assert.equal(statSync(join(r.fake.home, ".deyin-bot", "launch.sh.new")).isDirectory(), true, "what was in the way was left where it is");
  assert.equal(r.fake.has(".deyin-bot/launch.sh"), false);
});

test("a key that is only half placed is not taken for placed", async () => {
  const r = await rig();
  mkdirSync(join(r.fake.home, ".deyin-bot", "token.new"), { recursive: true });
  await refused(r.install(), /Placing the key failed on the server \(exit 1\)/);
  assert.equal(r.fake.has(".deyin-bot/token"), false, "no key stands where a half-written one was");
  assert.deepEqual(r.registrations, []);
});

test("a process whose arguments only mention serve is not taken for the engine", async () => {
  const r = await rig({ systemd: false });
  const bystander = spawn("sh", ["-c", "sleep 30", "serve"], { stdio: "ignore" });
  cleanups.push(() => void bystander.kill("SIGKILL"));
  mkdirSync(join(r.fake.home, ".deyin-bot"), { recursive: true });
  writeFileSync(join(r.fake.home, ".deyin-bot", "engine.pid"), String(bystander.pid));
  await r.install();
  assert.ok(alive(bystander.pid!), "a process that is not `bot-engine serve` was left alone");
});

test("an engine that ignores the polite stop is stopped anyway before the new one starts", async () => {
  const r = await rig({ systemd: false });
  const stubborn = spawn("sh", ["-c", 'trap "" TERM; while :; do sleep 1; done', "bot-engine", "serve"], { stdio: "ignore" });
  cleanups.push(() => void stubborn.kill("SIGKILL"));
  mkdirSync(join(r.fake.home, ".deyin-bot"), { recursive: true });
  writeFileSync(join(r.fake.home, ".deyin-bot", "engine.pid"), String(stubborn.pid));
  await new Promise((resolve) => setTimeout(resolve, 300));
  await r.install();
  assert.equal(alive(stubborn.pid!), false, "the old engine did not outlive setup");
  assert.equal((await r.status()).version, "1.2.3");
});

test("the tail of output for a message drops colour, blank lines and old lines, and is bounded", () => {
  assert.equal(tailOf("\u001b[31mred\u001b[0m\n\n  \nline2   \n"), "red\nline2");
  const many = Array.from({ length: 20 }, (_v, i) => `line${i}`).join("\n");
  assert.equal(tailOf(many, 3), "line17\nline18\nline19");
  const long = tailOf("x".repeat(2000), 8, 100);
  assert.equal(long.length, 101);
  assert.ok(long.startsWith("…"));
  assert.equal(tailOf(""), "");
});
