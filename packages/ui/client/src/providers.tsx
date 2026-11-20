import type { ReactNode } from "react";
import { I18nProvider } from "./i18n.js";
import { ConfirmDialogProvider } from "./components/ConfirmDialog.js";
import { PromptDockFallback } from "./components/PromptDock.js";
import { UpdateInstallOverlay } from "./components/UpdateInstallOverlay.js";
import { ConductorRunProvider } from "./hooks/useConductorRun.js";

/**
 * Root UI providers: translations plus shared confirmation dialogs. The prompt
 * dock fallback lives here so accept/reject cards stay reachable from every
 * view root (workspace, settings, plans) even when the composer is unmounted.
 * The update-install overlay lives here for the same reason: it must cover
 * whichever view root is showing when "Restart to update" is clicked.
 * Pipeline run state lives here so the run strip and the Pipeline tab share
 * one event subscription that outlives the right panel.
 */
export function AppProviders({
	language,
	onConductorRunStarted,
	children,
}: {
	language: string;
	onConductorRunStarted?: (runId: string) => void;
	children: ReactNode;
}) {
	return (
		<I18nProvider language={language}>
			<ConfirmDialogProvider>
				<ConductorRunProvider onRunStarted={onConductorRunStarted}>
					{children}
					<PromptDockFallback />
					<UpdateInstallOverlay />
				</ConductorRunProvider>
			</ConfirmDialogProvider>
		</I18nProvider>
	);
}
