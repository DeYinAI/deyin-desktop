import type { ToolDefinition } from "../types.js";
import { commitFileMutation, readFileForMutation } from "./file-mutation.js";
import { asOptionalBoolean, asString, resolvePathInWorkspace } from "./util.js";

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * Pure string-replace edit used by the edit tool (exported for unit tests):
 * old_string must exist and, unless replace_all, must be unique in the file.
 */
export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { next: string; replacements: number } {
  if (oldString === newString) throw new Error("old_string and new_string are identical.");
  const occurrences = countOccurrences(content, oldString);
  if (occurrences === 0) {
    throw new Error("old_string not found in file. Read the file and match its content exactly (including whitespace).");
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `old_string appears ${occurrences} times. Provide a larger unique snippet, or set replace_all to true.`,
    );
  }
  const next = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
  return { next, replacements: replaceAll ? occurrences : 1 };
}

export const editTool: ToolDefinition = {
  name: "edit",
  description:
    "Replace an exact string in a file. old_string must match the file content exactly (including indentation) and must be unique unless replace_all is true. Read the file first.",
  tier: "write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute, or relative to the workspace root)." },
      old_string: { type: "string", description: "Exact text to replace." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
    },
    required: ["path", "old_string", "new_string"],
  },
  summarize: (args) => String(args.path ?? ""),
  async execute(args, ctx): Promise<string> {
    const path = resolvePathInWorkspace(ctx.cwd, asString(args.path, "path"));
    const oldString = asString(args.old_string, "old_string");
    const newString = typeof args.new_string === "string" ? args.new_string : "";
    const replaceAll = asOptionalBoolean(args.replace_all) ?? false;

    const content = await readFileForMutation(path);
    if (!content && oldString) {
      throw new Error("File not found or empty. Read the file first.");
    }
    const { next, replacements } = applyEdit(content, oldString, newString, replaceAll);
    const outcome = await commitFileMutation({ path, before: content, after: next, operation: "edit" }, ctx);
    if (outcome === "rejected") {
      return "Change rejected by the user during review. Do not retry the same edit; ask what to do next.";
    }
    return `Replaced ${replacements} occurrence${replacements === 1 ? "" : "s"} in ${path}`;
  },
};
