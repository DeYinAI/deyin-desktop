import { useEffect, useRef, useState } from "react";

interface InlineImageProps {
  threadId: string;
  file: string;
  alt?: string;
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

  return (
    <div className="inline-image" ref={containerRef}>
      {error && <div className="hint hint--bad">Image error: {error}</div>}
      {!error && !src && <div className="hint">Loading image…</div>}
      {!error && src && (
        <figure className="inline-image__figure">
          <img className="inline-image__img" src={src} alt={alt ?? file} />
          {alt && <figcaption className="inline-image__caption">{alt}</figcaption>}
        </figure>
      )}
    </div>
  );
}
