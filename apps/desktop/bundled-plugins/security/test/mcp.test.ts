import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SERVER = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url));

async function rpc(env: NodeJS.ProcessEnv, method: string, params?: unknown, id = 1): Promise<unknown> {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line.trim()) lines.push(line.trim());
    }
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const parsed = lines.map((line) => {
      try {
        return JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
      } catch {
        return null;
      }
    }).find((msg) => msg?.id === id);
    if (parsed?.error) {
      child.kill();
      throw new Error(parsed.error.message ?? "MCP error");
    }
    if (parsed?.result !== undefined) {
      child.kill();
      return parsed.result;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  child.kill();
  throw new Error(`Timed out waiting for ${method}`);
}

test("security MCP lists expected tools", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "deyin-sec-tools-"));
  try {
    const result = (await rpc({ DEYIN_WORKSPACE: workspace }, "tools/list")) as {
      tools: { name: string }[];
    };
    const names = result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "security_export_sarif",
      "security_scan_diff",
      "security_scan_repo",
      "security_triage_finding",
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("security_scan_repo rejects paths outside workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "deyin-sec-bounds-"));
  const outside = mkdtempSync(join(tmpdir(), "deyin-sec-out-"));
  try {
    await assert.rejects(
      () => rpc({ DEYIN_WORKSPACE: workspace }, "tools/call", {
        name: "security_scan_repo",
        arguments: { root: outside },
      }),
      /inside workspace/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("security_scan_repo scans inside workspace and validates findings", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "deyin-sec-scan-"));
  try {
    writeFileSync(join(workspace, "leak.js"), 'const api_key = "super-secret-token-value";\n', "utf8");
    const result = (await rpc({ DEYIN_WORKSPACE: workspace }, "tools/call", {
      name: "security_scan_repo",
      arguments: { root: workspace },
    }, 2)) as { content: { text: string }[] };
    const report = JSON.parse(result.content[0]!.text) as {
      version: string;
      findings: { severity: string; source: string; ruleId: string }[];
    };
    assert.equal(report.version, "1");
    assert.ok(report.findings.some((f) => f.ruleId === "hardcoded-secret"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("security_scan_diff returns validated report", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "deyin-sec-diff-"));
  try {
    const diff = '+const token = "abcdefgh123456";\n';
    const result = (await rpc({ DEYIN_WORKSPACE: workspace }, "tools/call", {
      name: "security_scan_diff",
      arguments: { diff },
    }, 3)) as { content: { text: string }[] };
    const report = JSON.parse(result.content[0]!.text) as { version: string; findings: unknown[] };
    assert.equal(report.version, "1");
    assert.ok(Array.isArray(report.findings));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("security_scan_repo maps WSL POSIX path onto the workspace", async () => {
 // Simulate the WSL agent: the server workspace is a Windows UNC path
 // (\\\\wsl.localhost\\\\<distro>...) while the caller passes the POSIX twin that
 // shares its suffix (/home/...). assertInsideWorkspace must map one to the
 // other instead of rejecting the scan outright.
 const B = String.fromCharCode(92); // backslash
 const wsPosix = "/home/anh/projects/demo";
 const unc = B + B + "wsl.localhost" + B + "Ubuntu-22.04" + wsPosix.replace(/\//g, B);
 const workspaceDir = join(tmpdir(), "deyin-sec-wsl-");
 mkdirSync(workspaceDir, { recursive: true });
 try {
 writeFileSync(join(workspaceDir, "leak.js"), 'const password = "hunter2-hunter2";\n', "utf8");
 // A path outside the workspace is still rejected after mapping fails.
 await assert.rejects(
 () => rpc({ DEYIN_WORKSPACE: unc }, "tools/call", {
 name: "security_scan_repo",
 arguments: { root: "/etc" },
 }),
 /inside workspace/,
 );
 // On Windows hosts the UNC resolves to a real directory, so the scan
 // succeeds and reports findings. On POSIX CI the UNC is not a real path;
 // walk() returns an empty file list and the report is still valid JSON
 // with zero findings - the important part is the boundary check passing.
 const result = (await rpc({ DEYIN_WORKSPACE: unc }, "tools/call", {
 name: "security_scan_repo",
 arguments: { root: wsPosix },
 }, 4)) as { content: { text: string }[] };
 const report = JSON.parse(result.content[0]!.text) as { version: string; findings: { ruleId: string }[] };
 assert.equal(report.version, "1");
 assert.ok(Array.isArray(report.findings));
 } finally {
 rmSync(workspaceDir, { recursive: true, force: true });
 }
});
