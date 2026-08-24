import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirm } from "../ConfirmDialog.js";
import { useT } from "../../i18n.js";
import { Icon } from "../Icon.js";
import { EmptyState, Field, FormSection, PageHeader, Row, RowList, RowMenu, Tag } from "./controls.js";
import { Callout } from "../ui/index.js";
import type { SshAuthMethod, SshHostInfo } from "@deyin/contract";

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

function draftFromHost(host: SshHostInfo): Draft {
  return {
    label: host.label,
    host: host.host,
    port: String(host.port),
    username: host.username,
    authMethod: host.authMethod,
    // Secrets never leave the main process; blank means "keep what is stored".
    privateKey: "",
    passphrase: "",
    password: "",
  };
}

type SshApi = NonNullable<typeof window.deyin.sshHosts>;

/**
 * `sshHosts` is a desktop-only IPC namespace — the web transport leaves it
 * undefined. Resolve it once here so the editor below can take it as a plain
 * required prop instead of guarding at every call site.
 */
export function SshHostsPage() {
  const t = useT();
  const sshApi = window.deyin.sshHosts;
  if (!sshApi) {
    return (
      <div className="settings-page">
        <PageHeader title={t("ssh.title")} description={t("ssh.desc")} />
        <Callout tone="warn">{t("automations.desktopOnly")}</Callout>
      </div>
    );
  }
  return <SshHostsEditor api={sshApi} />;
}

function SshHostsEditor({ api: sshApi }: { api: SshApi }) {
  const t = useT();
  const { confirm } = useConfirm();
  const [hosts, setHosts] = useState<SshHostInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** The editor is only mounted once the user picks a host or adds one. */
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errors, setErrors] = useState<{ host?: string; username?: string }>({});
  const [testMessage, setTestMessage] = useState<{ tone: "ok" | "bad" | "muted"; text: string } | null>(null);
  const [pendingFingerprint, setPendingFingerprint] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const workingIdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    setHosts(await sshApi.list());
  }, [sshApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openHost = (host: SshHostInfo) => {
    setSelectedId(host.id);
    workingIdRef.current = host.id;
    setDraft(draftFromHost(host));
    setEditing(true);
    setDirty(false);
    setSaved(false);
    setErrors({});
    setTestMessage(null);
    setPendingFingerprint(null);
  };

  const openNew = () => {
    setSelectedId(null);
    workingIdRef.current = null;
    setDraft(EMPTY_DRAFT);
    setEditing(true);
    setDirty(false);
    setSaved(false);
    setErrors({});
    setTestMessage(null);
    setPendingFingerprint(null);
  };

  const closeEditor = () => {
    setEditing(false);
    setSelectedId(null);
    workingIdRef.current = null;
    setDraft(EMPTY_DRAFT);
    setDirty(false);
    setSaved(false);
    setErrors({});
    setTestMessage(null);
    setPendingFingerprint(null);
  };

  const patch = (p: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setDirty(true);
    setSaved(false);
    setErrors((prev) => {
      const next = { ...prev };
      if ("host" in p) delete next.host;
      if ("username" in p) delete next.username;
      return next;
    });
  };

  const validate = (): boolean => {
    const next: { host?: string; username?: string } = {};
    if (!draft.host.trim()) next.host = t("ssh.fillRequired");
    if (!draft.username.trim()) next.username = t("ssh.fillRequired");
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  /** Persists the draft (host record + any newly entered secrets); returns its id. */
  const saveHost = async (): Promise<string | null> => {
    if (!validate()) return null;
    const input = {
      label: draft.label.trim() || draft.host.trim(),
      host: draft.host.trim(),
      port: Number(draft.port) || 22,
      username: draft.username.trim(),
      authMethod: draft.authMethod,
    };

    setBusy(true);
    try {
      let id = selectedId;
      if (selectedId) {
        setHosts(await sshApi.update(selectedId, input));
      } else {
        const next = await sshApi.add(input);
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
        setHosts(await sshApi.setCredentials(id, creds));
        setDraft((d) => ({ ...d, privateKey: "", passphrase: "", password: "" }));
      }
      setDirty(false);
      setSaved(true);
      return id;
    } catch (err) {
      setTestMessage({ tone: "bad", text: err instanceof Error ? err.message : String(err) });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async (hostId: string, acceptFingerprint?: string): Promise<void> => {
    setTesting(true);
    setTestMessage(null);
    try {
      const result = await sshApi.test(hostId, acceptFingerprint);
      if (result.hostFingerprint && !result.ok) {
        setPendingFingerprint(result.hostFingerprint);
        setTestMessage({ tone: "muted", text: t("ssh.acceptFingerprint") });
        return;
      }
      setPendingFingerprint(null);
      setTestMessage({
        tone: result.ok ? "ok" : "bad",
        text: result.ok
          ? `${result.message} · Node ${result.nodeVersion ?? "?"} · deyin ${result.deyinVersion ?? "?"}`
          : result.message,
      });
      if (result.ok) setHosts(await sshApi.list());
    } finally {
      setTesting(false);
    }
  };

  const onTest = async (): Promise<void> => {
    // Testing always runs against what is on disk, so save first — otherwise a
    // just-typed key or hostname would not be part of the connection attempt.
    const id = dirty || !selectedId ? await saveHost() : selectedId;
    if (!id) return;
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

  const removeHost = async (id: string): Promise<void> => {
    const ok = await confirm({
      message: `${t("ssh.removeConfirm")} ${t("ssh.usedByAutomations")}`,
      destructive: true,
    });
    if (!ok) return;
    try {
      setHosts(await sshApi.remove(id));
      if (id === selectedId || id === workingIdRef.current) closeEditor();
    } catch (err) {
      setTestMessage({ tone: "bad", text: err instanceof Error ? err.message : String(err) });
    }
  };

  const selectedHost = useMemo(() => hosts.find((h) => h.id === selectedId) ?? null, [hosts, selectedId]);

  return (
    <div className="settings-page">
      <PageHeader title={t("ssh.title")} description={t("ssh.desc")}>
        <button className="btn btn--ghost" onClick={openNew}>
          <Icon name="plus" size={13} />
          {t("ssh.addHost")}
        </button>
      </PageHeader>

      <Callout tone="warn" className="ssh-hosts__warning">{t("ssh.tokenWarning")}</Callout>

      <FormSection title={t("ssh.hosts")} note={hosts.length > 0 ? String(hosts.length) : undefined}>
        {hosts.length === 0 ? (
          <EmptyState icon="server" title={t("ssh.emptyHosts")} hint={t("ssh.emptyHint")} />
        ) : (
          <RowList variant="plain">
            {hosts.map((host) => (
              <Row
                key={host.id}
                icon={<Icon name="server" size={15} />}
                title={host.label}
                tags={host.knownHostFingerprint ? <Tag tone="ok">{t("ssh.pinned")}</Tag> : undefined}
                description={`${host.username}@${host.host}:${host.port} · ${
                  host.authMethod === "password" ? t("ssh.auth.password") : t("ssh.auth.key")
                }`}
                actions={
                  <RowMenu
                    items={[
                      { label: t("ssh.edit"), icon: "pencil", onSelect: () => openHost(host) },
                      {
                        label: t("ssh.test"),
                        icon: "play",
                        onSelect: () => {
                          openHost(host);
                          void testConnection(host.id);
                        },
                      },
                      { label: t("ssh.remove"), icon: "trash", danger: true, onSelect: () => void removeHost(host.id) },
                    ]}
                  />
                }
                onClick={() => openHost(host)}
              />
            ))}
          </RowList>
        )}
      </FormSection>

      {editing && (
        <>
          <FormSection
            title={selectedHost ? `${t("ssh.editHost")} · ${selectedHost.label}` : t("ssh.newHost")}
            note={dirty ? t("ssh.unsaved") : saved ? t("ssh.saved") : undefined}
          >
            <div className="ssh-hosts__grid ssh-hosts__grid--label">
              <Field label={t("ssh.label")}>
                <input
                  className="input"
                  value={draft.label}
                  placeholder={draft.host || "prod-1"}
                  onChange={(e) => patch({ label: e.target.value })}
                />
              </Field>
              <Field label={t("ssh.port")}>
                <input
                  className="input input-mono"
                  inputMode="numeric"
                  value={draft.port}
                  onChange={(e) => patch({ port: e.target.value })}
                />
              </Field>
            </div>
            <div className="ssh-hosts__grid">
              <Field label={t("ssh.hostname")} hint={t("ssh.hostnameDesc")} error={errors.host}>
                <input
                  className="input input-mono"
                  value={draft.host}
                  placeholder="build.example.com"
                  onChange={(e) => patch({ host: e.target.value })}
                />
              </Field>
              <Field label={t("ssh.username")} hint={t("ssh.usernameDesc")} error={errors.username}>
                <input
                  className="input input-mono"
                  value={draft.username}
                  onChange={(e) => patch({ username: e.target.value })}
                />
              </Field>
            </div>
            <Field label={t("ssh.authMethod")}>
              <select
                className="select"
                value={draft.authMethod}
                onChange={(e) => patch({ authMethod: e.target.value as SshAuthMethod })}
              >
                <option value="privateKey">{t("ssh.auth.key")}</option>
                <option value="password">{t("ssh.auth.password")}</option>
              </select>
            </Field>

            {draft.authMethod === "privateKey" ? (
              <>
                <Field
                  label={t("ssh.privateKey")}
                  hint={t("ssh.privateKeyDesc")}
                  action={
                    <button
                      className="btn btn--ghost btn--small"
                      onClick={() =>
                        void sshApi.importKey().then((key) => {
                          if (key) patch({ privateKey: key });
                        })
                      }
                    >
                      <Icon name="attach" size={12} />
                      {t("ssh.importKey")}
                    </button>
                  }
                >
                  <textarea
                    className="input ssh-hosts__key"
                    rows={5}
                    spellCheck={false}
                    value={draft.privateKey}
                    onChange={(e) => patch({ privateKey: e.target.value })}
                    placeholder={selectedId ? t("ssh.keyUnchanged") : "-----BEGIN OPENSSH PRIVATE KEY-----"}
                  />
                </Field>
                <Field label={t("ssh.passphrase")}>
                  <input
                    className="input"
                    type="password"
                    autoComplete="new-password"
                    value={draft.passphrase}
                    onChange={(e) => patch({ passphrase: e.target.value })}
                  />
                </Field>
              </>
            ) : (
              <Field label={t("ssh.password")} hint={selectedId ? t("ssh.keyUnchanged") : undefined}>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={draft.password}
                  onChange={(e) => patch({ password: e.target.value })}
                />
              </Field>
            )}

            {testMessage && (
              <Callout tone={testMessage.tone === "ok" ? "good" : testMessage.tone === "bad" ? "bad" : "muted"}>
                {testMessage.text}
              </Callout>
            )}
            {pendingFingerprint && (
              <Field label={t("ssh.fingerprintTitle")}>
                <code className="ssh-hosts__fingerprint">{pendingFingerprint}</code>
              </Field>
            )}
          </FormSection>

          <div className="ssh-hosts__bar">
            <span className="ssh-hosts__bar-note">{t("ssh.testDesc")}</span>
            <button className="btn btn--ghost" onClick={closeEditor}>
              {t("ssh.cancel")}
            </button>
            {selectedId && (
              <button className="btn btn--ghost" onClick={() => void removeHost(selectedId)}>
                {t("ssh.remove")}
              </button>
            )}
            <button className="btn btn--ghost" disabled={busy || testing || !dirty} onClick={() => void saveHost()}>
              {t("ssh.save")}
            </button>
            {pendingFingerprint ? (
              <button className="btn btn--primary" disabled={testing} onClick={() => void acceptFingerprint()}>
                {t("ssh.pinAndTest")}
              </button>
            ) : (
              <button className="btn btn--primary" disabled={busy || testing} onClick={() => void onTest()}>
                {testing ? "…" : t("ssh.test")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
