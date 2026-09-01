import { useEffect, useState } from "react";
import { Icon } from "./Icon.js";
import { PromptDock } from "./PromptDock.js";

interface AppApprovalRequest {
	requestId: string;
	appId: string;
	action: string;
}

/** First-use app approval for Computer Use plugin tools. */
export function AppApprovalDialog() {
	const [req, setReq] = useState<AppApprovalRequest | null>(null);

	useEffect(() => {
		// Desktop-only bridge; the web host leaves it undefined.
		return window.deyin.computerUse?.onAppApprovalRequest((r) => setReq(r));
	}, []);

	if (!req) return null;

	const close = (decision: "always" | "once" | "deny") => {
		window.deyin.computerUse?.respondAppApproval(req.requestId, decision);
		setReq(null);
	};

	const actionLabel = req.action === "launch" ? "launch" : "interact with";

	return (
		<PromptDock>
			<div className="inline-card" role="alertdialog" aria-modal="false" aria-label="Computer use app approval">
				<Icon name="hand" size={16} className="inline-card__icon" />
				<div className="inline-card__text">
					<div className="inline-card__title">
						Allow computer use?
						<span className="inline-card__count">App approval</span>
					</div>
					<div className="inline-card__body">
						Deyin wants to {actionLabel} <code>{req.appId}</code>. “Always allow” adds it to the list in Settings →
						Computer Use; press Esc at any time during automation to cancel.
					</div>
				</div>
				<div className="inline-card__actions">
					<button type="button" className="btn btn--pill btn--ghost" onClick={() => close("deny")}>
						Deny
					</button>
					<button type="button" className="btn btn--pill btn--solid" onClick={() => close("once")}>
						Allow once
					</button>
					<button type="button" className="btn btn--pill btn--outline" onClick={() => close("always")}>
						Always allow
					</button>
				</div>
			</div>
		</PromptDock>
	);
}
