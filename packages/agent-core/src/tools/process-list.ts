import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition } from "../types.js";
import { asOptionalNumber, asOptionalString, truncate } from "./util.js";

const execFileAsync = promisify(execFile);
const MAX_ROWS = 100;

interface ProcRow {
  pid: string;
  name: string;
  args?: string;
}

/** Credential-shaped tokens that must never reach the model from argv. */
const SECRET_NAME = /(api[_-]?key|access[_-]?key|secret|password|token|bearer|auth)/i;
const SECRET_VALUE =
  /^(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;

export function redactArgs(args: string): string {
  // Tokenize while keeping whitespace, then redact:
  //  --flag=value | --flag value | NAME=value (env-style) | bare secret-shaped tokens.
  const parts = args.split(/(\s+)/);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i]!;
    if (/^\s*$/.test(tok)) {
      out.push(tok);
      continue;
    }
    const flagEq = tok.match(/^--([^=\s]+)=(.*)$/);
    if (flagEq) {
      // Redact when the flag NAME looks secret OR the value is secret-shaped
      // (e.g. --config=sk-... where the flag name is benign).
      const value = flagEq[2]!.replace(/^["']|["']$/g, "");
      if (SECRET_NAME.test(flagEq[1]!) || SECRET_VALUE.test(value)) {
        out.push(`--${flagEq[1]}=(redacted)`);
        continue;
      }
      // Credentials nested in the value (--db-url=postgres://user:pass@host).
      const cleaned = flagEq[2]!.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/gi, "$1(redacted)@");
      out.push(cleaned !== flagEq[2]! ? `--${flagEq[1]}=${cleaned}` : tok);
      continue;
    }
    if (tok.startsWith("--")) {
      const name = tok.slice(2);
      if (SECRET_NAME.test(name)) {
        out.push(`${tok} (redacted)`);
        // Swallow the following value token(s) (--password hunter2, or a
        // multi-word quoted value like --api_token "my secret password").
        let values = 0;
        let open = "";
        while (values < 4 && i + 1 < parts.length) {
          const next = parts[i + 1]!;
          if (/^\s+$/.test(next)) {
            out.push(next);
            i++;
            continue;
          }
          out.push("(redacted)");
          i++;
          values++;
          if (!open && /^["']/.test(next)) open = next[0]!;
          if (values > 0 && !open) break; // unquoted value: one token is enough
          if (open && next.endsWith(open)) break;
        }
      } else {
        out.push(tok);
      }
      continue;
    }
    const env = tok.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (env) {
      // Redact when the NAME looks secret OR the VALUE is secret-shaped
      // (e.g. AWS_ACCESS_KEY_ID=AKIA... — name or value alone may not match).
      const value = env[2]!.replace(/^["']|["']$/g, "");
      if (SECRET_NAME.test(env[1]!) || SECRET_VALUE.test(value)) {
        out.push(`${env[1]}=(redacted)`);
        continue;
      }
      // Credentials nested inside the value (DATABASE_URL=postgres://user:pass@host).
      const cleaned = env[2]!.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/gi, "$1(redacted)@");
      out.push(cleaned !== env[2]! ? `${env[1]}=${cleaned}` : tok);
      continue;
    }
    // Query-string style: run?token=secret&x=1 (may be glued to the command).
    const withQuery = tok.replace(/([?&](?:api[_-]?key|access[_-]?key|token|secret|password|auth)=)[^&\s"']*/gi, "$1(redacted)");
    if (withQuery !== tok) {
      out.push(withQuery);
      continue;
    }
    const unquoted = tok.replace(/^["']|["']$/g, "");
    if (SECRET_VALUE.test(unquoted)) {
      out.push("(redacted)");
      continue;
    }
    // URL userinfo: https://user:pass@host (any scheme) — credentials are secret.
    const withUserInfo = unquoted.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/gi, "$1(redacted)@");
    if (withUserInfo !== unquoted) {
      out.push(withUserInfo);
      continue;
    }
    // Header-style: "Authorization: Bearer <token>" — redact marker plus the
    // following value token(s) ("Bearer" scheme word + the credential).
    if (/^authorization\s*:/i.test(unquoted) || /^bearer\b/i.test(unquoted)) {
      out.push("(redacted)");
      let values = 2;
      while (values > 0 && i + 1 < parts.length) {
        const next = parts[i + 1]!;
        if (/^\s+$/.test(next)) {
          out.push(next);
          i++;
          continue;
        }
        out.push("(redacted)");
        i++;
        values--;
      }
      continue;
    }
    out.push(tok);
  }
  return out.join("");
}

async function posixProcesses(): Promise<ProcRow[]> {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,comm=,args="], {
    timeout: 5000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  const rows: ProcRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    rows.push({ pid: match[1]!, name: match[2]!, args: match[3] });
  }
  return rows;
}

async function winProcesses(): Promise<ProcRow[]> {
  const { stdout } = await execFileAsync("tasklist", ["/FO", "CSV", "/NH"], {
    timeout: 5000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  const rows: ProcRow[] = [];
  for (const line of stdout.split("\n")) {
    // CSV: "name","pid","session","session#","mem"
    const match = line.match(/^"([^"]*)","(\d+)"/);
    if (!match) continue;
    rows.push({ pid: match[2]!, name: match[1]! });
  }
  return rows;
}

/**
 * Snapshot of running processes (platform-aware: `ps` on POSIX, `tasklist` on
 * Windows), optionally filtered by a name substring. No signal/kill powers —
 * strictly read-only.
 */
export const processListTool: ToolDefinition = {
  name: "process_list",
  description:
    'List running processes (pid, name, command line) filtered by a name substring — e.g. process_list name="node". Read-only; use to check whether a dev server or build is still running.',
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Case-insensitive substring filter on process name." },
      max_rows: { type: "number", description: `Cap on rows (default ${MAX_ROWS}).` },
    },
  },
  summarize: (args) => String(args.name ?? "all processes"),
  async execute(args): Promise<string> {
    let rows: ProcRow[];
    try {
      rows = process.platform === "win32" ? await winProcesses() : await posixProcesses();
    } catch (err) {
      return `ERROR: could not list processes: ${err instanceof Error ? err.message : String(err)}`;
    }
    const filter = asOptionalString(args.name)?.toLowerCase();
    if (filter) rows = rows.filter((r) => r.name.toLowerCase().includes(filter) || r.args?.toLowerCase().includes(filter));
    if (rows.length === 0) return filter ? `No processes match "${filter}".` : "(no processes)";
    rows.sort((a, b) => a.name.localeCompare(b.name) || Number(a.pid) - Number(b.pid));
    const cap = Math.min(Math.max(asOptionalNumber(args.max_rows) ?? MAX_ROWS, 1), 500);
    const shown = rows.slice(0, cap);
    const lines = shown.map((r) => `${r.pid}\t${r.name}${r.args ? `\t${redactArgs(r.args)}` : ""}`);
    if (rows.length > shown.length) lines.push(`... (${rows.length - shown.length} more)`);
    return truncate(lines.join("\n"), 30_000);
  },
};
