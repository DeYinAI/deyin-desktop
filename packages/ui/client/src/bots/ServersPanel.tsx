import type { EngineHostView } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { fill } from "../automationFormat.js";
import { PageHeader, Tag } from "../components/settings/controls.js";
import {
  ROW_STATE_KEY,
  STEP_STATE_KEY,
  serverRow,
  sortServers,
  statusProblem,
  stepLabelKey,
  type EngineStatusState,
  type ServerRowState,
  type SetupView,
  type SetupViews,
} from "./botServers.js";

export interface ServersPanelProps {
  /** Null while the list is loading. */
  hosts: readonly EngineHostView[] | null;
  /** Why the list could not be loaded. */
  loadError: string | null;
  setups: SetupViews;
  statuses: Readonly<Record<string, EngineStatusState>>;
  /** A refusal from the last thing the person did that is not shown on a server's own row. */
  error: string | null;
  onInstall: (hostId: string) => void;
  onCancel: (hostId: string) => void;
  onCheck: (hostId: string) => void;
  onRemove: (host: EngineHostView) => void;
  onForget: (host: EngineHostView) => void;
  onDismiss: (hostId: string) => void;
  onOpenLink: (url: string) => void;
  /** Opens the page where servers are added and their host keys accepted; absent where there is none. */
  onOpenSshHosts?: () => void;
}

const STATE_TONE: Record<ServerRowState, "muted" | "ok" | "warn"> = {
  "needs-pin": "warn",
  "not-installed": "muted",
  installing: "warn",
  removing: "warn",
  installed: "ok",
};

/** The servers a person has saved, the engine on each, and what setting one up looks like while it happens. */
export function ServersPanel(props: ServersPanelProps) {
  const t = useT();
  const { hosts } = props;
  return (
    <section className="servers" aria-label={t("servers.title")}>
      <PageHeader title={t("servers.title")} description={t("servers.hint")}>
        {props.onOpenSshHosts ? (
          <button type="button" className="btn btn--outline" onClick={props.onOpenSshHosts}>
            {t("servers.manageHosts")}
          </button>
        ) : null}
      </PageHeader>

      {hosts === null && !props.loadError ? (
        <p className="hint" role="status">
          {t("servers.loading")}
        </p>
      ) : null}
      {props.loadError ? (
        <p className="hint--bad" role="alert">
          {t("servers.loadError")} {props.loadError}
        </p>
      ) : null}
      {hosts !== null && hosts.length === 0 ? <p className="hint">{t("servers.empty")}</p> : null}

      {hosts !== null && hosts.length > 0 ? (
        <ul className="servers__list">
          {sortServers(hosts).map((host) => (
            <ServerCard
              key={host.hostId}
              host={host}
              setup={props.setups[host.hostId]}
              status={props.statuses[host.hostId]}
              onInstall={props.onInstall}
              onCancel={props.onCancel}
              onCheck={props.onCheck}
              onRemove={props.onRemove}
              onForget={props.onForget}
              onDismiss={props.onDismiss}
              onOpenLink={props.onOpenLink}
            />
          ))}
        </ul>
      ) : null}

      <p className="hint--bad" role="alert" hidden={!props.error}>
        {props.error}
      </p>
    </section>
  );
}

interface ServerCardProps extends Pick<ServersPanelProps, "onInstall" | "onCancel" | "onCheck" | "onRemove" | "onForget" | "onDismiss" | "onOpenLink"> {
  host: EngineHostView;
  setup: SetupView | undefined;
  status: EngineStatusState | undefined;
}

function ServerCard({ host, setup, status, onInstall, onCancel, onCheck, onRemove, onForget, onDismiss, onOpenLink }: ServerCardProps) {
  const t = useT();
  const row = serverRow(host);
  return (
    <li className="server" aria-label={host.label}>
      <div className="server__head">
        <div className="server__title">
          <strong>{host.label}</strong>
          <span className="hint">{host.address}</span>
        </div>
        <Tag tone={STATE_TONE[row.state]}>{t(ROW_STATE_KEY[row.state])}</Tag>
      </div>

      {host.engine ? (
        <ul className="server__facts">
          {host.engine.version ? <li className="hint">{fill(t("servers.engine.version"), { version: host.engine.version })}</li> : null}
          <li className="hint">{t(host.engine.supervisor === "systemd" ? "servers.engine.systemd" : "servers.engine.nohup")}</li>
          {host.engine.survivesReboot ? null : <li className="hint--bad">{t("servers.engine.noReboot")}</li>}
          <li className="hint">{fill(t("servers.bots"), { count: host.bots })}</li>
        </ul>
      ) : host.bots > 0 ? (
        <p className="hint--bad">{fill(t("servers.botsWithoutEngine"), { count: host.bots })}</p>
      ) : null}

      <div className="server__actions">
        {row.canInstall ? (
          <button type="button" className="btn btn--primary" onClick={() => onInstall(host.hostId)}>
            {t(host.engine ? "servers.action.update" : "servers.action.install")}
          </button>
        ) : null}
        {row.canCancel ? (
          <button type="button" className="btn btn--outline" onClick={() => onCancel(host.hostId)}>
            {t("servers.action.cancel")}
          </button>
        ) : null}
        {row.canCheck ? (
          <button type="button" className="btn btn--ghost" disabled={status?.status === "checking"} onClick={() => onCheck(host.hostId)}>
            {t("servers.action.check")}
          </button>
        ) : null}
        {row.canRemove ? (
          <button type="button" className="btn btn--ghost" aria-label={`${t("servers.action.remove")}: ${host.label}`} onClick={() => onRemove(host)}>
            {t("servers.action.remove")}
          </button>
        ) : null}
        {row.canForget ? (
          <button type="button" className="btn btn--ghost" aria-label={`${t("servers.action.forget")}: ${host.label}`} onClick={() => onForget(host)}>
            {t("servers.action.forget")}
          </button>
        ) : null}
      </div>
      {row.state === "needs-pin" ? <p className="hint">{t("servers.pinHint")}</p> : null}

      {status ? <StatusLine status={status} /> : null}
      {setup ? <Setup setup={setup} onOpenLink={onOpenLink} onDismiss={() => onDismiss(host.hostId)} /> : null}
    </li>
  );
}

function StatusLine({ status }: { status: EngineStatusState }) {
  const t = useT();
  switch (status.status) {
    case "checking":
      return (
        <p className="hint" role="status">
          {t("servers.status.checking")}
        </p>
      );
    case "error":
      return (
        <p className="hint--bad" role="alert">
          {status.error}
        </p>
      );
    case "ready": {
      const problem = statusProblem(status.view);
      return (
        <div className="server__status" role="status">
          <p className="hint">{fill(t("servers.status.running"), { version: status.view.version, count: status.view.runningNow })}</p>
          {problem ? (
            <p className="hint--bad">{t(problem)}</p>
          ) : (
            <p className="hint">{fill(t("servers.status.agentOk"), { version: status.view.agentVersion ?? "" }).trim()}</p>
          )}
        </div>
      );
    }
    default: {
      const unhandled: never = status;
      throw new Error(`Unhandled status state: ${JSON.stringify(unhandled)}`);
    }
  }
}

function Setup({ setup, onOpenLink, onDismiss }: { setup: SetupView; onOpenLink: (url: string) => void; onDismiss: () => void }) {
  const t = useT();
  return (
    <div className="server__setup">
      <ol className="server__steps" aria-label={t("servers.progress")}>
        {setup.steps.map((row) => {
          const key = stepLabelKey(row.step);
          return (
            <li key={row.step} className={`server__step server__step--${row.state}`}>
              <span className="server__step-name">{key ? t(key) : row.message}</span>
              <span className="hint">
                {t(STEP_STATE_KEY[row.state])}
                {key && row.message ? ` · ${row.message}` : ""}
              </span>
            </li>
          );
        })}
      </ol>

      {setup.signIn ? (
        <div className="server__signin" role="alert">
          <strong>{t("servers.signIn.title")}</strong>
          <p className="hint">{t("servers.signIn.body")}</p>
          {setup.signIn.code ? (
            <p>
              <span className="hint">{t("servers.signIn.code")}</span> <code className="server__code">{setup.signIn.code}</code>
            </p>
          ) : null}
          {setup.signIn.url ? (
            <button type="button" className="btn btn--outline" onClick={() => onOpenLink(setup.signIn!.url!)}>
              {t("servers.signIn.open")}
            </button>
          ) : (
            <p className="hint--bad">{t("servers.signIn.noLink")}</p>
          )}
        </div>
      ) : null}

      {setup.finished ? (
        <div className="server__finished" role="status">
          {setup.finished.ok ? (
            <>
              <p>{fill(t("servers.finished.ok"), { version: setup.finished.version })}</p>
              {setup.finished.warnings.map((warning) => (
                <p key={warning} className="hint--bad">
                  {warning}
                </p>
              ))}
            </>
          ) : (
            <p className="hint--bad">{fill(t("servers.finished.failed"), { message: setup.finished.message })}</p>
          )}
          <button type="button" className="btn btn--ghost" onClick={onDismiss}>
            {t("servers.action.dismiss")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
