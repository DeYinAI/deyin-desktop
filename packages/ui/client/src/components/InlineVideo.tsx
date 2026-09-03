import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon.js";

interface InlineVideoProps {
  threadId: string;
  file: string;
  title?: string;
}

function downloadDataUrl(dataUrl: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = fileName;
  anchor.click();
}

/**
 * A generated video embedded in the chat. Bytes live in the host's per-thread
 * video store; this reads them back as a data URL when the card scrolls into view.
 */
export function InlineVideo({ threadId, file, title }: InlineVideoProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setVisible(true);
      },
      { rootMargin: "120px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void window.deyin.videos
      .read(threadId, file)
      .then((dataUrl) => {
        if (!cancelled) setSrc(dataUrl);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [visible, threadId, file]);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  const lightbox =
    expanded && src
      ? createPortal(
          <div
            className="inline-video-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label="Expanded video"
            onClick={() => setExpanded(false)}
          >
            <div className="inline-video-lightbox__panel" onClick={(event) => event.stopPropagation()}>
              <div className="inline-video-lightbox__frame">
                <video className="inline-video-lightbox__player" src={src} controls autoPlay playsInline />
                <div className="inline-video-lightbox__toolbar">
                  <button
                    type="button"
                    className="inline-video-lightbox__btn"
                    aria-label="Download video"
                    onClick={() => downloadDataUrl(src, file)}
                  >
                    <Icon name="download" size={18} />
                  </button>
                  <button
                    type="button"
                    className="inline-video-lightbox__btn"
                    aria-label="Close"
                    onClick={() => setExpanded(false)}
                  >
                    <Icon name="close" size={18} />
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <div className="inline-video" ref={containerRef}>
        {error && <div className="hint hint--bad">Video error: {error}</div>}
        {!error && !src && <div className="hint">Loading video…</div>}
        {!error && src && (
          <div className="inline-video__card">
            <video className="inline-video__player" src={src} controls playsInline aria-label={title ?? file} />
            <div className="inline-video__actions">
              <button
                type="button"
                className="inline-video__btn"
                aria-label="Expand video"
                onClick={() => setExpanded(true)}
              >
                <Icon name="maximize" size={16} />
              </button>
              <button
                type="button"
                className="inline-video__btn"
                aria-label="Download video"
                onClick={() => downloadDataUrl(src, file)}
              >
                <Icon name="download" size={16} />
              </button>
            </div>
          </div>
        )}
      </div>
      {lightbox}
    </>
  );
}
