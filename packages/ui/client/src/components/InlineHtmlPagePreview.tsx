import { useMemo, useState } from "react";
import { encodeSrcdoc, titleFromHtml } from "../htmlPage.js";
import { useT } from "../i18n.js";
import { Icon } from "./Icon.js";

interface InlineHtmlPagePreviewProps {
  html: string;
  onOpenPreview?: () => void;
}

/** Sandboxed iframe preview for a full HTML page pasted in assistant markdown. */
export function InlineHtmlPagePreview({ html, onOpenPreview }: InlineHtmlPagePreviewProps) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const title = useMemo(() => titleFromHtml(html) ?? t("chat.pagePreview"), [html, t]);
  const srcdoc = useMemo(() => encodeSrcdoc(html), [html]);

  if (!open) {
    return (
      <div className="inline-page-preview inline-page-preview--collapsed">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(true)}>
          <Icon name="maximize" size={14} />
          <span>{t("chat.showPagePreview")}</span>
        </button>
      </div>
    );
  }

  return (
    <div
      className={`inline-page-preview${fullscreen ? " inline-page-preview--fullscreen" : ""}`}
      role="region"
      aria-label={title}
    >
      <div className="inline-page-preview__bar">
        <span className="inline-page-preview__title">{title}</span>
        <div className="inline-page-preview__actions">
          {onOpenPreview && (
            <button
              type="button"
              className="btn btn--ghost btn--icon"
              onClick={onOpenPreview}
              title={t("chat.openPreview")}
              aria-label={t("chat.openPreview")}
            >
              <Icon name="panel" size={14} />
            </button>
          )}
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={() => setFullscreen((on) => !on)}
            title={fullscreen ? t("chat.exitFullscreenPreview") : t("chat.fullscreenPreview")}
            aria-label={fullscreen ? t("chat.exitFullscreenPreview") : t("chat.fullscreenPreview")}
          >
            <Icon name={fullscreen ? "minimize" : "maximize"} size={14} />
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={() => {
              setFullscreen(false);
              setOpen(false);
            }}
            title={t("chat.hidePagePreview")}
            aria-label={t("chat.hidePagePreview")}
          >
            <Icon name="minimize" size={14} />
          </button>
        </div>
      </div>
      <iframe
        className="inline-page-preview__frame"
        sandbox="allow-scripts"
        title={title}
        srcDoc={srcdoc}
      />
    </div>
  );
}
