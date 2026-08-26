import { dirname, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

/**
 * Resolve `path` relative to `root` (or as absolute) and ensure it sits inside `root`.
 * Rejects `../` escapes, sibling-prefix tricks (`/tmp/foo` vs `/tmp/foobar`), and
 * symlink redirection: a symlink inside root that points outside is followed to its
 * real target before the prefix check, so `files.read("escape/passwd")` cannot read
 * `/etc/passwd` via a symlink planted in the workspace.
 *
 * Symlink resolution follows the deepest existing ancestor of each path (the file
 * itself may not exist yet for files.write). For paths with no existing ancestor
 * below root, we fall back to the plain string-resolved form — which already handles
 * `..` collapses and sibling-prefix cases — because there is no on-disk redirect to
 * follow.
 */
export function assertInsideRoot(root: string, path: string): string {
  const r = resolve(root);
  const abs = resolve(r, path);

  const realRoot = resolveReal(r);
  const realAbs = resolveReal(abs);

  const escapes =
    realAbs !== realRoot && !realAbs.startsWith(realRoot + sep) && !realAbs.startsWith(realRoot + "\\");
  if (escapes) {
    throw new Error("Path escapes workspace root");
  }
  return abs;
}

/**
 * Resolve `p` through symlinks. If `p` exists, `realpathSync` it directly. Otherwise
 * walk up one level at a time; at the first existing ancestor, resolve it and
 * re-append the non-existent tail. If nothing along the chain exists, return the
 * original string-resolved `p` so string-based prefix checks still apply.
 */
function resolveReal(p: string): string {
  let cur = p;
  const tail: string[] = [];
  while (true) {
    try {
      const realAncestor = realpathSync(cur);
      return tail.length === 0 ? realAncestor : resolve(realAncestor, ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p; // reached filesystem root without a real path
      tail.push(cur.slice(parent.length + 1));
      cur = parent;
    }
  }
}
