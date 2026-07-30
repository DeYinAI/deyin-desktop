import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n.js";
import { PageHeader, SectionTitle, SettingCard } from "./controls.js";
import type { SshAuthMethod, SshHostInfo } from "../../../shared/types.js";

interface Draft {
  label: string;
  host: string;
  port: string;
  username: string;
  authMethod: SshAuthMethod;
  privateKey: string;
  passphrase: string;
  password: string;
}

const EMPTY_DRAFT: Draft = {
  label: "",
  host: "",
  port: "22",
  username: "",
  authMethod: "privateKey",
  privateKey: "",
  passphrase: "",
  password: "",
};

export function SshHostsPage() {
  const t = useT();
  const [hosts, setHosts] = useState<SshHostInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [pendingFingerprint, setPendingFingerprint] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const workingIdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    setHosts(await window.deyin.sshHosts.list());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const host = hosts.find((h) => h.id === selectedId);
    if (!selectedId || !host) {
      if (!selectedId) setDraft(EMPTY_DRAFT);
      return;
    }
    setDraft({
      label: host.label,
      host: host.host,
      port: String(host.port),
      username: host.username,
      authMethod: host.authMethod,
      privateKey: "",
      passphrase: "",
      password: "",
    });
    setTestMessage(null);
    // Do not clear pendingFingerprint here — hosts refresh must not wipe pin UX.
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps -- intentional: only on selection change

  const saveHost = async (): Promise<string | null> => {
    const input = {
      label: draft.label.trim() || draft.host.trim() || "SSH host",
      host: draft.host.trim(),
      port: Number(draft.port) || 22,
      username: draft.username.trim(),
      authMethod: draft.authMethod,
    };
    if (!input.host || !input.username) return null;

    let id = selectedId;
    if (selectedId) {
      setHosts(await window.deyin.sshHosts.update(selectedId, input));
    } else {
      const next = await window.deyin.sshHosts.add(input);
      setHosts(next);
      id = next.find((h) => h.host === input.host && h.username === input.username)?.id ?? next[0]?.id ?? null;
      if (id) setSelectedId(id);
    }
    if (!id) return null;
    workingIdRef.current = id;

    const creds: { privateKey?: string; passphrase?: string; password?: string } = {};
    if (draft.privateKey.trim()) creds.privateKey = draft.privateKey.trim();
    if (draft.passphrase.trim()) creds.passphrase = draft.passphrase;
    if (draft.password) creds.password = draft.password;

    // When the user switches auth method, clear the now-unused stored credential
    // fields so stale encrypted secrets don't linger on disk indefinitely.
    const stored = hosts.find((h) => h.id === id);
    if (stored && stored.authMethod !== draft.authMethod) {
      if (draft.authMethod === "password") {
        // Leaving key auth: clear key + passphrase (only if not already overwriting).
        if (creds.privateKey === undefined) creds.privateKey = "";
        if (creds.passphrase === undefined) creds.passphrase = "";
      } else if (draft.authMethod === "privateKey") {
        // Leaving password auth: clear password (only if not already overwriting).
        if (creds.password === undefined) creds.password = "";
      }
    }

    if (Object.keys(creds).length > 0) {
      setHosts(await window.deyin.sshHosts.setCredentials(id, creds));
      setDraft((d) => ({ ...d, privateKey: "", passphrase: "", password: "" }));
    }
    return id;
  };

  const testConnection = async (hostId: string, acceptFingerprint?: string): Promise<void> => {
    setTesting(true);
    setTestMessage(null);
    try {
      const result = await window.deyin.sshHosts.test(hostId, acceptFingerprint);
      if (result.hostFingerprint && !result.ok) {
        setPendingFingerprint(result.hostFingerprint);
        setTestMessage(t("ssh.acceptFingerprint"));
        return;
      }
      setPendingFingerprint(null);
      setTestMessage(
        result.ok
          ? `${result.message} Node ${result.nodeVersion ?? ""} · deyin ${result.deyinVersion ?? ""}`
          : result.message,
      );
      if (result.ok) setHosts(await window.deyin.sshHosts.list());
    } finally {
      setTesting(false);
    }
  };

  const onTest = async (): Promise<void> => {
    const id = (await saveHost()) ?? selectedId ?? workingIdRef.current;
    if (!id) {
      setTestMessage(t("ssh.fillRequired"));
      return;
    }
    workingIdRef.current = id;
    await testConnection(id);
  };

  const acceptFingerprint = async (): Promise<void> => {
    const id = selectedId ?? workingIdRef.current;
    if (!id || !pendingFingerprint) return;
    workingIdRef.current = id;
    // Pin happens inside test() after the live host key is observed.
    await testConnection(id, pendingFingerprint);
  };

  return (
    <div className="settings-page">
      <PageHeader title={t("ssh.title")} description={t("ssh.desc")} />

      <p className="hint ssh-hosts__warning">{t("ssh.tokenWarning")}</p>

      <SectionTitle>{t("ssh.hosts")}</SectionTitle>
      <div className="ssh-hosts__list">
        {hosts.map((host) => (
          <button
            key={host.id}
            className={`ssh-hosts__item ${selectedId === host.id ? "ssh-hosts__item--active" : ""}`}
            onClick={() => setSelectedId(host.id)}
          >
            <div>{host.label}</div>
            <div className="hint">
              {host.username}@{host.host}:{host.port}
              {host.knownHostFingerprint ? ` · ${t("ssh.pinned")}` : ""}
            </div>
          </button>
        ))}
        <button
          className="btn btn--ghost"
          onClick={() => {
            setSelectedId(null);
            workingIdRef.current = null;
            setDraft(EMPTY_DRAFT);
            setPendingFingerprint(null);
            setTestMessage(null);
          }}
        >
          {t("ssh.addHost")}
        </button>
      </div>

      <SectionTitle>{selectedId ? t("ssh.editHost") : t("ssh.newHost")}</SectionTitle>
      <SettingCard title={t("ssh.label")}>
        <input className="input" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
      </SettingCard>
      <SettingCard title={t("ssh.hostname")}>
        <input className="input" value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.target.value })} />
      </SettingCard>
      <SettingCard title={t("ssh.port")}>
        <input className="input" value={draft.port} onChange={(e) => setDraft({ ...draft, port: e.target.value })} />
      </SettingCard>
      <SettingCard title={t("ssh.username")}>
        <input className="input" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} />
      </SettingCard>
      <SettingCard title={t("ssh.authMethod")}>
        <select
          className="select"
          value={draft.authMethod}
          onChange={(e) => setDraft({ ...draft, authMethod: e.target.value as SshAuthMethod })}
        >
          <option value="privateKey">{t("ssh.auth.key")}</option>
          <option value="password">{t("ssh.auth.password")}</option>
        </select>
      </SettingCard>

      {draft.authMethod === "privateKey" && (
        <>
          <SettingCard title={t("ssh.privateKey")} description={t("ssh.privateKeyDesc")}>
            <textarea
              className="input automations__prompt"
              rows={5}
              value={draft.privateKey}
              onChange={(e) => setDraft({ ...draft, privateKey: e.target.value })}
              placeholder={selectedId ? t("ssh.keyUnchanged") : ""}
            />
            <button
              className="btn btn--ghost"
              onClick={() =>
                void window.deyin.sshHosts.importKey().then((key) => {
                  if (key) setDraft((d) => ({ ...d, privateKey: key }));
                })
              }
            >
              {t("ssh.importKey")}
            </button>
          </SettingCard>
          <SettingCard title={t("ssh.passphrase")}>
            <input
              className="input"
              type="password"
              value={draft.passphrase}
              onChange={(e) => setDraft({ ...draft, passphrase: e.target.value })}
            />
          </SettingCard>
        </>
      )}

      {draft.authMethod === "password" && (
        <SettingCard title={t("ssh.password")}>
          <input
            className="input"
            type="password"
            value={draft.password}
            onChange={(e) => setDraft({ ...draft, password: e.target.value })}
          />
        </SettingCard>
      )}

      <div className="automations__actions">
        {selectedId && (
          <button
            className="btn btn--ghost"
            onClick={() =>
              void window.deyin.sshHosts
                .remove(selectedId)
                .then((next) => {
                  setHosts(next);
                  setSelectedId(null);
                  setDraft(EMPTY_DRAFT);
                })
                .catch((err: unknown) => {
                  setTestMessage(err instanceof Error ? err.message : String(err));
                })
            }
          >
            {t("ssh.remove")}
          </button>
        )}
        <button className="btn btn--ghost" disabled={testing} onClick={() => void saveHost()}>
          {t("ssh.save")}
        </button>
        <button className="btn btn--primary" disabled={testing} onClick={() => void onTest()}>
          {t("ssh.test")}
        </button>
        {pendingFingerprint && (
          <button className="btn btn--primary" disabled={testing} onClick={() => void acceptFingerprint()}>
            {t("ssh.pinAndTest")}
          </button>
        )}
      </div>
      {testMessage && <p className="hint ssh-hosts__test">{testMessage}</p>}
      {pendingFingerprint && <p className="hint">{pendingFingerprint}</p>}
    </div>
  );
}
