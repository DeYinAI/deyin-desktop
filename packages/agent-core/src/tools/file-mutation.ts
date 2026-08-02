import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FileChange, ToolContext } from "../types.js";
import { resolvePathInWorkspace } from "./util.js";

export type FileMutationOp = "write" | "edit" | "delete";

export interface FileMutationRequest extends FileChange {
  operation: FileMutationOp;
}

/**
 * Apply a workspace file mutation, optionally routing through review queue
 * when ctx.applyFileChange is set (desktop review mode).
 */
export async function commitFileMutation(
  request: FileMutationRequest,
  ctx: ToolContext,
): Promise<"applied" | "rejected"> {
  const safe = { ...request, path: resolvePathInWorkspace(ctx.cwd, request.path) };
  if (ctx.applyFileChange) {
    return ctx.applyFileChange(safe);
  }
  await applyFileMutationDirect(safe);
  ctx.onFileChanged?.({ path: safe.path, before: safe.before, after: safe.after });
  return "applied";
}

export async function applyFileMutationDirect(request: FileMutationRequest): Promise<void> {
  const { path, after, operation } = request;
  if (operation === "delete") {
    await unlink(path);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, after, "utf8");
}

/** Read file content for write/edit preview; empty string when missing. */
export async function readFileForMutation(path: string): Promise<string> {
  return readFile(path, "utf8").catch(() => "");
}
