import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TEACH_LIMITS, missingTranslations, type TeachState } from "@deyin/host-core/shared";
import { BotTeachPanel, type TeachResult } from "../src/bots/BotTeach.js";
import { IDLE_TEACH, canAddNote, canStartTeaching, recordingLine, secretsLine, teachPhase } from "../src/bots/botTeach.js";

const noop = () => undefined;

function state(over: Partial<TeachState> = {}): TeachState {
  return { recording: true, botId: "ada", title: "Download the report", steps: 3, full: false, secretsOmitted: 0, ...over };
}

test("nothing recording is idle, a recording for this Bot is its own, and one for another Bot is not to be touched", () => {
  assert.equal(teachPhase(IDLE_TEACH, "ada"), "idle");
  assert.equal(teachPhase(state(), "ada"), "recording");
  assert.equal(teachPhase(state({ botId: "grace" }), "ada"), "elsewhere");
  assert.equal(teachPhase(state({ botId: undefined }), "ada"), "elsewhere");
  assert.equal(teachPhase({ ...IDLE_TEACH, botId: "ada" }, "ada"), "idle", "a stale Bot id does not make an idle state a recording");
});

test("a recording needs a task name, and a note needs words", () => {
  assert.equal(canStartTeaching(""), false);
  assert.equal(canStartTeaching("   "), false);
  assert.equal(canStartTeaching("Download"), true);
  assert.equal(canAddNote(" \n"), false);
  assert.equal(canAddNote("wait"), true);
});

test("the recording line says how much is kept, in the singular for one, and says when it is full", () => {
  assert.deepEqual(recordingLine(state({ steps: 0 })), { key: "bot.teach.recording", vars: { steps: 0 } });
  assert.deepEqual(recordingLine(state({ steps: 1 })), { key: "bot.teach.recordingOne", vars: { steps: 1 } });
  assert.deepEqual(recordingLine(state({ steps: 2 })), { key: "bot.teach.recording", vars: { steps: 2 } });
  assert.deepEqual(recordingLine(state({ steps: TEACH_LIMITS.steps, full: true })), { key: "bot.teach.full", vars: { steps: TEACH_LIMITS.steps, max: TEACH_LIMITS.steps } });
  assert.deepEqual(recordingLine(state({ steps: 1, full: true })).key, "bot.teach.full", "full wins over the singular");
});

test("secrets left out are counted for the person, and said nothing about when there were none", () => {
  assert.equal(secretsLine({ secretsOmitted: 0 }), null);
  assert.deepEqual(secretsLine({ secretsOmitted: 1 }), { key: "bot.teach.secretOne", vars: { count: 1 } });
  assert.deepEqual(secretsLine({ secretsOmitted: 4 }), { key: "bot.teach.secrets", vars: { count: 4 } });
  assert.equal(secretsLine({ secretsOmitted: -1 }), null);
});

test("every teach string exists in every language", () => {
  for (const locale of ["zh", "de"] as const) {
    assert.deepEqual(missingTranslations(locale).filter((key) => key.startsWith("bot.teach.")), [], locale);
  }
});

interface Over {
  phase?: ReturnType<typeof teachPhase>;
  state?: TeachState;
  title?: string;
  note?: string;
  busy?: boolean;
  error?: string | null;
  result?: TeachResult | null;
}

function render(over: Over = {}): string {
  return renderToStaticMarkup(
    createElement(BotTeachPanel, {
      phase: over.phase ?? "idle",
      state: over.state ?? IDLE_TEACH,
      title: over.title ?? "",
      note: over.note ?? "",
      busy: over.busy ?? false,
      error: over.error ?? null,
      result: over.result ?? null,
      onTitle: noop,
      onNote: noop,
      onStart: noop,
      onAddNote: noop,
      onStop: noop,
      onCancel: noop,
    }),
  );
}

test("idle shows the task name and a Start that stays off until the task has a name", () => {
  const empty = render();
  assert.match(empty, /Teach by showing/);
  assert.match(empty, /id="teach-title"[^>]*maxLength="120"/);
  assert.match(empty, /<button type="submit"[^>]*disabled=""[^>]*>Start recording</);
  assert.doesNotMatch(empty, /Stop and write the skill/);
  const named = render({ title: "Download the report" });
  assert.doesNotMatch(named, /<button type="submit"[^>]*disabled=""/);
  assert.match(named, /value="Download the report"/);
});

test("while recording, the person sees what is kept, the latest step, and can note, stop or throw away", () => {
  const html = render({ phase: "recording", state: state({ steps: 4, last: "Clicked “Export”" }), note: "" });
  assert.match(html, /role="status"[^>]*><span class="bot-panel__dot" aria-hidden="true"><\/span>Recording: 4 steps kept/);
  assert.match(html, /Latest: Clicked “Export”/);
  assert.match(html, />Stop and write the skill</);
  assert.match(html, />Throw away</);
  assert.match(html, /id="teach-note"[^>]*maxLength="300"/);
  assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Add note</, "no note, no Add note");
  assert.doesNotMatch(html, /id="teach-title"/, "a recording cannot be started again over itself");
});

test("a note with words can be added; secrets that were left out are said", () => {
  const html = render({ phase: "recording", state: state({ secretsOmitted: 2 }), note: "wait for the download" });
  assert.doesNotMatch(html, /<button type="submit"[^>]*disabled=""[^>]*>Add note</);
  assert.match(html, /2 password or card details were left out\./);
  const one = render({ phase: "recording", state: state({ secretsOmitted: 1 }) });
  assert.match(one, /1 password or card detail was left out\./);
  assert.doesNotMatch(render({ phase: "recording", state: state() }), /left out/);
});

test("when the recording is full it says so and still allows stopping", () => {
  const html = render({ phase: "recording", state: state({ steps: 200, full: true }) });
  assert.match(html, /That is as much as can be kept \(200 of 200 steps\)\. Stop to make the skill\./);
  assert.match(html, />Stop and write the skill</);
});

test("a recording for another Bot hides every control and says to finish it first", () => {
  const html = render({ phase: "elsewhere", state: state({ botId: "grace" }) });
  assert.match(html, /A recording is running for another Bot\. Finish it first\./);
  assert.doesNotMatch(html, /Start recording|Stop and write the skill|teach-title|teach-note/);
});

test("while a call is in flight nothing can be pressed twice", () => {
  const idle = render({ busy: true, title: "Download" });
  assert.match(idle, /<input id="teach-title"[^>]*disabled=""/);
  assert.match(idle, /<button type="submit"[^>]*disabled=""/);
  const recording = render({ phase: "recording", state: state(), busy: true, note: "x" });
  assert.match(recording, /<input id="teach-note"[^>]*disabled=""/);
  assert.equal((recording.match(/<button[^>]*disabled=""/g) ?? []).length, 3, "Add note, Throw away and Stop");
});

test("a refusal is shown as an alert", () => {
  const html = render({ error: "Open a page in the Browser tab first." });
  assert.match(html, /role="alert"[^>]*>Open a page in the Browser tab first\./);
});

test("after a recording the draft is announced with its warnings, but not while another one runs", () => {
  const result: TeachResult = { steps: 5, warnings: ["A field named “Card number” was left out."] };
  const html = render({ result });
  assert.match(html, /Wrote a draft from 5 steps\./);
  assert.match(html, /hint--bad">A field named “Card number” was left out\./);
  assert.doesNotMatch(render({ result, phase: "recording", state: state() }), /Wrote a draft/);
});

test("what the page's words say is escaped, never taken as markup", () => {
  const html = render({ phase: "recording", state: state({ last: "<script>alert(1)</script>" }) });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
