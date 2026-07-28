import { chmodSync, renameSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { RELEASES_REPO, VERSION, binaryAssetName, compareVersions, fetchLatestVersion } from "./version.js";
import { bold, dim, errorLine, green } from "./output.js";

/**
 * True when running as a compiled deyin binary. Checking the Bun runtime alone is not
 * enough: `bunx @deyin/cli` also runs under Bun, and self-updating there would
 * overwrite the user's bun executable (process.execPath). Require the executable to
 * actually be a deyin binary before replacing it.
 */
function isCompiledBinary(): boolean {
  return (
    Boolean((process.versions as Record<string, string | undefined>).bun) &&
    basename(process.execPath).toLowerCase().startsWith("deyin")
  );
}

export async function upgradeCommand(): Promise<number> {
  console.log(dim(`Current version: ${VERSION}. Checking ${RELEASES_REPO} for updates...`));
  const latest = await fetchLatestVersion(8000);
  if (!latest) {
    errorLine("could not reach GitHub to check for updates.");
    return 1;
  }
  if (compareVersions(latest, VERSION) <= 0) {
    console.log(`${green("Up to date")} (${VERSION}).`);
    return 0;
  }

  if (!isCompiledBinary()) {
    console.log(`Version ${bold(latest)} is available. Installed via npm; update with:`);
    console.log(`\n  npm install -g @deyin/cli@latest\n`);
    return 0;
  }

  const asset = binaryAssetName();
  const url = `https://github.com/${RELEASES_REPO}/releases/download/v${latest}/${asset}`;
  console.log(dim(`Downloading ${url}`));
  const res = await fetch(url, { headers: { "user-agent": `deyin-cli/${VERSION}` } });
  if (!res.ok) {
    errorLine(`download failed (HTTP ${res.status}).`);
    return 1;
  }
  const buf = Buffer.from(await res.arrayBuffer());

  const target = process.execPath;
  const staged = `${target}.new`;
  try {
    await writeFile(staged, buf);
    chmodSync(staged, 0o755);
    if (process.platform === "win32") {
      // A running .exe cannot be replaced; leave the new binary next to it.
      console.log(`Downloaded ${bold(latest)} to ${staged}.`);
      console.log("Close deyin, then replace the old binary with it.");
      return 0;
    }
    renameSync(staged, target);
    console.log(`${green("Updated")} to ${bold(latest)}. Restart deyin to use the new version.`);
    return 0;
  } catch (err) {
    errorLine(
      `could not replace ${target} (${err instanceof Error ? err.message : String(err)}). ` +
        `Try re-running the install script or with elevated permissions.`,
    );
    return 1;
  }
}
