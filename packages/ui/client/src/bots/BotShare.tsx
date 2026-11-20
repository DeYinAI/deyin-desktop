import { useEffect, useRef, useState } from "react";
import type { DeyinBot, ExportedTemplate } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { fill } from "../automationFormat.js";
import { writeClipboardText } from "../clipboard.js";
import { attempt } from "./botCalls.js";
import { comesWithLine, summaryCounts, type TemplatesApi } from "./botTemplates.js";

type Copied = "link" | "text" | "failed" | null;

interface BotSharePanelProps {
  exported: ExportedTemplate | null;
  includeRoutines: boolean;
  busy: boolean;
  error: string | null;
  copied: Copied;
  onIncludeRoutines: (include: boolean) => void;
  onShare: () => void;
  onCopy: (what: "link" | "text") => void;
  onClose: () => void;
}

/** The share section as pure markup: make the Bot into text or a link, and copy it. */
export function BotSharePanel(props: BotSharePanelProps) {
  const { exported, busy, copied } = props;
  const t = useT();
  const line = exported ? comesWithLine(summaryCounts(exported.summary)) : null;
  return (
    <section className="bot-panel" aria-label={t("bot.share.title")}>
      <h3 className="bot-detail__heading">{t("bot.share.title")}</h3>
      <p className="hint">{t("bot.share.hint")}</p>
      <label className="bot-panel__check">
        <input type="checkbox" checked={props.includeRoutines} disabled={busy} onChange={(event) => props.onIncludeRoutines(event.target.checked)} />
        <span>{t("bot.share.includeRoutines")}</span>
      </label>
      {props.error ? (
        <p className="hint--bad" role="alert">
          {props.error}
        </p>
      ) : null}
      {!exported ? (
        <div>
          <button type="button" className="btn btn--outline" disabled={busy} onClick={props.onShare}>
            {busy ? t("bot.share.making") : t("bot.share.make")}
          </button>
        </div>
      ) : (
        <div className="bot-panel__editor">
          {line ? <p className="hint">{fill(t(line.key), line.vars)}</p> : null}
          {exported.warnings.map((warning) => (
            <p key={warning} className="hint--bad">
              {warning}
            </p>
          ))}
          {exported.link ? (
            <div className="field">
              <label className="field__label" htmlFor="share-link">
                {t("bot.share.link")}
              </label>
              <input id="share-link" className="input" value={exported.link} readOnly onFocus={(event) => event.currentTarget.select()} />
            </div>
          ) : (
            <p className="hint">{t("bot.share.noLink")}</p>
          )}
          <div className="field">
            <label className="field__label" htmlFor="share-text">
              {t("bot.share.text")}
            </label>
            <textarea id="share-text" className="input bot-panel__code" rows={8} value={exported.text} readOnly onFocus={(event) => event.currentTarget.select()} />
          </div>
          <p className="hint" role="status">
            {copied === "link" ? t("bot.share.copiedLink") : copied === "text" ? t("bot.share.copiedText") : copied === "failed" ? t("bot.share.copyFailed") : ""}
          </p>
          <div className="bot-panel__buttons">
            <button type="button" className="btn btn--outline" onClick={props.onClose}>
              {t("bot.share.close")}
            </button>
            {exported.link ? (
              <button type="button" className="btn btn--outline" onClick={() => props.onCopy("link")}>
                {t("bot.share.copyLink")}
              </button>
            ) : null}
            <button type="button" className="btn btn--primary" onClick={() => props.onCopy("text")}>
              {t("bot.share.copyText")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

interface BotShareProps {
  bot: DeyinBot;
  api: TemplatesApi;
}

/** Hand a Bot to someone: its words and skills as text or a link, never its memory, files, vault or permissions. */
export function BotShare({ bot, api }: BotShareProps) {
  const [exported, setExported] = useState<ExportedTemplate | null>(null);
  const [includeRoutines, setIncludeRoutines] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<Copied>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Another Bot's page starts without what was made for this one.
  useEffect(() => {
    setExported(null);
    setError(null);
    setCopied(null);
  }, [bot.id]);

  const share = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setCopied(null);
    const outcome = await attempt(() => api.export(bot.id, { includeRoutines }));
    if (!mounted.current) return;
    setBusy(false);
    if (outcome.ok) setExported(outcome.value);
    else setError(outcome.error);
  };

  const copy = async (what: "link" | "text"): Promise<void> => {
    const content = what === "link" ? exported?.link : exported?.text;
    if (!content) return;
    const done = await writeClipboardText(content);
    if (mounted.current) setCopied(done ? what : "failed");
  };

  return (
    <BotSharePanel
      exported={exported}
      includeRoutines={includeRoutines}
      busy={busy}
      error={error}
      copied={copied}
      onIncludeRoutines={(include) => {
        setIncludeRoutines(include);
        // What was made says what it holds, so choosing again makes it again.
        setExported(null);
        setCopied(null);
      }}
      onShare={() => void share()}
      onCopy={(what) => void copy(what)}
      onClose={() => {
        setExported(null);
        setCopied(null);
      }}
    />
  );
}
