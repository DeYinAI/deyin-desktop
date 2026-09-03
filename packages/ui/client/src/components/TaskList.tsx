import { useMemo, useState, type MouseEvent } from "react";
import { useT } from "../i18n.js";
import { Icon } from "./Icon.js";
import type { AgentTodoItem } from "@deyin/contract";
import { TodoRows, countVisibleTodos, todosToDisplay } from "./TodoChecklist.js";

interface TaskListProps {
  todos: AgentTodoItem[];
  /** True while the agent run that owns these todos is still streaming. */
  running: boolean;
  /** Optional subtitle shown as "Build :: {title}" in the collapsed bar. */
  title?: string;
}

/** Stable identity for a todo list — used to re-show the bar when a new list arrives. */
function todoListFingerprint(todos: AgentTodoItem[]): string {
  return todos
    .filter((todo) => todo.status !== "cancelled")
    .map((todo) => `${todo.id}:${todo.status}:${todo.content}`)
    .join("|");
}

/**
 * Pinned task list above the composer (Cursor-style): expandable checklist with
 * a Build header and circular status markers. Fed by the thread's persisted
 * todo list, so it survives run folding and restarts.
 */
export function TaskList({ todos, running, title }: TaskListProps) {
  const [open, setOpen] = useState(true);
  const [dismissedFingerprint, setDismissedFingerprint] = useState<string | null>(null);
  const t = useT();

  const visible = todos.filter((todo) => todo.status !== "cancelled");
  const fingerprint = useMemo(() => todoListFingerprint(todos), [todos]);

  if (visible.length === 0) return null;

  const { done } = countVisibleTodos(visible);
  const current = visible.find((todo) => todo.status === "in_progress") ?? visible.find((todo) => todo.status === "pending");
  const allDone = done === visible.length;

  if (allDone && dismissedFingerprint === fingerprint) return null;

  const headerLabel = title
    ? `${t("chat.build")} :: ${title}`
    : allDone
      ? t("tasks.allDone")
      : (current?.content ?? t("tasks.title"));

  const dismiss = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setDismissedFingerprint(fingerprint);
  };

  return (
    <div className={`tasklist ${open ? "tasklist--open" : ""}`}>
      <div className="tasklist__bar">
        <button type="button" className="tasklist__toggle" onClick={() => setOpen((v) => !v)}>
          {allDone ? (
            <span className="todo-indicator todo-indicator--completed">
              <Icon name="check" size={9} />
            </span>
          ) : (
            <span className={`todo-indicator todo-indicator--in_progress ${running ? "todo-indicator--live" : ""}`}>
              <Icon name="arrowRight" size={8} className="todo-indicator__arrow" />
            </span>
          )}
          <span className="tasklist__label">{headerLabel}</span>
          <span className="tasklist__count">
            {done}/{visible.length}
          </span>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={11} className="tasklist__chevron" />
        </button>
        {allDone && (
          <button
            type="button"
            className="tasklist__dismiss"
            title={t("tasks.dismiss")}
            aria-label={t("tasks.dismiss")}
            onClick={dismiss}
          >
            <Icon name="close" size={11} />
          </button>
        )}
      </div>
      {open && (
        <div className="tasklist__items">
          <TodoRows items={todosToDisplay(visible)} running={running} />
        </div>
      )}
    </div>
  );
}
