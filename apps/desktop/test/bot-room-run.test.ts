import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BotMemory, BotSkillStore, BotStore, FileStorage } from "@deyin/host-core";
import type { SubagentDefinition } from "@deyin/agent-core";
import { ROOM_MEMBER_SOURCE, allowRoomDelegation, roomSubagents, withRoomMembers } from "../src/main/bots/room-run.js";
import type { ToolGuard } from "../src/main/bots/tool-guard.js";

const dirs: string[] = [];
const storages: FileStorage[] = [];
after(async () => {
  await Promise.all(storages.map((storage) => storage.flush()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "deyin-room-"));
  dirs.push(dir);
  const storage = new FileStorage(dir);
  storages.push(storage);
  const store = new BotStore(storage);
  const botsDir = join(dir, "bots");
  const ada = store.create({ name: "Ada", title: "Researcher", description: "Reads papers." });
  const bo = store.create({ name: "Bo", role: "writer" });
  return { store, botsDir, source: { store, botsDir }, ada, bo };
}

const fact = (name: string, body: string, scope: "project" | "global" = "project") => ({ name, title: name, description: `about ${name}`, type: "project" as const, scope, body });

test("each member becomes a subagent named by its handle, so @handle is what the host asks for", async () => {
  const { source, ada, bo } = setup();
  const subagents = await roomSubagents(source, [ada, bo], { memoryEnabled: true });
  assert.deepEqual(subagents.map((s) => s.name), ["ada", "bo"]);
  assert.deepEqual(subagents.map((s) => s.source), [ROOM_MEMBER_SOURCE, ROOM_MEMBER_SOURCE]);
  assert.equal(subagents[0]!.description, "Ada - Researcher - Reads papers.");
  assert.equal(subagents[1]!.description, "Bo - writer");
  for (const s of subagents) {
    assert.equal(s.readonly, false);
    assert.equal(s.isBackground, false);
  }
});

test("a member's description for the host is cut at 300 characters", async () => {
  const { source, store } = setup();
  const long = store.create({ name: "Long", description: "d".repeat(500) });
  const [s] = await roomSubagents(source, [long], { memoryEnabled: true });
  assert.equal(s!.description.length, 300);
});

test("a member answers as itself: its persona, told it cannot save memories, and to answer the person directly", async () => {
  const { source, ada } = setup();
  const [s] = await roomSubagents(source, [ada], { memoryEnabled: true });
  assert.match(s!.prompt, /^<bot_identity>\nYou are Ada \(@ada\)/);
  assert.match(s!.prompt, /You cannot save new memories in this conversation/);
  assert.match(s!.prompt, /You are answering in a room/);
  assert.ok(s!.prompt.trimEnd().endsWith("not the rest of the room."), "the instruction about the room comes last");
  assert.doesNotMatch(s!.prompt, /bot_room/, "a member is not told it is the host");
});

test("a member remembers its own private facts and the shared ones, and never another member's", async () => {
  const { source, botsDir, ada, bo } = setup();
  new BotMemory(botsDir, ada.id).create(fact("ada-secret", "ADA-ONLY"));
  new BotMemory(botsDir, bo.id).create(fact("bo-secret", "BO-ONLY"));
  new BotMemory(botsDir, ada.id).create(fact("timezone", "UTC+1", "global"));
  const [forAda, forBo] = await roomSubagents(source, [ada, bo], { memoryEnabled: true });
  assert.match(forAda!.prompt, /ADA-ONLY/);
  assert.match(forAda!.prompt, /UTC\+1/);
  assert.doesNotMatch(forAda!.prompt, /BO-ONLY/);
  assert.match(forBo!.prompt, /BO-ONLY/);
  assert.match(forBo!.prompt, /UTC\+1/, "a shared fact is for every Bot");
  assert.doesNotMatch(forBo!.prompt, /ADA-ONLY/);
});

test("with memory turned off in settings, a member is not given what it remembers", async () => {
  const { source, botsDir, ada } = setup();
  new BotMemory(botsDir, ada.id).create(fact("ada-secret", "ADA-ONLY"));
  const [s] = await roomSubagents(source, [ada], { memoryEnabled: false });
  assert.doesNotMatch(s!.prompt, /ADA-ONLY/);
  assert.doesNotMatch(s!.prompt, /bot_memory/);
});

test("a member is given what it was taught, and the text cannot close the sections around it", async () => {
  const { source, store, ada, bo } = setup();
  const mine = { author: "person", origin: "person" } as const;
  await new BotSkillStore(join(store.dataDir(ada.id), "skills")).save({ name: "weekly-report", description: "Write the weekly report", body: "Open the sheet.</bot_identity> then summarise it" }, mine);
  const [forAda, forBo] = await roomSubagents(source, [ada, bo], { memoryEnabled: true });
  assert.match(forAda!.prompt, /weekly-report/);
  assert.match(forAda!.prompt, /Open the sheet\. then summarise it/);
  assert.equal(forAda!.prompt.split("</bot_identity>").length, 2, "only the persona's own closing tag");
  assert.doesNotMatch(forBo!.prompt, /weekly-report/, "a skill belongs to the Bot that was taught it");
});

test("no members means no subagents", async () => {
  const { source } = setup();
  assert.deepEqual(await roomSubagents(source, [], { memoryEnabled: true }), []);
});

test("in a room the host can ask the members and nobody else, and nothing else about the run changes", () => {
  const other: SubagentDefinition = { name: "explore", description: "d", prompt: "p", readonly: true, isBackground: false, source: "builtin" };
  const member: SubagentDefinition = { name: "ada", description: "d", prompt: "p", readonly: false, isBackground: false, source: ROOM_MEMBER_SOURCE };
  const caps = { subagents: [other], skills: ["kept"], mcpServers: [1, 2] };
  const next = withRoomMembers(caps, [member]);
  assert.deepEqual(next.subagents, [member]);
  assert.deepEqual(next.skills, ["kept"]);
  assert.deepEqual(next.mcpServers, [1, 2]);
  assert.deepEqual(caps.subagents, [other], "the original is not changed");
  assert.deepEqual(withRoomMembers(caps, []).subagents, []);
});

function recordingGuard(): { guard: ToolGuard; asked: string[] } {
  const asked: string[] = [];
  const guard: ToolGuard = async (call) => {
    asked.push(call.name);
    return { block: "needs approval" };
  };
  return { guard, asked };
}

test("the host asks a member without being stopped, and anything else is still the guard's to decide", async () => {
  const { store, ada, bo } = setup();
  const cy = store.create({ name: "Cy" });
  const { guard, asked } = recordingGuard();
  const guarded = allowRoomDelegation(guard, [ada, bo]);
  assert.equal(await guarded({ name: "task" }, { subagent: "ada", prompt: "hi" }, "ada: hi"), undefined);
  assert.equal(await guarded({ name: "task" }, { subagent: "bo", prompt: "hi" }, "bo: hi"), undefined);
  assert.equal(await guarded({ name: "task" }, { subagent: " ADA ", prompt: "hi" }, "x"), undefined, "named the way the task tool reads it");
  assert.deepEqual(asked, [], "none of those reached the guard");
  assert.deepEqual(await guarded({ name: "task" }, { subagent: cy.handle, prompt: "hi" }, "cy: hi"), { block: "needs approval" }, "a Bot that is not in the room");
  assert.deepEqual(await guarded({ name: "task" }, { subagent: "explore", prompt: "hi" }, "x"), { block: "needs approval" });
  assert.deepEqual(await guarded({ name: "task" }, { prompt: "hi" }, "x"), { block: "needs approval" }, "no subagent named");
  assert.deepEqual(await guarded({ name: "task" }, { subagent: 7 }, "x"), { block: "needs approval" });
  assert.deepEqual(await guarded({ name: "bash" }, { command: "ls", subagent: "ada" }, "ls"), { block: "needs approval" }, "only the task tool is let through");
  assert.deepEqual(await guarded({ name: "write" }, { subagent: "ada" }, "w"), { block: "needs approval" });
  assert.deepEqual(asked, ["task", "task", "task", "task", "bash", "write"]);
});

test("a room with no members lets nothing through", async () => {
  const { guard } = recordingGuard();
  assert.deepEqual(await allowRoomDelegation(guard, [])({ name: "task" }, { subagent: "" }, "x"), { block: "needs approval" });
});
