/**
 * Minimal glob-to-RegExp compiler supporting `**`, `*`, `?`, `[...]` and `{a,b}`.
 * Enough for agent file matching without pulling in a dependency.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more path segments; bare `**` matches anything.
        if (glob[i + 2] === "/") {
          re += "(?:[^/]*/)*";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) {
        re += "\\[";
        i += 1;
      } else {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
        re += `[${cls}]`;
        i = end + 1;
      }
    } else if (c === "{") {
      const end = glob.indexOf("}", i + 1);
      if (end === -1) {
        re += "\\{";
        i += 1;
      } else {
        const options = glob
          .slice(i + 1, end)
          .split(",")
          .map((o) => o.replace(/[.+^${}()|[\]\\?*]/g, (m) => `\\${m}`));
        re += `(?:${options.join("|")})`;
        i = end + 1;
      }
    } else if ("\\.+^$()|".includes(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Match a relative path against a glob; bare-name patterns match at any depth. */
export function matchGlob(relPath: string, glob: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  const pattern = glob.includes("/") ? glob : `**/${glob}`;
  return globToRegExp(pattern).test(normalized);
}
