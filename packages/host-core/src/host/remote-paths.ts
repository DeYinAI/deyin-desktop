import { posix } from "node:path";

/** Normalize a remote POSIX path (collapse `.`, `..`, duplicate slashes). */
export function normalizeRemotePath(p: string): string {
  const parts = p.split("/").filter((seg) => seg && seg !== ".");
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return p.startsWith("/") ? `/${out.join("/")}` : out.join("/") || ".";
}

/** Resolve `path` relative to `root` and ensure it stays inside `root`. */
export function assertInsideRemoteRoot(root: string, path: string): string {
  const r = normalizeRemotePath(root);
  const abs = normalizeRemotePath(path.startsWith("/") ? path : posix.join(r, path));
  const escapes = abs !== r && !abs.startsWith(`${r}/`);
  if (escapes) throw new Error("Path escapes workspace root");
  return abs;
}

/** Shell-escape a path for remote exec. */
export function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}
