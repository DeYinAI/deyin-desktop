import type { ToolDefinition } from "../types.js";
import { commitFileMutation, readFileForMutation } from "./file-mutation.js";
import { asOptionalNumber, asOptionalString, asString, resolvePathInWorkspace } from "./util.js";

export interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

export interface FilePatch {
  oldPath?: string;
  newPath?: string;
  hunks: PatchHunk[];
}

/**
 * Parses a unified diff string into structured file patches and hunks.
 */
export function parseUnifiedDiff(diff: string): FilePatch[] {
  const lines = diff.split(/\r?\n/);
  const patches: FilePatch[] = [];
  let currentPatch: FilePatch | null = null;
  let currentHunk: PatchHunk | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.startsWith("diff --git ")) {
      if (currentPatch && currentPatch.hunks.length > 0) {
        patches.push(currentPatch);
      }
      currentPatch = { hunks: [] };
      currentHunk = null;
      const parts = line.slice("diff --git ".length).split(/\s+/);
      if (parts[0]) currentPatch.oldPath = parts[0].replace(/^[ab]\//, "");
      if (parts[1]) currentPatch.newPath = parts[1].replace(/^[ab]\//, "");
      continue;
    }

    if (line.startsWith("--- ")) {
      const raw = line.slice(4).trim().split(/\t|\s{2,}/)[0] ?? "";
      const cleaned = raw.replace(/^[ab]\//, "");
      if (!currentPatch) currentPatch = { hunks: [] };
      if (cleaned !== "/dev/null") currentPatch.oldPath = cleaned;
      continue;
    }

    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim().split(/\t|\s{2,}/)[0] ?? "";
      const cleaned = raw.replace(/^[ab]\//, "");
      if (!currentPatch) currentPatch = { hunks: [] };
      if (cleaned !== "/dev/null") currentPatch.newPath = cleaned;
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (!currentPatch) currentPatch = { hunks: [] };
      currentHunk = {
        oldStart: parseInt(hunkMatch[1]!, 10),
        oldCount: hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3]!, 10),
        newCount: hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1,
        lines: [],
      };
      currentPatch.hunks.push(currentHunk);
      continue;
    }

    if (currentHunk) {
      if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "") {
        currentHunk.lines.push(line);
      } else if (line.startsWith("\\ No newline at end of file")) {
        // Ignored metadata
      }
    }
  }

  if (currentPatch && currentPatch.hunks.length > 0) {
    patches.push(currentPatch);
  }

  return patches;
}

/**
 * Applies hunks to file content with fuzzy offset and whitespace tolerance.
 */
export function applyHunksToFile(
  originalContent: string,
  hunks: PatchHunk[],
  fuzzWindow = 10,
): { next: string; appliedHunks: number; additions: number; deletions: number } {
  let fileLines = originalContent.length === 0 ? [] : originalContent.split(/\r?\n/);
  let additions = 0;
  let deletions = 0;

  for (let hIdx = 0; hIdx < hunks.length; hIdx++) {
    const hunk = hunks[hIdx]!;
    const expectedOldLines: string[] = [];
    const replacementLines: string[] = [];

    for (const hLine of hunk.lines) {
      const marker = hLine[0];
      const text = hLine.slice(1);
      if (marker === "-") {
        expectedOldLines.push(text);
        deletions++;
      } else if (marker === "+") {
        replacementLines.push(text);
        additions++;
      } else {
        // Context line (' ' or empty)
        const ctxText = marker === " " ? text : hLine;
        expectedOldLines.push(ctxText);
        replacementLines.push(ctxText);
      }
    }

    // If hunk expects nothing and adds to an empty file
    if (expectedOldLines.length === 0 && fileLines.length === 0) {
      fileLines = [...replacementLines];
      continue;
    }

    let matchIndex = -1;
    const targetLine0 = Math.max(0, hunk.oldStart - 1);

    // 1. Try exact line position
    if (isMatchAt(fileLines, targetLine0, expectedOldLines, false)) {
      matchIndex = targetLine0;
    }

    // 2. Search within fuzz window around target line
    if (matchIndex === -1) {
      for (let offset = 1; offset <= fuzzWindow; offset++) {
        const tryBefore = targetLine0 - offset;
        if (tryBefore >= 0 && isMatchAt(fileLines, tryBefore, expectedOldLines, false)) {
          matchIndex = tryBefore;
          break;
        }
        const tryAfter = targetLine0 + offset;
        if (tryAfter <= fileLines.length - expectedOldLines.length && isMatchAt(fileLines, tryAfter, expectedOldLines, false)) {
          matchIndex = tryAfter;
          break;
        }
      }
    }

    // 3. Search anywhere in file
    if (matchIndex === -1) {
      for (let i = 0; i <= fileLines.length - expectedOldLines.length; i++) {
        if (isMatchAt(fileLines, i, expectedOldLines, false)) {
          matchIndex = i;
          break;
        }
      }
    }

    // 4. Try whitespace-insensitive match
    if (matchIndex === -1) {
      for (let i = 0; i <= fileLines.length - expectedOldLines.length; i++) {
        if (isMatchAt(fileLines, i, expectedOldLines, true)) {
          matchIndex = i;
          break;
        }
      }
    }

    if (matchIndex === -1) {
      const snippet = expectedOldLines.slice(0, 3).map((l) => `  ${l}`).join("\n");
      throw new Error(
        `Hunk #${hIdx + 1} failed to apply at line ${hunk.oldStart}. Expected context:\n${snippet}`,
      );
    }

    fileLines.splice(matchIndex, expectedOldLines.length, ...replacementLines);
  }

  const next = fileLines.join("\n");
  return { next, appliedHunks: hunks.length, additions, deletions };
}

function isMatchAt(fileLines: string[], start: number, expected: string[], trimWhitespace: boolean): boolean {
  if (start < 0 || start + expected.length > fileLines.length) return false;
  for (let i = 0; i < expected.length; i++) {
    const fLine = fileLines[start + i] ?? "";
    const eLine = expected[i] ?? "";
    if (trimWhitespace) {
      if (fLine.trim() !== eLine.trim()) return false;
    } else {
      if (fLine !== eLine) return false;
    }
  }
  return true;
}

/**
 * apply_patch tool for applying standard unified diffs to workspace files.
 */
export const applyPatchTool: ToolDefinition = {
  name: "apply_patch",
  description:
    "Apply a unified diff or patch (git diff format or standard unified diff) to files in the workspace. " +
    "Supports multiple hunks, fuzzy offset tolerance, and multi-file patches. " +
    "Use when proposing diffs or applying patches generated from version control or evaluation benchmarks.",
  tier: "write",
  parameters: {
    type: "object",
    properties: {
      patch: {
        type: "string",
        description: "The complete unified diff or patch text (containing @@ hunk headers, + additions, - deletions).",
      },
      path: {
        type: "string",
        description: "Optional file path if the patch header does not specify the target file or to override it.",
      },
      fuzz: {
        type: "number",
        description: "Max line offset tolerance when locating hunks (default 10).",
      },
    },
    required: ["patch"],
  },
  summarize: (args) => {
    const p = asOptionalString(args.path);
    return p ? `apply_patch to ${p}` : "apply_patch";
  },
  meta: (args, ctx) => ({
    cwd: asOptionalString(args.path) ? resolvePathInWorkspace(ctx.cwd, String(args.path)) : ctx.cwd,
  }),
  async execute(args, ctx): Promise<string> {
    const patchText = asString(args.patch, "patch");
    const explicitPath = asOptionalString(args.path);
    const fuzz = asOptionalNumber(args.fuzz) ?? 10;

    let parsed = parseUnifiedDiff(patchText);

    // If parseUnifiedDiff found no headers but path was given, construct a single hunk patch
    if (parsed.length === 0 && explicitPath) {
      const hunkLines: string[] = [];
      for (const line of patchText.split(/\r?\n/)) {
        if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "") {
          hunkLines.push(line);
        }
      }
      if (hunkLines.length > 0) {
        parsed = [{
          newPath: explicitPath,
          hunks: [{
            oldStart: 1,
            oldCount: hunkLines.filter((l) => l.startsWith("-") || l.startsWith(" ")).length,
            newStart: 1,
            newCount: hunkLines.filter((l) => l.startsWith("+") || l.startsWith(" ")).length,
            lines: hunkLines,
          }],
        }];
      }
    }

    if (parsed.length === 0) {
      return "ERROR: Could not parse patch. Ensure the diff contains valid unified diff format (e.g., '--- a/file', '+++ b/file', and '@@ -X,Y +A,B @@').";
    }

    const summaries: string[] = [];

    for (const filePatch of parsed) {
      const targetRel = explicitPath ?? filePatch.newPath ?? filePatch.oldPath;
      if (!targetRel) {
        return "ERROR: Target file path could not be determined from patch header. Provide the 'path' argument.";
      }

      const fullPath = resolvePathInWorkspace(ctx.cwd, targetRel);
      const before = await readFileForMutation(fullPath);

      try {
        const { next, appliedHunks, additions, deletions } = applyHunksToFile(before, filePatch.hunks, fuzz);
        const mutationRes = await commitFileMutation(
          {
            path: fullPath,
            before,
            after: next,
            operation: "edit",
          },
          ctx,
        );

        if (mutationRes === "rejected") {
          return `Patch to ${targetRel} was rejected by user.`;
        }

        summaries.push(`- ${targetRel}: ${appliedHunks} hunk(s) applied (+${additions}, -${deletions} lines)`);
      } catch (err) {
        return `Failed applying patch to ${targetRel}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return `Successfully applied patch to ${summaries.length} file(s):\n${summaries.join("\n")}`;
  },
};
