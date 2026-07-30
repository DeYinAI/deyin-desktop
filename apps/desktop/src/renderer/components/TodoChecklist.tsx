import type { AgentTodoItem, AgentTodoStatus } from "../../shared/types.js";
import { Icon } from "./Icon.js";

export type TodoDisplayStatus = AgentTodoStatus;

export interface TodoDisplayItem {
  id: string;
  content: string;
  status: TodoDisplayStatus;
}

/** Exclude cancelled items from progress totals (matches TaskList / TodoCard). */
export function countVisibleTodos(todos: ReadonlyArray<{ status?: TodoDisplayStatus | string }>): {
  visible: number;
  done: number;
} {
  const counted = todos.filter((t) => t.status !== "cancelled");
  return {
    visible: counted.length,
    done: counted.filter((t) => t.status === "completed").length,
  };
}

export function todosToDisplay(todos: AgentTodoItem[]): TodoDisplayItem[] {
  return todos.map((t) => ({ id: t.id, content: t.content, status: t.status }));
}

/** Circular Cursor-style status marker for a single todo. */
export function TodoStatusIndicator({
  status,
  running = false,
  interactive = false,
}: {
  status: TodoDisplayStatus;
  /** Animate the in-progress ring while the owning agent run is live. */
  running?: boolean;
  /** Render as a button affordance (hover) without wiring the click here. */
  interactive?: boolean;
}) {
  const live = status === "in_progress" && running;
  return (
    <span
      className={[
        "todo-indicator",
        `todo-indicator--${status}`,
        live ? "todo-indicator--live" : "",
        interactive ? "todo-indicator--interactive" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-hidden="true"
    >
      {status === "completed" && <Icon name="check" size={9} />}
      {status === "cancelled" && <Icon name="close" size={8} />}
      {status === "in_progress" && <Icon name="arrowRight" size={8} className="todo-indicator__arrow" />}
    </span>
  );
}

/** One checklist row with optional click-to-toggle when idle. */
export function TodoRow({
  item,
  running = false,
  onToggle,
}: {
  item: TodoDisplayItem;
  running?: boolean;
  /** When set and the agent is idle, clicking toggles completed ↔ pending. */
  onToggle?: (id: string) => void;
}) {
  const canToggle = Boolean(onToggle) && !running && (item.status === "pending" || item.status === "completed");
  const body = (
    <>
      <TodoStatusIndicator status={item.status} running={running} interactive={canToggle} />
      <span className="todo-row__text">{item.content}</span>
    </>
  );

  if (canToggle) {
    return (
      <button
        type="button"
        className={`todo-row todo-row--${item.status} todo-row--button`}
        onClick={() => onToggle?.(item.id)}
      >
        {body}
      </button>
    );
  }

  return <div className={`todo-row todo-row--${item.status}`}>{body}</div>;
}

/** Flat list of todo rows (cancelled included unless filtered by the caller). */
export function TodoRows({
  items,
  running = false,
  onToggle,
}: {
  items: TodoDisplayItem[];
  running?: boolean;
  onToggle?: (id: string) => void;
}) {
  return (
    <div className="todo-rows">
      {items.map((item) => (
        <TodoRow key={item.id} item={item} running={running} onToggle={onToggle} />
      ))}
    </div>
  );
}
