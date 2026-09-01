import type { ReactNode } from "react";
import { I18nProvider } from "./i18n.js";
import { ConfirmDialogProvider } from "./components/ConfirmDialog.js";
import { PromptDockFallback } from "./components/PromptDock.js";

/**
 * Root UI providers: translations plus shared confirmation dialogs. The prompt
 * dock fallback lives here so accept/reject cards stay reachable from every
 * view root (workspace, settings, plans) even when the composer is unmounted.
 */
export function AppProviders({ language, children }: { language: string; children: ReactNode }) {
	return (
		<I18nProvider language={language}>
			<ConfirmDialogProvider>
				{children}
				<PromptDockFallback />
			</ConfirmDialogProvider>
		</I18nProvider>
	);
}
