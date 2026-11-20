import { posix } from "node:path";
import { BotError, ENGINE_HOME } from "@deyin/host-core";
import { shellQuote } from "../../automations/cli-invocation.js";

/**
 * The shell the installer sends to a server, and the readers for what comes back. Pure strings in, strings out: the
 * installer runs them over SSH, and the tests run the very same text in a real shell against a fake server.
 *
 * Scripts are plain bash. Anything that could be a secret (the engine's key) goes in on stdin, never in the text of a
 * command, so it never shows up in a process list.
 */

export const SERVICE_NAME = "deyin-bot-engine";
/** Ends the cron line the installer adds, so it can find that line again and no other. */
export const CRON_MARK = "# deyin-bot-engine";
export const PROBE_MARK = "__DEYIN_PROBE__";
export const CLI_INSTALL_URL = "https://cdn.deyin.ai/cli/install.sh";

/** Where the engine keeps its files on the server, given the server user's home. */
export interface EnginePaths {
  home: string;
  token: string;
  pid: string;
  log: string;
  /** The small script that starts the engine when it is not run by systemd. */
  launcher: string;
  unit: string;
}

export function enginePaths(serverHome: string): EnginePaths {
  const home = posix.join(serverHome, ENGINE_HOME);
  return {
    home,
    token: posix.join(home, "token"),
    pid: posix.join(home, "engine.pid"),
    log: posix.join(home, "engine.log"),
    launcher: posix.join(home, "launch.sh"),
    unit: posix.join(serverHome, ".config", "systemd", "user", `${SERVICE_NAME}.service`),
  };
}

const q = shellQuote;

/* Probe ----------------------------------------------------------------------- */

/** What the installer learns about a server before it changes anything. */
export interface ServerProbe {
  os: string;
  arch: string;
  /** The server user's home, absolute. */
  home: string;
  user: string;
  /** The PATH a login shell has there; the engine's agents run with it. */
  path: string;
  /** Absolute path to `deyin`, when it is installed. */
  deyin?: string;
  deyinVersion?: string;
  /** The installed `deyin` has the `bot-engine` command. */
  botEngine: boolean;
  /** A systemd user manager is running. */
  systemdUser: boolean;
  /** The user's services keep running after logout. */
  linger: boolean;
  curl: boolean;
  crontab: boolean;
}

/** Writes one `key=value` per line after a marker, so noise a login shell prints first is ignored. */
export const PROBE_SCRIPT = `
echo ${PROBE_MARK}
echo "os=$(uname -s 2>/dev/null)"
echo "arch=$(uname -m 2>/dev/null)"
echo "home=$HOME"
echo "user=$(id -un 2>/dev/null)"
echo "path=$PATH"
d="$(command -v deyin 2>/dev/null || true)"
if [ -z "$d" ] && [ -x "$HOME/.local/bin/deyin" ]; then d="$HOME/.local/bin/deyin"; fi
echo "deyin=$d"
if [ -n "$d" ]; then
  echo "deyinVersion=$("$d" --version 2>/dev/null | head -n 1)"
  if "$d" --help 2>/dev/null | grep -q 'bot-engine'; then echo "botEngine=1"; else echo "botEngine=0"; fi
fi
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then echo "systemdUser=1"; else echo "systemdUser=0"; fi
${lingerCheck()}
if command -v curl >/dev/null 2>&1; then echo "curl=1"; else echo "curl=0"; fi
if command -v crontab >/dev/null 2>&1; then echo "crontab=1"; else echo "crontab=0"; fi
`;

function lingerCheck(): string {
  return `if command -v loginctl >/dev/null 2>&1 && loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then echo "linger=1"; else echo "linger=0"; fi`;
}

function plain(value: string | undefined, what: string): string {
  if (value === undefined || value === "") throw new BotError("conflict", `The server did not say ${what}.`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new BotError("conflict", `The server's answer for ${what} has characters that cannot be used.`);
  return value;
}

/** Read what `PROBE_SCRIPT` printed. Throws `BotError` when the server's answer cannot be used. */
export function parseProbe(output: string): ServerProbe {
  const at = output.lastIndexOf(PROBE_MARK);
  if (at < 0) throw new BotError("conflict", "The server did not answer the way a Linux or macOS shell does.");
  const values = new Map<string, string>();
  for (const line of output.slice(at + PROBE_MARK.length).split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) values.set(line.slice(0, eq), line.slice(eq + 1));
  }
  const os = plain(values.get("os"), "which system it runs");
  if (os !== "Linux" && os !== "Darwin") throw new BotError("conflict", `The Bot engine runs on Linux and macOS servers; this one reports ${os}.`);
  const home = plain(values.get("home"), "where its home folder is");
  if (!home.startsWith("/")) throw new BotError("conflict", "The server's home folder is not an absolute path.");
  const deyin = values.get("deyin");
  const version = values.get("deyinVersion");
  return {
    os,
    arch: plain(values.get("arch"), "its architecture"),
    home,
    user: plain(values.get("user"), "which user you are"),
    path: plain(values.get("path"), "its PATH"),
    ...(deyin ? { deyin: plain(deyin, "where deyin is") } : {}),
    ...(version ? { deyinVersion: plain(version, "the deyin version") } : {}),
    botEngine: values.get("botEngine") === "1",
    systemdUser: values.get("systemdUser") === "1",
    linger: values.get("linger") === "1",
    curl: values.get("curl") === "1",
    crontab: values.get("crontab") === "1",
  };
}

/* The CLI ---------------------------------------------------------------------- */

/**
 * Install or update the Deyin CLI with its own installer. Needs curl. `pipefail` makes a download that failed fail the
 * step; without it `bash` is handed nothing, succeeds, and the person is told deyin "cannot be found" instead of why.
 */
export const INSTALL_CLI_SCRIPT = `set -o pipefail; curl -fsSL ${q(CLI_INSTALL_URL)} | bash`;

export function whoamiScript(deyin: string): string {
  return `${q(deyin)} whoami`;
}

/** Device sign-in: prints a link and a code, then waits for the person to approve. */
export function loginScript(deyin: string): string {
  return `${q(deyin)} login`;
}

/** Take the colour codes and carriage returns out of what a terminal program printed. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}

export interface SignInPrompt {
  url: string;
  code: string;
}

const SIGN_IN_URL = /To sign in, open (\S+)/;
const SIGN_IN_CODE = /enter the code:\s*([A-Za-z0-9-]+)/;

/**
 * The link and code `deyin login` printed, once both are there. The link comes from the server and the person will
 * open it, so only a plain `https` link is passed on.
 */
export function parseSignInPrompt(output: string): SignInPrompt | undefined {
  const text = stripAnsi(output);
  const url = SIGN_IN_URL.exec(text)?.[1];
  const code = SIGN_IN_CODE.exec(text)?.[1];
  if (!url || !code) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BotError("conflict", "The sign-in link the server printed is not a link.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new BotError("conflict", "The sign-in link the server printed is not a plain https link, so it was not opened.");
  }
  if (code.length < 4 || code.length > 32) throw new BotError("conflict", "The sign-in code the server printed does not look like a code.");
  return { url: parsed.toString(), code };
}

/* The key ---------------------------------------------------------------------- */

/** Put the key (from stdin) in the engine's folder, readable by this user only. */
export function writeKeyScript(paths: EnginePaths): string {
  return [
    "set -e",
    "umask 077",
    `mkdir -p ${q(paths.home)}`,
    `chmod 700 ${q(paths.home)}`,
    `cat > ${q(`${paths.token}.new`)}`,
    `chmod 600 ${q(`${paths.token}.new`)}`,
    `mv -f ${q(`${paths.token}.new`)} ${q(paths.token)}`,
  ].join("\n");
}

/* Starting and stopping -------------------------------------------------------- */

export interface LaunchOptions {
  deyin: string;
  port: number;
  /** The login shell's PATH, so the agents the engine runs find their tools. */
  path: string;
  paths: EnginePaths;
}

/**
 * The script that starts the engine when systemd does not: it writes its process id, sets the login PATH, and becomes
 * the engine. It is put on the server as a file (on stdin) rather than written into the command that runs it, so a
 * long PATH never makes a command too long for SSH and nothing is quoted inside quotes.
 */
export function launcherScript(options: LaunchOptions): string {
  const { paths } = options;
  return [
    "#!/bin/sh",
    `echo $$ > ${q(paths.pid)}`,
    `export PATH=${q(options.path)}`,
    `exec ${q(options.deyin)} bot-engine serve --port ${options.port} --home ${q(paths.home)} --token-file ${q(paths.token)}`,
    "",
  ].join("\n");
}

function systemdValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$");
}

function systemdWord(value: string): string {
  return /^[A-Za-z0-9_@+=:,./-]+$/.test(value) ? value : `"${systemdValue(value)}"`;
}

/** The unit that keeps the engine running under the user's own systemd, restarting it if it stops. */
export function systemdUnit(options: LaunchOptions): string {
  const { paths } = options;
  const exec = [options.deyin, "bot-engine", "serve", "--port", String(options.port), "--home", paths.home, "--token-file", paths.token].map(systemdWord).join(" ");
  return [
    "[Unit]",
    "Description=Deyin Bot engine",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${exec}`,
    `Environment="PATH=${systemdValue(options.path)}"`,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** Try to keep the user's services running after they log out. Prints `linger=1` or `linger=0` for what is true afterwards. */
export const ENABLE_LINGER_SCRIPT = `
if command -v loginctl >/dev/null 2>&1; then loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true; fi
${lingerCheck()}
`;

/** Install the unit (its text on stdin), enable it and (re)start it. */
export function startSystemdScript(paths: EnginePaths): string {
  return [
    "set -e",
    `mkdir -p ${q(posix.dirname(paths.unit))}`,
    `cat > ${q(`${paths.unit}.new`)}`,
    `mv -f ${q(`${paths.unit}.new`)} ${q(paths.unit)}`,
    "systemctl --user daemon-reload",
    `systemctl --user enable ${SERVICE_NAME}.service`,
    `systemctl --user restart ${SERVICE_NAME}.service`,
  ].join("\n");
}

/**
 * Put the launcher (its text on stdin) in the engine's folder and run it in the background with nohup, its output to
 * the log. With `withCron` it also starts at reboot from the user's crontab.
 */
export function startNohupScript(paths: EnginePaths, withCron: boolean): string {
  const lines = [
    "set -e",
    "umask 077",
    `mkdir -p ${q(paths.home)}`,
    `cat > ${q(`${paths.launcher}.new`)}`,
    `chmod 700 ${q(`${paths.launcher}.new`)}`,
    `mv -f ${q(`${paths.launcher}.new`)} ${q(paths.launcher)}`,
    `cd ${q(paths.home)}`,
    'if command -v setsid >/dev/null 2>&1; then run="setsid nohup"; else run="nohup"; fi',
    `$run sh ${q(paths.launcher)} >> ${q(paths.log)} 2>&1 < /dev/null &`,
  ];
  if (withCron) {
    // Cron treats % as a newline, so each one is escaped.
    const entry = `@reboot sh ${q(paths.launcher)} >> ${q(paths.log)} 2>&1 < /dev/null ${CRON_MARK}`.replace(/%/g, "\\%");
    lines.push(`{ crontab -l 2>/dev/null | grep -v -F ${q(CRON_MARK)} || true; printf '%s\\n' ${q(entry)}; } | crontab -`);
  }
  return lines.join("\n");
}

/** Stop an engine this installer started with nohup. Only a process that really is the engine is touched. */
export function stopNohupScript(paths: EnginePaths): string {
  return `
pidfile=${q(paths.pid)}
if [ -f "$pidfile" ]; then
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [ -n "$pid" ] && ps -p "$pid" -o args= 2>/dev/null | grep -q 'bot-engine serve'; then
    kill "$pid" 2>/dev/null || true
    for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
  fi
  rm -f "$pidfile"
fi
`;
}

/** Stop the engine's systemd unit and turn it off. Harmless where there is none. */
export function stopSystemdScript(): string {
  return `
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now ${SERVICE_NAME}.service >/dev/null 2>&1 || true
fi
`;
}

/** Take the engine's line out of the user's crontab. Harmless where there is none. */
export function removeCronScript(): string {
  return `
if command -v crontab >/dev/null 2>&1; then
  if crontab -l >/dev/null 2>&1; then
    crontab -l 2>/dev/null | grep -v -F ${q(CRON_MARK)} | crontab - || true
  fi
fi
`;
}

/** Remove the engine from a server: stop it, forget it at boot, delete its key. With `purge`, delete the Bots' files too. */
export function uninstallScript(paths: EnginePaths, purge: boolean): string {
  return [
    stopSystemdScript(),
    stopNohupScript(paths),
    removeCronScript(),
    `rm -f ${q(paths.unit)} ${q(paths.token)} ${q(`${paths.token}.new`)} ${q(paths.launcher)}`,
    "if command -v systemctl >/dev/null 2>&1; then systemctl --user daemon-reload >/dev/null 2>&1 || true; fi",
    purge ? `rm -rf ${q(paths.home)}` : `rm -f ${q(paths.log)}`,
    "echo removed",
  ].join("\n");
}

/** The last of the engine's log, for a message about why it did not start. */
export function diagnosticsScript(paths: EnginePaths, supervisor: "systemd" | "nohup"): string {
  const tail = `tail -n 20 ${q(paths.log)} 2>&1 || true`;
  return supervisor === "systemd"
    ? `if command -v journalctl >/dev/null 2>&1; then journalctl --user -u ${SERVICE_NAME}.service -n 20 --no-pager 2>&1 || true; else ${tail}; fi`
    : tail;
}
