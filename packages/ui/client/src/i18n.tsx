import { createContext, useContext, useMemo, type ReactNode } from "react";
import { translate, type MessageKey } from "@deyin/host-core/shared";

type Translate = (key: MessageKey) => string;

const I18nContext = createContext<Translate>((key) => translate("en", key));

/** Provides the active interface language (settings.language) to every component. */
export function I18nProvider({ language, children }: { language: string; children: ReactNode }) {
  const t = useMemo<Translate>(() => (key) => translate(language, key), [language]);
  return <I18nContext.Provider value={t}>{children}</I18nContext.Provider>;
}

/** Translation hook: `const t = useT(); t("nav.settings")`. */
export function useT(): Translate {
  return useContext(I18nContext);
}
