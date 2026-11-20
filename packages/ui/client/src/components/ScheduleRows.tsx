import { useT } from "../i18n.js";
import { describeTimeZone } from "../automationFormat.js";
import { type RepeatKind, type ScheduleDraft } from "../automationSchedule.js";
import { RuleRow, RuleStepper, RuleTimeInput, RuleWeekdayRow } from "./AutomationRuleControls.js";
import { RuleSelect, type RuleOption } from "./RuleSelect.js";

export const SCHEDULE_REPEAT_ORDER: readonly RepeatKind[] = [
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

function repeatLabelKey(kind: RepeatKind) {
  switch (kind) {
    case "weekly":
      return "automations.repeat.weekly" as const;
    case "weekdays":
      return "automations.repeat.weekdays" as const;
    case "daily":
      return "automations.repeat.daily" as const;
    case "hourly":
      return "automations.repeat.hourly" as const;
    case "minutely":
      return "automations.repeat.minutely" as const;
    case "monthly":
      return "automations.repeat.monthly" as const;
    case "once":
      return "automations.repeat.once" as const;
    case "manual":
      return "automations.repeat.manual" as const;
    case "custom":
      return "automations.repeat.custom" as const;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}


interface ScheduleRowsProps {
  schedule: ScheduleDraft;
  onChange: (patch: Partial<ScheduleDraft>) => void;
  /** The current time, for the time-zone row. */
  now: number;
  /** Row ids are `${idPrefix}-<field>`, so two editors on one page never share a label target. */
  idPrefix: string;
  /** Which repeat choices to offer, in order; every kind by default. */
  kinds?: readonly RepeatKind[];
}

/** The Repeat / interval / day / time / zone rows shared by the automation and routine editors. */
export function ScheduleRows({ schedule, onChange, now, idPrefix, kinds = SCHEDULE_REPEAT_ORDER }: ScheduleRowsProps) {
  const t = useT();
  const rowId = (name: string) => `${idPrefix}-${name}`;
  const zone = describeTimeZone(new Date(now));
  const repeatOptions: RuleOption[] = kinds.map((kind) => ({ id: kind, label: t(repeatLabelKey(kind)) }));
  const hourlyMinute = Number(schedule.time.split(":")[1] ?? "0");
  return (
    <>
      <RuleSelect
        label={t("automations.field.repeat")}
        value={schedule.repeat}
        options={repeatOptions}
        onChange={(id) => onChange({ repeat: id as RepeatKind })}
      />
      {(schedule.repeat === "daily" || schedule.repeat === "hourly" || schedule.repeat === "minutely") && (
        <RuleRow label={t("automations.field.interval")} htmlFor={rowId("interval")}>
          <RuleStepper
            id={rowId("interval")}
            min={1}
            max={9999}
            value={Number(schedule.interval) || 1}
            onChange={(value) => onChange({ interval: String(value) })}
          />
        </RuleRow>
      )}
      {schedule.repeat === "weekly" && (
        <RuleWeekdayRow
          weekdays={schedule.weekdays}
          onToggle={(day) =>
            onChange({
              weekdays: schedule.weekdays.includes(day)
                ? schedule.weekdays.filter((d) => d !== day)
                : [...schedule.weekdays, day].sort((a, b) => a - b),
            })
          }
        />
      )}
      {schedule.repeat === "monthly" && (
        <RuleRow label={t("automations.field.monthDay")} htmlFor={rowId("monthDay")}>
          <RuleStepper
            id={rowId("monthDay")}
            min={1}
            max={31}
            value={schedule.monthDay}
            onChange={(value) => onChange({ monthDay: value })}
          />
        </RuleRow>
      )}
      {schedule.repeat === "once" && (
        <RuleRow label={t("automations.field.date")} htmlFor={rowId("date")}>
          <input
            id={rowId("date")}
            className="rule-input"
            type="date"
            value={schedule.date}
            onChange={(event) => onChange({ date: event.target.value })}
          />
        </RuleRow>
      )}
      {(schedule.repeat === "weekly" ||
        schedule.repeat === "weekdays" ||
        schedule.repeat === "daily" ||
        schedule.repeat === "monthly" ||
        schedule.repeat === "once") && (
        <RuleRow label={t("automations.field.time")} htmlFor={rowId("time")}>
          <RuleTimeInput id={rowId("time")} value={schedule.time} onChange={(time) => onChange({ time })} />
        </RuleRow>
      )}
      {schedule.repeat === "hourly" && (
        <RuleRow label={t("automations.field.minute")} htmlFor={rowId("minute")}>
          <RuleStepper
            id={rowId("minute")}
            min={0}
            max={59}
            value={Number.isFinite(hourlyMinute) ? hourlyMinute : 0}
            onChange={(minute) => onChange({ time: `${schedule.time.split(":")[0] ?? "00"}:${pad2(minute)}` })}
          />
        </RuleRow>
      )}
      {schedule.repeat === "custom" && (
        <RuleRow label={t("automations.cron")} htmlFor={rowId("cron")}>
          <input
            id={rowId("cron")}
            className="rule-input rule-input--mono"
            value={schedule.cron}
            spellCheck={false}
            onChange={(event) => onChange({ cron: event.target.value })}
          />
        </RuleRow>
      )}
      {schedule.repeat !== "manual" && (
        <div className="rule-row">
          <span className="rule-row__label">{t("automations.field.zone")}</span>
          <span className="rule-value rule-value--disabled">
            <span className="rule-value__text">{zone}</span>
          </span>
        </div>
      )}
    </>
  );
}
