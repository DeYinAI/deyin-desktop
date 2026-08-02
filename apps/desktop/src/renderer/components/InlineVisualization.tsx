import { useEffect, useMemo, useRef, useState } from "react";

interface InlineVisualizationProps {
  threadId: string;
  file: string;
  title?: string;
}

function encodeSrcdoc(html: string): string {
  return html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function buildVisDocument(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;"></head><body>${body}</body></html>`;
}

/** Sandboxed iframe for HTML visualization fragments. */
export function InlineVisualization({ threadId, file, title }: InlineVisualizationProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
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
    void window.deyin.visualize
      .read(threadId, file)
      .then((content) => {
        if (!cancelled) setHtml(content);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [visible, threadId, file]);

  const srcdoc = useMemo(() => (html ? encodeSrcdoc(buildVisDocument(html)) : null), [html]);

  return (
    <div className="inline-vis" ref={containerRef}>
      {error && <div className="hint hint--bad">Visualization error: {error}</div>}
      {!error && !srcdoc && <div className="hint">Loading visualization…</div>}
      {!error && srcdoc && (
        <>
          {title && <div className="inline-vis__title">{title}</div>}
          <iframe className="inline-vis__frame" sandbox="allow-scripts" title={title ?? file} srcDoc={srcdoc} />
        </>
      )}
    </div>
  );
}
