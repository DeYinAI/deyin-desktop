import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { loadPlugin, type InstalledPlugin } from "./plugins.js";

/**
 * Install plugins from GitHub without a git dependency: download the codeload
 * tarball for a repo@ref, extract it (minimal ustar reader) into
 * `<pluginsDir>/<name>`, and stamp .deyin-install.json with the origin.
 */

export interface GitHubSource {
  owner: string;
  repo: string;
  ref?: string;
  /** Subdirectory inside the repo holding the plugin (multi-plugin repos). */
  subdir?: string;
}

/** Accepts "owner/repo", "owner/repo@ref", "owner/repo/path", full github.com URLs. */
export function parseGitHubSource(input: string): GitHubSource | null {
  let text = input.trim();
  const urlMatch = /^https?:\/\/github\.com\/([^/]+)\/([^/@#\s]+)(?:\/tree\/([^/]+))?(\/[^@#\s]*)?/.exec(text);
  if (urlMatch) {
    const subdir = urlMatch[4]?.replace(/^\/+|\/+$/g, "");
    return {
      owner: urlMatch[1]!,
      repo: urlMatch[2]!.replace(/\.git$/, ""),
      ref: urlMatch[3],
      subdir: subdir || undefined,
    };
  }
  text = text.replace(/^github:/, "");
  const short = /^([\w.-]+)\/([\w.-]+?)(?:@([\w./-]+))?(?:\/(.+))?$/.exec(text);
  if (!short) return null;
  return { owner: short[1]!, repo: short[2]!.replace(/\.git$/, ""), ref: short[3], subdir: short[4] };
}

async function resolveDefaultBranch(owner: string, repo: string): Promise<string> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "deyin" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { default_branch?: string };
      if (body.default_branch) return body.default_branch;
    }
  } catch {
    // fall through to main
  }
  return "main";
}

/**
 * Minimal ustar extractor: regular files only, path-traversal safe. GitHub
 * codeload archives wrap everything in a single "<repo>-<ref>/" folder and
 * start with a pax_global_header entry, so the first path segment of every
 * entry is dropped (entries without a "/" are metadata and are skipped).
 */
function extractTar(tarball: Buffer, destination: string, subdir?: string): Promise<number> {
  return (async () => {
    let written = 0;
    let offset = 0;
    while (offset + 512 <= tarball.length) {
      const header = tarball.subarray(offset, offset + 512);
      offset += 512;
      if (header.every((b) => b === 0)) break;

      const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
      const prefixField = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
      const fullName = prefixField ? `${prefixField}/${rawName}` : rawName;
      const size = parseInt(header.subarray(124, 136).toString("utf8").trim() || "0", 8) || 0;
      const type = header[156];
      const blocks = Math.ceil(size / 512);
      const content = tarball.subarray(offset, offset + size);
      offset += blocks * 512;

      // Drop the top-level wrapper folder; skip wrapper-less metadata entries
      // (pax_global_header) and directory records.
      const slash = fullName.indexOf("/");
      if (slash < 0) continue;
      let rel = fullName.slice(slash + 1);
      if (!rel || rel.endsWith("/")) continue;
      if (subdir) {
        const prefix = `${subdir}/`;
        if (!rel.startsWith(prefix)) continue;
        rel = rel.slice(prefix.length);
        if (!rel) continue;
      }
      // 0 or "0" = regular file; skip links, dirs and pax/extended headers.
      if (type !== 0x30 && type !== 0) continue;

      const safe = normalize(rel);
      if (safe.startsWith("..") || safe.includes(`..${sep}`)) continue;
      const target = join(destination, safe);
      if (!target.startsWith(normalize(destination + sep))) continue;

      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      written += 1;
    }
    return written;
  })();
}

export interface InstallResult {
  ok: boolean;
  plugin?: InstalledPlugin;
  message?: string;
}

/** Download owner/repo@ref and unpack it as `<pluginsDir>/<name>`. */
export async function installPluginFromGitHub(
  source: GitHubSource,
  pluginsDir: string,
  opts: { name?: string } = {},
): Promise<InstallResult> {
  const ref = source.ref ?? (await resolveDefaultBranch(source.owner, source.repo));
  const url = `https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${encodeURIComponent(ref)}`;

  let body: ArrayBuffer;
  try {
    const res = await fetch(url, { headers: { "user-agent": "deyin" }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return { ok: false, message: `GitHub download failed (HTTP ${res.status}).` };
    body = await res.arrayBuffer();
  } catch (err) {
    return { ok: false, message: `GitHub download failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  let tar: Buffer;
  try {
    tar = gunzipSync(Buffer.from(body));
  } catch {
    return { ok: false, message: "Downloaded archive is not a valid tarball." };
  }

  const name = (opts.name ?? (source.subdir ? source.subdir.split("/").pop()! : source.repo))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
  const finalDir = join(pluginsDir, name);
  const stagingDir = join(pluginsDir, `.staging-${name}-${Date.now()}`);

  try {
    await mkdir(stagingDir, { recursive: true });
    const files = await extractTar(tar, stagingDir, source.subdir);
    if (files === 0) {
      await rm(stagingDir, { recursive: true, force: true });
      return { ok: false, message: source.subdir ? `No files under "${source.subdir}" in the repo.` : "Archive contained no files." };
    }
    await writeFile(
      join(stagingDir, ".deyin-install.json"),
      JSON.stringify(
        {
          source: `github:${source.owner}/${source.repo}${source.subdir ? `/${source.subdir}` : ""}`,
          ref,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    await rm(finalDir, { recursive: true, force: true });
    await rename(stagingDir, finalDir);
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  const plugin = await loadPlugin(finalDir, name);
  if (!plugin) return { ok: false, message: "Installed, but the plugin could not be loaded." };
  return { ok: true, plugin };
}

export async function uninstallPlugin(pluginsDir: string, name: string): Promise<void> {
  const dir = join(pluginsDir, name);
  const safe = normalize(dir);
  if (!safe.startsWith(normalize(pluginsDir + sep))) throw new Error("Invalid plugin name.");
  await rm(safe, { recursive: true, force: true });
}
