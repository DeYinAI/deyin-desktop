import { useEffect, useRef, useState } from "react";
import type { VaultItem, VaultKind } from "@deyin/host-core/shared";
import { useT } from "../../i18n.js";
import { fill } from "../../automationFormat.js";
import { useConfirm } from "../ConfirmDialog.js";
import { VaultPanel, type VaultPanelProps, type VaultState } from "../../bots/VaultPanel.js";
import { useBots } from "../../bots/useBots.js";
import { attemptVault, attemptVaultLoad, emptyVaultForm, formFromItem, vaultFormProblem, vaultPayload, type VaultApi, type VaultForm, type VaultOutcome } from "../../bots/botVault.js";

/** The Vault settings page. It needs the desktop host, so a build without one shows nothing. */
export function VaultPage({ onePassword }: { onePassword?: VaultPanelProps["onePassword"] }) {
  const api = typeof window === "undefined" ? undefined : window.deyin?.vault;
  return api ? <VaultPageBody api={api} onePassword={onePassword} /> : null;
}

function VaultPageBody({ api, onePassword }: { api: VaultApi; onePassword: VaultPanelProps["onePassword"] }) {
  const t = useT();
  const { confirm } = useConfirm();
  const { bots } = useBots();
  const [state, setState] = useState<VaultState>({ status: "loading" });
  const [editor, setEditor] = useState<VaultForm | null>(null);
  const [busy, setBusy] = useState(false);
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
    setState({ status: "loading" });
    const stop = api.onChange((snapshot) => {
      if (current) setState({ status: "ready", snapshot });
    });
    void attemptVaultLoad(api).then((outcome) => {
      if (!current) return;
      // A change that arrived while loading is newer than the answer.
      setState((existing) => (existing.status === "ready" ? existing : outcome.ok ? { status: "ready", snapshot: outcome.value } : { status: "error", error: outcome.error }));
    });
    return () => {
      current = false;
      stop();
    };
  }, [api]);

  /** Run one change, hold the controls while it goes through, and show a refusal. */
  const change = async <T,>(run: () => Promise<VaultOutcome<T>>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const outcome = await run();
    if (!mounted.current) return false;
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return false;
    }
    return true;
  };

  const open = (form: VaultForm): void => {
    setError(null);
    setEditor(form);
  };

  const save = (): void => {
    if (!editor || vaultFormProblem(editor) !== null) return;
    void change(() => attemptVault(() => api.save(vaultPayload(editor)))).then((saved) => {
      // Closing drops what was typed, secrets included.
      if (saved && mounted.current) setEditor(null);
    });
  };

  const remove = async (item: VaultItem): Promise<void> => {
    const accepted = await confirm({ message: fill(t("vault.removeConfirm"), { title: item.title }), confirmLabel: t("vault.removeYes"), cancelLabel: t("vault.cancel"), destructive: true });
    if (!accepted) return;
    const removed = await change(() => attemptVault(() => api.remove(item.id)));
    if (removed && mounted.current) setEditor((current) => (current?.id === item.id ? null : current));
  };

  return (
    <VaultPanel
      state={state}
      bots={bots}
      editor={editor}
      busy={busy}
      error={error}
      now={new Date()}
      {...(onePassword ? { onePassword } : {})}
      onAdd={(kind: VaultKind) => open(emptyVaultForm(kind))}
      onEdit={(item) => open(formFromItem(item))}
      onRemove={(item) => void remove(item)}
      onRevoke={(botId, itemId, host) => void change(() => attemptVault(() => api.revoke(botId, itemId, host)))}
      onForm={(patch) => setEditor((current) => (current ? { ...current, ...patch } : current))}
      onSave={save}
      onCancel={() => {
        setError(null);
        setEditor(null);
      }}
    />
  );
}
