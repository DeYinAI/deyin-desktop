import {
  BotError,
  RUNTIME_LIMITS,
  botResultAsync,
  cleanRelativePath,
  type BotResult,
  type BotRuntime,
  type BotStore,
  type DeyinBot,
  type FileContent,
  type FileScope,
  type RuntimeFileEntry,
} from "@deyin/host-core";

/**
 * Two places a person keeps files for their Bots. A Bot's own folder is where it works: what it makes and what it is
 * given to read, on its own computer, which is a server for a Bot that lives on one. The library is a folder on this
 * computer, shared by every Bot, for what the person wants to hand to any of them: a style guide, a price list.
 * Only text moves between them, so what is shown is what the Bot reads.
 */

export interface FilesHandlerDeps {
  store: Pick<BotStore, "get">;
  /** The computer a Bot works on: this one, or its server. A refusal (no server, cannot connect) is thrown. */
  runtimeOf(bot: DeyinBot): BotRuntime;
  /** The shared folder on this computer. */
  library: BotRuntime;
  /** Called after a Bot's own files changed, so a person looking at them sees it. */
  changed?(scope: FileScope, botId: string | null): void;
}

export interface FilesHandlers {
  list(scope: unknown, botId: unknown, path: unknown): Promise<BotResult<RuntimeFileEntry[]>>;
  read(scope: unknown, botId: unknown, path: unknown): Promise<BotResult<FileContent>>;
  write(scope: unknown, botId: unknown, path: unknown, content: unknown): Promise<BotResult<null>>;
  remove(scope: unknown, botId: unknown, path: unknown): Promise<BotResult<null>>;
  /** Copy one text file between the library and a Bot's folder, under the same name unless one is given. */
  copy(direction: unknown, botId: unknown, path: unknown, as?: unknown): Promise<BotResult<{ path: string }>>;
}

const text = (value: unknown, what: string): string => {
  if (typeof value !== "string") throw new BotError("invalid", `${what} must be text.`);
  return value;
};

function scopeOf(value: unknown): FileScope {
  if (value === "bot" || value === "library") return value;
  throw new BotError("invalid", "Choose the Bot's files or the library.");
}

/** Whether `content` is something a person can read as text, and a Bot too. */
export function isPlainText(content: string): boolean {
  return !content.includes("\u0000") && !content.includes("\uFFFD");
}

function requireText(content: string, path: string): string {
  if (!isPlainText(content)) throw new BotError("invalid", `"${path}" is not a text file. Only text files can be used here.`);
  return content;
}

/** Whether something is already at `path`: a file, or a folder. Only "not there" is an answer; anything else is thrown. */
async function exists(runtime: BotRuntime, path: string): Promise<boolean> {
  try {
    await runtime.readFile(path);
    return true;
  } catch (error) {
    if (error instanceof BotError && error.code === "not_found") return false;
    // Something is there, only not something that can be read as text: a folder, a picture, a file too big to open.
    if (error instanceof BotError && (error.code === "invalid" || error.code === "limit")) return true;
    throw error;
  }
}

export function createFilesHandlers(deps: FilesHandlerDeps): FilesHandlers {
  const { store } = deps;

  const runtimeFor = (scope: FileScope, botId: unknown): BotRuntime => {
    if (scope === "library") return deps.library;
    const id = text(botId, "The Bot id");
    const bot = store.get(id);
    if (!bot) throw new BotError("not_found", "That Bot no longer exists.");
    return deps.runtimeOf(bot);
  };
  const owner = (scope: FileScope, botId: unknown): string | null => (scope === "bot" ? (botId as string) : null);

  return {
    list: (scope, botId, path) =>
      botResultAsync(async () => {
        const where = scopeOf(scope);
        const runtime = runtimeFor(where, botId);
        const entries = await runtime.listFiles(cleanRelativePath(typeof path === "string" ? path : "", { allowRoot: true }));
        return [...entries].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
      }),

    read: (scope, botId, path) =>
      botResultAsync(async () => {
        const where = scopeOf(scope);
        const clean = cleanRelativePath(text(path, "The file path"));
        const content = requireText(await runtimeFor(where, botId).readFile(clean), clean);
        return { path: clean, content, size: Buffer.byteLength(content, "utf8") };
      }),

    write: (scope, botId, path, content) =>
      botResultAsync(async () => {
        const where = scopeOf(scope);
        const clean = cleanRelativePath(text(path, "The file path"));
        const body = requireText(text(content, "A file's content"), clean);
        await runtimeFor(where, botId).writeFile(clean, body);
        deps.changed?.(where, owner(where, botId));
        return null;
      }),

    remove: (scope, botId, path) =>
      botResultAsync(async () => {
        const where = scopeOf(scope);
        const clean = cleanRelativePath(text(path, "The file path"));
        await runtimeFor(where, botId).removeFile(clean, { recursive: true });
        deps.changed?.(where, owner(where, botId));
        return null;
      }),

    copy: (direction, botId, path, as) =>
      botResultAsync(async () => {
        if (direction !== "to-bot" && direction !== "to-library") throw new BotError("invalid", "Choose whether to copy into the Bot or into the library.");
        const from = direction === "to-bot" ? deps.library : runtimeFor("bot", botId);
        const into = direction === "to-bot" ? runtimeFor("bot", botId) : deps.library;
        const source = cleanRelativePath(text(path, "The file path"));
        const target = as === undefined || as === "" ? source : cleanRelativePath(text(as, "The new name"));
        const content = requireText(await from.readFile(source), source);
        if (Buffer.byteLength(content, "utf8") > RUNTIME_LIMITS.fileBytes) throw new BotError("limit", "That file is too big to copy.");
        // A copy never replaces something that is already there: a person says so by choosing another name or removing it first.
        if (await exists(into, target)) throw new BotError("conflict", `There is already a file called "${target}". Give the copy another name.`);
        await into.writeFile(target, content);
        deps.changed?.(direction === "to-bot" ? "bot" : "library", direction === "to-bot" ? (botId as string) : null);
        return { path: target };
      }),
  };
}
