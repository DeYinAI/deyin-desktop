import type { ReactNode } from "react";
import { I18nProvider } from "./i18n.js";
import { ConfirmDialogProvider } from "./components/ConfirmDialog.js";

/** Root UI providers: translations plus shared confirmation dialogs. */
export function AppProviders({ language, children }: { language: string; children: ReactNode }) {
  return (
    <I18nProvider language={language}>
      <ConfirmDialogProvider>{children}</ConfirmDialogProvider>
    </I18nProvider>
  );
}
