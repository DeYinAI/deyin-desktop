import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Open the user's preferred editor ($VISUAL or $EDITOR) on a temporary file
 * to compose or edit multiline prompts. Restores TTY raw mode on return.
 */
export function openInEditor(initialText = ""): string | null {
  const editor =
    process.env.VISUAL ||
    process.env.EDITOR ||
    (process.platform === "win32" ? "notepad" : "nano");

  const tmpFile = join(
    tmpdir(),
    `deyin-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`,
  );

  const isTTY = Boolean(process.stdin.isTTY);
  const wasRaw = Boolean(
    isTTY && (process.stdin as unknown as { isRaw?: boolean }).isRaw,
  );

  try {
    writeFileSync(tmpFile, initialText, "utf8");

    if (isTTY) {
      if (process.stdin.setRawMode) process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    try {
      let bin = editor;
      let extraArgs: string[] = [];
      if (existsSync(editor)) {
        bin = editor;
      } else {
        const parts = editor.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [editor];
        bin = parts[0]?.replace(/^['"]|['"]$/g, "") ?? editor;
        extraArgs = parts.slice(1).map((a) => a.replace(/^['"]|['"]$/g, ""));
      }

      const res = spawnSync(bin, [...extraArgs, tmpFile], {
        stdio: isTTY ? "inherit" : ["ignore", "inherit", "inherit"],
      });
      if (res.error) return null;

      if (!existsSync(tmpFile)) return null;
      return readFileSync(tmpFile, "utf8");
    } finally {
      if (isTTY) {
        process.stdin.resume();
        if (wasRaw && process.stdin.setRawMode) {
          process.stdin.setRawMode(true);
        }
      }
    }
  } finally {
    try {
      rmSync(tmpFile, { force: true });
    } catch {
      // Ignore temp file cleanup failures
    }
  }
}
