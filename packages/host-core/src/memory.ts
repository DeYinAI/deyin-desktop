import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Background memory: durable, typed facts (user preferences, project constraints,
 * feedback, references) that survive across sessions. Facts are one markdown
 * file per fact with frontmatter metadata, stored under `<dir>/memory/`;
 * forgotten facts move to `<dir>/memory/.archive/` and can be recovered.
 *
 * Modeled on Deyin's context memory fact model: immutable `id`, monotonic
 * `revision`, independent `type` and `scope`, and BM25-lite recall ranking with
 * a project preference and staleness down-ranking.
 */

export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemoryScope = "project" | "global";

export interface MemoryFact {
  /** Immutable identifier (uuid). */
  id: string;
  /** Stable lowercase-kebab name used for references (e.g. `project/release-flow`). */
  name: string;
  title: string;
  description: string;
  type: MemoryType;
  scope: MemoryScope;
  /** Monotonic revision; updates require matching `expectedRevision`. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Markdown body. */
  body: string;
  /** On-disk path of the fact file (or archive path for archived facts). */
  path: string;
  archived: boolean;
}

export interface MemoryInput {
  name?: string;
  title: string;
  description?: string;
  type: MemoryType;
  scope?: MemoryScope;
  body: string;
}

export interface MemoryRecallHit {
  fact: MemoryFact;
  score: number;
}

/** Staleness horizon per type (days); older facts are down-ranked, never hidden. */
const FRESHNESS_DAYS: Record<MemoryType, number> = {
  reference: 45,
  project: 180,
  user: 365,
  feedback: 365,
};

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "you", "your", "are", "was", "were",
  "from", "have", "has", "will", "can", "use", "using", "used", "when", "what",
  "how", "why", "not", "but", "its", "it's", "into", "about", "than", "then",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
}

function isoNow(): string {
  return new Date().toISOString();
}

function freshnessFactor(fact: MemoryFact): number {
  const days = (Date.now() - Date.parse(fact.updatedAt)) / 86_400_000;
  const stale = FRESHNESS_DAYS[fact.type];
  if (Number.isNaN(days) || days <= stale) return 1;
  return Math.max(0.3, 1 - (days - stale) / stale);
}

/* Frontmatter (flat subset, same shape agent-core's capability parser reads). */

function parseFrontmatter(source: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { data: {}, body: source };
  const data: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    data[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { data, body: source.slice(match[0].length) };
}

function serializeFact(fact: MemoryFact): string {
  const fm = [
    "---",
    `id: ${fact.id}`,
    `name: ${fact.name}`,
    `title: ${fact.title}`,
    `description: ${fact.description}`,
    `type: ${fact.type}`,
    `scope: ${fact.scope}`,
    `revision: ${fact.revision}`,
    `created_at: ${fact.createdAt}`,
    `updated_at: ${fact.updatedAt}`,
    "---",
  ];
  return `${fm.join("\n")}\n${fact.body.trim()}\n`;
}

function parseFact(path: string, source: string, archived: boolean): MemoryFact | null {
  const { data, body } = parseFrontmatter(source);
  if (!data.id || !data.name) return null;
  return {
    id: data.id,
    name: data.name,
    title: data.title ?? data.name,
    description: data.description ?? "",
    type: (data.type as MemoryType) ?? "project",
    scope: (data.scope as MemoryScope) ?? "project",
    revision: Number(data.revision) || 1,
    createdAt: data.created_at ?? data.updated_at ?? isoNow(),
    updatedAt: data.updated_at ?? data.created_at ?? isoNow(),
    body: body.trim(),
    path,
    archived,
  };
}

/** BM25-lite ranker: title x3, description x2, body x1, project bonus, staleness down-rank. */
export function rankMemoryFacts(query: string, facts: MemoryFact[]): MemoryRecallHit[] {
  const terms = tokenize(query);
  if (terms.length === 0 || facts.length === 0) return [];
  const n = facts.length;
  const docFreq = new Map<string, number>();
  for (const fact of facts) {
    const seen = new Set(tokenize(`${fact.title} ${fact.description} ${fact.body}`));
    for (const t of seen) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  const scored = facts.map((fact) => {
    const haystack = [fact.title, fact.title, fact.title, fact.description, fact.description, fact.body].join(" ");
    const tf = new Map<string, number>();
    for (const t of tokenize(haystack)) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of terms) {
      const count = tf.get(t) ?? 0;
      if (count === 0) continue;
      const idf = Math.log(1 + n / (1 + (docFreq.get(t) ?? 1)));
      score += (1 + Math.log(1 + count)) * idf;
    }
    if (score === 0) return null;
    if (fact.scope === "project") score += 0.5;
    score *= freshnessFactor(fact);
    return { fact, score };
  });
  return scored
    .filter((s): s is MemoryRecallHit => s !== null)
    .sort((a, b) => b.score - a.score);
}

/**
 * File-backed memory store. Facts live as `<dir>/memory/<name>.md`; forgotten
 * facts are moved to `<dir>/memory/.archive/<id>.md` (never deleted outright).
 */
export class MemoryStore {
  readonly dir: string;
  private readonly factsDir: string;
  private readonly archiveDir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.factsDir = join(dir, "memory");
    this.archiveDir = join(this.factsDir, ".archive");
  }

  private factPath(name: string): string {
    return join(this.factsDir, `${name}.md`);
  }

  private ensureDirs(): void {
    mkdirSync(this.factsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.archiveDir, { recursive: true, mode: 0o700 });
  }

  private readDir(directory: string): MemoryFact[] {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return [];
    }
    const facts: MemoryFact[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const path = join(directory, entry);
      try {
        const fact = parseFact(path, readFileSync(path, "utf8"), directory === this.archiveDir);
        if (fact) facts.push(fact);
      } catch {
        // skip unreadable fact files
      }
    }
    return facts;
  }

  /** All active facts (project + global). */
  list(): MemoryFact[] {
    return this.readDir(this.factsDir).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Facts in the archive (forgotten, recoverable). */
  archived(): MemoryFact[] {
    return this.readDir(this.archiveDir).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Read a fact by name, title, or id (active facts only). */
  read(ref: string): MemoryFact | undefined {
    const target = ref.trim();
    return this.list().find(
      (f) => f.name === target || f.title === target || f.id === target || target === `project/${f.name}` || target === `global/${f.name}`,
    );
  }

  /** BM25-lite recall over active facts. */
  search(query: string, limit = 8): MemoryRecallHit[] {
    return rankMemoryFacts(query, this.list()).slice(0, limit);
  }

  /** Create a fact (create-only: refuses when the name already exists). */
  create(input: MemoryInput): MemoryFact {
    const name = slugify(input.name ?? input.title);
    if (!name) throw new Error("Memory fact name is required.");
    if (this.read(name)) throw new Error(`A memory fact named "${name}" already exists.`);
    const now = isoNow();
    const fact: MemoryFact = {
      id: randomUUID(),
      name,
      title: input.title.trim(),
      description: input.description?.trim() ?? "",
      type: input.type,
      scope: input.scope ?? "project",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      body: input.body.trim(),
      path: this.factPath(name),
      archived: false,
    };
    this.ensureDirs();
    writeFileSync(fact.path, serializeFact(fact), { encoding: "utf8", mode: 0o600 });
    return fact;
  }

  /** Update a fact; rejects stale `expectedRevision` (optimistic concurrency). */
  update(ref: string, patch: { title?: string; description?: string; type?: MemoryType; scope?: MemoryScope; body?: string }, expectedRevision?: number): MemoryFact {
    const existing = this.read(ref);
    if (!existing || existing.archived) throw new Error(`Memory fact "${ref}" not found.`);
    if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
      throw new Error(`Memory fact "${ref}" changed (revision ${existing.revision}, expected ${expectedRevision}).`);
    }
    const now = isoNow();
    const next: MemoryFact = {
      ...existing,
      title: patch.title?.trim() ?? existing.title,
      description: patch.description?.trim() ?? existing.description,
      type: patch.type ?? existing.type,
      scope: patch.scope ?? existing.scope,
      body: patch.body?.trim() ?? existing.body,
      revision: existing.revision + 1,
      updatedAt: now,
    };
    writeFileSync(existing.path, serializeFact(next), { encoding: "utf8", mode: 0o600 });
    return next;
  }

  /** Move a fact to the archive (removed from active recall). */
  forget(ref: string): void {
    const fact = this.read(ref);
    if (!fact || fact.archived) throw new Error(`Memory fact "${ref}" not found.`);
    this.ensureDirs();
    renameSync(fact.path, join(this.archiveDir, `${fact.id}.md`));
  }

  /** Restore an archived fact as a new higher revision. */
  recover(ref: string): MemoryFact {
    const archived = this.archived().find((f) => f.id === ref || f.name === ref);
    if (!archived) throw new Error(`Archived memory fact "${ref}" not found.`);
    const existing = this.read(archived.name);
    if (existing) throw new Error(`A fact named "${archived.name}" already exists; recover it under a new name instead.`);
    const now = isoNow();
    const restored: MemoryFact = {
      ...archived,
      revision: archived.revision + 1,
      updatedAt: now,
      path: this.factPath(archived.name),
      archived: false,
    };
    renameSync(archived.path, restored.path);
    writeFileSync(restored.path, serializeFact(restored), { encoding: "utf8", mode: 0o600 });
    return restored;
  }

  /** Permanently delete an archived fact. */
  purge(ref: string): void {
    const archived = this.archived().find((f) => f.id === ref || f.name === ref);
    if (!archived) throw new Error(`Archived memory fact "${ref}" not found.`);
    rmSync(archived.path, { force: true });
  }

  /** Number of active facts (for automatic-write budgeting). */
  count(): number {
    return this.list().length;
  }
}
