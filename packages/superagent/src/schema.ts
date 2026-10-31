/**
 * Minimal schema combinators: each describes a value as JSON Schema (for the model's tool declaration) and parses an
 * untrusted value into its TypeScript type, refusing with a path-qualified {@link UserError}. No third-party dependency.
 */
import { UserError } from "./core/errors.js";

export interface Schema<T> {
  readonly json: Record<string, unknown>;
  /** Present on object schemas so unknown keys can be refused. */
  parse(value: unknown, path?: string): T;
  /** True for a schema whose property may be left out. */
  readonly optional?: true;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

const fail = (path: string, message: string): never => {
  throw new UserError("invalid", `${path || "value"}: ${message}`);
};
const withDescription = (json: Record<string, unknown>, description: string | undefined) => (description ? { ...json, description } : json);

interface StringOptions { min?: number; max?: number; trim?: boolean; pattern?: RegExp; description?: string; check?: (value: string) => string | undefined }
export function string(options: StringOptions = {}): Schema<string> {
  const { min, max, trim, pattern, description, check } = options;
  return {
    json: withDescription({ type: "string", ...(min !== undefined ? { minLength: min } : {}), ...(max !== undefined ? { maxLength: max } : {}) }, description),
    parse(value, path = "") {
      if (typeof value !== "string") return fail(path, "expected a string");
      const text = trim ? value.trim() : value;
      if (min !== undefined && text.length < min) return fail(path, min === 1 ? "must not be empty" : `at least ${min} characters`);
      if (max !== undefined && text.length > max) return fail(path, `at most ${max} characters`);
      if (pattern && !pattern.test(text)) return fail(path, `does not match ${String(pattern)}`);
      const problem = check?.(text);
      if (problem) return fail(path, problem);
      return text;
    },
  };
}

interface NumberOptions { int?: boolean; min?: number; max?: number; description?: string }
export function number(options: NumberOptions = {}): Schema<number> {
  const { int, min, max, description } = options;
  return {
    json: withDescription({ type: int ? "integer" : "number", ...(min !== undefined ? { minimum: min } : {}), ...(max !== undefined ? { maximum: max } : {}) }, description),
    parse(value, path = "") {
      if (typeof value !== "number" || !Number.isFinite(value)) return fail(path, "expected a number");
      if (int && !Number.isInteger(value)) return fail(path, "expected an integer");
      if (min !== undefined && value < min) return fail(path, `at least ${min}`);
      if (max !== undefined && value > max) return fail(path, `at most ${max}`);
      return value;
    },
  };
}

export function boolean(description?: string): Schema<boolean> {
  return {
    json: withDescription({ type: "boolean" }, description),
    parse: (value, path = "") => (typeof value === "boolean" ? value : fail(path, "expected true or false")),
  };
}

export function enumeration<const V extends readonly [string, ...string[]]>(values: V, description?: string): Schema<V[number]> {
  return {
    json: withDescription({ type: "string", enum: [...values] }, description),
    parse: (value, path = "") => (typeof value === "string" && (values as readonly string[]).includes(value) ? (value as V[number]) : fail(path, `expected one of ${values.join(", ")}`)),
  };
}

export const unknown = (description?: string): Schema<unknown> => ({ json: withDescription({}, description), parse: (value) => value });

export function array<T>(item: Schema<T>, options: { min?: number; max?: number; description?: string } = {}): Schema<T[]> {
  const { min, max, description } = options;
  return {
    json: withDescription({ type: "array", items: item.json, ...(min !== undefined ? { minItems: min } : {}), ...(max !== undefined ? { maxItems: max } : {}) }, description),
    parse(value, path = "") {
      if (!Array.isArray(value)) return fail(path, "expected an array");
      if (min !== undefined && value.length < min) return fail(path, `at least ${min} items`);
      if (max !== undefined && value.length > max) return fail(path, `at most ${max} items`);
      return value.map((entry, index) => item.parse(entry, `${path}[${index}]`));
    },
  };
}

/** A property that may be absent. */
export function optional<T>(inner: Schema<T>): Schema<T | undefined> {
  return { json: inner.json, optional: true, parse: (value, path) => (value === undefined ? undefined : inner.parse(value, path)) };
}

/** A property that may be absent or null. */
export function nullish<T>(inner: Schema<T>): Schema<T | null | undefined> {
  return { json: inner.json, optional: true, parse: (value, path) => (value === undefined || value === null ? (value as null | undefined) : inner.parse(value, path)) };
}

type Shape = Record<string, Schema<unknown>>;
type ObjectOf<S extends Shape> = { [K in keyof S as undefined extends Infer<S[K]> ? never : K]: Infer<S[K]> } & { [K in keyof S as undefined extends Infer<S[K]> ? K : never]?: Infer<S[K]> };

/** A strict object: unknown keys are refused, so a misspelled argument is reported rather than silently ignored. */
export function object<S extends Shape>(shape: S, description?: string): Schema<ObjectOf<S>> {
  const names = Object.keys(shape);
  return {
    json: withDescription(
      {
        type: "object",
        properties: Object.fromEntries(names.map((name) => [name, shape[name]!.json])),
        required: names.filter((name) => !shape[name]!.optional),
        additionalProperties: false,
      },
      description,
    ),
    parse(value, path = "") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(path, "expected an object");
      const record = value as Record<string, unknown>;
      for (const name of Object.keys(record)) if (!names.includes(name)) fail(path ? `${path}.${name}` : name, "unknown property");
      const out: Record<string, unknown> = {};
      for (const name of names) {
        const parsed = shape[name]!.parse(record[name], path ? `${path}.${name}` : name);
        if (parsed !== undefined) out[name] = parsed;
      }
      return out as ObjectOf<S>;
    },
  };
}

/** `with a description`: re-describes a schema without changing how it parses. */
export const describe = <T>(inner: Schema<T>, description: string): Schema<T> => ({ ...inner, json: { ...inner.json, description } });
