import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolDefinition } from "@deyin/agent-core";
import { REDACTED, isSecretName, redact, redactingTool, secretValues, workerEnvironment } from "../src/main/superagent/secrets.js";

test("names that hold credentials are recognized, and ordinary ones are not", () => {
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "OPENAI_API_KEY", "SSH_AUTH_SOCK", "NPM_TOKEN", "db_password", "GH_PAT", "ANTHROPIC_APIKEY"]) {
    assert.equal(isSecretName(name), true, name);
  }
  for (const name of ["PATH", "HOME", "LANG", "XAUTHORITY", "DSH_SUPERAGENT_GITHUB_ACCOUNT", "GIT_AUTHOR_NAME", "KEYBOARD", "TERM"]) {
    assert.equal(isSecretName(name), false, name);
  }
});

test("the worker's shell loses the desktop's credentials and gets its own variables, which win", () => {
  const env = workerEnvironment({ GH_TOKEN: "agent-token-value", DSH_SUPERAGENT_TICKET: "t1" }, { GH_TOKEN: "users-own", OPENAI_API_KEY: "k", PATH: "/bin", HOME: "/home/me" });
  assert.deepEqual(env, { GH_TOKEN: "agent-token-value", OPENAI_API_KEY: null, DSH_SUPERAGENT_TICKET: "t1" });
});

test("only credential variables of sufficient length are hidden, in the forms they may be echoed in", () => {
  const values = secretValues({ GH_TOKEN: "ghp_abc/def+123", DSH_SUPERAGENT_NAME: "acme/app", GITHUB_TOKEN: "short" });
  assert.ok(values.includes("ghp_abc/def+123"));
  assert.ok(values.includes(encodeURIComponent("ghp_abc/def+123")));
  assert.ok(values.includes(Buffer.from("ghp_abc/def+123").toString("base64")));
  assert.ok(!values.includes("acme/app") && !values.includes("short"));
  assert.deepEqual(values, [...values].sort((a, b) => b.length - a.length), "longest first, so a value inside another cannot leave a fragment");
});

test("redaction replaces every occurrence and leaves other text alone", () => {
  assert.equal(redact("a SECRET1234 b SECRET1234", ["SECRET1234"]), `a ${REDACTED} b ${REDACTED}`);
  assert.equal(redact("nothing here", ["SECRET1234"]), "nothing here");
  assert.equal(redact("x", []), "x");
});

const tool = (execute: ToolDefinition["execute"]): ToolDefinition => ({ name: "t", description: "", parameters: { type: "object", properties: {} }, tier: "read", summarize: () => "t", execute });

test("a redacting tool hides secrets in its result and in its errors, and passes everything else through", async () => {
  const secrets = ["SECRET1234"];
  const ok = redactingTool(tool(async () => "token=SECRET1234"), secrets);
  assert.equal(await ok.execute({}, {} as never), `token=${REDACTED}`);
  const failing = redactingTool(tool(async () => { throw new Error("denied for SECRET1234"); }), secrets);
  await assert.rejects(failing.execute({}, {} as never), (error: Error) => error.message === `denied for ${REDACTED}`);
  const abort = new DOMException("aborted", "AbortError");
  const aborting = redactingTool(tool(async () => { throw abort; }), secrets);
  await assert.rejects(aborting.execute({}, {} as never), (error: unknown) => error === abort, "an abort stays the same error");
  const untouched = tool(async () => "x");
  assert.equal(redactingTool(untouched, []), untouched, "no secrets, no wrapper");
});
