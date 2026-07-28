import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FileStorage } from "@deyin/host-core";

const FALLBACK_VERSION = "0.1.1";

function readPackageVersion(): string {
  // Compiled single binaries carry the version as a build-time define
  // (see scripts/compile.mjs); source runs read package.json directly.
  if (process.env.DEYIN_BUILD_VERSION) return process.env.DEYIN_BUILD_VERSION;
  try {
    const path = fileURLToPath(new URL("../package.json", import.meta.url));
    return (JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version ?? FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

export const VERSION = readPackageVersion();

/** GitHub repo whose Releases carry the CLI binaries (deyin-<os>-<arch> assets). */
export const RELEASES_REPO = process.env.DEYIN_RELEASES_REPO ?? "DeYinAI/deyin-desktop";

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function fetchLatestVersion(timeoutMs = 4000): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": `deyin-cli/${VERSION}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: string };
    return body.tag_name?.replace(/^v/, "") ?? null;
  } catch {
    return null;
  }
}

interface UpdateCheckCache {
  checkedAt: number;
  latest: string | null;
}

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Non-blocking daily update check. Returns a one-line notice when a newer version
 * exists, else null. Never throws; network failures just skip the notice.
 */
export async function updateNotice(storage: FileStorage): Promise<string | null> {
  const cache = storage.readJson<UpdateCheckCache>("update-check.json", { checkedAt: 0, latest: null });
  let latest = cache.latest;
  if (Date.now() - cache.checkedAt > CHECK_INTERVAL_MS) {
    latest = await fetchLatestVersion();
    storage.writeJson<UpdateCheckCache>("update-check.json", { checkedAt: Date.now(), latest });
  }
  if (latest && compareVersions(latest, VERSION) > 0) {
    return `Update available: ${VERSION} -> ${latest}. Run \`deyin upgrade\`.`;
  }
  return null;
}

/** Asset name for this platform in GitHub Releases, e.g. deyin-linux-x64. */
export function binaryAssetName(platform = process.platform, arch = process.arch): string {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : "linux";
  const cpu = arch === "arm64" ? "arm64" : "x64";
  return `deyin-${os}-${cpu}${platform === "win32" ? ".exe" : ""}`;
}
