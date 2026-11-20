import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BotError,
  RUNTIME_LIMITS,
  isEngineRunRecord,
  isValidRoutineId,
  isValidRuntimeBotId,
  parseEngineRoutine,
  type EngineRoutine,
  type EngineRunRecord,
} from "@deyin/host-core";

/**
 * What the engine keeps on the server, under one folder (`~/.deyin-bot` by default):
 *
 *   token                         the key the desktop shows to be let in (mode 0600)
 *   bots/<botId>/files/           the Bot's own folder: what it can read, write and run commands in
 *   bots/<botId>/routines.json    its routines
 *   bots/<botId>/runs/<id>.json   the last runs of each routine
 *
 * Small JSON files, replaced whole through a temporary file, so a crash never leaves half of one. The desktop
 * keeps the master copy of routines; this is the engine's working copy, kept so a routine still runs when the
 * desktop is closed.
 */

const FILE_VERSION = 1;

function writeAtomic(file: string, content: string): void {
  const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Parse a JSON file; a missing file is "nothing", and one that will not parse is set aside so it is not lost. */
function readJson(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      // Nothing more can be done with it.
    }
    return undefined;
  }
}

export class EngineStore {
  constructor(readonly home: string) {}

  /** Make the engine's folder, private to its user. */
  ensure(): void {
    mkdirSync(join(this.home, "bots"), { recursive: true, mode: 0o700 });
  }

  tokenFile(): string {
    return join(this.home, "token");
  }

  botDir(botId: string): string {
    if (!isValidRuntimeBotId(botId)) throw new BotError("invalid", "That is not a Bot id.");
    return join(this.home, "bots", botId);
  }

  filesDir(botId: string): string {
    return join(this.botDir(botId), "files");
  }

  private routinesFile(botId: string): string {
    return join(this.botDir(botId), "routines.json");
  }

  private runsFile(botId: string, routineId: string): string {
    if (!isValidRoutineId(routineId)) throw new BotError("invalid", "That is not a routine id.");
    return join(this.botDir(botId), "runs", `${routineId}.json`);
  }

  botIds(): string[] {
    const dir = join(this.home, "bots");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((name) => isValidRuntimeBotId(name) && statSync(join(dir, name)).isDirectory()).sort();
  }

  hasBot(botId: string): boolean {
    return existsSync(this.botDir(botId));
  }

  /** Make a Bot's folder if it is not there; refuses a new one past the cap. */
  ensureBot(botId: string): void {
    const dir = this.botDir(botId);
    if (!existsSync(dir) && this.botIds().length >= RUNTIME_LIMITS.bots) {
      throw new BotError("limit", `This server keeps at most ${RUNTIME_LIMITS.bots} Bots. Remove one to add another.`);
    }
    mkdirSync(join(dir, "files"), { recursive: true, mode: 0o700 });
  }

  /** Forget a Bot: its files, routines and run records. */
  removeBot(botId: string): boolean {
    const dir = this.botDir(botId);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  routines(botId: string): EngineRoutine[] {
    if (!this.hasBot(botId)) return [];
    const parsed = readJson(this.routinesFile(botId));
    const list = typeof parsed === "object" && parsed !== null ? (parsed as { routines?: unknown }).routines : undefined;
    if (!Array.isArray(list)) return [];
    const routines: EngineRoutine[] = [];
    for (const item of list) {
      try {
        const id = typeof item === "object" && item !== null ? (item as { id?: unknown }).id : undefined;
        if (typeof id === "string") routines.push(parseEngineRoutine(item, id));
      } catch {
        // A routine that no longer passes the checks is dropped rather than run.
      }
    }
    return routines;
  }

  /** Add or replace one routine, refusing a new one past the Bot's cap. */
  saveRoutine(botId: string, routine: EngineRoutine): void {
    this.ensureBot(botId);
    const others = this.routines(botId).filter((r) => r.id !== routine.id);
    if (others.length >= RUNTIME_LIMITS.routinesPerBot) {
      throw new BotError("limit", `A Bot can have at most ${RUNTIME_LIMITS.routinesPerBot} routines. Delete one to add another.`);
    }
    writeAtomic(this.routinesFile(botId), JSON.stringify({ version: FILE_VERSION, routines: [...others, routine] }, null, 2));
  }

  removeRoutine(botId: string, routineId: string): boolean {
    if (!isValidRoutineId(routineId)) throw new BotError("invalid", "That is not a routine id.");
    if (!this.hasBot(botId)) return false;
    const all = this.routines(botId);
    const rest = all.filter((r) => r.id !== routineId);
    if (rest.length === all.length) return false;
    writeAtomic(this.routinesFile(botId), JSON.stringify({ version: FILE_VERSION, routines: rest }, null, 2));
    rmSync(this.runsFile(botId, routineId), { force: true });
    return true;
  }

  /** The recorded runs of a routine, newest first. */
  runs(botId: string, routineId: string): EngineRunRecord[] {
    if (!this.hasBot(botId)) return [];
    const parsed = readJson(this.runsFile(botId, routineId));
    const list = typeof parsed === "object" && parsed !== null ? (parsed as { runs?: unknown }).runs : undefined;
    return Array.isArray(list) ? list.filter(isEngineRunRecord) : [];
  }

  /** Add a run record, or replace the one with the same id, keeping the newest few. */
  recordRun(botId: string, record: EngineRunRecord): void {
    if (!this.hasBot(botId)) return;
    const file = this.runsFile(botId, record.routineId);
    mkdirSync(join(this.botDir(botId), "runs"), { recursive: true, mode: 0o700 });
    const rest = this.runs(botId, record.routineId).filter((r) => r.id !== record.id);
    const runs = [record, ...rest].sort((a, b) => b.startedAt - a.startedAt).slice(0, RUNTIME_LIMITS.runRecords);
    writeAtomic(file, JSON.stringify({ version: FILE_VERSION, runs }, null, 2));
  }
}
