import { useEffect, useMemo, useState } from "react";
import { Icon } from "./Icon.js";

export interface QuestionOption {
  id: string;
  label: string;
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

export function AskQuestionDialog({ title, questions, onSubmit, onCancel }: Props) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const canSubmit = useMemo(() => {
    return questions.every((q) => {
      const value = answers[q.id];
      if (q.allow_multiple) {
        const selected = Array.isArray(value) ? value : [];
        if (selected.includes(OTHER_ID)) return (otherText[q.id] ?? "").trim().length > 0;
        return selected.length > 0;
      }
      if (value === OTHER_ID) return (otherText[q.id] ?? "").trim().length > 0;
      return typeof value === "string" && value.length > 0;
    });
  }, [answers, otherText, questions]);

  const submit = () => {
    const out: Record<string, string | string[]> = {};
    for (const q of questions) {
      const value = answers[q.id];
      if (q.allow_multiple) {
        const selected = Array.isArray(value) ? [...value] : [];
        const idx = selected.indexOf(OTHER_ID);
        if (idx >= 0) {
          selected[idx] = `other:${(otherText[q.id] ?? "").trim()}`;
        }
        out[q.id] = selected;
      } else if (value === OTHER_ID) {
        out[q.id] = `other:${(otherText[q.id] ?? "").trim()}`;
      } else {
        out[q.id] = typeof value === "string" ? value : "";
      }
    }
    onSubmit(out);
  };

  return (
    <div className="approval ask-question" role="dialog" aria-modal="true">
      <div className="approval__box ask-question__box">
        <div className="approval__title">
          <Icon name="hand" size={15} />
          {title?.trim() || "Choose an option"}
        </div>
        <div className="ask-question__list">
          {questions.map((q) => (
            <fieldset key={q.id} className="ask-question__item">
              <legend className="ask-question__prompt">{q.prompt}</legend>
              <div className="ask-question__options">
                {q.options.map((opt) => {
                  const inputType = q.allow_multiple ? "checkbox" : "radio";
                  const checked = q.allow_multiple
                    ? Array.isArray(answers[q.id]) && (answers[q.id] as string[]).includes(opt.id)
                    : answers[q.id] === opt.id;
                  return (
                    <label key={opt.id} className="ask-question__option">
                      <input
                        type={inputType}
                        name={q.id}
                        checked={checked}
                        onChange={() => {
                          if (q.allow_multiple) {
                            const cur = Array.isArray(answers[q.id]) ? [...(answers[q.id] as string[])] : [];
                            const next = cur.includes(opt.id) ? cur.filter((id) => id !== opt.id) : [...cur, opt.id];
                            setAnswers((prev) => ({ ...prev, [q.id]: next }));
                          } else {
                            setAnswers((prev) => ({ ...prev, [q.id]: opt.id }));
                          }
                        }}
                      />
                      <span>{opt.label}</span>
                    </label>
                  );
                })}
                <label className="ask-question__option">
                  <input
                    type={q.allow_multiple ? "checkbox" : "radio"}
                    name={q.id}
                    checked={
                      q.allow_multiple
                        ? Array.isArray(answers[q.id]) && (answers[q.id] as string[]).includes(OTHER_ID)
                        : answers[q.id] === OTHER_ID
                    }
                    onChange={() => {
                      if (q.allow_multiple) {
                        const cur = Array.isArray(answers[q.id]) ? [...(answers[q.id] as string[])] : [];
                        const next = cur.includes(OTHER_ID) ? cur.filter((id) => id !== OTHER_ID) : [...cur, OTHER_ID];
                        setAnswers((prev) => ({ ...prev, [q.id]: next }));
                      } else {
                        setAnswers((prev) => ({ ...prev, [q.id]: OTHER_ID }));
                      }
                    }}
                  />
                  <span>Other</span>
                </label>
                {(q.allow_multiple
                  ? Array.isArray(answers[q.id]) && (answers[q.id] as string[]).includes(OTHER_ID)
                  : answers[q.id] === OTHER_ID) && (
                  <input
                    className="ask-question__other"
                    type="text"
                    placeholder="Type your answer…"
                    value={otherText[q.id] ?? ""}
                    onChange={(e) => setOtherText((prev) => ({ ...prev, [q.id]: e.target.value }))}
                  />
                )}
              </div>
            </fieldset>
          ))}
        </div>
        <div className="approval__actions">
          <button type="button" className="btn btn--outline" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn" disabled={!canSubmit} onClick={submit}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
