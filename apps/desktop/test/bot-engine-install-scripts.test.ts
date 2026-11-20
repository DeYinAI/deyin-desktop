import assert from "node:assert/strict";
import { test } from "node:test";
import { BotError } from "@deyin/host-core";
import {
  CRON_MARK,
  PROBE_MARK,
  enginePaths,
  launcherScript,
  parseProbe,
  parseSignInPrompt,
  startNohupScript,
  stripAnsi,
  systemdUnit,
  writeKeyScript,
} from "../src/main/bots/engine/install-scripts.js";

const probeText = (over: Record<string, string | undefined> = {}, noise = ""): string => {
  const values: Record<string, string | undefined> = {
    os: "Linux",
    arch: "x86_64",
    home: "/home/anh",
    user: "anh",
    path: "/home/anh/.local/bin:/usr/bin",
    deyin: "/home/anh/.local/bin/deyin",
    deyinVersion: "deyin 1.2.3",
    botEngine: "1",
    systemdUser: "1",
    linger: "0",
    curl: "1",
    crontab: "1",
    ...over,
  };
  const lines = Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`);
  return `${noise}${PROBE_MARK}\n${lines.join("\n")}\n`;
};

const refuses = (fn: () => unknown, pattern: RegExp): void => {
  assert.throws(fn, (error) => error instanceof BotError && error.code === "conflict" && pattern.test(error.message));
};

test("a probe answer is read into what the installer needs to know", () => {
  assert.deepEqual(parseProbe(probeText()), {
    os: "Linux",
    arch: "x86_64",
    home: "/home/anh",
    user: "anh",
    path: "/home/anh/.local/bin:/usr/bin",
    deyin: "/home/anh/.local/bin/deyin",
    deyinVersion: "deyin 1.2.3",
    botEngine: true,
    systemdUser: true,
    linger: false,
    curl: true,
    crontab: true,
  });
});

test("noise a login shell prints before the marker is ignored, and the last marker wins", () => {
  const noisy = `Welcome to the server!\nos=Windows\n${probeText({ os: "Darwin" })}`;
  assert.equal(parseProbe(noisy).os, "Darwin");
  assert.equal(parseProbe(`${probeText({ os: "Linux" }, `${probeText({ os: "Darwin" })}\n`)}`).os, "Linux");
});

test("a server with no deyin has none of its details, and flags that are not 1 are false", () => {
  const probe = parseProbe(probeText({ deyin: "", deyinVersion: undefined, botEngine: undefined, systemdUser: "0", linger: "yes", curl: "", crontab: "0" }));
  assert.equal("deyin" in probe, false);
  assert.equal("deyinVersion" in probe, false);
  assert.deepEqual({ b: probe.botEngine, s: probe.systemdUser, l: probe.linger, c: probe.curl, t: probe.crontab }, { b: false, s: false, l: false, c: false, t: false });
});

test("an answer that is not a probe, or names an unsupported system, is refused", () => {
  refuses(() => parseProbe("bash: command not found"), /did not answer the way a Linux or macOS shell does/);
  refuses(() => parseProbe(probeText({ os: "FreeBSD" })), /Linux and macOS servers; this one reports FreeBSD/);
  refuses(() => parseProbe(probeText({ os: "" })), /did not say which system/);
  refuses(() => parseProbe(probeText({ os: undefined })), /did not say which system/);
  refuses(() => parseProbe(probeText({ home: "relative/home" })), /not an absolute path/);
  refuses(() => parseProbe(probeText({ home: "" })), /where its home folder is/);
  refuses(() => parseProbe(probeText({ user: "" })), /which user you are/);
  refuses(() => parseProbe(probeText({ path: "" })), /its PATH/);
  refuses(() => parseProbe(probeText({ arch: "" })), /its architecture/);
});

test("a value with a control character is refused, so it can never end up in a script", () => {
  refuses(() => parseProbe(probeText({ path: "/bin:\u0007/usr/bin" })), /characters that cannot be used/);
  refuses(() => parseProbe(probeText({ deyin: "/bin/deyin\u001b[0m" })), /characters that cannot be used/);
  refuses(() => parseProbe(probeText({ deyinVersion: "1\u0000" })), /characters that cannot be used/);
});

test("Windows line endings in the answer do not stick to the values", () => {
  const probe = parseProbe(probeText().replace(/\n/g, "\r\n"));
  assert.equal(probe.home, "/home/anh");
  assert.equal(probe.botEngine, true);
});

test("colour codes and carriage returns are taken out of terminal output", () => {
  assert.equal(stripAnsi("\u001b[0mTo sign in\u001b[36m x\u001b[0m\r\nok\u001b[1;31m!\u001b[0m"), "To sign in x\nok!");
  assert.equal(stripAnsi("plain"), "plain");
});

test("the sign-in link and code are read from what `deyin login` prints, colours and all", () => {
  const out = "\n\u001b[0mTo sign in, open \u001b[36mhttps://openference.com/device?user_code=ABCD-EFGH\u001b[0m\r\nand enter the code: \u001b[1mABCD-EFGH\u001b[0m\n\nWaiting for approval...\n";
  assert.deepEqual(parseSignInPrompt(out), { url: "https://openference.com/device?user_code=ABCD-EFGH", code: "ABCD-EFGH" });
});

test("nothing is returned until both the link and the code have been printed", () => {
  assert.equal(parseSignInPrompt(""), undefined);
  assert.equal(parseSignInPrompt("To sign in, open https://openference.com/device"), undefined);
  assert.equal(parseSignInPrompt("and enter the code: ABCD-EFGH"), undefined);
  assert.equal(parseSignInPrompt("To sign in, open https://openference.com/device\nand enter the code: "), undefined);
});

test("a sign-in link that is not a plain https link is refused, because the person will open it", () => {
  const code = "\nand enter the code: ABCD-EFGH\n";
  refuses(() => parseSignInPrompt(`To sign in, open http://evil.example/x${code}`), /not a plain https link/);
  refuses(() => parseSignInPrompt(`To sign in, open file:///etc/passwd${code}`), /not a plain https link/);
  refuses(() => parseSignInPrompt(`To sign in, open javascript:alert(1)${code}`), /not a plain https link/);
  refuses(() => parseSignInPrompt(`To sign in, open https://user:pw@evil.example/x${code}`), /not a plain https link/);
  refuses(() => parseSignInPrompt(`To sign in, open https://user@evil.example/x${code}`), /not a plain https link/);
  refuses(() => parseSignInPrompt(`To sign in, open not-a-link${code}`), /not a link/);
});

test("a code that cannot be a code is refused", () => {
  const link = "To sign in, open https://openference.com/device\n";
  refuses(() => parseSignInPrompt(`${link}and enter the code: abc`), /does not look like a code/);
  refuses(() => parseSignInPrompt(`${link}and enter the code: ${"A".repeat(33)}`), /does not look like a code/);
  assert.equal(parseSignInPrompt(`${link}and enter the code: ABCD`)?.code, "ABCD");
  assert.equal(parseSignInPrompt(`${link}and enter the code: ${"A".repeat(32)}`)?.code.length, 32);
});

const options = (over: Partial<Parameters<typeof launcherScript>[0]> = {}) => ({
  deyin: "/home/anh/.local/bin/deyin",
  port: 7790,
  path: "/home/anh/.local/bin:/usr/bin",
  paths: enginePaths("/home/anh"),
  ...over,
});

test("the engine's files are under its own folder in the server user's home", () => {
  assert.deepEqual(enginePaths("/home/anh"), {
    home: "/home/anh/.deyin-bot",
    token: "/home/anh/.deyin-bot/token",
    pid: "/home/anh/.deyin-bot/engine.pid",
    log: "/home/anh/.deyin-bot/engine.log",
    launcher: "/home/anh/.deyin-bot/launch.sh",
    unit: "/home/anh/.config/systemd/user/deyin-bot-engine.service",
  });
  assert.equal(enginePaths("/root").home, "/root/.deyin-bot");
});

test("the launcher writes its process id, sets the login PATH, and becomes the engine", () => {
  assert.equal(
    launcherScript(options()),
    "#!/bin/sh\necho $$ > '/home/anh/.deyin-bot/engine.pid'\nexport PATH='/home/anh/.local/bin:/usr/bin'\nexec '/home/anh/.local/bin/deyin' bot-engine serve --port 7790 --home '/home/anh/.deyin-bot' --token-file '/home/anh/.deyin-bot/token'\n",
  );
});

test("a path with a space or a quote is quoted in the launcher, however long the PATH is", () => {
  const script = launcherScript(options({ deyin: "/opt/my tools/it's/deyin", path: "/p:".repeat(5_000) }));
  assert.ok(script.includes(`exec '/opt/my tools/it'\\''s/deyin' bot-engine serve`), script);
  assert.ok(script.length > 15_000, "a long PATH is carried whole");
});

test("the systemd unit starts the engine on its port, restarts it, and carries the PATH", () => {
  const unit = systemdUnit(options());
  assert.match(unit, /^\[Unit\]\nDescription=Deyin Bot engine\n/);
  assert.ok(unit.includes("ExecStart=/home/anh/.local/bin/deyin bot-engine serve --port 7790 --home /home/anh/.deyin-bot --token-file /home/anh/.deyin-bot/token\n"));
  assert.ok(unit.includes('Environment="PATH=/home/anh/.local/bin:/usr/bin"\n'));
  assert.ok(unit.includes("Restart=always\nRestartSec=5\n"));
  assert.ok(unit.includes("[Install]\nWantedBy=default.target\n"));
  assert.ok(unit.endsWith("\n"));
});

test("systemd's special characters are escaped in the unit: spaces, quotes, % and $", () => {
  const unit = systemdUnit(options({ deyin: "/opt/a b/d%y$n", path: '/a"b:/c\\d:/p%q:/$HOME' }));
  assert.ok(unit.includes('ExecStart="/opt/a b/d%%y$$n" bot-engine serve'), unit);
  assert.ok(unit.includes('Environment="PATH=/a\\"b:/c\\\\d:/p%%q:/$$HOME"'), unit);
});

test("the nohup script puts the launcher in place from stdin and runs it detached, into the log", () => {
  const script = startNohupScript(options().paths, false);
  assert.ok(script.startsWith("set -e\numask 077\nmkdir -p '/home/anh/.deyin-bot'\ncat > '/home/anh/.deyin-bot/launch.sh.new'\nchmod 700 '/home/anh/.deyin-bot/launch.sh.new'\nmv -f '/home/anh/.deyin-bot/launch.sh.new' '/home/anh/.deyin-bot/launch.sh'\ncd '/home/anh/.deyin-bot'\n"), script);
  assert.ok(script.includes('if command -v setsid >/dev/null 2>&1; then run="setsid nohup"; else run="nohup"; fi'));
  assert.ok(script.includes("$run sh '/home/anh/.deyin-bot/launch.sh' >> '/home/anh/.deyin-bot/engine.log' 2>&1 < /dev/null &"));
  assert.ok(!script.includes("crontab"), "no cron unless asked");
  assert.ok(script.length < 1_500, "the script stays short whatever the PATH is");
});

test("the cron entry marks itself, escapes % for cron, and replaces only its own earlier line", () => {
  const script = startNohupScript(enginePaths("/home/a%b"), true);
  const entry = script.split("\n").find((line) => line.includes("crontab -l"));
  assert.ok(entry, script);
  assert.ok(entry.includes(`grep -v -F '${CRON_MARK}' || true`), "removes its own old line, and only that");
  assert.ok(entry.includes("| crontab -"));
  assert.ok(entry.includes("@reboot sh "), entry);
  assert.ok(entry.includes("/home/a\\%b/.deyin-bot/launch.sh"), entry);
  assert.ok(entry.includes("/home/a\\%b/.deyin-bot/engine.log"), entry);
  assert.ok(entry.includes(`${CRON_MARK}'; } | crontab -`), "the line ends with its mark");
  assert.ok(!/[^\\]%b/.test(entry), "no bare % is left in the entry");
});

test("the key script takes the key on stdin and never has it in the script text", () => {
  const script = writeKeyScript(enginePaths("/home/anh"));
  assert.ok(script.startsWith("set -e\numask 077\n"));
  assert.ok(script.includes("chmod 700 '/home/anh/.deyin-bot'"));
  assert.ok(script.includes("cat > '/home/anh/.deyin-bot/token.new'"));
  assert.ok(script.includes("chmod 600 '/home/anh/.deyin-bot/token.new'"));
  assert.ok(script.endsWith("mv -f '/home/anh/.deyin-bot/token.new' '/home/anh/.deyin-bot/token'"));
});
