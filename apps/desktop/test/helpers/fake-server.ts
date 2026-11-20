import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REAL_TOOLS = ["sh", "bash", "cat", "mkdir", "chmod", "mv", "rm", "ps", "grep", "head", "tail", "tr", "id", "sleep", "touch", "cp", "sed", "dirname", "date", "env", "nohup", "setsid", "wc", "cut", "sort", "ls", "kill", "tee", "basename", "readlink", "ln", "sleep", "cmp", "uname"];
const ENGINE_RUNNER = fileURLToPath(new URL("./engine-runner.mjs", import.meta.url));

export interface FakeServerOptions {
  /** `deyin` is already installed there (the installer then skips installing it). */
  deyinInstalled?: boolean;
  /** The installed `deyin` has the `bot-engine` command. */
  botEngine?: boolean;
  /** The `deyin` a download installs has the `bot-engine` command. */
  downloadHasBotEngine?: boolean;
  signedIn?: boolean;
  systemd?: boolean;
  /** systemd is there but no user manager is running (no `systemctl --user`). */
  noUserManager?: boolean;
  /** `loginctl enable-linger` is allowed. */
  lingerAllowed?: boolean;
  lingerEnabled?: boolean;
  cron?: boolean;
  curl?: boolean;
  /** `deyin login` fails. */
  loginFails?: boolean;
  /** `deyin login` says it worked but nothing is signed in afterwards. */
  loginDoesNotStick?: boolean;
  /** `deyin whoami` exits with this code instead of answering by whether anyone is signed in. */
  whoamiExit?: number;
  /** The download of the installer fails, as a server that cannot reach the internet would. */
  curlFails?: boolean;
  os?: string;
}

/**
 * A pretend Linux server: a home folder and a folder of small stand-ins for the programs the installer's scripts call
 * (`deyin`, `systemctl`, `loginctl`, `crontab`, `curl`, a `bash` that ignores `-l`). The scripts run in a real shell
 * against it, so what is tested is the shell the installer really sends. The `deyin` there starts the real engine.
 */
export class FakeServer {
  readonly root = mkdtempSync(join(tmpdir(), "deyin-fakeserver-"));
  readonly home = join(this.root, "home");
  readonly bin = join(this.root, "bin");
  /** The only real programs the server has: what a minimal Linux install does, so a missing one is really missing. */
  readonly usr = join(this.root, "usr-bin");
  readonly state = join(this.home, ".fake-systemd");

  constructor(readonly options: FakeServerOptions = {}) {
    mkdirSync(this.home, { recursive: true });
    mkdirSync(this.bin, { recursive: true });
    mkdirSync(this.usr, { recursive: true });
    for (const tool of REAL_TOOLS) {
      try {
        symlinkSync(execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), join(this.usr, tool));
      } catch {
        // not on this machine; a script that needs it will say so
      }
    }
    symlinkSync(process.execPath, join(this.usr, "node"));
    mkdirSync(this.state, { recursive: true });
    const o = { deyinInstalled: true, botEngine: true, downloadHasBotEngine: true, signedIn: true, systemd: true, lingerAllowed: true, lingerEnabled: false, cron: true, curl: true, os: "Linux", ...options };
    const node = process.execPath;
    const real = (name: string): string => execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
    this.script("bash", `#!/bin/sh\nif [ "$1" = "-lc" ]; then shift; set -- -c "$@"; fi\nexec ${real("bash")} "$@"\n`);
    this.script("uname", `#!/bin/sh\nif [ "$1" = "-s" ]; then echo ${o.os}; else exec ${real("uname")} "$@"; fi\n`);
    this.script("deyin-real", this.deyinScript(node, o.botEngine));
    this.script("deyin-download", this.deyinScript(node, o.downloadHasBotEngine));
    if (o.deyinInstalled) this.install("deyin-real");
    if (o.signedIn) writeFileSync(join(this.home, ".signed-in"), "yes");
    if (o.lingerEnabled) writeFileSync(join(this.home, ".fake-linger"), "yes");
    if (o.systemd) {
      if (options.noUserManager) writeFileSync(join(this.state, "no-user-manager"), "yes");
      this.script("systemctl", this.systemctlScript(node));
      this.script("loginctl", this.loginctlScript(o.lingerAllowed));
    }
    if (o.cron) this.script("crontab", this.crontabScript());
    if (o.curl) this.script("curl", this.curlScript(options.curlFails === true));
    if (o.loginFails) writeFileSync(join(this.home, ".login-fails"), "yes");
    if (o.loginDoesNotStick) writeFileSync(join(this.home, ".login-noop"), "yes");
    if (options.whoamiExit !== undefined) writeFileSync(join(this.home, ".whoami-exit"), String(options.whoamiExit));
  }

  /** The environment commands run with: this server's home, its stand-ins first on PATH, and the real node. */
  get env(): NodeJS.ProcessEnv {
    return { HOME: this.home, USER: "tester", LOGNAME: "tester", PATH: `${this.bin}:${join(this.home, ".local", "bin")}:${this.usr}`, TERM: "dumb" };
  }

  /** What the login shell's PATH is, as the probe will see it. */
  get path(): string {
    return this.env.PATH ?? "";
  }

  private script(name: string, body: string): void {
    const file = join(this.bin, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }

  private install(from: string): void {
    const dir = join(this.home, ".local", "bin");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "deyin");
    writeFileSync(target, readFileSync(join(this.bin, from)));
    chmodSync(target, 0o755);
  }

  private deyinScript(node: string, botEngine: boolean | undefined): string {
    return `#!/bin/sh
case "$1" in
  --version) echo "deyin 1.2.3" ;;
  --help) echo "USAGE deyin run|login|whoami${botEngine ? "|bot-engine" : ""}" ;;
  whoami)
    if [ -f "$HOME/.whoami-exit" ]; then echo "whoami: forced exit" >&2; exit "$(cat "$HOME/.whoami-exit")"; fi
    if [ -f "$HOME/.signed-in" ]; then echo "Ada <ada@example.com>"; exit 0; fi
    echo "Not signed in. Run \\\`deyin login\\\`."; exit 2 ;;
  login)
    printf '\\n\\033[0mTo sign in, open \\033[36mhttps://openference.com/device?user_code=ABCD-EFGH\\033[0m\\r\\nand enter the code: \\033[1mABCD-EFGH\\033[0m\\n\\n'
    sleep 0.2
    echo "Waiting for approval..."
    sleep 0.2
    if [ -f "$HOME/.login-fails" ]; then echo "login failed: access denied" >&2; exit 1; fi
    if [ ! -f "$HOME/.login-noop" ]; then touch "$HOME/.signed-in"; fi
    echo "Signed in as Ada" ;;
  bot-engine) exec ${node} ${ENGINE_RUNNER} "$@" ;;
  *) echo "unknown command $1" >&2; exit 64 ;;
esac
`;
  }

  private systemctlScript(node: string): string {
    void node;
    return `#!/bin/bash
state="$HOME/.fake-systemd"; mkdir -p "$state"
[ "$1" = "--user" ] && shift
cmd="$1"; shift
unit="$HOME/.config/systemd/user/deyin-bot-engine.service"
stop() { if [ -f "$state/pid" ]; then kill "$(cat "$state/pid")" 2>/dev/null || true; rm -f "$state/pid"; fi; }
case "$cmd" in
  show-environment) [ -f "$state/no-user-manager" ] && exit 1; echo "FOO=bar" ;;
  daemon-reload) echo "daemon-reload" >> "$state/calls" ;;
  enable) echo "enable $*" >> "$state/calls"; touch "$state/enabled" ;;
  restart)
    echo "restart $*" >> "$state/calls"
    stop
    line="$(grep '^ExecStart=' "$unit" | sed 's/^ExecStart=//')"
    path="$(grep '^Environment="PATH=' "$unit" | sed 's/^Environment="PATH=//; s/"$//')"
    ( export PATH="$path"; eval "exec setsid nohup $line" >> "$state/engine.out" 2>&1 < /dev/null & echo $! > "$state/pid" )
    ;;
  disable)
    echo "disable $*" >> "$state/calls"; rm -f "$state/enabled"
    case " $* " in *" --now "*) stop ;; esac ;;
  *) exit 0 ;;
esac
`;
  }

  private loginctlScript(allowed: boolean | undefined): string {
    return `#!/bin/sh
case "$1" in
  enable-linger) echo "$*" >> "$HOME/.fake-loginctl-calls"; ${allowed === false ? "exit 1" : 'touch "$HOME/.fake-linger"'} ;;
  show-user) if [ -f "$HOME/.fake-linger" ]; then echo "Linger=yes"; else echo "Linger=no"; fi ;;
esac
`;
  }

  private crontabScript(): string {
    return `#!/bin/sh
file="$HOME/.fake-crontab"
case "$1" in
  -l) [ -f "$file" ] || { echo "no crontab for tester" >&2; exit 1; }; cat "$file" ;;
  -) cat > "$file.new" && mv "$file.new" "$file" ;;
esac
`;
  }

  private curlScript(fails: boolean): string {
    if (fails) return `#!/bin/sh\necho "curl: (22) The requested URL returned error: 404" >&2\nexit 22\n`;
    return `#!/bin/sh
echo '#!/bin/sh'
echo 'mkdir -p "$HOME/.local/bin"'
echo 'cp "${join(this.bin, "deyin-download")}" "$HOME/.local/bin/deyin"'
echo 'chmod +x "$HOME/.local/bin/deyin"'
echo 'echo "Installed deyin"'
`;
  }

  /* What a test looks at --------------------------------------------------------- */

  file(relative: string): string | undefined {
    const path = join(this.home, relative);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }

  has(relative: string): boolean {
    return existsSync(join(this.home, relative));
  }

  /** The crontab, or undefined when there is none. */
  crontab(): string | undefined {
    return this.file(".fake-crontab");
  }

  /** Stop any engine this fake server started, whichever way it was started. */
  stopEngines(): void {
    for (const pidFile of [join(this.state, "pid"), join(this.home, ".deyin-bot", "engine.pid")]) {
      if (!existsSync(pidFile)) continue;
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 1) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }

  destroy(): void {
    this.stopEngines();
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** A port nothing is listening on, for an engine to take. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}
