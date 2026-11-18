import type { ReactNode } from "react";
import { I18nProvider } from "./i18n.js";
import { ConfirmDialogProvider } from "./components/ConfirmDialog.js";
import { PromptDockFallback } from "./components/PromptDock.js";
import { UpdateInstallOverlay } from "./components/UpdateInstallOverlay.js";
import { BotRunProvider } from "./hooks/useBotRun.js";

/**
 * Root UI providers: translations plus shared confirmation dialogs. The prompt
 * dock fallback lives here so accept/reject cards stay reachable from every
 * view root (workspace, settings, plans) even when the composer is unmounted.
 * The update-install overlay lives here for the same reason: it must cover
 * whichever view root is showing when "Restart to update" is clicked.
 * Bot pipeline run state lives here so the run strip and the Bot Flow tab share
 * one event subscription that outlives the right panel.
 */
export function AppProviders({
	language,
	onBotRunStarted,
	children,
}: {
	language: string;
	onBotRunStarted?: (runId: string) => void;
	children: ReactNode;
}) {
	return (
		<I18nProvider language={language}>
			<ConfirmDialogProvider>
				<BotRunProvider onRunStarted={onBotRunStarted}>
					{children}
					<PromptDockFallback />
					<UpdateInstallOverlay />
				</BotRunProvider>
			</ConfirmDialogProvider>
		</I18nProvider>
	);
}
