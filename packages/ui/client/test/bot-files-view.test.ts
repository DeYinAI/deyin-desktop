import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RUNTIME_LIMITS, missingTranslations, type RuntimeFileEntry } from "@deyin/host-core/shared";
import { BotFilesPanel, type FilesState } from "../src/bots/BotFiles.js";
import {
  FILE_NAME_MAX,
  copyDirection,
  copyLabelKey,
  crumbs,
  fileContentProblem,
  formatSize,
  isFileDirty,
  joinPath,
  newFileProblem,
  sortEntries,
  type FileEditor,
} from "../src/bots/botFiles.js";

const noop = () => undefined;

function entry(name: string, kind: "file" | "directory" = "file", over: Partial<RuntimeFileEntry> = {}): RuntimeFileEntry {
  return { name, path: name, kind, size: kind === "file" ? 1200 : 0, modifiedAt: 1, ...over };
}

test("paths join with one slash and nothing in front at the top", () => {
  assert.equal(joinPath("", "notes.md"), "notes.md");
  assert.equal(joinPath("reports/2026", "q1.md"), "reports/2026/q1.md");
});

test("breadcrumbs name each folder with the path that opens it, and the top has none", () => {
  assert.deepEqual(crumbs(""), []);
  assert.deepEqual(crumbs("a"), [{ name: "a", path: "a" }]);
  assert.deepEqual(crumbs("a/b/c"), [
    { name: "a", path: "a" },
    { name: "b", path: "a/b" },
    { name: "c", path: "a/b/c" },
  ]);
  assert.deepEqual(crumbs("a//b/"), [
    { name: "a", path: "a" },
    { name: "b", path: "a/b" },
  ]);
});

test("folders come before files, each in name order, and the host's list is not changed", () => {
  const given = [entry("zeta.md"), entry("beta", "directory"), entry("alpha.md"), entry("alpha", "directory")];
  const copy = [...given];
  assert.deepEqual(sortEntries(given).map((one) => one.name), ["alpha", "beta", "alpha.md", "zeta.md"]);
  assert.deepEqual(given, copy);
});

test("sizes read like a person would say them", () => {
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(1023), "1023 B");
  assert.equal(formatSize(1024), "1.0 KB");
  assert.equal(formatSize(1536), "1.5 KB");
  assert.equal(formatSize(10 * 1024), "10 KB");
  assert.equal(formatSize(1024 * 1024), "1.0 MB");
  assert.equal(formatSize(-1), "");
  assert.equal(formatSize(Number.NaN), "");
  assert.equal(formatSize(Number.POSITIVE_INFINITY), "");
});

test("a new file's name must be there, plain, short and not already used", () => {
  assert.equal(newFileProblem("notes.md", []), null);
  assert.equal(newFileProblem("  notes.md ", []), null);
  assert.equal(newFileProblem("", []), "bot.files.problem.name");
  assert.equal(newFileProblem("   ", []), "bot.files.problem.name");
  assert.equal(newFileProblem("a/b.md", []), "bot.files.problem.nameForm");
  assert.equal(newFileProblem("a\\b.md", []), "bot.files.problem.nameForm");
  assert.equal(newFileProblem("a\0b", []), "bot.files.problem.nameForm");
  assert.equal(newFileProblem(".", []), "bot.files.problem.nameForm");
  assert.equal(newFileProblem("..", []), "bot.files.problem.nameForm");
  assert.equal(newFileProblem("x".repeat(FILE_NAME_MAX + 1), []), "bot.files.problem.nameForm");
  assert.equal(newFileProblem("x".repeat(FILE_NAME_MAX), []), null);
  assert.equal(newFileProblem("notes.md", ["notes.md"]), "bot.files.problem.taken");
  assert.equal(newFileProblem(" notes.md", ["notes.md"]), "bot.files.problem.taken", "what is typed is trimmed before it is compared");
  assert.equal(newFileProblem("Notes.md", ["notes.md"]), null);
});

test("text too big for the host is caught before it is sent, measured in bytes not characters", () => {
  assert.equal(fileContentProblem(""), null);
  assert.equal(fileContentProblem("a".repeat(RUNTIME_LIMITS.fileBytes)), null);
  assert.equal(fileContentProblem("a".repeat(RUNTIME_LIMITS.fileBytes + 1)), "bot.files.problem.big");
  // 3 bytes each: well under the limit in characters, over in bytes.
  assert.equal(fileContentProblem("€".repeat(Math.floor(RUNTIME_LIMITS.fileBytes / 3) + 1)), "bot.files.problem.big");
  assert.equal(fileContentProblem("€".repeat(Math.floor(RUNTIME_LIMITS.fileBytes / 3))), null);
});

test("a new file is always something to save; an open one only once it has changed", () => {
  assert.equal(isFileDirty({ isNew: true, original: "", content: "" }), true);
  assert.equal(isFileDirty({ isNew: false, original: "a", content: "a" }), false);
  assert.equal(isFileDirty({ isNew: false, original: "a", content: "b" }), true);
});

test("copying goes to the other place from where the person is looking", () => {
  assert.equal(copyDirection("bot"), "to-library");
  assert.equal(copyDirection("library"), "to-bot");
  assert.equal(copyLabelKey("bot"), "bot.files.copyToLibrary");
  assert.equal(copyLabelKey("library"), "bot.files.copyToBot");
});

test("every file string exists in every language", () => {
  for (const locale of ["zh", "de"] as const) {
    assert.deepEqual(missingTranslations(locale).filter((key) => key.startsWith("bot.files.")), [], locale);
  }
});

interface Over {
  scope?: "bot" | "library";
  dir?: string;
  state?: FilesState;
  notice?: string | null;
  info?: string | null;
  editor?: FileEditor | null;
  newName?: string | null;
}

function render(over: Over = {}): string {
  return renderToStaticMarkup(
    createElement(BotFilesPanel, {
      scope: over.scope ?? "bot",
      dir: over.dir ?? "",
      state: over.state ?? { status: "ready", entries: [] },
      notice: over.notice ?? null,
      info: over.info ?? null,
      editor: over.editor ?? null,
      newName: over.newName ?? null,
      onScope: noop,
      onOpenDir: noop,
      onOpenFile: noop,
      onNewFile: noop,
      onNewName: noop,
      onContent: noop,
      onSave: noop,
      onCancel: noop,
      onRemove: noop,
      onCopy: noop,
    }),
  );
}

function editor(over: Partial<FileEditor> = {}): FileEditor {
  return { path: "notes.md", isNew: false, original: "a", content: "a", busy: false, error: null, ...over };
}

test("the two places are tabs, the chosen one selected, each with its own explanation", () => {
  const mine = render();
  assert.match(mine, /role="tab" aria-selected="true"[^>]*>This Bot&#x27;s files</);
  assert.match(mine, /role="tab" aria-selected="false"[^>]*>Library</);
  assert.match(mine, /Where this Bot works/);
  const library = render({ scope: "library" });
  assert.match(library, /role="tab" aria-selected="false"[^>]*>This Bot&#x27;s files</);
  assert.match(library, /role="tab" aria-selected="true"[^>]*>Library</);
  assert.match(library, /A folder on this computer that every Bot can be given files from/);
});

test("loading, a failed load and an empty folder are each said, and only a loaded folder can have a file added", () => {
  const loading = render({ state: { status: "loading" } });
  assert.match(loading, /role="status"[^>]*>Loading files…/);
  assert.doesNotMatch(loading, /New file/);
  const failed = render({ state: { status: "error", error: "ipc closed" } });
  assert.match(failed, /role="alert"[^>]*>Couldn&#x27;t load the files\. ipc closed/);
  assert.doesNotMatch(failed, /New file/);
  const empty = render();
  assert.match(empty, /Nothing here yet\./);
  assert.match(empty, />New file</);
});

test("folders list first with a slash and Open, files with their size, Edit and a copy to the other place; both can be removed", () => {
  const html = render({ state: { status: "ready", entries: [entry("notes.md"), entry("reports", "directory")] } });
  assert.ok(html.indexOf("reports/") < html.indexOf("notes.md"));
  assert.match(html, />Open</);
  assert.match(html, /bot-panel__meta">1\.2 KB</);
  assert.match(html, />Edit</);
  assert.match(html, />Copy to library</);
  assert.equal(html.match(/>Remove</g)?.length, 2);
  const library = render({ scope: "library", state: { status: "ready", entries: [entry("notes.md")] } });
  assert.match(library, />Copy to this Bot</);
  assert.doesNotMatch(library, />Copy to library</);
});

test("a folder's size is not shown", () => {
  const html = render({ state: { status: "ready", entries: [entry("reports", "directory", { size: 4096 })] } });
  assert.doesNotMatch(html, /bot-panel__meta/);
});

test("the breadcrumbs go back up: the top is a button when inside a folder, the folder you are in is not", () => {
  const top = render();
  assert.match(top, /<button[^>]*disabled=""[^>]*>This Bot&#x27;s files<\/button>/);
  const deep = render({ dir: "reports/2026" });
  assert.doesNotMatch(deep, /<button[^>]*disabled=""[^>]*>This Bot&#x27;s files<\/button>/);
  assert.match(deep, /<button[^>]*>reports<\/button>/);
  assert.doesNotMatch(deep, /<button[^>]*disabled=""[^>]*>reports<\/button>/);
  assert.match(deep, /<button[^>]*disabled=""[^>]*>2026<\/button>/);
});

test("file names are escaped, never taken as markup", () => {
  const html = render({ state: { status: "ready", entries: [entry("<img src=x onerror=alert(1)>.md")] } });
  assert.doesNotMatch(html, /<img/);
});

test("a notice and an info line are told apart: one is an alert", () => {
  const html = render({ notice: "That file is gone.", info: "Copied to the library as notes.md." });
  assert.match(html, /role="alert"[^>]*>That file is gone\./);
  assert.match(html, /role="status"[^>]*>Copied to the library as notes\.md\./);
});

test("a new file asks for a name; Save stays off until the name is fine and there are words", () => {
  const html = render({ editor: editor({ isNew: true, path: "", original: "", content: "hello" }), newName: "" });
  assert.match(html, /<form[^>]*aria-label="New file"/);
  assert.match(html, /id="file-name"[^>]*maxLength="120"/);
  assert.doesNotMatch(html, /<button[^>]*>New file</, "the New file button gives way to the form");
  assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Save</);
  const named = render({ editor: editor({ isNew: true, path: "", original: "", content: "hello" }), newName: "notes.md" });
  assert.doesNotMatch(named, /<button type="submit"[^>]*disabled=""/);
});

test("a name already used is said, once something is typed", () => {
  const taken = render({
    state: { status: "ready", entries: [entry("notes.md")] },
    editor: editor({ isNew: true, path: "", original: "", content: "x" }),
    newName: "notes.md",
  });
  assert.match(taken, /role="status"[^>]*>There is already a file with that name here\./);
  assert.match(taken, /<button type="submit"[^>]*disabled=""/);
  const bad = render({ editor: editor({ isNew: true, path: "", original: "", content: "x" }), newName: "a/b" });
  assert.match(bad, /A file name has no slashes/);
  const untouched = render({ editor: editor({ isNew: true, path: "", original: "", content: "x" }), newName: "" });
  assert.doesNotMatch(untouched, /Name the file\./, "nothing is scolded before the person types");
});

test("an open file shows where it is, and Save is off until it changes", () => {
  const same = render({ editor: editor() });
  assert.match(same, /aria-label="Edit notes\.md"/);
  assert.match(same, /<p class="hint">notes\.md<\/p>/);
  assert.doesNotMatch(same, /id="file-name"/);
  assert.match(same, /<button type="submit"[^>]*disabled=""/);
  const changed = render({ editor: editor({ content: "b" }) });
  assert.doesNotMatch(changed, /<button type="submit"[^>]*disabled=""/);
});

test("text too big is said and cannot be saved; a host refusal replaces it", () => {
  const big = render({ editor: editor({ content: "a".repeat(RUNTIME_LIMITS.fileBytes + 1) }) });
  assert.match(big, /That is too much text for one file \(2 MB at most\)\./);
  assert.match(big, /<button type="submit"[^>]*disabled=""/);
  const refused = render({ editor: editor({ content: "b", error: "The folder is full." }) });
  assert.match(refused, /role="alert"[^>]*>The folder is full\./);
});

test("while saving the form cannot be changed or sent again", () => {
  const html = render({ editor: editor({ content: "b", busy: true }) });
  assert.match(html, /<textarea id="file-content"[^>]*disabled=""/);
  assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Saving…</);
});
