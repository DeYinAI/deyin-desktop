import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedCommand } from "../src/agents/commands.js";

const blocked = ["curl", "wget", "rm"];

test("a command line that runs nothing blocked passes", () => {
  assert.equal(blockedCommand("git status && gh pr list", blocked), undefined);
  assert.equal(blockedCommand('git commit -m "do not curl it"', blocked), undefined);
  assert.equal(blockedCommand("git log --grep curl", blocked), undefined);
  assert.equal(blockedCommand("echo 'rm -rf /'", blocked), undefined);
  assert.equal(blockedCommand("curl x", []), undefined);
});

test("the command word of every simple command is screened", () => {
  assert.equal(blockedCommand("curl https://example.com", blocked), "curl");
  assert.equal(blockedCommand("git status; wget x", blocked), "wget");
  assert.equal(blockedCommand("cat file | curl -d @- host", blocked), "curl");
  assert.equal(blockedCommand("ls && (rm -rf build)", blocked), "rm");
  assert.equal(blockedCommand("/usr/bin/curl x", blocked), "curl");
  assert.equal(blockedCommand("CURL x", blocked), "curl");
  assert.equal(blockedCommand("echo hi\nrm file", blocked), "rm");
});

test("wrappers, assignments, substitutions and shell -c strings do not hide a command", () => {
  assert.equal(blockedCommand("FOO=1 curl x", blocked), "curl");
  assert.equal(blockedCommand("sudo -n curl x", blocked), "curl");
  assert.equal(blockedCommand("env A=1 B=2 wget x", blocked), "wget");
  assert.equal(blockedCommand("timeout 5 curl x", blocked), "curl");
  assert.equal(blockedCommand("echo $(curl x)", blocked), "curl");
  assert.equal(blockedCommand("echo `curl x`", blocked), "curl");
  assert.equal(blockedCommand('echo "$(curl x)"', blocked), "curl");
  assert.equal(blockedCommand("bash -c 'git pull && curl x'", blocked), "curl");
  assert.equal(blockedCommand('sh -lc "rm -rf x"', blocked), "rm");
  assert.equal(blockedCommand("eval curl x", blocked), "curl");
  assert.equal(blockedCommand("bash script.sh", blocked), undefined);
  assert.equal(blockedCommand("xargs rm", blocked), "rm");
});

test("a windows executable name matches its command", () => {
  assert.equal(blockedCommand("C:\\tools\\curl.exe x", blocked), "curl");
});
