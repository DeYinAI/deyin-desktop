/**
 * Teaching a Bot a task by doing it. The person works in the app's browser while this keeps a short, plain record of
 * what they did, and afterwards the record is turned into a skill they read, change and save. Nothing is recorded
 * that the Bot should not have: what is typed into a password, card or code field is never kept, and a page address
 * is kept without the part after the `?`, which is where tokens live.
 *
 * Deyin records the browser, the one place it can see clearly, in bounds the person can see.
 * Everything here is browser-safe: the page script sends raw events, and this decides what is kept.
 */
import { SKILL_LIMITS, skillNameFrom, type BotSkillInput } from "./skills.js";
import { BotError, cleanBotLine } from "./types.js";

export const TEACH_LIMITS = {
  /** Steps kept; the recording stops taking more after this and says so. */
  steps: 200,
  /** How long a recording may run. */
  durationMs: 15 * 60_000,
  /** Characters kept of anything typed. */
  text: 300,
  /** Characters kept of a field or button's name. */
  label: 120,
  url: 300,
  note: 500,
  title: 80,
} as const;

export type TeachStep =
  | { kind: "open"; atMs: number; url: string; title?: string }
  | { kind: "click"; atMs: number; target: string }
  | { kind: "type"; atMs: number; target: string; text: string; secret: false }
  | { kind: "type"; atMs: number; target: string; secret: true }
  | { kind: "choose"; atMs: number; target: string; value: string }
  | { kind: "press"; atMs: number; key: string }
  | { kind: "note"; atMs: number; text: string };

/** What the page tells us it saw. Raw: the recorder decides what to keep. */
export type TeachEvent =
  | { kind: "open"; url: string; title?: string }
  | { kind: "click"; target: string }
  | { kind: "type"; target: string; text: string; secret?: boolean }
  | { kind: "choose"; target: string; value: string }
  | { kind: "press"; key: string }
  | { kind: "note"; text: string };

export interface TeachRecording {
  title: string;
  startedAt: number;
  endedAt?: number;
  steps: TeachStep[];
  /** More happened than was kept, because it ran past the steps or the time allowed. */
  truncated: boolean;
  /** Typed values left out because they looked like secrets. */
  secretsOmitted: number;
}

/** Names that say a field holds something the Bot must not be handed. */
const SECRET_FIELD = /pass(?:word|code|phrase)?|pwd|secret|token|api[\s_-]?key|otp|one[\s-]?time|2fa|verification code|security code|cvv|cvc|card (?:number|no)|credit card|iban|ssn|social security|pin\b/i;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Whether what was typed, whatever field it went into, looks like something to keep private. */
export function looksSecret(text: string): boolean {
  const compact = text.replace(/[\s-]/g, "");
  if (/^\d{13,19}$/.test(compact) && luhn(compact)) return true;
  if (/^(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}$/.test(text.trim())) return true;
  if (/^[A-Za-z0-9+/_=-]{32,}$/.test(text.trim()) && /\d/.test(text) && /[A-Za-z]/.test(text)) return true;
  return false;
}

/** A page address without what follows `?` or `#`, and without a name or password in front of the host. */
export function plainUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`.slice(0, TEACH_LIMITS.url);
  } catch {
    return "";
  }
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * What the page's script sent, as an event, or null when it is not one. The page is not trusted: only what a person
 * can do on a page (click, type, choose, press a key) is accepted from it, every field must be text, and each is cut
 * to a size before anything else looks at it. Opening a page and a note are made by the app, never read from a page.
 */
export function parseTeachPageEvent(value: unknown): TeachEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const text = (field: unknown, max: number): string | null => (typeof field === "string" ? field.slice(0, max) : null);
  switch (source.kind) {
    case "click": {
      const target = text(source.target, 400);
      return target === null ? null : { kind: "click", target };
    }
    case "type": {
      const target = text(source.target ?? "", 400);
      const typed = text(source.text ?? "", 2_000);
      if (target === null || typed === null) return null;
      return { kind: "type", target, text: typed, ...(source.secret === true ? { secret: true } : {}) };
    }
    case "choose": {
      const target = text(source.target ?? "", 400);
      const chosen = text(source.value, 400);
      return target === null || chosen === null ? null : { kind: "choose", target, value: chosen };
    }
    case "press": {
      const key = text(source.key, 60);
      return key === null ? null : { kind: "press", key };
    }
    default:
      return null;
  }
}

/**
 * Keeps a recording within its bounds. Events arrive in the order they happened; each is cleaned, made safe, and
 * either added, merged into the step before it (typing in the same field is one step, not one per key), or dropped.
 */
export class TeachRecorder {
  private readonly steps: TeachStep[] = [];
  private truncated = false;
  private secrets = 0;
  private endedAt: number | undefined;

  constructor(
    private readonly title: string,
    private readonly startedAt: number,
    private readonly now: () => number = Date.now,
  ) {}

  get count(): number {
    return this.steps.length;
  }

  get full(): boolean {
    return this.truncated || this.steps.length >= TEACH_LIMITS.steps;
  }

  get ended(): boolean {
    return this.endedAt !== undefined;
  }

  /** Take one event. Returns whether anything was kept or changed. */
  add(event: TeachEvent): boolean {
    if (this.endedAt !== undefined) return false;
    const atMs = this.now() - this.startedAt;
    if (atMs > TEACH_LIMITS.durationMs || this.steps.length >= TEACH_LIMITS.steps) {
      this.truncated = true;
      return false;
    }
    const last = this.steps.at(-1);
    switch (event.kind) {
      case "open": {
        const url = plainUrl(event.url);
        if (!url) return false;
        if (last?.kind === "open" && last.url === url) return false;
        const title = cleanBotLine(event.title ?? "");
        this.steps.push({ kind: "open", atMs, url, ...(title ? { title: clip(title, TEACH_LIMITS.label) } : {}) });
        return true;
      }
      case "click": {
        const target = clip(cleanBotLine(event.target), TEACH_LIMITS.label);
        if (!target) return false;
        this.steps.push({ kind: "click", atMs, target });
        return true;
      }
      case "type": {
        const target = clip(cleanBotLine(event.target), TEACH_LIMITS.label) || "a field";
        const secret = event.secret === true || SECRET_FIELD.test(target) || looksSecret(event.text);
        if (secret) {
          if (last?.kind === "type" && last.secret && last.target === target) return false;
          // What replaces typing in this field is one step, however many keys it took.
          if (last?.kind === "type" && !last.secret && last.target === target) this.steps.pop();
          this.secrets += 1;
          this.steps.push({ kind: "type", atMs, target, secret: true });
          return true;
        }
        const text = clip(event.text.replace(/\s+/g, " ").trim(), TEACH_LIMITS.text);
        if (!text) return false;
        if (last?.kind === "type" && !last.secret && last.target === target) {
          this.steps[this.steps.length - 1] = { kind: "type", atMs: last.atMs, target, text, secret: false };
          return true;
        }
        this.steps.push({ kind: "type", atMs, target, text, secret: false });
        return true;
      }
      case "choose": {
        const target = clip(cleanBotLine(event.target), TEACH_LIMITS.label) || "a menu";
        const value = clip(cleanBotLine(event.value), TEACH_LIMITS.label);
        if (!value) return false;
        this.steps.push({ kind: "choose", atMs, target, value });
        return true;
      }
      case "press": {
        const key = cleanBotLine(event.key).slice(0, 24);
        if (!key) return false;
        this.steps.push({ kind: "press", atMs, key });
        return true;
      }
      case "note": {
        const text = clip(cleanBotLine(event.text), TEACH_LIMITS.note);
        if (!text) return false;
        this.steps.push({ kind: "note", atMs, text });
        return true;
      }
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  }

  /** The recording so far, or all of it once stopped. */
  snapshot(): TeachRecording {
    return {
      title: this.title,
      startedAt: this.startedAt,
      ...(this.endedAt !== undefined ? { endedAt: this.endedAt } : {}),
      steps: [...this.steps],
      truncated: this.truncated,
      secretsOmitted: this.secrets,
    };
  }

  stop(): TeachRecording {
    this.endedAt ??= this.now();
    return this.snapshot();
  }
}

/* Drafting --------------------------------------------------------------------- */

export interface SkillDraft {
  skill: BotSkillInput;
  /** Things to know before saving, in plain words. */
  warnings: string[];
}

/** One step as a sentence, as it reads in a drafted skill and as it is shown while recording. */
export function teachStepSentence(step: TeachStep): string {
  switch (step.kind) {
    case "open":
      return `Open ${step.url}${step.title ? ` (the page is called "${step.title}")` : ""}.`;
    case "click":
      return `Click ${step.target}.`;
    case "type":
      return step.secret
        ? `Fill in ${step.target} from the Vault, the person's saved login or card. Never type it from memory and never write it in a message.`
        : `Type "${step.text}" into ${step.target}.`;
    case "choose":
      return `Choose "${step.value}" in ${step.target}.`;
    case "press":
      return `Press ${step.key}.`;
    case "note":
      return `Note from the person: ${step.text}`;
    default: {
      const unreachable: never = step;
      return unreachable;
    }
  }
}

/**
 * A first draft of a skill from a recording: the steps in order, in words, with a rule to stop and ask when the page is
 * not as described. It is a draft: the person reads it and changes it before it is saved, and a Bot that reads it
 * knows it was written from one run, not a rule.
 */
export function draftSkillFromRecording(recording: TeachRecording, options: { name?: string; description?: string } = {}): SkillDraft {
  const title = cleanBotLine(recording.title).slice(0, TEACH_LIMITS.title) || "Task";
  const steps = recording.steps;
  if (steps.length === 0) throw new BotError("invalid", "Nothing was recorded. Start again and do the task in the browser.");
  const warnings: string[] = [];
  if (recording.truncated) warnings.push(`The recording was cut short at ${TEACH_LIMITS.steps} steps or ${Math.round(TEACH_LIMITS.durationMs / 60_000)} minutes. The rest of the task is not in the draft.`);
  if (recording.secretsOmitted > 0) {
    warnings.push(
      `${recording.secretsOmitted} typed ${recording.secretsOmitted === 1 ? "value was" : "values were"} left out because ${recording.secretsOmitted === 1 ? "it looked" : "they looked"} like ${recording.secretsOmitted === 1 ? "a secret" : "secrets"}. The draft says to use the Vault instead.`,
    );
  }
  const lines = [
    `# ${title}`,
    "",
    "This was written from one time the person did the task. Follow the steps in order and look at the page after each one. If a page is not what a step expects, stop and tell the person what you see instead of guessing.",
    "",
  ];
  if (steps[0]!.kind !== "open") {
    warnings.push("The recording did not start by opening a page. Say where the task begins.");
    lines.push("The recording did not start on a page. Say where the task begins before saving.", "");
  }
  lines.push("## Steps", "", steps.map((step, index) => `${index + 1}. ${teachStepSentence(step)}`).join("\n"));
  const body = lines.join("\n").slice(0, SKILL_LIMITS.body);
  const name = options.name ? skillNameFrom(options.name) : skillNameFrom(title);
  const description = cleanBotLine(options.description ?? "") || `${title}, the way the person showed it in the browser.`;
  return { skill: { name, description: description.slice(0, SKILL_LIMITS.description), body }, warnings };
}
