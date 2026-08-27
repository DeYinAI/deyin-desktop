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

/** One string replacement within a file. */
export interface EditSpec {
  oldString: string;
  newString: string;
  replaceAll: boolean;
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

/**
 * Apply edits in order, each one matching against the result of the previous
 * edit. All-or-nothing: the first failure throws and nothing is written, so a
 * batch never leaves the file half-edited.
 */
export function applyEdits(content: string, edits: EditSpec[]): { next: string; replacements: number } {
  if (edits.length === 0) throw new Error("No edits provided.");
  let next = content;
  let replacements = 0;
  for (const [index, edit] of edits.entries()) {
    try {
      const result = applyEdit(next, edit.oldString, edit.newString, edit.replaceAll);
      next = result.next;
      replacements += result.replacements;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (edits.length === 1) {
        if (error instanceof Error) throw error;
        throw new Error(reason, { cause: error });
      }
      throw new Error(
        `edits[${index}] failed: ${reason} No edits were applied — later edits match against the file as earlier edits leave it, so re-check the whole batch.`,
        { cause: error },
      );
    }
  }
  return { next, replacements };
}

/** Accept either the single-edit form or the batched `edits` array. */
function parseEdits(args: Record<string, unknown>): EditSpec[] {
  const raw = args.edits;
  if (raw === undefined) {
    return [
      {
        oldString: asString(args.old_string, "old_string"),
        newString: typeof args.new_string === "string" ? args.new_string : "",
        replaceAll: asOptionalBoolean(args.replace_all) ?? false,
      },
    ];
  }
  if (args.old_string !== undefined) {
    throw new Error("Provide either edits or old_string/new_string, not both.");
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("edits must be a non-empty array of { old_string, new_string } objects.");
  }
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`edits[${index}] must be an object with old_string and new_string.`);
    }
    const edit = entry as Record<string, unknown>;
    return {
      oldString: asString(edit.old_string, `edits[${index}].old_string`),
      newString: typeof edit.new_string === "string" ? edit.new_string : "",
      replaceAll: asOptionalBoolean(edit.replace_all) ?? false,
    };
  });
}

export const editTool: ToolDefinition = {
  name: "edit",
  description:
    "Replace exact strings in a file. old_string must match the file content exactly (including indentation) and must be unique unless replace_all is true. Read the file first. " +
    "When a file needs several changes, pass them all in one call via edits — the batch applies in order, all-or-nothing, as a single change for review, instead of one call per edit.",
  tier: "write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute, or relative to the workspace root)." },
      old_string: { type: "string", description: "Exact text to replace. Single-edit form; omit when using edits." },
      new_string: { type: "string", description: "Replacement text. Single-edit form; omit when using edits." },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
      edits: {
        type: "array",
        description:
          "Batched edits applied to this file in order. Prefer this over repeated edit calls whenever you know several changes to the same file. Each edit matches against the file as the previous edits leave it; if any one fails, none are applied.",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string", description: "Exact text to replace." },
            new_string: { type: "string", description: "Replacement text." },
            replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
          },
          required: ["old_string", "new_string"],
        },
      },
    },
    required: ["path"],
  },
  summarize: (args) => {
    const path = String(args.path ?? "");
    const count = Array.isArray(args.edits) ? args.edits.length : 1;
    return count > 1 ? `${path} (${count} edits)` : path;
  },
  async execute(args, ctx): Promise<string> {
    const path = resolvePathInWorkspace(ctx.cwd, asString(args.path, "path"));
    const edits = parseEdits(args);

    const content = await readFileForMutation(path);
    if (!content && edits.some((edit) => edit.oldString)) {
      throw new Error("File not found or empty. Read the file first.");
    }
    const { next, replacements } = applyEdits(content, edits);
    const outcome = await commitFileMutation({ path, before: content, after: next, operation: "edit" }, ctx);
    if (outcome === "rejected") {
      return "Change rejected by the user during review. Do not retry the same edit; ask what to do next.";
    }
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    return edits.length === 1
      ? `Replaced ${plural(replacements, "occurrence")} in ${path}`
      : `Applied ${plural(edits.length, "edit")} (${plural(replacements, "replacement")}) in ${path}`;
  },
};
