import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface InlineImageProps {
  threadId: string;
  file: string;
  alt?: string;
}

function downloadDataUrl(dataUrl: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = fileName;
  anchor.click();
}

/**
 * A generated image embedded in the chat. The bytes live in the host's per-thread
 * image store; this reads them back as a data URL when the card scrolls into view,
 * so replaying a long thread does not decode every picture at once.
 */
export function InlineImage({ threadId, file, alt }: InlineImageProps) {
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
    void window.deyin.images
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
            className="inline-image-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label="Expanded image"
            onClick={() => setExpanded(false)}
          >
            <div className="inline-image-lightbox__panel" onClick={(event) => event.stopPropagation()}>
              <img className="inline-image-lightbox__img" src={src} alt={alt ?? file} />
              <div className="inline-image-lightbox__actions">
                <button
                  type="button"
                  className="btn btn--outline btn--small"
                  onClick={() => downloadDataUrl(src, file)}
                >
                  Download
                </button>
                <button type="button" className="btn btn--ghost btn--small" onClick={() => setExpanded(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <div className="inline-image" ref={containerRef}>
        {error && <div className="hint hint--bad">Image error: {error}</div>}
        {!error && !src && <div className="hint">Loading image…</div>}
        {!error && src && (
          <button
            type="button"
            className="inline-image__open"
            onClick={() => setExpanded(true)}
            aria-label={alt ? `Expand image: ${alt}` : "Expand image"}
          >
            <img className="inline-image__img" src={src} alt={alt ?? file} />
          </button>
        )}
      </div>
      {lightbox}
    </>
  );
}
