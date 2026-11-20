import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  LOCKED,
  NOT_INSTALLED,
  NO_SUCH_LOGIN,
  OnePasswordError,
  TIMED_OUT,
  createOnePassword,
  onePasswordIf,
  opFailure,
  runOp,
  type OpResult,
} from "../src/main/bots/onepassword.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const ID = "abcdefghijklmnopqrstuvwxyz";

/** A stand-in for `op`: a real program, started the way the real one is, that writes down what it was given. */
function fakeOp(body: string): { command: string; args: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "deyin-op-"));
  dirs.push(dir);
  const command = join(dir, "op");
  const record = join(dir, "args");
  writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\n${body}\n`);
  chmodSync(command, 0o755);
  return { command, args: () => readFileSync(record, "utf8").split("\n").slice(0, -1) };
}

test("the logins are asked for as logins only, in JSON, and parsed", async () => {
  const op = fakeOp(`cat <<'JSON'\n[{"id":"${ID}","title":"GitHub","category":"LOGIN","additional_information":"octocat","urls":[{"href":"https://github.com/login"}]}]\nJSON`);
  const logins = await createOnePassword(runOp(op.command)).logins();
  assert.deepEqual(logins, [{ id: ID, title: "GitHub", username: "octocat", sites: ["github.com"] }]);
  assert.deepEqual(op.args(), ["item", "list", "--categories", "Login", "--format", "json"]);
});

test("a login's credential is read by its id, as JSON, and only the user name and password are taken", async () => {
  const op = fakeOp(`cat <<'JSON'\n{"id":"${ID}","fields":[{"purpose":"USERNAME","value":"octocat"},{"purpose":"PASSWORD","value":"s3cret"},{"label":"one-time password","value":"123456"}]}\nJSON`);
  assert.deepEqual(await createOnePassword(runOp(op.command)).credential(ID), { username: "octocat", password: "s3cret" });
  assert.deepEqual(op.args(), ["item", "get", ID, "--format", "json"]);
});

test("an id that could be taken for an option or a command never reaches op", async () => {
  const calls: string[][] = [];
  const spy = async (args: readonly string[]): Promise<OpResult> => {
    calls.push([...args]);
    return { code: 0, stdout: "{}", stderr: "" };
  };
  const onePassword = createOnePassword(spy);
  for (const bad of ["--vault=x", "-h", "", "short", "id with space 1234", "abc;rm -rf ~/ #", "$(whoami)abcdefgh"]) {
    await assert.rejects(onePassword.credential(bad), (error: unknown) => error instanceof OnePasswordError && error.message === NO_SUCH_LOGIN, bad);
  }
  assert.deepEqual(calls, []);
});

test("arguments are passed to op as they are, never through a shell", async () => {
  const op = fakeOp("exit 0");
  await runOp(op.command)(["a b", "$(touch /tmp/should-not-exist-op)", "x;y", "`id`", "*"]);
  assert.deepEqual(op.args(), ["a b", "$(touch /tmp/should-not-exist-op)", "x;y", "`id`", "*"]);
});

test("op not being installed is said plainly, with what to do", async () => {
  await assert.rejects(runOp(join(tmpdir(), "no-such-dir-op", "op"))([]), (error: unknown) => error instanceof OnePasswordError && error.message === NOT_INSTALLED);
  assert.match(NOT_INSTALLED, /Integrate with 1Password CLI/);
});

test("op taking too long (waiting for an unlock nobody gives) ends the call and says so", async () => {
  const op = fakeOp("exec sleep 30");
  const started = Date.now();
  await assert.rejects(runOp(op.command, 300)(["item", "list"]), (error: unknown) => error instanceof OnePasswordError && error.message === TIMED_OUT);
  assert.ok(Date.now() - started < 10_000, "it did not wait for the program");
});

test("a locked or signed-out 1Password, and a login that is gone, are told apart", () => {
  const said = (stderr: string): string => opFailure({ code: 1, stdout: "", stderr }).message;
  assert.equal(said("[ERROR] 2026/01/01 10:00:00 You are not currently signed in. Please run `op signin`"), LOCKED);
  assert.equal(said("[ERROR] 2026/01/01 10:00:00 account is not signed in"), LOCKED);
  assert.equal(said("[ERROR] 2026/01/01 10:00:00 authorization prompt dismissed"), LOCKED);
  assert.equal(said(`[ERROR] 2026/01/01 10:00:00 "x" isn't an item in any vault.`), NO_SUCH_LOGIN);
});

test("any other refusal is passed on as one line without op's date prefix, capped in length", () => {
  const said = (stderr: string): string => opFailure({ code: 3, stdout: "", stderr }).message;
  assert.equal(said("[ERROR] 2026/01/01 10:00:00 vault is archived\nmore detail"), "1Password said: vault is archived");
  assert.equal(said(""), "1Password's command-line tool stopped with code 3.");
  assert.equal(said(`[ERROR] 2026/01/01 10:00:00 ${"x".repeat(1000)}`).length, "1Password said: ".length + 200);
});

test("a failed run reports only op's error, never what it printed on standard output", async () => {
  const op = fakeOp(`echo '{"fields":[{"purpose":"PASSWORD","value":"LEAKED-SECRET"}]}'\necho '[ERROR] 2026/01/01 10:00:00 boom' >&2\nexit 1`);
  await assert.rejects(createOnePassword(runOp(op.command)).credential(ID), (error: unknown) => {
    assert.ok(error instanceof OnePasswordError);
    assert.equal(error.message, "1Password said: boom");
    assert.ok(!error.message.includes("LEAKED-SECRET"));
    return true;
  });
});

test("output that is not what op normally prints gives no logins and no credential, not a crash", async () => {
  const op = fakeOp("echo 'surprise'");
  const onePassword = createOnePassword(runOp(op.command));
  assert.deepEqual(await onePassword.logins(), []);
  assert.deepEqual(await onePassword.credential(ID), { username: null, password: null });
});

test("1Password is only used when it is turned on, and one connection is shared", () => {
  assert.equal(onePasswordIf(false), undefined);
  const first = onePasswordIf(true);
  assert.ok(first);
  assert.equal(onePasswordIf(true), first);
});
