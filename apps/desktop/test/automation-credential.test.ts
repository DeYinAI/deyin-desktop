import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderInfo } from "@deyin/host-core";
import { LOCAL_ENDPOINT_NO_KEY, credentialProbe } from "../src/main/automations/agent-run-context.js";
import { preflight } from "../src/main/automations/health.js";

function provider(over: Partial<ProviderInfo> & { id: string }): ProviderInfo {
  return {
    name: over.id,
    kind: "custom",
    status: "connected",
    enabled: true,
    apiFormat: "chat-completions",
    hasKey: true,
    connectionModes: ["API key"],
    activeMode: "API key",
    models: [],
    disabledModels: [],
    ...over,
  };
}

function deps(providers: ProviderInfo[], keys: Record<string, string>, account: string | null) {
  let accountCalls = 0;
  return {
    deps: {
      agents: { listProviders: () => providers, getKey: (id: string) => keys[id] ?? null },
      auth: { getAccessToken: async () => (accountCalls++, account) },
    } as unknown as Parameters<typeof credentialProbe>[0],
    accountCalls: () => accountCalls,
  };
}

const run = (providerId: string, kind: "local" | "ssh" | "wsl" = "local") => ({ providerId, target: { kind } });
const probes = (credential: ReturnType<typeof credentialProbe>) => ({
  ...credential,
  workspaceExists: () => true,
  sleep: async () => undefined,
});
const preflightTarget = { target: { kind: "local" as const, workspacePath: "/w" } };

test("a local run on a model from a provider the person added needs that provider's key, not an Openference sign-in", async () => {
  const { deps: d, accountCalls } = deps([provider({ id: "mine", name: "My gateway" })], { mine: "sk-mine" }, null);
  const result = await preflight(preflightTarget, probes(credentialProbe(d, run("mine"))));
  assert.deepEqual(result, { ok: true, token: "sk-mine" });
  assert.equal(accountCalls(), 0, "the account is never asked");
});

test("a provider with no saved key says so, in words that name it and where to fix it", async () => {
  const { deps: d } = deps([provider({ id: "mine", name: "My gateway", hasKey: false, status: "not-connected" })], {}, "account-token");
  const result = await preflight(preflightTarget, probes(credentialProbe(d, run("mine"))));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.blocker.kind, "auth");
  assert.equal(!result.ok && result.blocker.detail, "No API key is saved for My gateway. Add one in Settings, under Models.");
});

test("a local endpoint that takes no key does not need one", async () => {
  const { deps: d } = deps([provider({ id: "ollama", name: "Ollama", local: true, hasKey: false })], {}, null);
  assert.deepEqual(await preflight(preflightTarget, probes(credentialProbe(d, run("ollama")))), { ok: true, token: LOCAL_ENDPOINT_NO_KEY });
});

test("an Openference model still needs the Openference sign-in, and says so when signed out", async () => {
  const signedIn = deps([provider({ id: "openference", kind: "primary" })], {}, "account-token");
  assert.deepEqual(await preflight(preflightTarget, probes(credentialProbe(signedIn.deps, run("openference")))), { ok: true, token: "account-token" });
  const signedOut = deps([provider({ id: "openference", kind: "primary" })], {}, null);
  const result = await preflight(preflightTarget, probes(credentialProbe(signedOut.deps, run("openference"))));
  assert.equal(!result.ok && result.blocker.detail, "Not signed in. Connect your Openference account first.");
});

test("runs on WSL or an SSH host carry the Openference token, so they keep the sign-in check even with a custom provider", async () => {
  for (const kind of ["wsl", "ssh"] as const) {
    const { deps: d, accountCalls } = deps([provider({ id: "mine" })], { mine: "sk-mine" }, "account-token");
    const result = await preflight({ target: { kind, distro: "Ubuntu", workspacePath: "/w", hostId: "h" } as never }, probes(credentialProbe(d, run("mine", kind))));
    assert.deepEqual(result, { ok: true, token: "account-token" }, kind);
    assert.equal(accountCalls(), 1, kind);
  }
});

test("a provider id nobody knows falls back to the Openference sign-in", async () => {
  const { deps: d } = deps([], {}, "account-token");
  assert.deepEqual(await preflight(preflightTarget, probes(credentialProbe(d, run("gone")))), { ok: true, token: "account-token" });
});
