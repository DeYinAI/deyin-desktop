import type { DeyinApi } from "@deyin/contract";
import { RUNTIME_LIMITS, type CopyDirection, type FileScope, type MessageKey, type RuntimeFileEntry } from "@deyin/host-core/shared";

/** The file calls the panel needs. Absent where there is no desktop host. */
export type FilesApi = NonNullable<DeyinApi["botFiles"]>;

export const FILE_NAME_MAX = 120;

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export interface Crumb {
  name: string;
  path: string;
}

/** The folders leading to `dir`, each with the path that opens it. The top is not one of them: the page names it. */
export function crumbs(dir: string): Crumb[] {
  const parts = dir.split("/").filter((part) => part !== "");
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }));
}

/** Folders first, then files, each by name; the host already sorts, but a list that arrives otherwise is still shown in order. */
export function sortEntries(entries: readonly RuntimeFileEntry[]): RuntimeFileEntry[] {
  return [...entries].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What is wrong with the name of a new file, or null. `taken` are the names already in the folder. */
export function newFileProblem(name: string, taken: readonly string[]): MessageKey | null {
  const clean = name.trim();
  if (!clean) return "bot.files.problem.name";
  if (clean.length > FILE_NAME_MAX || /[\\/\0]/.test(clean) || clean === "." || clean === "..") return "bot.files.problem.nameForm";
  if (taken.includes(clean)) return "bot.files.problem.taken";
  return null;
}

/** What is wrong with a file's words before they are sent, or null: the host refuses the same, but the person is told sooner. */
export function fileContentProblem(content: string): MessageKey | null {
  // Characters are at most four bytes, so only text that could be too big is measured exactly.
  if (content.length * 4 > RUNTIME_LIMITS.fileBytes && new TextEncoder().encode(content).length > RUNTIME_LIMITS.fileBytes) return "bot.files.problem.big";
  return null;
}

/** An open file: its words as read (empty and `isNew` for a new one), and as changed. */
export interface FileEditor {
  /** Where it is, or will be, kept. */
  path: string;
  isNew: boolean;
  original: string;
  content: string;
  busy: boolean;
  error: string | null;
}

export function isFileDirty(editor: Pick<FileEditor, "isNew" | "original" | "content">): boolean {
  return editor.isNew || editor.content !== editor.original;
}

/** Copying goes the other way from where the person is looking: from a Bot's folder into the library, and back. */
export function copyDirection(scope: FileScope): CopyDirection {
  switch (scope) {
    case "bot":
      return "to-library";
    case "library":
      return "to-bot";
    default: {
      const unhandled: never = scope;
      throw new Error(`Unhandled file scope: ${String(unhandled)}`);
    }
  }
}

export function copyLabelKey(scope: FileScope): MessageKey {
  return scope === "bot" ? "bot.files.copyToLibrary" : "bot.files.copyToBot";
}
