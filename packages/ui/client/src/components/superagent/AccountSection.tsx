import { useEffect, useState } from "react";
import type { SuperagentVerification } from "@deyin/contract";
import type { SuperagentView } from "@deyin/superagent/client";
import { Callout } from "../ui/index.js";
import { Field, FormSection, Tag } from "../settings/controls.js";
import type { SuperagentController } from "./useSuperagent.js";
import { useConfirm } from "../ConfirmDialog.js";

/** The agent account: its GitHub token, who it belongs to, and whether it can push to the watched repository. */
export function AccountSection({ view, controller }: { view: SuperagentView; controller: SuperagentController }) {
  const { confirm } = useConfirm();
  const [token, setToken] = useState("");
  const [verified, setVerified] = useState<SuperagentVerification | null>(null);
  const { account, accountError } = view.status;
  const api = window.deyin.superagent;
  // A check answers for one account and repository; once either changes the answer no longer holds.
  useEffect(() => setVerified(null), [account?.login, view.settings.github.repository]);

  const connect = async () => {
    if (!api || !token.trim()) return;
    if (await controller.act(() => api.setToken(token))) {
      setToken("");
      setVerified(null);
    }
  };
  const verify = async () => {
    if (!api) return;
    setVerified((await controller.ask(() => api.verify())) ?? null);
  };
  const disconnect = async () => {
    if (!api) return;
    const ok = await confirm({
      message: "Disconnect the agent account? Every running ticket stops, and the token is deleted from this computer.",
      destructive: true,
    });
    if (ok && (await controller.act(() => api.clearToken()))) setVerified(null);
  };

  return (
    <FormSection title="Agent account" note="A dedicated GitHub account the agent acts as">
      {account ? (
        <>
          <div className="superagent__account">
            <Tag tone="ok">Connected</Tag>
            <strong>@{account.login}</strong>
            <span className="superagent__spacer" />
            <button type="button" className="btn btn--ghost btn--small" disabled={controller.busy} onClick={() => void verify()}>
              Check access
            </button>
            <button type="button" className="btn btn--ghost btn--small" disabled={controller.busy} onClick={() => void disconnect()}>
              Disconnect
            </button>
          </div>
          {verified && (
            <Callout tone={verified.canPush ? "good" : "warn"}>
              {verified.canPush
                ? `@${verified.login} can push to ${verified.repository}.`
                : `@${verified.login} can see ${verified.repository} but cannot push to it; workers could not open pull requests.`}
            </Callout>
          )}
        </>
      ) : (
        <>
          {accountError && <Callout tone="bad">{accountError}</Callout>}
          <Field
            label="GitHub token"
            hint="A personal access token of the agent's own account (not yours), with access to the repository: contents, issues and pull requests read and write. It is stored encrypted on this computer and never sent to a model."
          >
            <div className="superagent__token">
              <input
                className="input input-mono"
                type="password"
                aria-label="GitHub token"
                autoComplete="off"
                spellCheck={false}
                placeholder="github_pat_…"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void connect();
                }}
              />
              <button type="button" className="btn btn--primary" disabled={controller.busy || !token.trim()} onClick={() => void connect()}>
                Connect
              </button>
            </div>
          </Field>
        </>
      )}
    </FormSection>
  );
}
