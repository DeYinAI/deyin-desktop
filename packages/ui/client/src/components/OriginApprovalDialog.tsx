import { useEffect, useState } from "react";
import { originActionVerb } from "../chromeStatus.js";
import { Icon } from "./Icon.js";
import { PromptDock } from "./PromptDock.js";

interface OriginApprovalRequest {
	requestId: string;
	origin: string;
	action: string;
}

/**
 * First-use approval for a site in the user's real Chrome. Several
 * conversations can ask at once, so requests queue instead of replacing each
 * other (a replaced request would never be answered and would stall its run).
 */
export function OriginApprovalDialog() {
	const [queue, setQueue] = useState<OriginApprovalRequest[]>([]);

	useEffect(() => {
		// Desktop-only bridge; the web host leaves it undefined.
		return window.deyin.chrome?.onOriginApprovalRequest((r) => setQueue((q) => [...q, r]));
	}, []);

	const req = queue[0];
	if (!req) return null;

	const close = (decision: "always" | "once" | "deny") => {
		window.deyin.chrome?.respondOriginApproval(req.requestId, decision);
		setQueue((q) => q.filter((r) => r.requestId !== req.requestId));
	};

	return (
		<PromptDock>
			<div className="inline-card" role="alertdialog" aria-modal="false" aria-label="Chrome site approval">
				<Icon name="hand" size={16} className="inline-card__icon" />
				<div className="inline-card__text">
					<div className="inline-card__title">
						Allow this site in Chrome?
						{queue.length > 1 && <span className="inline-card__count">{queue.length} waiting</span>}
					</div>
					<div className="inline-card__body">
						Deyin wants to {originActionVerb(req.action)} <code>{req.origin}</code> in your Chrome, in its own background tab. “Always
						allow” adds it to Settings → Chrome. You can press Stop there, or in the extension, to cut access at any time.
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
