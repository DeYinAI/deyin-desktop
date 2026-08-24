import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useT } from "../i18n.js";

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface ConfirmRequest {
  options: ConfirmOptions;
  resolve: (accepted: boolean) => void;
}

type ConfirmFn = (options: ConfirmOptions | string) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

function normalizeOptions(options: ConfirmOptions | string): ConfirmOptions {
  return typeof options === "string" ? { message: options } : options;
}

/** App-wide styled confirmation prompts (replaces blocking `window.confirm`). */
export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [queue, setQueue] = useState<ConfirmRequest[]>([]);
  const queueRef = useRef(queue);
  queueRef.current = queue;

  const confirm = useCallback<ConfirmFn>((options) => {
    const normalized = normalizeOptions(options);
    return new Promise<boolean>((resolve) => {
      setQueue((prev) => [...prev, { options: normalized, resolve }]);
    });
  }, []);

  const current = queue[0] ?? null;

  const finish = useCallback((accepted: boolean) => {
    const pending = queueRef.current[0];
    if (!pending) return;
    pending.resolve(accepted);
    setQueue((prev) => prev.slice(1));
  }, []);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, finish]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {current && (
        <div
          className="goal-modal-backdrop"
          role="presentation"
          onClick={() => finish(false)}
        >
          <div
            className="goal-modal confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-message"
            onClick={(e) => e.stopPropagation()}
          >
            {current.options.title ? (
              <div className="goal-modal__title" id="confirm-dialog-title">
                {current.options.title}
              </div>
            ) : null}
            <p
              className="confirm-dialog__message"
              id={current.options.title ? "confirm-dialog-message" : "confirm-dialog-title"}
            >
              {current.options.message}
            </p>
            <div className="goal-modal__actions">
              <button
                type="button"
                className="chip chip--small"
                autoFocus
                onClick={() => finish(false)}
              >
                {current.options.cancelLabel ?? t("common.cancel")}
              </button>
              <button
                type="button"
                className={`chip chip--small${
                  current.options.destructive
                    ? " confirm-dialog__confirm--danger"
                    : " confirm-dialog__confirm--primary"
                }`}
                onClick={() => finish(true)}
              >
                {current.options.confirmLabel ?? t("common.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

/** Non-blocking confirmation dialog matching app modal styling. */
export function useConfirm(): { confirm: ConfirmFn } {
  const confirm = useContext(ConfirmContext);
  if (!confirm) {
    throw new Error("useConfirm must be used within ConfirmDialogProvider");
  }
  return { confirm };
}
