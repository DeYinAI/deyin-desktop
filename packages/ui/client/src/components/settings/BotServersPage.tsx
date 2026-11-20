import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineHostView } from "@deyin/host-core/shared";
import { useT } from "../../i18n.js";
import { fill } from "../../automationFormat.js";
import { useConfirm } from "../ConfirmDialog.js";
import { ServersPanel } from "../../bots/ServersPanel.js";
import {
  attemptServerList,
  attemptServers,
  dismissSetup,
  reduceSetup,
  safeSignInUrl,
  type EngineStatusState,
  type ServersApi,
  type SetupViews,
} from "../../bots/botServers.js";

/** Where Bots run: the servers a person has saved, and the engine on each. It needs the desktop host, so a build without one shows nothing. */
export function BotServersPage({ onOpenSshHosts }: { onOpenSshHosts?: () => void }) {
  const api = typeof window === "undefined" ? undefined : window.deyin?.engines;
  return api ? <BotServersBody api={api} onOpenSshHosts={onOpenSshHosts} /> : null;
}

function BotServersBody({ api, onOpenSshHosts }: { api: ServersApi; onOpenSshHosts?: () => void }) {
  const t = useT();
  const { confirm } = useConfirm();
  const [hosts, setHosts] = useState<EngineHostView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [setups, setSetups] = useState<SetupViews>({});
  const [statuses, setStatuses] = useState<Readonly<Record<string, EngineStatusState>>>({});
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    const stopList = api.onChange((list) => {
      if (current) setHosts(list);
    });
    const stopSetup = api.onSetup((event) => {
      if (current) setSetups((views) => reduceSetup(views, event));
    });
    void attemptServerList(api).then((outcome) => {
      if (!current) return;
      // A change that arrived while loading is newer than the answer.
      if (outcome.ok) setHosts((existing) => existing ?? outcome.value);
      else setLoadError(outcome.error);
    });
    return () => {
      current = false;
      stopList();
      stopSetup();
    };
  }, [api]);

  const install = useCallback(
    async (hostId: string): Promise<void> => {
      setError(null);
      setSetups((views) => dismissSetup(views, hostId));
      setStatuses((existing) => omit(existing, hostId));
      const outcome = await attemptServers(() => api.install(hostId));
      if (!mounted.current || outcome.ok) return;
      // A refusal before anything started has no setup to show it in, so it becomes one.
      setSetups((views) => (views[hostId]?.finished ? views : reduceSetup(views, { type: "finished", hostId, ok: false, message: outcome.error })));
    },
    [api],
  );

  const check = useCallback(
    async (hostId: string): Promise<void> => {
      setStatuses((existing) => ({ ...existing, [hostId]: { status: "checking" } }));
      const outcome = await attemptServers(() => api.status(hostId));
      if (!mounted.current) return;
      setStatuses((existing) => ({ ...existing, [hostId]: outcome.ok ? { status: "ready", view: outcome.value } : { status: "error", error: outcome.error } }));
    },
    [api],
  );

  const remove = useCallback(
    async (host: EngineHostView): Promise<void> => {
      const accepted = await confirm({
        title: fill(t("servers.remove.title"), { server: host.label }),
        message: t("servers.remove.message"),
        confirmLabel: t("servers.action.remove"),
        destructive: true,
      });
      if (!accepted) return;
      // Whether the Bots' files and routines on the server go too is a separate, plainly worded question.
      const purge = await confirm({
        title: fill(t("servers.purge.title"), { server: host.label }),
        message: t("servers.purge.message"),
        confirmLabel: t("servers.purge.confirm"),
        cancelLabel: t("servers.purge.keep"),
        destructive: true,
      });
      setError(null);
      const outcome = await attemptServers(() => api.uninstall(host.hostId, purge));
      if (!mounted.current) return;
      if (!outcome.ok) {
        setError(outcome.error);
        return;
      }
      setSetups((views) => dismissSetup(views, host.hostId));
      setStatuses((existing) => omit(existing, host.hostId));
    },
    [api, confirm, t],
  );

  const forget = useCallback(
    async (host: EngineHostView): Promise<void> => {
      const accepted = await confirm({
        title: fill(t("servers.forget.title"), { server: host.label }),
        message: t("servers.forget.message"),
        confirmLabel: t("servers.action.forget"),
        destructive: true,
      });
      if (!accepted) return;
      setError(null);
      const outcome = await attemptServers(() => api.forget(host.hostId));
      if (!mounted.current) return;
      if (!outcome.ok) setError(outcome.error);
      else setStatuses((existing) => omit(existing, host.hostId));
    },
    [api, confirm, t],
  );

  return (
    <ServersPanel
      hosts={hosts}
      loadError={loadError}
      setups={setups}
      statuses={statuses}
      error={error}
      onInstall={(hostId) => void install(hostId)}
      onCancel={(hostId) => void api.cancel(hostId)}
      onCheck={(hostId) => void check(hostId)}
      onRemove={(host) => void remove(host)}
      onForget={(host) => void forget(host)}
      onDismiss={(hostId) => setSetups((views) => dismissSetup(views, hostId))}
      onOpenLink={(url) => {
        // The link came from the server: it is checked again here, and only ever opened in the person's own browser.
        const safe = safeSignInUrl(url);
        if (safe) window.deyin.shell.openExternal(safe);
      }}
      {...(onOpenSshHosts ? { onOpenSshHosts } : {})}
    />
  );
}

function omit<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}
