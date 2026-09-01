import { useEffect, useState } from "react";
import { Icon } from "./Icon.js";
import { PromptDock } from "./PromptDock.js";

interface TrustRequest {
	requestId: string;
	root: string;
}

const projectName = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() ?? root;

/**
 * Workspace trust gate (desktop). A cloned repo's `.deyin/hooks.json` and
 * `.deyin/mcp.json` can define shell commands; they only run after this
 * one-time decision. Renders through the prompt dock as the same inline card
 * used for tool permissions.
 */
export function WorkspaceTrustDialog() {
	const [req, setReq] = useState<TrustRequest | null>(null);

	useEffect(() => {
		// Desktop-only bridge; the web host leaves it undefined.
		return window.deyin.workspaceTrust?.onRequest((r) => setReq(r));
	}, []);

	if (!req) return null;

	const close = (decision: "trust" | "skip") => {
		window.deyin.workspaceTrust?.respond(req.requestId, decision);
		setReq(null);
	};

	return (
		<PromptDock>
			<div className="inline-card" role="alertdialog" aria-modal="false" aria-label="Trust this workspace?">
				<Icon name="shield" size={16} className="inline-card__icon" />
				<div className="inline-card__text">
					<div className="inline-card__title">
						Trust this workspace?
						<span className="inline-card__count">One-time</span>
					</div>
					<div className="inline-card__body">
						<code>{projectName(req.root)}</code> contains Deyin configuration (<code>.deyin/hooks.json</code> or{" "}
						<code>.deyin/mcp.json</code>) that can run commands when you send a message. Trust it only if you trust
						where this code came from. Skipping ignores that config for this run.
					</div>
				</div>
				<div className="inline-card__actions">
					<button type="button" className="btn btn--pill btn--ghost" onClick={() => close("skip")}>
						Skip workspace config
					</button>
					<button type="button" className="btn btn--pill btn--solid" onClick={() => close("trust")}>
						Trust and continue
					</button>
				</div>
			</div>
		</PromptDock>
	);
}
