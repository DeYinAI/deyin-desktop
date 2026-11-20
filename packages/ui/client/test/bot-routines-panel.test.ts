import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AutomationInfo } from "@deyin/contract";
import { BotRoutinesPanel, type RoutineEditor, type RoutinesState } from "../src/bots/BotRoutines.js";
import { emptyRoutineForm } from "../src/bots/botRoutines.js";

const noop = () => undefined;
const NOW = new Date(2026, 0, 5, 12, 0, 0);

function info(over: Partial<AutomationInfo> = {}): AutomationInfo {
  return {
    id: "a1",
    botId: "ada",
    name: "Digest",
    enabled: true,
    payload: { kind: "prompt", prompt: "Summarise" },
    trigger: { kind: "cron", expression: "30 8 * * *" },
    target: { kind: "local", workspacePath: "/bots/ada/files" },
    model: "m",
    providerId: "openference",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

interface Over {
  state?: RoutinesState;
  notice?: string | null;
  info?: string | null;
  editor?: RoutineEditor | null;
}

function render(over: Over = {}): string {
  return renderToStaticMarkup(
    createElement(BotRoutinesPanel, {
      state: over.state ?? { status: "ready", rows: [], addBlock: null },
      notice: over.notice ?? null,
      info: over.info ?? null,
      editor: over.editor ?? null,
      now: NOW.getTime(),
      onNew: noop,
      onEdit: noop,
      onToggle: noop,
      onTest: noop,
      onDelete: noop,
      onChangeForm: noop,
      onSave: noop,
      onCancel: noop,
    }),
  );
}

const ready = (rows: AutomationInfo[], addBlock: RoutinesState extends infer S ? (S extends { addBlock: infer B } ? B : never) : never = null): RoutinesState => ({ status: "ready", rows, addBlock });

test("loading and load failure are shown, with no list or New button", () => {
  const loading = render({ state: { status: "loading" } });
  assert.match(loading, /role="status"[^>]*>Loading routines…/);
  assert.doesNotMatch(loading, /New routine/);
  const failed = render({ state: { status: "error", error: "ipc closed" } });
  assert.match(failed, /role="alert"[^>]*>Couldn&#x27;t load routines\. ipc closed/);
  assert.doesNotMatch(failed, /New routine/);
});

test("an empty Bot says so and offers a new routine", () => {
  const html = render();
  assert.match(html, /No routines yet\./);
  assert.match(html, />New routine</);
  assert.doesNotMatch(html, /bot-routines__list/);
});

test("each routine shows its name and schedule, and Test, Edit and Delete", () => {
  const html = render({ state: ready([info({ name: "Morning digest" })]) });
  assert.match(html, /bot-routine__name">Morning digest</);
  assert.match(html, /bot-routine__schedule">Every day at 08:30</);
  assert.match(html, />Test</);
  assert.match(html, />Edit</);
  assert.match(html, />Delete</);
  assert.doesNotMatch(html, /No routines yet/);
});

test("the switch reflects whether the routine is running, and its name says what it will do", () => {
  const on = render({ state: ready([info({ enabled: true })]) });
  assert.match(on, /role="switch"[^>]*aria-checked="true"/);
  assert.match(on, /aria-label="Pause: Digest"/);
  const off = render({ state: ready([info({ enabled: false })]) });
  assert.match(off, /aria-checked="false"/);
  assert.match(off, /aria-label="Resume: Digest"/);
  assert.match(off, /bot-routine__badge">Paused</);
  assert.doesNotMatch(on, /bot-routine__badge/);
});

test("a finished one-shot is marked ended", () => {
  const ended = info({ trigger: { kind: "once", at: NOW.getTime() - 1000 }, lastScheduledAt: NOW.getTime() - 1000 });
  assert.match(render({ state: ready([ended]) }), /bot-routine__badge">Ended</);
});

test("a skill routine cannot be edited here, and says where it can", () => {
  const html = render({ state: ready([info({ payload: { kind: "skill", skill: "digest" } })]) });
  assert.match(html, /<button type="button" class="btn btn--ghost" disabled="" title="Edit in Automations">Edit</);
  const plain = render({ state: ready([info()]) });
  assert.doesNotMatch(plain, /disabled="" title="Edit in Automations"/);
});

test("when no more can be added, the reason replaces the New button", () => {
  const limit = render({ state: ready([info()], "limit") });
  assert.match(limit, /This Bot has reached the limit of 50 routines\./);
  assert.doesNotMatch(limit, />New routine</);
  assert.match(render({ state: ready([], "archived") }), /Restore this Bot to add routines\./);
  assert.match(render({ state: ready([], "noModel") }), /Choose a model first/);
  assert.doesNotMatch(render({ state: ready([], "noModel") }), />New routine</);
});

test("a refusal and a test-run notice are shown", () => {
  assert.match(render({ notice: "A routine cannot move to another Bot." }), /role="alert"[^>]*>A routine cannot move to another Bot\./);
  assert.match(render({ info: "Started a test run." }), /role="status"[^>]*>Started a test run\./);
  assert.doesNotMatch(render(), /role="alert"/);
});

test("names and instructions are escaped", () => {
  const html = render({ state: ready([info({ name: "<img src=x onerror=alert(1)>" })]) });
  assert.doesNotMatch(html, /<img src=x/);
});

function editor(over: Partial<RoutineEditor> = {}): RoutineEditor {
  return { id: null, form: emptyRoutineForm(NOW), busy: false, error: null, ...over };
}

test("the editor replaces the New button, with name, instruction and the schedule rows", () => {
  const html = render({ editor: editor() });
  assert.doesNotMatch(html, />New routine</);
  assert.match(html, /<form class="bot-routines__editor" aria-label="New routine"/);
  assert.match(html, /id="routine-name"/);
  assert.match(html, /id="routine-instruction"/);
  assert.match(html, /placeholder="What should this Bot do each time\?"/);
  assert.match(html, /<span class="rule-row__label">Repeat</);
  assert.match(html, /id="routine-time"/, "the schedule rows use this editor's own ids");
  assert.doesNotMatch(html, /id="autos-/);
});

test("an empty form cannot be saved, and does not shout about it", () => {
  const html = render({ editor: editor() });
  assert.match(html, /<button type="submit" class="btn btn--primary" disabled="">Save routine</);
  assert.doesNotMatch(html, /Give the routine a name/);
});

test("a complete form can be saved", () => {
  const form = { ...emptyRoutineForm(NOW), name: "Digest", instruction: "Go" };
  const html = render({ editor: editor({ form }) });
  assert.match(html, /<button type="submit" class="btn btn--primary">Save routine</);
  assert.match(html, /value="Digest"/);
});

test("editing an existing routine is titled Edit", () => {
  assert.match(render({ editor: editor({ id: "a1" }) }), /aria-label="Edit"/);
});

test("a schedule that is too frequent is called out and blocks saving", () => {
  const base = emptyRoutineForm(NOW);
  const form = { ...base, name: "n", instruction: "i", schedule: { ...base.schedule, repeat: "minutely" as const, interval: "2" } };
  const html = render({ editor: editor({ form }) });
  assert.match(html, /A routine can run at most once every 5 minutes\./);
  assert.match(html, /<button type="submit" class="btn btn--primary" disabled="">/);
});

test("a host refusal while saving is shown in the editor and replaces the hint", () => {
  const html = render({ editor: editor({ error: "Ada is archived." }) });
  assert.match(html, /role="alert"[^>]*>Ada is archived\./);
});

test("while saving, the fields and both buttons are locked", () => {
  const form = { ...emptyRoutineForm(NOW), name: "n", instruction: "i" };
  const html = render({ editor: editor({ form, busy: true }) });
  assert.match(html, /<button type="submit" class="btn btn--primary" disabled="">Saving…</);
  assert.match(html, /<button type="button" class="btn btn--outline" disabled="">Cancel</);
  assert.match(html, /id="routine-name"[^>]*disabled=""/);
  assert.match(html, /id="routine-instruction"[^>]*disabled=""/);
});

test("the name is capped to the same length automations allow", () => {
  assert.match(render({ editor: editor() }), /id="routine-name"[^>]*maxLength="120"/);
});
