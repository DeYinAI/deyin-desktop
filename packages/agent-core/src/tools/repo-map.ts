import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { ToolDefinition } from "../types.js";
import { asOptionalNumber, asOptionalString, IGNORED_DIRS, resolvePath, truncate } from "./util.js";

const DEFAULT_MAX_FILES = 50;
const MAX_FILE_SCAN = 200;
const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512 KB
const MAX_DEPTH = 10;
const MAX_LINE_CHARS = 2048;

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyw",
  ".go",
  ".rs",
  ".java", ".kt", ".scala",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".dart",
  ".zig",
]);

export interface SymbolEntry {
  name: string;
  kind: "class" | "interface" | "type" | "enum" | "function" | "method" | "struct" | "trait";
  line: number;
  signature: string;
  parent?: string;
}

export interface FileSymbols {
  relPath: string;
  symbols: SymbolEntry[];
}

/**
 * Extract declarations and symbol signatures from file source lines.
 */
export function extractSymbolsFromSource(content: string, filename: string): SymbolEntry[] {
  if (content.includes("\0")) return [];

  const ext = extname(filename).toLowerCase();
  const lines = content.split("\n");
  const symbols: SymbolEntry[] = [];

  let currentParent: string | undefined;
  let parentBraceDepth = 0;
  let braceDepth = 0;
  let rubyNesting = 0;
  let rubyParentDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine === undefined || rawLine.length > MAX_LINE_CHARS) continue;

    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      continue;
    }

    const lineNum = i + 1;

    // Track block depth for brace-delimited languages
    if (![".py", ".pyw", ".rb"].includes(ext)) {
      const opens = (rawLine.match(/\{/g) || []).length;
      const closes = (rawLine.match(/\}/g) || []).length;
      braceDepth += opens - closes;
      if (currentParent && braceDepth <= parentBraceDepth) {
        currentParent = undefined;
      }
    } else if (ext === ".py" || ext === ".pyw") {
      // In python, unindenting clears parent class
      if (currentParent && !rawLine.startsWith(" ") && !rawLine.startsWith("\t")) {
        currentParent = undefined;
      }
    }

    // TypeScript / JavaScript
    if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
      const classMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/);
      if (classMatch && classMatch[1]) {
        const name = classMatch[1];
        symbols.push({ name, kind: "class", line: lineNum, signature: trimmed.replace(/\{.*$/, "").trim() });
        currentParent = name;
        parentBraceDepth = braceDepth - 1;
        continue;
      }

      const ifaceMatch = trimmed.match(/^(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/);
      if (ifaceMatch && ifaceMatch[1]) {
        symbols.push({ name: ifaceMatch[1], kind: "interface", line: lineNum, signature: trimmed.replace(/\{.*$/, "").trim() });
        continue;
      }

      const typeMatch = trimmed.match(/^(?:export\s+)?type\s+([A-Za-z0-9_$]+)/);
      if (typeMatch && typeMatch[1]) {
        symbols.push({ name: typeMatch[1], kind: "type", line: lineNum, signature: trimmed.slice(0, 100).trim() });
        continue;
      }

      const enumMatch = trimmed.match(/^(?:export\s+)?enum\s+([A-Za-z0-9_$]+)/);
      if (enumMatch && enumMatch[1]) {
        symbols.push({ name: enumMatch[1], kind: "enum", line: lineNum, signature: trimmed.replace(/\{.*$/, "").trim() });
        continue;
      }

      const funcMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/);
      if (funcMatch && funcMatch[1]) {
        symbols.push({ name: funcMatch[1], kind: "function", line: lineNum, signature: trimmed.replace(/\{.*$/, "").trim() });
        continue;
      }

      const constFuncMatch = trimmed.match(/^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::\s*[^=]+)?=>/);
      if (constFuncMatch && constFuncMatch[1]) {
        symbols.push({ name: constFuncMatch[1], kind: "function", line: lineNum, signature: trimmed.slice(0, 100).trim() });
        continue;
      }

      if (currentParent) {
        const methodMatch = trimmed.match(/^(?:(?:public|private|protected|static|async|override|readonly)\s+)*([A-Za-z0-9_$]+)\s*\(([^)]*)\)(?:\s*:\s*[^{;]+)?/);
        if (
          methodMatch &&
          methodMatch[1] &&
          !["if", "for", "while", "switch", "catch", "constructor", "super"].includes(methodMatch[1])
        ) {
          symbols.push({ name: methodMatch[1], kind: "method", line: lineNum, signature: trimmed.replace(/\{.*$/, "").trim(), parent: currentParent });
          continue;
        }
      }
    }

    // Python
    if (ext === ".py" || ext === ".pyw") {
      const pyClass = trimmed.match(/^class\s+([A-Za-z0-9_]+)(?:\([^)]*\))?:/);
      if (pyClass && pyClass[1]) {
        const name = pyClass[1];
        symbols.push({ name, kind: "class", line: lineNum, signature: trimmed });
        currentParent = name;
        continue;
      }

      const pyFunc = rawLine.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)(?:\s*->\s*[^:]+)?:/);
      if (pyFunc && pyFunc[1] !== undefined && pyFunc[2]) {
        const isMethod = pyFunc[1].length > 0 && Boolean(currentParent);
        symbols.push({
          name: pyFunc[2],
          kind: isMethod ? "method" : "function",
          line: lineNum,
          signature: trimmed,
          parent: isMethod ? currentParent : undefined,
        });
        continue;
      }
    }

    // Go
    if (ext === ".go") {
      const goType = trimmed.match(/^type\s+([A-Za-z0-9_]+)\s+(struct|interface)/);
      if (goType && goType[1]) {
        symbols.push({ name: goType[1], kind: goType[2] === "struct" ? "struct" : "interface", line: lineNum, signature: trimmed });
        continue;
      }

      const goMethod = trimmed.match(/^func\s+\((?:[^)]+)\)\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/);
      if (goMethod && goMethod[1]) {
        symbols.push({ name: goMethod[1], kind: "method", line: lineNum, signature: trimmed.replace(/\{.*$/, "").trim() });
        continue;
      }

      const goFunc = trimmed.match(/^func\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/);
      if (goFunc && goFunc[1]) {
        symbols.push({ name: goFunc[1], kind: "function", line: lineNum, signature: trimmed.replace(/\{.*$/, "").trim() });
        continue;
      }
    }

    // Rust
    if (ext === ".rs") {
      const rsStruct = trimmed.match(/^(?:pub\s+)?struct\s+([A-Za-z0-9_]+)/);
      if (rsStruct && rsStruct[1]) {
        symbols.push({ name: rsStruct[1], kind: "struct", line: lineNum, signature: trimmed.replace(/\{.*$/, "").trim() });
        continue;
      }

      const rsTrait = trimmed.match(/^(?:pub\s+)?trait\s+([A-Za-z0-9_]+)/);
      if (rsTrait && rsTrait[1]) {
        symbols.push({ name: rsTrait[1], kind: "trait", line: lineNum, signature: trimmed.replace(/\{.*$/, "").trim() });
        continue;
      }

      const rsEnum = trimmed.match(/^(?:pub\s+)?enum\s+([A-Za-z0-9_]+)/);
      if (rsEnum && rsEnum[1]) {
        symbols.push({ name: rsEnum[1], kind: "enum", line: lineNum, signature: trimmed.replace(/\{.*$/, "").trim() });
        continue;
      }

      const rsImpl = trimmed.match(/^impl(?:\s*<[^>]+>)?(?:\s+[A-Za-z0-9_:]+\s+for)?\s+(?:dyn\s+)?([A-Za-z0-9_]+)/);
      if (rsImpl && rsImpl[1]) {
        currentParent = rsImpl[1];
        parentBraceDepth = braceDepth - 1;
        continue;
      }

      const rsFn = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/);
      if (rsFn && rsFn[1]) {
        symbols.push({
          name: rsFn[1],
          kind: currentParent ? "method" : "function",
          line: lineNum,
          signature: trimmed.replace(/\{.*$/, "").trim(),
          parent: currentParent,
        });
        continue;
      }
    }

    // Java / Kotlin / Scala
    if ([".java", ".kt", ".scala"].includes(ext)) {
      const typeDecl = trimmed.match(
        /^(?:(?:public|protected|private|internal|abstract|final|sealed|open|data|static)\s+)*(class|interface|enum|record|object|trait)\s+([A-Za-z0-9_$]+)/,
      );
      if (typeDecl && typeDecl[1] && typeDecl[2]) {
        const rawKind = typeDecl[1];
        const kind: SymbolEntry["kind"] = rawKind === "interface" ? "interface" : rawKind === "enum" ? "enum" : rawKind === "trait" ? "trait" : "class";
        symbols.push({ name: typeDecl[2], kind, line: lineNum, signature: trimmed.replace(/\{.*$/, "").trim() });
        currentParent = typeDecl[2];
        parentBraceDepth = braceDepth - 1;
        continue;
      }

      // Kotlin fun
      const ktFun = trimmed.match(/^(?:(?:public|protected|private|internal|override|suspend|inline)\s+)*fun\s+(?:<[^>]+>\s+)?(?:[A-Za-z0-9_]+\.)?([A-Za-z0-9_]+)\s*\(([^)]*)\)/);
      if (ktFun && ktFun[1]) {
        symbols.push({
          name: ktFun[1],
          kind: currentParent ? "method" : "function",
          line: lineNum,
          signature: trimmed.replace(/\{.*$/, "").trim(),
          parent: currentParent,
        });
        continue;
      }

      // Java method
      if (currentParent) {
        const javaMethod = trimmed.match(/^(?:(?:public|protected|private|static|final|abstract|synchronized|native|default)\s+)+[A-Za-z0-9_$<>, ?\[\]]+\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/);
        if (javaMethod && javaMethod[1] && !["if", "for", "while", "switch", "catch"].includes(javaMethod[1])) {
          symbols.push({
            name: javaMethod[1],
            kind: "method",
            line: lineNum,
            signature: trimmed.replace(/\{.*$/, "").trim(),
            parent: currentParent,
          });
          continue;
        }
      }
    }

    // C / C++
    if ([".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"].includes(ext)) {
      const typeDecl = trimmed.match(/^(?:typedef\s+)?(struct|class|enum(?:\s+class)?)\s+([A-Za-z0-9_]+)/);
      if (typeDecl && typeDecl[1] && typeDecl[2]) {
        const rawKind = typeDecl[1];
        const kind: SymbolEntry["kind"] = rawKind.startsWith("enum") ? "enum" : rawKind === "struct" ? "struct" : "class";
        symbols.push({ name: typeDecl[2], kind, line: lineNum, signature: trimmed.replace(/\{.*$/, "").trim() });
        currentParent = typeDecl[2];
        parentBraceDepth = braceDepth - 1;
        continue;
      }

      const cppFunc = trimmed.match(/^(?:(?:inline|static|virtual|explicit|constexpr|extern\s+"C")\s+)*[A-Za-z0-9_:*&<>]+\s+(?:[A-Za-z0-9_]+::)?([A-Za-z0-9_]+)\s*\(([^)]*)\)/);
      if (cppFunc && cppFunc[1] && !["if", "for", "while", "switch", "catch", "return", "sizeof"].includes(cppFunc[1])) {
        symbols.push({
          name: cppFunc[1],
          kind: currentParent || trimmed.includes("::") ? "method" : "function",
          line: lineNum,
          signature: trimmed.replace(/\{.*$/, "").trim(),
          parent: currentParent,
        });
        continue;
      }
    }

    // C#
    if (ext === ".cs") {
      const csType = trimmed.match(/^(?:(?:public|protected|private|internal|static|abstract|sealed|partial|readonly)\s+)*(class|interface|struct|record|enum)\s+([A-Za-z0-9_]+)/);
      if (csType && csType[1] && csType[2]) {
        const rawKind = csType[1];
        const kind: SymbolEntry["kind"] = rawKind === "interface" ? "interface" : rawKind === "struct" ? "struct" : rawKind === "enum" ? "enum" : "class";
        symbols.push({ name: csType[2], kind, line: lineNum, signature: trimmed.replace(/\{.*$/, "").trim() });
        currentParent = csType[2];
        parentBraceDepth = braceDepth - 1;
        continue;
      }

      if (currentParent) {
        const csMethod = trimmed.match(/^(?:(?:public|protected|private|internal|static|async|virtual|override|abstract|sealed)\s+)+[A-Za-z0-9_?<>\[\],\s]+\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/);
        if (csMethod && csMethod[1] && !["if", "for", "while", "switch", "catch"].includes(csMethod[1])) {
          symbols.push({
            name: csMethod[1],
            kind: "method",
            line: lineNum,
            signature: trimmed.replace(/\{.*$/, "").trim(),
            parent: currentParent,
          });
          continue;
        }
      }
    }

    // Ruby
    if (ext === ".rb") {
      const rbModuleClass = trimmed.match(/^(class|module)\s+([A-Za-z0-9_:]+)/);
      if (rbModuleClass && rbModuleClass[1] && rbModuleClass[2]) {
        rubyNesting++;
        symbols.push({ name: rbModuleClass[2], kind: "class", line: lineNum, signature: trimmed });
        currentParent = rbModuleClass[2];
        rubyParentDepth = rubyNesting;
        continue;
      }

      const rbDef = rawLine.match(/^(\s*)def\s+(?:self\.)?([A-Za-z0-9_!?=]+)(?:\(([^)]*)\))?/);
      if (rbDef && rbDef[2]) {
        rubyNesting++;
        const isMethod = Boolean(currentParent);
        symbols.push({
          name: rbDef[2],
          kind: isMethod ? "method" : "function",
          line: lineNum,
          signature: trimmed,
          parent: isMethod ? currentParent : undefined,
        });
        continue;
      }

      if (/^(?:if|unless|while|until|for|case)\b/.test(trimmed) || /\bdo(?:\s*\|[^|]*\|)?$/.test(trimmed)) {
        rubyNesting++;
      }

      if (trimmed === "end") {
        rubyNesting = Math.max(0, rubyNesting - 1);
        if (rubyNesting < rubyParentDepth) {
          currentParent = undefined;
          rubyParentDepth = 0;
        }
      }
    }

    // PHP
    if (ext === ".php") {
      const phpType = trimmed.match(/^(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z0-9_]+)/);
      if (phpType && phpType[1] && phpType[2]) {
        const rawKind = phpType[1];
        const kind: SymbolEntry["kind"] = rawKind === "interface" ? "interface" : rawKind === "trait" ? "trait" : rawKind === "enum" ? "enum" : "class";
        symbols.push({ name: phpType[2], kind, line: lineNum, signature: trimmed.replace(/\{.*$/, "").trim() });
        currentParent = phpType[2];
        parentBraceDepth = braceDepth - 1;
        continue;
      }

      const phpFunc = trimmed.match(/^(?:(?:public|protected|private|static|abstract|final)\s+)*function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/);
      if (phpFunc && phpFunc[1]) {
        symbols.push({
          name: phpFunc[1],
          kind: currentParent ? "method" : "function",
          line: lineNum,
          signature: trimmed.replace(/\{.*$/, "").trim(),
          parent: currentParent,
        });
        continue;
      }
    }
  }

  return symbols;
}

export function formatRepoMap(files: FileSymbols[], detail: "outline" | "signatures" = "outline"): string {
  if (files.length === 0) return "No matching symbols found.";

  const out: string[] = [];
  for (const f of files) {
    if (f.symbols.length === 0) continue;
    out.push(`${f.relPath}:`);

    for (const sym of f.symbols) {
      if (detail === "signatures") {
        const indent = sym.parent ? "    " : "  ";
        out.push(`${indent}[${sym.kind}] ${sym.signature.slice(0, 120)} (line ${sym.line})`);
      } else {
        if (sym.kind === "method" && sym.parent) {
          out.push(`    .${sym.name}()`);
        } else {
          out.push(`  ${sym.kind} ${sym.name}`);
        }
      }
    }
  }

  if (out.length === 0) return "No matching symbols found.";
  return out.join("\n");
}

/**
 * Structural symbol map tool for the repository.
 * Extracts symbols (classes, functions, interfaces, methods, types) across code files.
 */
export const repoMapTool: ToolDefinition = {
  name: "repo_map",
  description:
    "Generates an outline or symbol map of the codebase (or a subdirectory), extracting classes, functions, interfaces, methods, and types. Use to understand repository architecture and discover definitions without reading full files.",
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory or file to map (defaults to workspace root)." },
      query: { type: "string", description: "Optional symbol name or keyword filter (case-insensitive)." },
      detail: {
        type: "string",
        enum: ["outline", "signatures"],
        description: 'Detail level: "outline" (compact symbol names, default) or "signatures" (line numbers and signatures).',
      },
      max_files: { type: "number", description: `Maximum files with symbols to include (default ${DEFAULT_MAX_FILES}, max ${MAX_FILE_SCAN}).` },
    },
  },
  summarize: (args) => (args.query ? `query="${args.query}"` : String(args.path ?? ".")),
  async execute(args, ctx): Promise<string> {
    const root = asOptionalString(args.path) ? resolvePath(ctx.cwd, String(args.path)) : ctx.cwd;
    const query = asOptionalString(args.query)?.toLowerCase();
    const detail = (args.detail === "signatures" ? "signatures" : "outline") as "outline" | "signatures";
    const maxFiles = Math.min(Math.max(asOptionalNumber(args.max_files) ?? DEFAULT_MAX_FILES, 1), MAX_FILE_SCAN);

    const collected: FileSymbols[] = [];
    let fileCount = 0;

    const scanDirectory = async (dir: string, depth = 0): Promise<void> => {
      if (fileCount >= maxFiles || depth > MAX_DEPTH) return;

      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      entries.sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
      });

      for (const entry of entries) {
        if (fileCount >= maxFiles) break;

        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) {
          continue;
        }

        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await scanDirectory(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (!CODE_EXTENSIONS.has(ext)) continue;

          try {
            const st = await stat(fullPath);
            if (st.size > MAX_FILE_SIZE_BYTES || st.size === 0) continue;

            const content = await readFile(fullPath, "utf8");
            let symbols = extractSymbolsFromSource(content, entry.name);

            if (query) {
              symbols = symbols.filter(
                (s) =>
                  s.name.toLowerCase().includes(query) ||
                  (s.parent && s.parent.toLowerCase().includes(query)) ||
                  s.signature.toLowerCase().includes(query),
              );
            }

            if (symbols.length > 0) {
              const rel = relative(ctx.cwd, fullPath).replace(/\\/g, "/");
              collected.push({ relPath: rel || entry.name, symbols });
              fileCount++;
            }
          } catch {
            // Ignore unreadable files
          }
        }
      }
    };

    const rootStat = await stat(root).catch(() => null);
    if (!rootStat) return `Directory or file not found: ${root}`;

    if (rootStat.isFile()) {
      if (rootStat.size > MAX_FILE_SIZE_BYTES) {
        return `File exceeds size limit of ${MAX_FILE_SIZE_BYTES / 1024} KB: ${root}`;
      }
      try {
        const content = await readFile(root, "utf8");
        let symbols = extractSymbolsFromSource(content, root);
        if (query) {
          symbols = symbols.filter(
            (s) =>
              s.name.toLowerCase().includes(query) ||
              (s.parent && s.parent.toLowerCase().includes(query)) ||
              s.signature.toLowerCase().includes(query),
          );
        }
        const rel = relative(ctx.cwd, root).replace(/\\/g, "/");
        return truncate(formatRepoMap([{ relPath: rel || root, symbols }], detail));
      } catch (err) {
        return `Could not read file: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    await scanDirectory(root, 0);
    return truncate(formatRepoMap(collected, detail));
  },
};
