import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { EngineExecLine } from "./engine-protocol.js";
import { RUNTIME_LIMITS, cleanRelativePath, execTimeout, type RuntimeExecRequest, type RuntimeFileEntry } from "./runtime.js";
import { BotError } from "./types.js";

/**
 * The parts of a Bot's computer that are the same wherever it is: a folder of files the Bot may touch and a shell it
 * may run commands in. The desktop's local runtime and the engine on a server both run on these, so there is one
 * place where "stay inside the Bot's folder" is enforced and one place to test it.
 *
 * Every path arrives already cleaned by `cleanRelativePath`; what is checked here is the real disk, where a symbolic
 * link inside the folder can point outside it.
 */

function inside(realRoot: string, candidate: string): boolean {
  return candidate === realRoot || candidate.startsWith(realRoot + sep);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

/** The Bot's folder, made if it is not there yet, as the real path every other check compares against. */
export async function ensureBotRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  return realpath(root);
}

/**
 * The real path of `rel` under `root`, refusing any route that ends outside the folder. A file that does not exist
 * yet is judged by the nearest folder that does, and a link that points nowhere is refused, because writing through
 * it would land wherever it points.
 */
export async function resolveInsideRoot(root: string, rel: string): Promise<string> {
  const realRoot = await ensureBotRoot(root);
  const target = rel === "" ? realRoot : join(realRoot, ...rel.split("/"));
  let probe = target;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (!inside(realRoot, real)) throw new BotError("invalid", "That path leads outside the Bot's folder.");
      return join(real, relative(probe, target));
    } catch (error) {
      if (error instanceof BotError) throw error;
      if (!isMissing(error)) throw error;
      let isLink = false;
      try {
        isLink = (await lstat(probe)).isSymbolicLink();
      } catch (inner) {
        if (!isMissing(inner)) throw inner;
      }
      if (isLink) throw new BotError("invalid", "That path goes through a link that points nowhere.");
      const parent = dirname(probe);
      if (parent === probe) throw new BotError("invalid", "That path leads outside the Bot's folder.");
      probe = parent;
    }
  }
}

function notFound(rel: string): BotError {
  return new BotError("not_found", `There is no ${rel === "" ? "folder" : `"${rel}"`} in the Bot's folder.`);
}

/** The entries of a folder, folders first, then by name. A link that leads outside the folder is left out of the list. */
export async function listBotFiles(root: string, rel: string): Promise<RuntimeFileEntry[]> {
  const clean = cleanRelativePath(rel, { allowRoot: true });
  const realRoot = await ensureBotRoot(root);
  const dir = await resolveInsideRoot(root, clean);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isMissing(error)) throw notFound(clean);
    if ((error as { code?: string }).code === "ENOTDIR") throw new BotError("invalid", `"${clean}" is a file, not a folder.`);
    throw error;
  }
  const entries: RuntimeFileEntry[] = [];
  for (const name of names.sort()) {
    if (entries.length >= RUNTIME_LIMITS.listEntries) break;
    try {
      const full = join(dir, name);
      const real = await realpath(full);
      if (!inside(realRoot, real)) continue;
      const info = await stat(real);
      if (!info.isFile() && !info.isDirectory()) continue;
      entries.push({
        name,
        path: clean === "" ? name : `${clean}/${name}`,
        kind: info.isDirectory() ? "directory" : "file",
        size: info.isDirectory() ? 0 : info.size,
        modifiedAt: Math.round(info.mtimeMs),
      });
    } catch (error) {
      // Gone between the listing and the look, or a link to nowhere: not there to show.
      if (!isMissing(error)) throw error;
    }
  }
  return entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "directory" ? -1 : 1));
}

export async function readBotFile(root: string, rel: string): Promise<string> {
  const clean = cleanRelativePath(rel);
  const file = await resolveInsideRoot(root, clean);
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if (isMissing(error)) throw notFound(clean);
    throw error;
  }
  if (!info.isFile()) throw new BotError("invalid", `"${clean}" is a folder, not a file.`);
  if (info.size > RUNTIME_LIMITS.fileBytes) {
    throw new BotError("limit", `"${clean}" is larger than the ${Math.round(RUNTIME_LIMITS.fileBytes / 1024 / 1024)} MB a Bot file may be.`);
  }
  const bytes = await readFile(file);
  if (bytes.includes(0)) throw new BotError("invalid", `"${clean}" is not a text file.`);
  return bytes.toString("utf8");
}

/** Write a text file whole, by writing next to it and moving it into place, so a reader never sees half of one. */
export async function writeBotFile(root: string, rel: string, content: string): Promise<void> {
  const clean = cleanRelativePath(rel);
  if (typeof content !== "string") throw new BotError("invalid", "A file's content must be text.");
  if (Buffer.byteLength(content, "utf8") > RUNTIME_LIMITS.fileBytes) {
    throw new BotError("limit", `A Bot file may be at most ${Math.round(RUNTIME_LIMITS.fileBytes / 1024 / 1024)} MB.`);
  }
  const file = await resolveInsideRoot(root, clean);
  const realRoot = await ensureBotRoot(root);
  if (file === realRoot) throw new BotError("invalid", "Name a file.");
  try {
    if ((await stat(file)).isDirectory()) throw new BotError("conflict", `"${clean}" is a folder.`);
  } catch (error) {
    if (error instanceof BotError) throw error;
    if (!isMissing(error)) throw error;
  }
  const parent = dirname(file);
  await mkdir(parent, { recursive: true });
  // The folders just made may have crossed a link made in the meantime; check the parent once more.
  const realParent = await realpath(parent);
  if (!inside(realRoot, realParent)) throw new BotError("invalid", "That path leads outside the Bot's folder.");
  const temp = join(realParent, `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function removeBotFile(root: string, rel: string, options: { recursive?: boolean } = {}): Promise<void> {
  const clean = cleanRelativePath(rel);
  const realRoot = await ensureBotRoot(root);
  // A link is removed itself, never what it points at: judge the link's own place, not where it leads.
  const parent = await resolveInsideRoot(root, clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "");
  const name = clean.slice(clean.lastIndexOf("/") + 1);
  const target = join(parent, name);
  if (!inside(realRoot, target) || target === realRoot) throw new BotError("invalid", "That path leads outside the Bot's folder.");
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (isMissing(error)) throw notFound(clean);
    throw error;
  }
  if (info.isDirectory() && options.recursive !== true) {
    const children = await readdir(target);
    if (children.length > 0) throw new BotError("conflict", `"${clean}" is a folder with things in it. Remove it with everything inside to go ahead.`);
  }
  await rm(target, { recursive: info.isDirectory(), force: false });
}

/* Commands -------------------------------------------------------------------- */

export interface StreamCommandOptions {
  /** Kill the process and stop reading. */
  signal?: AbortSignal;
  /** The shell to use; the system's by default. Tests pass their own. */
  spawnImpl?: typeof spawn;
  env?: NodeJS.ProcessEnv;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    // A negative pid is the process group, so a command's own children go down with it.
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/**
 * Run `request.command` in a shell, in the Bot's folder (or a folder inside it), and say each piece of output as it
 * comes. Resolves after the `exit` line has been said. The command is killed at its timeout and when `signal` aborts.
 */
export async function streamBotCommand(
  root: string,
  request: RuntimeExecRequest,
  emit: (line: EngineExecLine) => void,
  options: StreamCommandOptions = {},
): Promise<void> {
  const cwdRel = request.cwd ? cleanRelativePath(request.cwd, { allowRoot: true }) : "";
  const cwd = await resolveInsideRoot(root, cwdRel);
  try {
    if (!(await stat(cwd)).isDirectory()) throw new BotError("invalid", `"${cwdRel}" is a file, not a folder.`);
  } catch (error) {
    if (error instanceof BotError) throw error;
    if (isMissing(error)) throw notFound(cwdRel);
    throw error;
  }
  if (options.signal?.aborted) {
    emit({ type: "exit", code: null, timedOut: false });
    return;
  }
  const timeoutMs = execTimeout(request);
  await new Promise<void>((resolve) => {
    const child = (options.spawnImpl ?? spawn)(request.command, {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      windowsHide: true,
    });
    let timedOut = false;
    let finished = false;
    const finish = (code: number | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      emit({ type: "exit", code, timedOut });
      resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onAbort = (): void => killTree(child);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => emit({ type: "stdout", data }));
    child.stderr?.on("data", (data: string) => emit({ type: "stderr", data }));
    child.on("error", (error) => {
      emit({ type: "stderr", data: `Could not start the command: ${error.message}\n` });
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
