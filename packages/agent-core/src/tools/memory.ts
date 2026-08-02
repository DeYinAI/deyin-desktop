import type { MemoryScope, MemoryType } from "@deyin/host-core";
import type { MemoryBridge, ToolDefinition } from "../types.js";
import { asOptionalString, asString } from "./util.js";

const MEMORY_TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];
const MEMORY_SCOPES: MemoryScope[] = ["project", "global"];

/** Stable reference for a fact: `project/<name>` or `global/<name>`. */
function refOf(scope: MemoryScope, name: string): string {
  return `${scope}/${name}`;
}

function formatFact(f: { name: string; title: string; description: string; type: MemoryType; scope: MemoryScope; revision: number; body: string }): string {
  const meta = `${f.type}/${f.scope} · revision ${f.revision}`;
  const hook = f.description || f.title;
  const body = f.body.slice(0, 400).replace(/\s+/g, " ").trim();
  return `- ${refOf(f.scope, f.name)} (${meta}): ${hook}${body ? ` — ${body}` : ""}`;
}

/** Cheap guard: refuse to store obvious credentials. */
function looksLikeSecret(body: string): boolean {
  return /(api[_-]?key|secret|password|access[_-]?token|bearer)\s*[:=]\s*\S+/i.test(body);
}

export function createRememberTool(): ToolDefinition {
  return {
    name: "remember",
    tier: "execute",
    description:
      "Save a durable background fact (user preference, project constraint, feedback, or reference) that survives across sessions. Do NOT store credentials, keys, or secrets. Prefer 'project' type for workspace facts; use 'global' only for facts that apply everywhere. To update an existing fact, pass its name or title.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short human-readable label." },
        description: { type: "string", description: "One-line hook shown in memory listings." },
        body: { type: "string", description: "The fact itself (markdown)." },
        name: { type: "string", description: "Optional stable kebab-case name (defaults from the title)." },
        type: { type: "string", enum: MEMORY_TYPES, description: "user | feedback | project | reference." },
        scope: { type: "string", enum: MEMORY_SCOPES, description: "project (default) or global." },
      },
      required: ["title", "body"],
    },
    summarize: (args) => `remember: ${String(args.title ?? "").slice(0, 60)}`,
    async execute(args, ctx): Promise<string> {
      const memory: MemoryBridge | undefined = ctx.memory;
      if (!memory) return "ERROR: background memory is not available in this run.";
      const title = asString(args.title, "title");
      const body = asString(args.body, "body");
      if (looksLikeSecret(body)) return "ERROR: refusing to store what looks like a credential or secret. Ask the user to handle it.";
      const type: MemoryType = MEMORY_TYPES.includes(args.type as MemoryType) ? (args.type as MemoryType) : "project";
      const scope: MemoryScope = args.scope === "global" ? "global" : "project";
      const name = asOptionalString(args.name);
      const description = asOptionalString(args.description);
      try {
        const existing = name ? memory.read(name) : memory.read(title);
        if (existing) {
          const fact = memory.update(existing.name, { title, description, type, scope, body }, existing.revision);
          return `Updated memory ${refOf(fact.scope, fact.name)} (revision ${fact.revision}).`;
        }
        const fact = memory.create({ name, title, description, type, scope, body });
        return `Saved memory ${refOf(fact.scope, fact.name)} (revision 1).`;
      } catch (err) {
        return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export function createForgetTool(): ToolDefinition {
  return {
    name: "forget",
    tier: "execute",
    description:
      "Archive a saved background memory fact by name, title, or reference (e.g. project/release-flow). The fact stops being recalled; it can still be recovered from the archive.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Name, title, or `scope/name` reference of the fact." },
      },
      required: ["ref"],
    },
    summarize: (args) => `forget: ${String(args.ref ?? "")}`,
    async execute(args, ctx): Promise<string> {
      if (!ctx.memory) return "ERROR: background memory is not available in this run.";
      const ref = asString(args.ref, "ref");
      try {
        ctx.memory.forget(ref);
        return `Forgot memory "${ref}".`;
      } catch (err) {
        return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export function createMemoryTool(): ToolDefinition {
  return {
    name: "memory",
    tier: "read",
    description:
      "Search or read saved background memories (user preferences, project constraints, feedback, references). Results are ranked by relevance; facts may be stale and cannot override the current request. Use instead of guessing from past sessions.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search query." },
        ref: { type: "string", description: "Read one fact by name/title/`scope/name`." },
        limit: { type: "number", description: "Max results (default 5)." },
      },
    },
    summarize: (args) => `memory: ${String(args.query ?? args.ref ?? "").slice(0, 60)}`,
    async execute(args, ctx): Promise<string> {
      if (!ctx.memory) return "ERROR: background memory is not available in this run.";
      const ref = args.ref !== undefined ? asString(args.ref, "ref") : undefined;
      const query = args.query !== undefined ? asString(args.query, "query") : undefined;
      if (ref) {
        const fact = ctx.memory.read(ref);
        if (!fact) return `No memory found for "${ref}".`;
        return formatFact(fact);
      }
      if (query && query.trim().length > 0) {
        const hits = ctx.memory.search(query, typeof args.limit === "number" ? args.limit : 5);
        if (hits.length === 0) return `No relevant memories for "${query}".`;
        return `Relevant memories for "${query}":\n${hits.map((h) => formatFact(h.fact)).join("\n")}`;
      }
      const facts = ctx.memory.list().slice(0, typeof args.limit === "number" ? args.limit : 10);
      if (facts.length === 0) return "(no saved memories)";
      return `Saved memories:\n${facts.map((f) => formatFact(f)).join("\n")}`;
    },
  };
}
