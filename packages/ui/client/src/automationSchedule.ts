import type { AutomationTrigger } from "@deyin/contract";

/** How often an automation repeats, as offered by the "Repeat" row of the editor. */
export type RepeatKind = "weekly" | "weekdays" | "daily" | "hourly" | "minutely" | "monthly" | "once" | "manual" | "custom";

export const REPEAT_KINDS: readonly RepeatKind[] = [
  "weekly",
  "weekdays",
  "daily",
  "hourly",
  "minutely",
  "monthly",
  "once",
  "manual",
  "custom",
];

/** Editable schedule: every repeat kind keeps its own fields so switching back and forth loses nothing. */
export interface ScheduleDraft {
  repeat: RepeatKind;
  /** Every N days / hours / minutes. Kept as text so the field can be emptied while typing. */
  interval: string;
  /** Weekly: 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
  /** Monthly: 1–31. */
  monthDay: number;
  /** Local wall-clock time, "HH:mm". */
  time: string;
  /** Once: local calendar date, "YYYY-MM-DD". */
  date: string;
  /** Custom: raw five-field cron expression. */
  cron: string;
}

const pad = (n: number): string => String(n).padStart(2, "0");

export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A fresh schedule: every day, a few minutes from now (rounded up to the next 5). */
export function defaultSchedule(now: Date = new Date()): ScheduleDraft {
  const soon = new Date(now.getTime() + 5 * 60_000);
  soon.setMinutes(Math.ceil(soon.getMinutes() / 5) * 5, 0, 0);
  return {
    repeat: "daily",
    interval: "1",
    weekdays: [1],
    monthDay: soon.getDate(),
    time: formatTime(soon),
    date: formatDate(soon),
    cron: "0 9 * * *",
  };
}

function parseTime(time: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return { hour: 9, minute: 0 };
  return { hour: Math.min(23, Number(match[1])), minute: Math.min(59, Number(match[2])) };
}

/** The local timestamp a once-schedule points at, or NaN while the date/time is incomplete. */
export function onceTimestamp(draft: Pick<ScheduleDraft, "date" | "time">): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) return Number.NaN;
  const { hour, minute } = parseTime(draft.time);
  const [y, m, d] = draft.date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, hour, minute, 0, 0).getTime();
}

function intervalOf(draft: ScheduleDraft): number {
  const n = Number(draft.interval);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** Turn the editor's schedule into the trigger the host stores. */
export function scheduleToTrigger(draft: ScheduleDraft): AutomationTrigger {
  const { hour, minute } = parseTime(draft.time);
  const n = intervalOf(draft);
  switch (draft.repeat) {
    case "manual":
      return { kind: "manual" };
    case "custom":
      return { kind: "cron", expression: draft.cron.trim() };
    case "once":
      return { kind: "once", at: onceTimestamp(draft) };
    case "weekdays":
      return { kind: "cron", expression: `${minute} ${hour} * * 1-5` };
    case "weekly": {
      const days = draft.weekdays.length > 0 ? [...draft.weekdays].sort((a, b) => a - b) : [1];
      return { kind: "cron", expression: `${minute} ${hour} * * ${days.join(",")}` };
    }
    case "daily":
      return { kind: "cron", expression: n === 1 ? `${minute} ${hour} * * *` : `${minute} ${hour} */${n} * *` };
    case "hourly":
      return { kind: "cron", expression: n === 1 ? `${minute} * * * *` : `${minute} */${n} * * *` };
    case "minutely":
      return { kind: "cron", expression: n === 1 ? "* * * * *" : `*/${n} * * * *` };
    case "monthly":
      return { kind: "cron", expression: `${minute} ${hour} ${draft.monthDay} * *` };
    default: {
      const unreachable: never = draft.repeat;
      return unreachable;
    }
  }
}

/** Recover the editor's schedule from a stored trigger; anything not produced by the editor becomes "custom". */
export function triggerToSchedule(trigger: AutomationTrigger, now: Date = new Date()): ScheduleDraft {
  const base = defaultSchedule(now);
  if (trigger.kind === "manual") return { ...base, repeat: "manual" };
  if (trigger.kind === "once") {
    const at = new Date(trigger.at);
    return { ...base, repeat: "once", date: formatDate(at), time: formatTime(at) };
  }
  const expr = trigger.expression.trim().replace(/\s+/g, " ");
  const custom: ScheduleDraft = { ...base, repeat: "custom", cron: trigger.expression };
  const at = (m: string, h: string): string => `${pad(Number(h))}:${pad(Number(m))}`;
  let m: RegExpExecArray | null;
  if ((m = /^(\d+) (\d+) \* \* 1-5$/.exec(expr))) return { ...base, repeat: "weekdays", time: at(m[1]!, m[2]!), cron: expr };
  if ((m = /^(\d+) (\d+) \* \* ([0-6](?:,[0-6])*)$/.exec(expr))) {
    return { ...base, repeat: "weekly", time: at(m[1]!, m[2]!), weekdays: m[3]!.split(",").map(Number), cron: expr };
  }
  if ((m = /^(\d+) (\d+) \* \* \*$/.exec(expr))) return { ...base, repeat: "daily", interval: "1", time: at(m[1]!, m[2]!), cron: expr };
  if ((m = /^(\d+) (\d+) \*\/(\d+) \* \*$/.exec(expr))) {
    return { ...base, repeat: "daily", interval: m[3]!, time: at(m[1]!, m[2]!), cron: expr };
  }
  if ((m = /^(\d+) \* \* \* \*$/.exec(expr))) return { ...base, repeat: "hourly", interval: "1", time: at(m[1]!, "0"), cron: expr };
  if ((m = /^(\d+) \*\/(\d+) \* \* \*$/.exec(expr))) {
    return { ...base, repeat: "hourly", interval: m[2]!, time: at(m[1]!, "0"), cron: expr };
  }
  if (expr === "* * * * *") return { ...base, repeat: "minutely", interval: "1", cron: expr };
  if ((m = /^\*\/(\d+) \* \* \* \*$/.exec(expr))) return { ...base, repeat: "minutely", interval: m[1]!, cron: expr };
  if ((m = /^(\d+) (\d+) (\d+) \* \*$/.exec(expr))) {
    return { ...base, repeat: "monthly", monthDay: Number(m[3]), time: at(m[1]!, m[2]!), cron: expr };
  }
  return custom;
}

export type ScheduleIssue = "interval" | "weekday" | "monthDay" | "time" | "date" | "past" | "cron";

/** First problem with a schedule that the host would reject (or silently misread), or undefined when it is fine. */
export function scheduleIssue(draft: ScheduleDraft, now: number = Date.now()): ScheduleIssue | undefined {
  const needsInterval = draft.repeat === "daily" || draft.repeat === "hourly" || draft.repeat === "minutely";
  if (needsInterval && !/^[1-9]\d{0,3}$/.test(draft.interval)) return "interval";
  if (draft.repeat === "weekly" && draft.weekdays.length === 0) return "weekday";
  if (draft.repeat === "monthly" && (!Number.isInteger(draft.monthDay) || draft.monthDay < 1 || draft.monthDay > 31)) return "monthDay";
  const needsTime = draft.repeat !== "manual" && draft.repeat !== "custom" && draft.repeat !== "minutely";
  if (needsTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) return "time";
  if (draft.repeat === "once") {
    const at = onceTimestamp(draft);
    if (!Number.isFinite(at)) return "date";
    if (at <= now) return "past";
  }
  if (draft.repeat === "custom" && draft.cron.trim().split(/\s+/).length !== 5) return "cron";
  return undefined;
}
