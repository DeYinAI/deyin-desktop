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
import { Icon } from "./Icon.js";
import { PromptDock } from "./PromptDock.js";

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

/**
 * App-wide confirmation prompts (replaces blocking `window.confirm`). Renders
 * through the prompt dock — above the composer in the workspace, bottom-center
 * elsewhere — as the same inline card the agent's permission prompts use.
 */
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
				<PromptDock>
					<div
						className="inline-card"
						role="alertdialog"
						aria-modal="false"
						aria-labelledby="confirm-dialog-title"
						aria-describedby="confirm-dialog-message"
					>
						<Icon name="shield" size={16} className="inline-card__icon" />
						<div className="inline-card__text">
							<div className="inline-card__title" id="confirm-dialog-title">
								{current.options.title ?? (current.options.destructive ? "Are you sure?" : "Confirm")}
							</div>
							<div className="inline-card__body" id="confirm-dialog-message">
								{current.options.message}
							</div>
						</div>
						<div className="inline-card__actions">
							<button type="button" className="btn btn--pill btn--ghost" autoFocus onClick={() => finish(false)}>
								{current.options.cancelLabel ?? t("common.cancel")}
							</button>
							<button
								type="button"
								className={`btn btn--pill ${current.options.destructive ? "btn--danger" : "btn--solid"}`}
								onClick={() => finish(true)}
							>
								{current.options.confirmLabel ?? t("common.confirm")}
							</button>
						</div>
					</div>
				</PromptDock>
			)}
		</ConfirmContext.Provider>
	);
}

/** Non-blocking confirmation dialog matching the app's inline prompt cards. */
export function useConfirm(): { confirm: ConfirmFn } {
	const confirm = useContext(ConfirmContext);
	if (!confirm) {
		throw new Error("useConfirm must be used within ConfirmDialogProvider");
	}
	return { confirm };
}
