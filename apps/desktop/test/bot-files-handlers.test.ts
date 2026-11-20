import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BotError, BotStore, FileStorage, RUNTIME_LIMITS, type BotRuntime, type DeyinBot, type FileScope } from "@deyin/host-core";
import { LocalBotRuntime } from "../src/main/bots/engine/runtimes.js";
import { createFilesHandlers, isPlainText } from "../src/main/bots/files-handlers.js";

const dirs: string[] = [];
const storages: FileStorage[] = [];
after(async () => {
  await Promise.all(storages.map((storage) => storage.flush()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setup(options: { runtimeOf?: (bot: DeyinBot) => BotRuntime } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "deyin-files-"));
  dirs.push(dir);
  const storage = new FileStorage(dir);
  storages.push(storage);
  const store = new BotStore(storage);
  const libraryDir = join(dir, "library");
  const library = new LocalBotRuntime({ root: libraryDir });
  const changed: Array<[FileScope, string | null]> = [];
  const handlers = createFilesHandlers({
    store,
    runtimeOf: options.runtimeOf ?? ((bot) => new LocalBotRuntime({ root: join(store.dataDir(bot.id), "files") })),
    library,
    changed: (scope, botId) => changed.push([scope, botId]),
  });
  const ada = store.create({ name: "Ada" });
  return { dir, store, libraryDir, library, handlers, changed, ada, filesOf: (bot: DeyinBot) => join(store.dataDir(bot.id), "files") };
}

function ok<T>(result: { ok: true; value: T } | { ok: false; error: string; code: string }): T {
  assert.ok(result.ok, result.ok ? "" : `${result.code}: ${result.error}`);
  return (result as { ok: true; value: T }).value;
}

function refused(result: { ok: true; value: unknown } | { ok: false; error: string; code: string }, code?: string): string {
  assert.equal(result.ok, false, "expected a refusal");
  if (result.ok) return "";
  if (code) assert.equal(result.code, code, result.error);
  return result.error;
}

test("a Bot's files can be written, listed, read and removed, folders first, and each change is announced", async () => {
  const t = setup();
  ok(await t.handlers.write("bot", t.ada.id, "notes.md", "hello"));
  ok(await t.handlers.write("bot", t.ada.id, "reports/q1.md", "numbers"));
  ok(await t.handlers.write("bot", t.ada.id, "a-file.txt", "x"));
  assert.deepEqual(ok(await t.handlers.list("bot", t.ada.id, "")).map((e) => [e.name, e.kind]), [["reports", "directory"], ["a-file.txt", "file"], ["notes.md", "file"]]);
  assert.deepEqual(ok(await t.handlers.list("bot", t.ada.id, "reports")).map((e) => e.path), ["reports/q1.md"]);
  assert.deepEqual(ok(await t.handlers.read("bot", t.ada.id, "reports/q1.md")), { path: "reports/q1.md", content: "numbers", size: 7 });
  ok(await t.handlers.remove("bot", t.ada.id, "reports"));
  assert.deepEqual(ok(await t.handlers.list("bot", t.ada.id, "")).map((e) => e.name), ["a-file.txt", "notes.md"]);
  assert.deepEqual(t.changed, [["bot", t.ada.id], ["bot", t.ada.id], ["bot", t.ada.id], ["bot", t.ada.id]]);
});

test("the size of a file is its bytes, not its letters", async () => {
  const t = setup();
  ok(await t.handlers.write("bot", t.ada.id, "naïve.txt", "né"));
  assert.equal(ok(await t.handlers.read("bot", t.ada.id, "naïve.txt")).size, 3);
});

test("the library is one folder on this computer, shared, and has nothing to do with any Bot's folder", async () => {
  const t = setup();
  const bo = t.store.create({ name: "Bo" });
  ok(await t.handlers.write("library", null, "style.md", "Be brief."));
  assert.equal(ok(await t.handlers.read("library", undefined, "style.md")).content, "Be brief.", "no Bot is needed to use it");
  assert.deepEqual(ok(await t.handlers.list("bot", bo.id, "")), []);
  assert.deepEqual(ok(await t.handlers.list("bot", t.ada.id, "")), []);
  assert.deepEqual(t.changed, [["library", null]]);
  assert.equal(existsSync(join(t.libraryDir, "style.md")), true);
});

test("the library can be listed before anything is in it", async () => {
  const t = setup();
  assert.deepEqual(ok(await t.handlers.list("library", null, "")), []);
});

test("a file moves from the library into a Bot's folder and back, as text, under the same name or another", async () => {
  const t = setup();
  ok(await t.handlers.write("library", null, "style.md", "Be brief."));
  assert.deepEqual(ok(await t.handlers.copy("to-bot", t.ada.id, "style.md")), { path: "style.md" });
  assert.equal(ok(await t.handlers.read("bot", t.ada.id, "style.md")).content, "Be brief.");
  assert.deepEqual(ok(await t.handlers.copy("to-bot", t.ada.id, "style.md", "guides/tone.md")), { path: "guides/tone.md" });
  ok(await t.handlers.write("bot", t.ada.id, "report.md", "Findings"));
  ok(await t.handlers.copy("to-library", t.ada.id, "report.md", "findings-2026.md"));
  assert.equal(ok(await t.handlers.read("library", null, "findings-2026.md")).content, "Findings");
  assert.equal(ok(await t.handlers.read("library", null, "style.md")).content, "Be brief.", "the original stays");
  assert.deepEqual(t.changed.slice(-3), [["bot", t.ada.id], ["bot", t.ada.id], ["library", null]]);
});

test("a copy never replaces what is there, whether a file or a folder, and says so", async () => {
  const t = setup();
  ok(await t.handlers.write("library", null, "style.md", "Library version"));
  ok(await t.handlers.write("bot", t.ada.id, "style.md", "Bot's own version"));
  assert.match(refused(await t.handlers.copy("to-bot", t.ada.id, "style.md"), "conflict"), /There is already a file called "style\.md"/);
  assert.equal(ok(await t.handlers.read("bot", t.ada.id, "style.md")).content, "Bot's own version");
  ok(await t.handlers.write("bot", t.ada.id, "folder/x.md", "x"));
  refused(await t.handlers.copy("to-bot", t.ada.id, "style.md", "folder"), "conflict");
  mkdirSync(join(t.filesOf(t.ada), "bin"), { recursive: true });
  writeFileSync(join(t.filesOf(t.ada), "bin", "data.bin"), Buffer.from([0, 1, 2]));
  refused(await t.handlers.copy("to-bot", t.ada.id, "style.md", "bin/data.bin"), "conflict");
  assert.deepEqual([...readFileSync(join(t.filesOf(t.ada), "bin", "data.bin"))], [0, 1, 2], "a file that is not text is not replaced either");
  const changesBefore = t.changed.length;
  refused(await t.handlers.copy("to-bot", t.ada.id, "style.md"));
  assert.equal(t.changed.length, changesBefore, "a refused copy announces nothing");
});

test("a failure checking for something already there is a failure, not permission to write", async () => {
  const flaky: BotRuntime = {
    kind: "server",
    capabilities: { exec: true, files: true, agent: true, scheduler: true, browser: false },
    home: "~/x",
    health: async () => ({ ok: true }),
    exec: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, truncated: false }),
    listFiles: async () => [],
    readFile: async () => {
      throw new BotError("conflict", "Could not connect to Dell.");
    },
    writeFile: async () => assert.fail("must not write when it could not look first"),
    removeFile: async () => undefined,
    run: async () => ({ reason: "completed", finalText: "" }),
  };
  const t = setup({ runtimeOf: () => flaky });
  ok(await t.handlers.write("library", null, "style.md", "Be brief."));
  assert.match(refused(await t.handlers.copy("to-bot", t.ada.id, "style.md"), "conflict"), /Could not connect to Dell/);
});

test("only text moves: a file with a NUL or a broken encoding is neither read, written nor copied", async () => {
  const t = setup();
  mkdirSync(t.filesOf(t.ada), { recursive: true });
  writeFileSync(join(t.filesOf(t.ada), "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
  writeFileSync(join(t.filesOf(t.ada), "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  assert.match(refused(await t.handlers.read("bot", t.ada.id, "image.png"), "invalid"), /not a text file/);
  assert.match(refused(await t.handlers.read("bot", t.ada.id, "latin1.txt"), "invalid"), /not a text file/);
  assert.match(refused(await t.handlers.write("bot", t.ada.id, "a.txt", "a\u0000b"), "invalid"), /not a text file/);
  assert.match(refused(await t.handlers.copy("to-library", t.ada.id, "image.png"), "invalid"), /not a text file/);
  assert.equal(existsSync(join(t.libraryDir, "image.png")), false);
  assert.equal(isPlainText("plain, with é and 日本語 and 🙂"), true);
  assert.equal(isPlainText("a\u0000b"), false);
  assert.equal(isPlainText("bad \uFFFD"), false);
});

test("a path cannot leave the folder it is in, by going up, by a full path, or by a link", async () => {
  const t = setup();
  writeFileSync(join(t.dir, "secret.txt"), "top secret");
  mkdirSync(t.filesOf(t.ada), { recursive: true });
  symlinkSync(join(t.dir, "secret.txt"), join(t.filesOf(t.ada), "link.txt"));
  symlinkSync(t.dir, join(t.filesOf(t.ada), "linked-dir"));
  for (const path of ["../secret.txt", "../../x", "/etc/passwd", "C:\\Windows\\win.ini", "a/../../b", "link.txt", "linked-dir/secret.txt"]) {
    const calls: Record<string, () => Promise<{ ok: true; value: unknown } | { ok: false; error: string; code: string }>> = {
      read: () => t.handlers.read("bot", t.ada.id, path),
      write: () => t.handlers.write("bot", t.ada.id, path, "x"),
      remove: () => t.handlers.remove("bot", t.ada.id, path),
      copy: () => t.handlers.copy("to-library", t.ada.id, path),
    };
    for (const [name, call] of Object.entries(calls)) {
      // Removing a link removes the link and never what it leads to; that is checked on its own below.
      if (name === "remove" && path === "link.txt") continue;
      const result = await call();
      assert.equal(result.ok, false, `${name} ${path}`);
    }
  }
  assert.equal(readFileSync(join(t.dir, "secret.txt"), "utf8"), "top secret");
  ok(await t.handlers.remove("bot", t.ada.id, "link.txt"));
  assert.equal(existsSync(join(t.filesOf(t.ada), "link.txt")), false, "the link itself is gone");
  assert.equal(readFileSync(join(t.dir, "secret.txt"), "utf8"), "top secret", "what it led to is not touched");
  refused(await t.handlers.list("bot", t.ada.id, "../.."));
  refused(await t.handlers.list("bot", t.ada.id, "/"));
});

test("every argument is checked, because it came from a page", async () => {
  const t = setup();
  refused(await t.handlers.list("somewhere", t.ada.id, ""), "invalid");
  refused(await t.handlers.list(undefined, t.ada.id, ""), "invalid");
  for (const bad of [undefined, null, 5, {}, []]) {
    refused(await t.handlers.list("bot", bad, ""), "invalid");
    refused(await t.handlers.read("bot", t.ada.id, bad), "invalid");
    refused(await t.handlers.write("bot", t.ada.id, bad, "x"), "invalid");
    refused(await t.handlers.remove("bot", t.ada.id, bad), "invalid");
    refused(await t.handlers.copy("to-bot", t.ada.id, bad), "invalid");
  }
  for (const bad of [undefined, null, 5, {}]) refused(await t.handlers.write("bot", t.ada.id, "a.txt", bad), "invalid");
  refused(await t.handlers.copy("sideways", t.ada.id, "a.txt"), "invalid");
  refused(await t.handlers.copy("to-bot", t.ada.id, "a.txt", 5), "invalid");
  assert.deepEqual(ok(await t.handlers.list("bot", t.ada.id, 5)), [], "a path that is not text means the top folder");
});

test("a Bot that is gone has no files; a file that is not there is not found", async () => {
  const t = setup();
  assert.deepEqual(await t.handlers.list("bot", "nope", ""), { ok: false, error: "That Bot no longer exists.", code: "not_found" });
  refused(await t.handlers.read("bot", t.ada.id, "missing.md"), "not_found");
  refused(await t.handlers.remove("bot", t.ada.id, "missing.md"), "not_found");
  refused(await t.handlers.copy("to-bot", t.ada.id, "missing.md"), "not_found");
  refused(await t.handlers.read("bot", t.ada.id, "reports"), undefined);
});

test("a room has a folder of its own, where its Bots' work lands, apart from each Bot's", async () => {
  const t = setup();
  const bo = t.store.create({ name: "Bo" });
  const room = t.store.create({ name: "Room", kind: "room", memberBotIds: [t.ada.id, bo.id] });
  ok(await t.handlers.write("bot", room.id, "notes.md", "from the room"));
  assert.deepEqual(ok(await t.handlers.list("bot", room.id, "")).map((entry) => entry.name), ["notes.md"]);
  assert.deepEqual(ok(await t.handlers.list("bot", t.ada.id, "")), [], "a member's own folder is not the room's");
});

test("a Bot's folder is whichever computer the Bot lives on: the handlers ask for it by Bot every time", async () => {
  const asked: string[] = [];
  const t = setup({
    runtimeOf: (bot) => {
      asked.push(bot.id);
      throw new BotError("conflict", "Dell is not set up yet.");
    },
  });
  assert.match(refused(await t.handlers.list("bot", t.ada.id, ""), "conflict"), /Dell is not set up/);
  assert.deepEqual(asked, [t.ada.id]);
  ok(await t.handlers.write("library", null, "a.md", "x"));
  assert.deepEqual(asked, [t.ada.id], "the library never asks for a Bot's computer");
});

test("a file bigger than a Bot file may be is refused, in words", async () => {
  const t = setup();
  const big = "x".repeat(RUNTIME_LIMITS.fileBytes + 1);
  assert.match(refused(await t.handlers.write("bot", t.ada.id, "big.txt", big), "limit"), /at most 2 MB/);
});
