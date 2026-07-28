import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { installPluginFromGitHub, parseGitHubSource, uninstallPlugin } from "../src/capabilities/plugin-install.js";
import { discoverPlugins } from "../src/capabilities/plugins.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deyin-plugin-"));
}

/** Build a minimal ustar entry for one regular file. */
function tarEntry(name: string, content: string): Buffer {
  const data = Buffer.from(content, "utf8");
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "utf8"); // mode
  header.write("0000000\0", 108, 8, "utf8"); // uid
  header.write("0000000\0", 116, 8, "utf8"); // gid
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8"); // size
  header.write("00000000000\0", 136, 12, "utf8"); // mtime
  header.write("        ", 148, 8, "utf8"); // checksum placeholder (spaces)
  header[156] = 0x30; // typeflag '0' = regular file
  header.write("ustar\0", 257, 6, "utf8");
  header.write("00", 263, 2, "utf8");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
  const blocks = Math.ceil(data.length / 512);
  const body = Buffer.alloc(blocks * 512);
  data.copy(body);
  return Buffer.concat([header, body]);
}

function makeRepoTarball(prefix: string, files: Record<string, string>): Buffer {
  const entries = Object.entries(files).map(([name, content]) => tarEntry(`${prefix}/${name}`, content));
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

test("parseGitHubSource accepts short specs and URLs", () => {
  assert.deepEqual(parseGitHubSource("owner/repo"), { owner: "owner", repo: "repo", ref: undefined, subdir: undefined });
  assert.deepEqual(parseGitHubSource("owner/repo@v1.2"), { owner: "owner", repo: "repo", ref: "v1.2", subdir: undefined });
  assert.deepEqual(parseGitHubSource("github:owner/repo"), { owner: "owner", repo: "repo", ref: undefined, subdir: undefined });
  const url = parseGitHubSource("https://github.com/owner/repo/tree/main/plugins/foo");
  assert.equal(url?.owner, "owner");
  assert.equal(url?.ref, "main");
  assert.equal(url?.subdir, "plugins/foo");
  assert.equal(parseGitHubSource("not a repo"), null);
});

test("installPluginFromGitHub downloads, extracts and stamps install metadata", async (t) => {
  const dir = tempDir();
  const tarball = makeRepoTarball("repo-main", {
    ".deyin-plugin/plugin.json": JSON.stringify({ name: "toolkit", version: "0.2.0", variables: ["API_KEY"] }),
    "skills/greet/SKILL.md": "---\nname: greet\ndescription: Greets\n---\nSay hi.",
    "commands/ship.md": "Ship it: $ARGUMENTS",
    "mcp.json": JSON.stringify({ mcpServers: { search: { command: "npx search" } } }),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes("codeload.github.com")) {
      return new Response(new Uint8Array(tarball), { status: 200 });
    }
    return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  const result = await installPluginFromGitHub({ owner: "acme", repo: "toolkit" }, dir);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.plugin?.name, "toolkit");
  assert.equal(result.plugin?.version, "0.2.0");
  assert.deepEqual(result.plugin?.variables, ["API_KEY"]);
  assert.ok(result.plugin?.skillsDir);
  assert.ok(result.plugin?.commandsDir);
  assert.ok(result.plugin?.mcpFile);

  const skill = readFileSync(join(dir, "toolkit", "skills", "greet", "SKILL.md"), "utf8");
  assert.ok(skill.includes("Say hi."));
  const meta = JSON.parse(readFileSync(join(dir, "toolkit", ".deyin-install.json"), "utf8")) as { source: string; ref: string };
  assert.equal(meta.source, "github:acme/toolkit");
  assert.equal(meta.ref, "main");

  const discovered = await discoverPlugins(dir);
  assert.equal(discovered.length, 1);

  await uninstallPlugin(dir, "toolkit");
  assert.ok(!existsSync(join(dir, "toolkit")));
  await assert.rejects(() => uninstallPlugin(dir, "../evil"));
});

test("installPluginFromGitHub extracts only the requested subdir", async (t) => {
  const dir = tempDir();
  const tarball = makeRepoTarball("mono-main", {
    "README.md": "root readme",
    "plugins/foo/plugin.json": JSON.stringify({ name: "foo" }),
    "plugins/foo/SKILL.md": "---\nname: foo\ndescription: One-skill plugin\n---\n",
    "plugins/bar/plugin.json": JSON.stringify({ name: "bar" }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Uint8Array(tarball), { status: 200 })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  const result = await installPluginFromGitHub({ owner: "acme", repo: "mono", ref: "main", subdir: "plugins/foo" }, dir);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.plugin?.name, "foo");
  assert.ok(existsSync(join(dir, "foo", "SKILL.md")));
  assert.ok(!existsSync(join(dir, "foo", "README.md")));
  assert.ok(result.plugin?.rootSkill, "root SKILL.md acts as the single skill");
});
