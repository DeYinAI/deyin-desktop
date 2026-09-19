import { CHANGELOG_RELEASES, type ChangelogRelease } from "./changelogData.js";

export { type ChangelogRelease, CHANGELOG_RELEASES };

export interface ReleaseNotesResult {
  version: string;
  displayVersion: string;
  date?: string;
  content: string;
  isFallback: boolean;
}

export const GITHUB_CHANGELOG_URL = "https://github.com/DeYinAI/deyin-desktop/blob/main/docs/CHANGELOG.md";

export function getReleaseNotes(targetVersion: string): ReleaseNotesResult {
  const norm = targetVersion.replace(/^v/, "").trim();

  // 1. Exact match
  const exact = CHANGELOG_RELEASES.find((r) => r.version === norm);
  if (exact) {
    return {
      version: exact.version,
      displayVersion: `v${exact.version}`,
      date: exact.date,
      content: exact.content,
      isFallback: false,
    };
  }

  // 2. Prefix / major.minor match (e.g. "1.0.21-dev" or "1.0.21.1")
  const prefixMatch = CHANGELOG_RELEASES.find((r) => norm.startsWith(r.version));
  if (prefixMatch) {
    return {
      version: prefixMatch.version,
      displayVersion: `v${prefixMatch.version}`,
      date: prefixMatch.date,
      content: prefixMatch.content,
      isFallback: false,
    };
  }

  // 3. Fallback to latest known release
  const latest = CHANGELOG_RELEASES[0];
  if (latest) {
    return {
      version: latest.version,
      displayVersion: `v${latest.version}`,
      date: latest.date,
      content: latest.content,
      isFallback: true,
    };
  }

  return {
    version: norm,
    displayVersion: `v${norm}`,
    content: "Release highlights are not available for this version.",
    isFallback: true,
  };
}
