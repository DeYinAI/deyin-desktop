import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "./Icon.js";
import type { SecurityFinding, SecurityFindingsReport, SecuritySeverity } from "@deyin/contract";

const SEVERITY_ORDER: Record<SecuritySeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

interface SecurityFindingsPanelProps {
  active: boolean;
  threadId: string | null;
  workspaceRoot: string | null;
  onOpenFile?: (path: string) => void;
}

function sortFindings(findings: SecurityFinding[]): SecurityFinding[] {
  return [...findings].sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity] ?? 99;
    const sb = SEVERITY_ORDER[b.severity] ?? 99;
    if (sa !== sb) return sa - sb;
    const fa = a.location?.file ?? "";
    const fb = b.location?.file ?? "";
    if (fa !== fb) return fa.localeCompare(fb);
    return (a.location?.line ?? 0) - (b.location?.line ?? 0);
  });
}

function resolveFilePath(workspaceRoot: string | null, file: string): string {
  if (!file || file === "<diff>") return file;
  if (/^[a-zA-Z]:[\\/]/.test(file) || file.startsWith("/")) return file;
  if (!workspaceRoot) return file;
  return `${workspaceRoot.replace(/[\\/]+$/, "")}/${file.replace(/^[/\\]+/, "")}`;
}

/** Workspace Security tab — severity-sorted findings with file:line links. */
export function SecurityFindingsPanel(props: SecurityFindingsPanelProps) {
  const [report, setReport] = useState<SecurityFindingsReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!props.threadId) {
      setReport(null);
      return;
    }
    setError(null);
    try {
      const next = await window.deyin.security.listFindings(props.threadId);
      setReport(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [props.threadId]);

  useEffect(() => {
    if (props.active) void refresh();
  }, [props.active, refresh]);

  useEffect(() => {
    if (!props.threadId) return;
    return window.deyin.security.onFindingsChanged((threadId) => {
      if (threadId === props.threadId) void refresh();
    });
  }, [props.threadId, refresh]);

  const findings = useMemo(() => sortFindings(report?.findings ?? []), [report]);

  const clear = async () => {
    if (!props.threadId) return;
    setBusy(true);
    try {
      await window.deyin.security.clearFindings(props.threadId);
      setReport(null);
    } finally {
      setBusy(false);
    }
  };

  const openFinding = (finding: SecurityFinding) => {
    const file = finding.location?.file;
    if (!file || file === "<diff>") return;
    const full = resolveFilePath(props.workspaceRoot, file);
    if (props.onOpenFile) props.onOpenFile(full);
    else void window.deyin.shell.showItem(full);
  };

  if (!props.threadId) {
    return <div className="wspanel__body wspanel__empty">Start a task to collect security findings.</div>;
  }

  return (
    <div className="security-tab">
      <div className="security-tab__toolbar">
        <span className="security-tab__title">
          <Icon name="shield" size={14} />
          Security findings
        </span>
        <span className="security-tab__count">{findings.length}</span>
        <span className="security-tab__toolbar-spacer" />
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void refresh()} disabled={busy}>
          Refresh
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void clear()} disabled={busy || findings.length === 0}>
          Clear
        </button>
      </div>

      {error && <div className="security-tab__error">{error}</div>}

      {report?.scannedAt && (
        <div className="security-tab__meta">
          Last scan {new Date(report.scannedAt).toLocaleString()}
          {report.sources?.length ? ` · ${report.sources.join(", ")}` : ""}
        </div>
      )}

      <div className="security-tab__body wspanel__body">
        {findings.length === 0 ? (
          <div className="wspanel__empty">No findings yet. Run a security scan from chat or scan a git diff.</div>
        ) : (
          <ul className="security-findings">
            {findings.map((f) => (
              <li key={f.id} className={`security-finding security-finding--${f.severity}`}>
                <div className="security-finding__head">
                  <span className={`security-finding__sev security-finding__sev--${f.severity}`}>{f.severity}</span>
                  <span className="security-finding__rule">{f.ruleId}</span>
                  <span className="security-finding__source">{f.source}</span>
                </div>
                <p className="security-finding__message">{f.message}</p>
                {f.location?.file && f.location.file !== "<diff>" ? (
                  <button type="button" className="security-finding__link" onClick={() => openFinding(f)}>
                    {f.location.file}
                    {f.location.line ? `:${f.location.line}` : ""}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function highSeverityFindings(report: SecurityFindingsReport | null): SecurityFinding[] {
  if (!report) return [];
  return report.findings.filter((f) => f.severity === "critical" || f.severity === "high");
}
