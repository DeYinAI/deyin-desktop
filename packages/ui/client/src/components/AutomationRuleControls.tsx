import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import { weekdayName } from "../automationFormat.js";
import { useT } from "../i18n.js";
import { Icon } from "./Icon.js";

/** Monday first, as the weekday pills are laid out; values are Date weekdays (0 = Sunday). */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

interface RowProps {
  label: string;
  children: ReactNode;
  /** Id of the control the label points at. */
  htmlFor?: string;
}

/** A labelled row of the rules card whose control is not a menu. */
export function RuleRow({ label, htmlFor, children }: RowProps) {
  return (
    <div className="rule-row">
      <label className="rule-row__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

interface StepperProps {
  id: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}

/** Whole-number pill with hover arrows; values clamp, and an emptied field stages nothing. */
export function RuleStepper({ id, min, max, value, onChange }: StepperProps) {
  const t = useT();
  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  return (
    <span className="rule-stepper" style={{ "--interval-digits": String(value).length } as CSSProperties}>
      <input
        id={id}
        className="rule-stepper__input"
        type="number"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (event.target.value === "" || !Number.isSafeInteger(next)) return;
          onChange(clamp(next));
        }}
      />
      <span className="rule-stepper__arrows">
        <button
          type="button"
          className="rule-stepper__arrow"
          aria-label={t("automations.stepper.increase")}
          disabled={value >= max}
          onClick={() => onChange(clamp(value + 1))}
        >
          <Icon name="chevronDown" size={9} className="rule-stepper__up" />
        </button>
        <button
          type="button"
          className="rule-stepper__arrow"
          aria-label={t("automations.stepper.decrease")}
          disabled={value <= min}
          onClick={() => onChange(clamp(value - 1))}
        >
          <Icon name="chevronDown" size={9} />
        </button>
      </span>
    </span>
  );
}

interface WeekdayRowProps {
  weekdays: readonly number[];
  onToggle: (day: number) => void;
}

/** One pill per weekday; the group is named by the row's label. */
export function RuleWeekdayRow({ weekdays, onToggle }: WeekdayRowProps) {
  const t = useT();
  const labelId = useId();
  return (
    <div className="rule-row">
      <span className="rule-row__label" id={labelId}>
        {t("automations.field.weekdays")}
      </span>
      <div className="rule-weekdays" role="group" aria-labelledby={labelId}>
        {WEEKDAY_ORDER.map((day) => {
          const selected = weekdays.includes(day);
          return (
            <button
              key={day}
              type="button"
              className={`rule-pill${selected ? " rule-pill--active" : ""}`}
              aria-pressed={selected}
              aria-label={weekdayName(day, undefined, "long")}
              onClick={() => onToggle(day)}
            >
              {weekdayName(day)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface TimeInputProps {
  id: string;
  /** "HH:mm". */
  value: string;
  onChange: (value: string) => void;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * 24-hour time as two digit fields, so it reads the same as the schedule summary whatever the system's
 * clock format is. A half-typed value stays local; the schedule only sees complete, valid times.
 */
export function RuleTimeInput({ id, value, onChange }: TimeInputProps) {
  const [h, m] = value.split(":");
  const [hour, setHour] = useState(h ?? "");
  const [minute, setMinute] = useState(m ?? "");
  useEffect(() => {
    setHour(h ?? "");
    setMinute(m ?? "");
  }, [h, m]);

  const commit = (nextHour: string, nextMinute: string) => {
    const hh = Number(nextHour);
    const mm = Number(nextMinute);
    if (nextHour === "" || nextMinute === "" || !Number.isInteger(hh) || !Number.isInteger(mm)) return;
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return;
    onChange(`${pad2(hh)}:${pad2(mm)}`);
  };
  const digits = (raw: string) => raw.replace(/\D/g, "").slice(0, 2);
  const settle = () => {
    setHour(h ?? "");
    setMinute(m ?? "");
  };

  return (
    <span className="rule-time">
      <input
        id={id}
        className="rule-time__field"
        inputMode="numeric"
        aria-label="HH"
        value={hour}
        onChange={(event) => {
          const next = digits(event.target.value);
          setHour(next);
          commit(next, minute);
        }}
        onBlur={settle}
      />
      <span className="rule-time__colon">:</span>
      <input
        className="rule-time__field"
        inputMode="numeric"
        aria-label="mm"
        value={minute}
        onChange={(event) => {
          const next = digits(event.target.value);
          setMinute(next);
          commit(hour, next);
        }}
        onBlur={settle}
      />
      <Icon name="clock" size={14} className="rule-time__icon" />
    </span>
  );
}
