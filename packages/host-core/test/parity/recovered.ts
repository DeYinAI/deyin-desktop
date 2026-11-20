/** Reads the recovered interface metadata in `docs/rea/grok-bot-1.2.3`. Interface names and numbers only. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dirname, "../../../..");
const RECOVERED_DIR = join(REPO_ROOT, "docs/rea/grok-bot-1.2.3");

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(RECOVERED_DIR, name), "utf8")) as T;
}

const enums = readJson<Record<string, string[]>>("proto-enums.json");
const shapes = readJson<Record<string, string>>("proto-shapes.json");

export const RECOVERED_ENUM_COUNT = Object.keys(enums).length;
export const RECOVERED_SHAPE_COUNT = Object.keys(shapes).length;

/** The named values of a recovered enum, in number order, without the `UNSPECIFIED` zero. */
export function recoveredEnumValues(name: string): string[] {
  const entries = enums[name];
  if (!entries) throw new Error(`recovered enum ${name} not found`);
  return entries
    .map((entry) => {
      const at = entry.indexOf("=");
      return { number: Number(entry.slice(0, at)), name: entry.slice(at + 1) };
    })
    .filter((value) => value.number !== 0)
    .sort((a, b) => a.number - b.number)
    .map((value) => value.name);
}

/** The field names of a recovered message, in field-number order. */
export function recoveredFieldNames(name: string): string[] {
  const shape = shapes[name];
  if (shape === undefined) throw new Error(`recovered shape ${name} not found`);
  return shape
    .split("|")
    .map((field) => field.split(" "))
    .map(([number, fieldName]) => ({ number: Number(number), fieldName: fieldName ?? "" }))
    .sort((a, b) => a.number - b.number)
    .map((field) => field.fieldName);
}

/** Every message name starting with `prefix`, for the document's coverage line. */
export function recoveredShapeNames(prefix: string): string[] {
  return Object.keys(shapes).filter((name) => name.startsWith(prefix));
}
