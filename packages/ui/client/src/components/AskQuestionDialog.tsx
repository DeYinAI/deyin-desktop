import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "./Icon.js";

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface QuestionItem {
  id: string;
  prompt: string;
  allow_multiple?: boolean;
  options: QuestionOption[];
}

interface Props {
  title?: string;
  questions: QuestionItem[];
  onSubmit: (answers: Record<string, string | string[]>) => void;
  onCancel: () => void;
}

const OTHER_ID = "__other__";

type Answers = Record<string, string | string[]>;

function isAnswered(q: QuestionItem, answers: Answers, otherText: Record<string, string>): boolean {
  const value = answers[q.id];
  if (q.allow_multiple) {
    const selected = Array.isArray(value) ? value : [];
    if (selected.includes(OTHER_ID)) return (otherText[q.id] ?? "").trim().length > 0;
    return selected.length > 0;
  }
  if (value === OTHER_ID) return (otherText[q.id] ?? "").trim().length > 0;
  return typeof value === "string" && value.length > 0;
}

/**
 * One question at a time, sitting in the composer stack. Single-select answers
 * commit on click and step to the next question (or submit on the last one);
 * multi-select waits for Continue. "Other" is a footer affordance, not a row in
 * the list, so the options stay a clean numbered set.
 */
export function AskQuestionDialog({ title, questions, onSubmit, onCancel }: Props) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});

  const question = questions[Math.min(index, questions.length - 1)];
  const multi = question?.allow_multiple === true;
  const showOther = question ? (otherOpen[question.id] ?? false) : false;

  const encode = useCallback(
    (source: Answers, text: Record<string, string>): Answers => {
      const out: Answers = {};
      for (const q of questions) {
        const value = source[q.id];
        if (q.allow_multiple) {
          const selected = Array.isArray(value) ? [...value] : [];
          const idx = selected.indexOf(OTHER_ID);
          if (idx >= 0) selected[idx] = `other:${(text[q.id] ?? "").trim()}`;
          out[q.id] = selected;
        } else if (value === OTHER_ID) {
          out[q.id] = `other:${(text[q.id] ?? "").trim()}`;
        } else {
          out[q.id] = typeof value === "string" ? value : "";
        }
      }
      return out;
    },
    [questions],
  );

  const complete = useMemo(
    () => questions.every((q) => isAnswered(q, answers, otherText)),
    [answers, otherText, questions],
  );

  const currentAnswered = question ? isAnswered(question, answers, otherText) : false;
  const lastIndex = questions.length - 1;

  const submit = useCallback(
    (source: Answers = answers, text: Record<string, string> = otherText) => {
      onSubmit(encode(source, text));
    },
    [answers, encode, onSubmit, otherText],
  );

  /** Commit the current question and either advance or submit the whole set. */
  const advance = useCallback(
    (source: Answers, text: Record<string, string> = otherText) => {
      const nextUnanswered = questions.findIndex((q, i) => i > index && !isAnswered(q, source, text));
      if (nextUnanswered >= 0) {
        setIndex(nextUnanswered);
        return;
      }
      if (questions.every((q) => isAnswered(q, source, text))) submit(source, text);
      else setIndex(questions.findIndex((q) => !isAnswered(q, source, text)));
    },
    [index, otherText, questions, submit],
  );

  const pick = useCallback(
    (optionId: string) => {
      if (!question) return;
      if (multi) {
        const cur = Array.isArray(answers[question.id]) ? [...(answers[question.id] as string[])] : [];
        const next = cur.includes(optionId) ? cur.filter((id) => id !== optionId) : [...cur, optionId];
        setAnswers((prev) => ({ ...prev, [question.id]: next }));
        return;
      }
      const next = { ...answers, [question.id]: optionId };
      setAnswers(next);
      if (optionId === OTHER_ID) {
        setOtherOpen((prev) => ({ ...prev, [question.id]: true }));
        return;
      }
      setOtherOpen((prev) => ({ ...prev, [question.id]: false }));
      advance(next);
    },
    [advance, answers, multi, question],
  );

  const isSelected = useCallback(
    (optionId: string) => {
      if (!question) return false;
      const value = answers[question.id];
      return multi ? Array.isArray(value) && value.includes(optionId) : value === optionId;
    },
    [answers, multi, question],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowRight" && index < lastIndex) setIndex(index + 1);
      else if (e.key === "ArrowLeft" && index > 0) setIndex(index - 1);
      else if (/^[1-9]$/.test(e.key)) {
        const opt = question?.options[Number(e.key) - 1];
        if (opt) {
          e.preventDefault();
          pick(opt.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, lastIndex, onCancel, pick, question]);

  if (!question) return null;

  const otherValue = otherText[question.id] ?? "";
  const otherReady = otherValue.trim().length > 0;

  return (
    <div className="askq" role="group" aria-label={title?.trim() || "Choose an option"}>
      <div className="askq__head">
        <div className="askq__prompt">{question.prompt}</div>
        {questions.length > 1 && (
          <div className="askq__nav">
            <button
              type="button"
              className="askq__navbtn"
              aria-label="Previous question"
              disabled={index === 0}
              onClick={() => setIndex(index - 1)}
            >
              <Icon name="chevronLeft" size={13} />
            </button>
            <span className="askq__count">
              {index + 1}/{questions.length}
            </span>
            <button
              type="button"
              className="askq__navbtn"
              aria-label="Next question"
              disabled={index >= lastIndex}
              onClick={() => setIndex(index + 1)}
            >
              <Icon name="chevronRight" size={13} />
            </button>
          </div>
        )}
        <button type="button" className="askq__close" aria-label="Dismiss" onClick={onCancel}>
          <Icon name="close" size={12} />
        </button>
      </div>

      <div className="askq__options" role={multi ? "group" : "radiogroup"}>
        {question.options.map((opt, i) => {
          const selected = isSelected(opt.id);
          return (
            <button
              key={opt.id}
              type="button"
              role={multi ? "checkbox" : "radio"}
              aria-checked={selected}
              className={`askq__option${selected ? " askq__option--on" : ""}`}
              onClick={() => pick(opt.id)}
            >
              <span className="askq__index">{multi ? <Icon name="check" size={11} /> : i + 1}</span>
              <span className="askq__body">
                <span className="askq__label">
                  {opt.label}
                  {opt.recommended && <span className="askq__badge">Recommended</span>}
                </span>
                {opt.description && <span className="askq__desc">{opt.description}</span>}
              </span>
              {!multi && <Icon name="arrowRight" size={13} className="askq__go" />}
            </button>
          );
        })}
      </div>

      <div className="askq__foot">
        <button
          type="button"
          className={`askq__other${showOther || isSelected(OTHER_ID) ? " askq__other--on" : ""}`}
          onClick={() => {
            const next = !showOther;
            setOtherOpen((prev) => ({ ...prev, [question.id]: next }));
            if (next) pick(OTHER_ID);
            else if (!multi && answers[question.id] === OTHER_ID) {
              setAnswers((prev) => {
                const copy = { ...prev };
                delete copy[question.id];
                return copy;
              });
            }
          }}
        >
          <Icon name="pencil" size={12} />
          <span>Something else</span>
        </button>
        <div className="askq__actions">
          <button type="button" className="btn btn--pill btn--ghost askq__skip" onClick={onCancel}>
            Skip
          </button>
          {(multi || showOther) && (
            <button
              type="button"
              className="btn btn--pill btn--solid"
              disabled={!currentAnswered}
              onClick={() => advance(answers, otherText)}
            >
              {index < lastIndex || !complete ? "Next" : "Continue"}
            </button>
          )}
        </div>
      </div>

      {showOther && (
        <input
          className="askq__input"
          type="text"
          autoFocus
          placeholder="Tell the agent what to do instead…"
          value={otherValue}
          onChange={(e) => setOtherText((prev) => ({ ...prev, [question.id]: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !otherReady) return;
            e.preventDefault();
            const nextText = { ...otherText, [question.id]: otherValue };
            const nextAnswers = multi
              ? answers
              : ({ ...answers, [question.id]: OTHER_ID } satisfies Answers);
            setAnswers(nextAnswers);
            advance(nextAnswers, nextText);
          }}
        />
      )}
    </div>
  );
}
