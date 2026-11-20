import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SKILL_LIMITS,
  checkSkillInput,
  isSkillName,
  isSkillOrigin,
  parseSkillMarkdown,
  skillMarkdown,
  uniqueSkillName,
  type BotSkill,
  type BotSkillInput,
  type BotSkillSummary,
  type SkillAuthor,
  type SkillOrigin,
  type SkillRevision,
} from "./skills.js";
import { BotError } from "./types.js";

interface History {
  origin: SkillOrigin;
  version: number;
  revisions: SkillRevision[];
}

export interface SaveSkillOptions {
  /** Who is making this change. */
  author: SkillAuthor;
  /** Where the skill came from, used only when this creates it. */
  origin: SkillOrigin;
  /** The version the change was made from. A skill changed since is refused rather than overwritten. */
  expectedVersion?: number;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

function firstLine(body: string): string {
  return body.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0 && !line.startsWith("#")) ?? "";
}

function readHistory(raw: string | undefined): History {
  if (raw === undefined) return { origin: "person", version: 1, revisions: [] };
  try {
    const value = JSON.parse(raw) as Partial<History> | null;
    const revisions = Array.isArray(value?.revisions)
      ? value.revisions.filter(
          (r): r is SkillRevision =>
            typeof r === "object" &&
            r !== null &&
            typeof r.id === "string" &&
            typeof r.content === "string" &&
            typeof r.resultVersion === "number" &&
            (r.author === "bot" || r.author === "person"),
        )
      : [];
    return {
      origin: isSkillOrigin(value?.origin) ? value.origin : "person",
      version: typeof value?.version === "number" && value.version >= 1 ? Math.floor(value.version) : 1,
      revisions,
    };
  } catch {
    return { origin: "person", version: 1, revisions: [] };
  }
}

/**
 * One Bot's skills on this computer: `<root>/<name>/SKILL.md`, plus a small history file beside it so a change can
 * be undone. The `SKILL.md` is the truth; a person or another tool may edit it by hand, and what the history knows
 * about is only who first wrote it, which version it is on and what it used to say.
 *
 * Changes to one store run one at a time, so two saves cannot both read the same version and one silently lose.
 */
export class BotSkillStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    /** The folder holding one folder per skill: where the agent looks for `SKILL.md` files. */
    readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private dir(name: string): string {
    if (!isSkillName(name)) throw new BotError("invalid", "That is not a valid skill name.");
    return join(this.root, name);
  }

  private async readAll(name: string): Promise<{ skill: BotSkill; history: History } | undefined> {
    const dir = this.dir(name);
    let text: string;
    let modified: number;
    try {
      const file = join(dir, "SKILL.md");
      [text, modified] = await Promise.all([readFile(file, "utf8"), stat(file).then((s) => Math.round(s.mtimeMs))]);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    let raw: string | undefined;
    try {
      raw = await readFile(join(dir, "history.json"), "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const history = readHistory(raw);
    const parsed = parseSkillMarkdown(text);
    const description = parsed.description ?? (firstLine(parsed.body) || name);
    return {
      history,
      skill: { name, description, body: parsed.body, origin: history.origin, version: history.version, updatedAt: modified, bytes: Buffer.byteLength(parsed.body, "utf8") },
    };
  }

  private async names(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return entries.filter((entry) => entry.isDirectory() && isSkillName(entry.name)).map((entry) => entry.name).sort();
  }

  /** Every skill with its instructions. A folder without a readable `SKILL.md` is not a skill and is left out. */
  async all(): Promise<BotSkill[]> {
    const found: BotSkill[] = [];
    for (const name of await this.names()) {
      const one = await this.readAll(name);
      if (one) found.push(one.skill);
    }
    return found;
  }

  async list(): Promise<BotSkillSummary[]> {
    return (await this.all()).map(({ body: _body, ...summary }) => summary);
  }

  async get(name: string): Promise<BotSkill> {
    const one = await this.readAll(name);
    if (!one) throw new BotError("not_found", `This Bot has no skill called "${name}".`);
    return one.skill;
  }

  /** Make or change a skill. Saving what is already there changes nothing and adds no revision. */
  async save(input: unknown, options: SaveSkillOptions): Promise<BotSkill> {
    const checked = checkSkillInput(input);
    return this.serial(async () => {
      const existing = await this.readAll(checked.name);
      if (!existing && (await this.names()).length >= SKILL_LIMITS.perBot) {
        throw new BotError("limit", `A Bot can have ${SKILL_LIMITS.perBot} skills. Remove one to add another.`);
      }
      if (existing && options.expectedVersion !== undefined && options.expectedVersion !== existing.skill.version) {
        throw new BotError("conflict", `"${checked.name}" was changed since you opened it. Open it again to see what it says now.`);
      }
      if (existing && existing.skill.body === checked.body.trim() && existing.skill.description === checked.description) return existing.skill;
      return this.write(checked, existing?.history, options.author, options.origin, existing === undefined);
    });
  }

  /**
   * Add a skill under a name no other skill has: `name` as given if it is free, else with `-2`, `-3`… The free name is
   * chosen and the skill written in one step, so two of these at once never take the same name, and one never changes
   * a skill that is already there.
   */
  async saveUnique(input: unknown, options: Omit<SaveSkillOptions, "expectedVersion">): Promise<BotSkill> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new BotError("invalid", "The skill is not in a form this app understands.");
    const source = input as Record<string, unknown>;
    return this.serial(async () => {
      const taken = await this.names();
      if (taken.length >= SKILL_LIMITS.perBot) throw new BotError("limit", `A Bot can have ${SKILL_LIMITS.perBot} skills. Remove one to add another.`);
      const checked = checkSkillInput({ ...source, name: uniqueSkillName(typeof source.name === "string" ? source.name : "", taken) });
      return this.write(checked, undefined, options.author, options.origin, true);
    });
  }

  private async write(input: BotSkillInput, previous: History | undefined, author: SkillAuthor, origin: SkillOrigin, created: boolean): Promise<BotSkill> {
    const dir = this.dir(input.name);
    await mkdir(dir, { recursive: true });
    const version = previous ? previous.version + 1 : 1;
    const revision: SkillRevision = {
      id: `r${version}`,
      skill: input.name,
      atMs: this.now(),
      author,
      content: input.body.trim(),
      description: input.description,
      resultVersion: version,
      created,
      rolledBack: false,
    };
    const history: History = {
      origin: previous?.origin ?? origin,
      version,
      revisions: [...(previous?.revisions ?? []), revision].slice(-SKILL_LIMITS.revisions),
    };
    await this.atomic(join(dir, "SKILL.md"), skillMarkdown(input));
    await this.atomic(join(dir, "history.json"), JSON.stringify(history, null, 2));
    return this.get(input.name);
  }

  private async atomic(path: string, content: string): Promise<void> {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  }

  async remove(name: string): Promise<void> {
    const dir = this.dir(name);
    await this.serial(async () => {
      if (!(await this.readAll(name))) throw new BotError("not_found", `This Bot has no skill called "${name}".`);
      await rm(dir, { recursive: true, force: true });
    });
  }

  /** What a skill used to say, newest change first. */
  async revisions(name: string): Promise<SkillRevision[]> {
    const one = await this.readAll(name);
    if (!one) throw new BotError("not_found", `This Bot has no skill called "${name}".`);
    return [...one.history.revisions].reverse();
  }

  /**
   * Put a skill back to what it said after an earlier change. That is a new change, so it can itself be undone, and
   * the changes it undoes are marked as rolled back.
   */
  revert(name: string, revisionId: string): Promise<BotSkill> {
    return this.serial(async () => {
      const one = await this.readAll(name);
      if (!one) throw new BotError("not_found", `This Bot has no skill called "${name}".`);
      const target = one.history.revisions.find((revision) => revision.id === revisionId);
      if (!target) throw new BotError("not_found", "That earlier version is no longer kept.");
      if (target.resultVersion === one.skill.version) throw new BotError("conflict", "That is what the skill says now.");
      const marked: History = {
        ...one.history,
        revisions: one.history.revisions.map((revision) => (revision.resultVersion > target.resultVersion ? { ...revision, rolledBack: true } : revision)),
      };
      return this.write({ name, description: target.description, body: target.content }, marked, "person", one.history.origin, false);
    });
  }
}
