#!/usr/bin/env node
/**
 * Bundled security MCP server — stdio transport.
 * Tools: security_scan_repo, security_scan_diff, security_triage_finding, security_export_sarif
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, extname, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(join(__dirname, "..", "findings.schema.json"), "utf8"));
const WORKSPACE = String(process.env.DEYIN_WORKSPACE ?? "").trim();

const SENSITIVE_PATTERNS = [
  { id: "hardcoded-secret", re: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/gi, severity: "high" },
  { id: "eval-usage", re: /\beval\s*\(/g, severity: "medium" },
  { id: "innerhtml", re: /\.innerHTML\s*=/g, severity: "medium" },
  { id: "sql-concat", re: /(SELECT|INSERT|UPDATE|DELETE)[\s\S]{0,80}\+\s*/gi, severity: "high" },
];

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function findingId(ruleId, file, line) {
  return createHash("sha256").update(`${ruleId}:${file}:${line ?? 0}`).digest("hex").slice(0, 12);
}

function assertInsideWorkspace(root) {
  if (!WORKSPACE) throw new Error("DEYIN_WORKSPACE is not configured.");
  const resolved = resolve(root);
  const workspace = resolve(WORKSPACE);
  if (resolved !== workspace && !resolved.startsWith(workspace + sep)) {
    throw new Error(`Scan root must be inside workspace (${workspace}).`);
  }
  return resolved;
}

function validateReport(report) {
  const severities = new Set(SCHEMA.definitions.finding.properties.severity.enum);
  const sources = new Set(SCHEMA.definitions.finding.properties.source.enum);
  if (report.version !== "1") throw new Error("Invalid findings report version.");
  if (typeof report.scannedAt !== "string" || !report.scannedAt) throw new Error("Invalid scannedAt.");
  if (!Array.isArray(report.findings)) throw new Error("findings must be an array.");
  for (const f of report.findings) {
    if (!f || typeof f !== "object") throw new Error("Invalid finding.");
    if (!f.id || !f.ruleId || !f.message) throw new Error("Finding missing required fields.");
    if (!severities.has(f.severity)) throw new Error(`Invalid severity: ${f.severity}`);
    if (!sources.has(f.source)) throw new Error(`Invalid source: ${f.source}`);
    if (f.location?.file !== undefined && typeof f.location.file !== "string") {
      throw new Error("Invalid finding location.");
    }
  }
}

function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity] ?? 99;
    const sb = SEVERITY_ORDER[b.severity] ?? 99;
    if (sa !== sb) return sa - sb;
    const fa = a.location?.file ?? "";
    const fb = b.location?.file ?? "";
    if (fa !== fb) return fa.localeCompare(fb);
    return (a.location?.line ?? 0) - (b.location?.line ?? 0);
  });
}

function dedupeFindings(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const key = `${f.ruleId}|${f.location?.file ?? ""}|${f.location?.line ?? 0}|${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function scanFileRegex(path, content) {
  const findings = [];
  for (const pat of SENSITIVE_PATTERNS) {
    pat.re.lastIndex = 0;
    let m;
    while ((m = pat.re.exec(content)) !== null) {
      const line = content.slice(0, m.index).split("\n").length;
      findings.push({
        id: findingId(pat.id, path, line),
        ruleId: pat.id,
        severity: pat.severity,
        message: `Potential ${pat.id.replace(/-/g, " ")}`,
        source: "regex",
        location: { file: path, line },
      });
    }
  }
  return findings;
}

function walk(dir, exts, max = 500) {
  const files = [];
  if (!existsSync(dir)) return files;
  const stack = [dir];
  while (stack.length > 0 && files.length < max) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (exts.has(extname(e.name))) files.push(p);
    }
  }
  return files;
}

function semgrepAvailable() {
  const probe = spawnSync("semgrep", ["--version"], { encoding: "utf8", timeout: 5000 });
  return probe.status === 0;
}

function mapSemgrepSeverity(value) {
  const v = String(value ?? "INFO").toUpperCase();
  if (v === "ERROR") return "high";
  if (v === "WARNING") return "medium";
  return "low";
}

function runSemgrep(root) {
  if (!semgrepAvailable()) return [];
  try {
    const out = execFileSync("semgrep", ["--json", "--quiet", "--no-git-ignore", root], {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(out);
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    return results.map((r) => {
      const file = String(r.path ?? "<unknown>");
      const line = r.start?.line ?? 1;
      const ruleId = String(r.check_id ?? "semgrep");
      return {
        id: findingId(ruleId, file, line),
        ruleId,
        severity: mapSemgrepSeverity(r.extra?.severity),
        message: String(r.extra?.message ?? ruleId),
        source: "semgrep",
        location: { file, line, column: r.start?.col ?? undefined },
      };
    });
  } catch {
    return [];
  }
}

function mapNpmSeverity(value) {
  const v = String(value ?? "low").toLowerCase();
  if (v === "critical") return "critical";
  if (v === "high") return "high";
  if (v === "moderate") return "medium";
  if (v === "low") return "low";
  return "info";
}

function runNpmAudit(root) {
  const pkg = join(root, "package.json");
  if (!existsSync(pkg)) return [];
  try {
    const out = execFileSync("npm", ["audit", "--json"], {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseNpmAudit(out);
  } catch (err) {
    const stdout = err && typeof err === "object" && "stdout" in err ? String(err.stdout ?? "") : "";
    if (stdout.trim()) return parseNpmAudit(stdout);
    return [];
  }
}

function parseNpmAudit(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const vulns = parsed.vulnerabilities ?? {};
  const findings = [];
  for (const [name, info] of Object.entries(vulns)) {
    if (!info || typeof info !== "object") continue;
    const severity = mapNpmSeverity(info.severity);
    const via = Array.isArray(info.via) ? info.via : [];
    const detail = via.find((v) => v && typeof v === "object") ?? {};
    findings.push({
      id: findingId(`npm-audit:${name}`, "package.json", 1),
      ruleId: `npm-audit:${name}`,
      severity,
      message: String(detail.title ?? detail.url ?? `Vulnerable dependency: ${name}`),
      source: "npm-audit",
      location: { file: "package.json", line: 1 },
    });
  }
  return findings;
}

function buildReport({ root, findings, scanned, sources }) {
  const report = {
    version: "1",
    scannedAt: new Date().toISOString(),
    root,
    scanned,
    sources: [...new Set(sources)],
    findings: sortFindings(dedupeFindings(findings)),
  };
  validateReport(report);
  return report;
}

function scanRepo(root) {
  const resolved = assertInsideWorkspace(root);
  const exts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".go", ".rs"]);
  const files = walk(resolved, exts);
  const findings = [];
  const sources = [];

  const semgrepFindings = runSemgrep(resolved);
  if (semgrepFindings.length > 0) sources.push("semgrep");
  findings.push(...semgrepFindings);

  for (const f of files) {
    try {
      findings.push(...scanFileRegex(f, readFileSync(f, "utf8")));
    } catch {
      // skip unreadable
    }
  }
  if (findings.some((f) => f.source === "regex")) sources.push("regex");

  const auditFindings = runNpmAudit(resolved);
  if (auditFindings.length > 0) sources.push("npm-audit");
  findings.push(...auditFindings);

  return buildReport({ root: resolved, findings, scanned: files.length, sources });
}

function scanDiff(diff) {
  const findings = scanFileRegex("<diff>", diff);
  return buildReport({ root: WORKSPACE || undefined, findings, scanned: 1, sources: ["regex"] });
}

const handlers = {
  initialize: () => ({
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "deyin-security", version: "1.0.0" },
  }),
  "tools/list": () => ({
    tools: [
      {
        name: "security_scan_repo",
        description: "Scan a repository directory for common security issues.",
        inputSchema: { type: "object", properties: { root: { type: "string", description: "Repo root path." } }, required: ["root"] },
      },
      {
        name: "security_scan_diff",
        description: "Scan a unified diff text for security issues.",
        inputSchema: { type: "object", properties: { diff: { type: "string" } }, required: ["diff"] },
      },
      {
        name: "security_triage_finding",
        description: "Suggest triage priority for a finding.",
        inputSchema: {
          type: "object",
          properties: {
            ruleId: { type: "string" },
            severity: { type: "string" },
            message: { type: "string" },
          },
          required: ["ruleId", "severity"],
        },
      },
      {
        name: "security_export_sarif",
        description: "Export findings array to SARIF JSON.",
        inputSchema: { type: "object", properties: { findings: { type: "array" } }, required: ["findings"] },
      },
    ],
  }),
  "tools/call": (params) => {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === "security_scan_repo") {
      const root = String(args.root ?? WORKSPACE ?? process.cwd());
      const report = scanRepo(root);
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }
    if (name === "security_scan_diff") {
      const diff = String(args.diff ?? "");
      const report = scanDiff(diff);
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }
    if (name === "security_triage_finding") {
      const sev = String(args.severity ?? "low");
      const priority = sev === "critical" || sev === "high" ? "P0-fix-before-merge" : sev === "medium" ? "P1-schedule-fix" : "P2-backlog";
      return { content: [{ type: "text", text: JSON.stringify({ priority, recommendation: `Review ${args.ruleId} manually.` }) }] };
    }
    if (name === "security_export_sarif") {
      const findings = Array.isArray(args.findings) ? args.findings : [];
      const sarif = {
        version: "2.1.0",
        $schema: "https://json.schemastore.org/sarif-2.1.0.json",
        runs: [{ tool: { driver: { name: "deyin-security", version: "1.0.0" } }, results: findings }],
      };
      return { content: [{ type: "text", text: JSON.stringify(sarif, null, 2) }] };
    }
    throw new Error(`Unknown tool: ${name}`);
  },
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    const id = req.id;
    try {
      const handler = handlers[req.method];
      if (!handler) throw new Error(`Method not found: ${req.method}`);
      const result = handler(req.params);
      send({ jsonrpc: "2.0", id, result });
    } catch (err) {
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
    }
  }
});
