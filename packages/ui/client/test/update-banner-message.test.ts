import assert from "node:assert/strict";
import test from "node:test";
import { LOCALES, translate, type MessageKey } from "@deyin/host-core/shared";
import type { UpdateStatus, UpdatesState } from "@deyin/contract";
import { fill, updateBannerMessage } from "../src/updateBannerMessage.js";

const en = (key: MessageKey): string => translate("en", key);

function state(status: UpdateStatus, extra: Partial<UpdatesState> = {}): UpdatesState {
  return { status, currentVersion: "1.0.29", availableVersion: "1.0.30", ...extra };
}

test("every updater status maps to the right banner text (or nothing)", () => {
  // Record<UpdateStatus, ...> makes a newly added status fail to compile here until it is covered.
  const expected: Record<UpdateStatus, string | null> = {
    idle: null,
    checking: null,
    "not-available": null,
    unsupported: null,
    available: "Update 1.0.30 is available",
    downloading: "Downloading update 1.0.30… 42%",
    downloaded: "Update 1.0.30 is ready",
    installing: "Installing update 1.0.30…",
    error: "Could not update: disk full",
  };
  const extras: Partial<Record<UpdateStatus, Partial<UpdatesState>>> = {
    downloading: { progressPercent: 42 },
    error: { error: "disk full" },
  };
  for (const status of Object.keys(expected) as UpdateStatus[]) {
    assert.equal(updateBannerMessage(state(status, extras[status]), en), expected[status], status);
  }
});

test("'installing' is never rendered as an update error", () => {
  const message = updateBannerMessage(state("installing"), en);
  assert.ok(message);
  assert.doesNotMatch(message, /could not update|unknown/i);
});

test("an error without a message falls back to 'unknown'", () => {
  assert.equal(updateBannerMessage(state("error"), en), "Could not update: unknown");
});

test("fill() substitutes every placeholder and blanks missing ones", () => {
  assert.equal(fill("{a} and {b}", { a: 1, b: "two" }), "1 and two");
  assert.equal(fill("v{version}", {}), "v");
});

test("the install-screen strings exist and carry the version in every locale", () => {
  const englishTitle = en("update.installing");
  const englishHint = en("update.installingHint");
  for (const { id } of LOCALES) {
    const title = translate(id, "update.installing");
    const hint = translate(id, "update.installingHint");
    assert.match(title, /\{version\}/, `${id}: title must keep the {version} placeholder`);
    assert.notEqual(hint, "update.installingHint", `${id}: hint must be defined`);
    if (id !== "en") {
      assert.notEqual(title, englishTitle, `${id}: title must be translated, not the English fallback`);
      assert.notEqual(hint, englishHint, `${id}: hint must be translated, not the English fallback`);
    }
  }
});
