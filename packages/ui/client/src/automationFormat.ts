import type { AutomationTrigger } from "@deyin/contract";
import type { MessageKey } from "@deyin/host-core/shared";
import { triggerToSchedule } from "./automationSchedule.js";

type Translate = (key: MessageKey) => string;

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ""));
}

/** Localized weekday name; 0 = Sunday. */
export function weekdayName(day: number, locale?: string, style: "short" | "long" = "short"): string {
  // 2023-01-01 was a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: style }).format(new Date(2023, 0, 1 + day));
}

/** "Every day at 09:00", "Weekly on Mon, Wed at 18:30", "Manual only", … */
export function describeSchedule(trigger: AutomationTrigger, t: Translate, locale?: string): string {
  const s = triggerToSchedule(trigger);
  const n = Number(s.interval) || 1;
  const minute = s.time.split(":")[1] ?? "00";
  switch (s.repeat) {
    case "manual":
      return t("automations.freq.manual");
    case "custom":
      return s.cron.trim();
    case "once": {
      const at = trigger.kind === "once" ? trigger.at : Number.NaN;
      const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
      return fill(t("automations.freq.once"), { date });
    }
    case "weekdays":
      return fill(t("automations.freq.weekdays"), { time: s.time });
    case "weekly": {
      const days = [...s.weekdays].sort((a, b) => a - b).map((d) => weekdayName(d, locale));
      return fill(t("automations.freq.weekly"), { days: days.join(", "), time: s.time });
    }
    case "daily":
      return n === 1
        ? fill(t("automations.freq.daily"), { time: s.time })
        : fill(t("automations.freq.dailyN"), { n, time: s.time });
    case "hourly":
      return n === 1
        ? fill(t("automations.freq.hourly"), { minute })
        : fill(t("automations.freq.hourlyN"), { n, minute });
    case "minutely":
      return n === 1 ? t("automations.freq.minutely") : fill(t("automations.freq.minutelyN"), { n });
    case "monthly":
      return fill(t("automations.freq.monthly"), { day: s.monthDay, time: s.time });
    default: {
      const unreachable: never = s.repeat;
      return unreachable;
    }
  }
}

const UNITS: ReadonlyArray<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: "day", ms: 86_400_000 },
  { unit: "hour", ms: 3_600_000 },
  { unit: "minute", ms: 60_000 },
];

/** "in 3 hours", "in 20 minutes" — rounded to the largest unit that fits at least once. */
export function formatRelative(at: number, now: number, locale?: string): string {
  const diff = at - now;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const { unit, ms } of UNITS) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(Math.round(diff / 1000), "second");
}

/** "Wed, Nov 18, 8:45 PM (in 3 hours)". */
export function formatNextRun(at: number, now: number, locale?: string): string {
  const date = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
  return `${date} (${formatRelative(at, now, locale)})`;
}

/** "UTC+01:00 · Europe/London": the offset in force at `at`, then the system zone name. */
export function describeTimeZone(at: Date): string {
  const offsetMinutes = -at.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)} · ${zone}`;
}
