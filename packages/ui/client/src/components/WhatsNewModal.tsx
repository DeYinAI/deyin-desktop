import { useEffect, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getReleaseNotes, GITHUB_CHANGELOG_URL } from "../changelog.js";
import { Icon } from "./Icon.js";

interface Props {
  version: string;
  onDismiss: () => void;
}

/** Release notes modal dynamically populated from docs/CHANGELOG.md. */
export function WhatsNewModal({ version, onDismiss }: Props) {
  const notes = useMemo(() => getReleaseNotes(version), [version]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  const openExternal = (url: string) => {
    if (window.deyin?.shell?.openExternal) {
      window.deyin.shell.openExternal(url);
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="whats-new-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div className="modal whats-new-modal">
        <div className="whats-new-modal__header">
          <div>
            <h2 id="whats-new-title" className="whats-new-modal__title">
              What&apos;s new in Deyin {notes.displayVersion}
            </h2>
            {notes.date && (
              <p className="whats-new-modal__date">Released on {notes.date}</p>
            )}
            {notes.isFallback && (
              <p className="whats-new-modal__fallback-hint">
                Showing highlights from latest release {notes.displayVersion}
              </p>
            )}
          </div>
          <button
            type="button"
            className="icon-btn whats-new-modal__close"
            onClick={onDismiss}
            aria-label="Close"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="whats-new-modal__body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a({ href, children }) {
                return (
                  <a
                    href={href}
                    onClick={(e) => {
                      e.preventDefault();
                      if (href) openExternal(href);
                    }}
                  >
                    {children}
                  </a>
                );
              },
              code({ className, children, ...rest }) {
                const isBlock = /language-/.test(className ?? "");
                if (isBlock) return <code className={className} {...rest}>{children}</code>;
                return <code className="ui-code-tag" {...rest}>{children}</code>;
              },
            }}
          >
            {notes.content}
          </ReactMarkdown>
        </div>

        <div className="whats-new-modal__footer">
          <button
            type="button"
            className="btn btn--ghost whats-new-modal__changelog-btn"
            onClick={() => openExternal(GITHUB_CHANGELOG_URL)}
          >
            <Icon name="link" size={14} />
            <span>Full changelog</span>
          </button>

          <button type="button" className="btn btn--primary" onClick={onDismiss}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
