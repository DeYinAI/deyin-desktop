/**
 * Best-effort screen of a worker's shell command against the commands an installation blocks. It reads the command word of every
 * simple command (through pipes, lists, subshells, `$(…)`, wrappers such as `sudo` or `env`, and `sh -c` strings); it is a
 * guard against honest mistakes and prompt injection, not a sandbox.
 */

const WRAPPERS = new Set(["sudo", "doas", "env", "command", "exec", "nohup", "time", "nice", "ionice", "builtin", "xargs", "stdbuf", "timeout", "setsid", "then", "do", "else", "elif", "if", "while", "until", "!"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_DEPTH = 6;

/** Splits a command line into simple commands, each a list of its words with quotes removed. */
function simpleCommands(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | undefined;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }
    // A backslash escapes a shell metacharacter; before anything else it is a path separator, as in a Windows path.
    if (char === "\\" && " \t'\"\\$;&|()<>`\n".includes(line[index + 1] ?? "x")) {
      word += line[index + 1] ?? "";
      inWord = true;
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "`") {
        // Command substitution inside double quotes still runs; its text is screened as a command of its own.
        const close = line.indexOf("`", index + 1);
        const inner = close < 0 ? line.slice(index + 1) : line.slice(index + 1, close);
        commands.push(...simpleCommands(inner));
        word += char;
      } else if (char === "$" && line[index + 1] === "(") {
        const inner = balanced(line, index + 1);
        commands.push(...simpleCommands(inner));
        word += char;
      } else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
      continue;
    }
    if (char === " " || char === "\t") endWord();
    else if (";&|\n()`".includes(char)) endCommand();
    else {
      word += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/** The text inside the parenthesis that opens at `open`, up to its match. */
function balanced(line: string, open: number): string {
  let depth = 0;
  for (let index = open; index < line.length; index += 1) {
    if (line[index] === "(") depth += 1;
    else if (line[index] === ")") {
      depth -= 1;
      if (depth === 0) return line.slice(open + 1, index);
    }
  }
  return line.slice(open + 1);
}

const nameOf = (word: string): string => (word.split(/[\\/]/).at(-1) ?? word).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();

function screen(line: string, blocked: ReadonlySet<string>, depth: number): string | undefined {
  if (depth > MAX_DEPTH) return undefined;
  for (const words of simpleCommands(line)) {
    let at = 0;
    while (at < words.length) {
      const word = words[at]!;
      if (ASSIGNMENT.test(word)) at += 1;
      else if (WRAPPERS.has(nameOf(word))) {
        at += 1;
        // A wrapper's own options and assignments, and timeout's duration, come before the command it runs.
        while (at < words.length && (words[at]!.startsWith("-") || ASSIGNMENT.test(words[at]!) || (nameOf(word) === "timeout" && /^\d/.test(words[at]!)))) at += 1;
      } else break;
    }
    const command = words[at];
    if (command === undefined) continue;
    const name = nameOf(command);
    if (blocked.has(name)) return name;
    if (SHELLS.has(name) || name === "eval") {
      const rest = words.slice(at + 1);
      const script = name === "eval" ? rest.join(" ") : rest[rest.findIndex((item) => /^-[A-Za-z]*c[A-Za-z]*$/.test(item)) + 1];
      const found = script !== undefined && (name === "eval" || rest.some((item) => /^-[A-Za-z]*c[A-Za-z]*$/.test(item))) ? screen(script, blocked, depth + 1) : undefined;
      if (found) return found;
    }
  }
  return undefined;
}

/** The first blocked command `line` would run, or `undefined` when it runs none. */
export function blockedCommand(line: string, blocked: readonly string[]): string | undefined {
  if (blocked.length === 0) return undefined;
  return screen(line, new Set(blocked.map((name) => name.toLowerCase())), 0);
}
