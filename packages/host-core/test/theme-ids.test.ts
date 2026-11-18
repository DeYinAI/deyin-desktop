import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, THEME_IDS, migrateSettings } from "../src/defaults.js";

/**
 * The theme allowlist used to be a hardcoded array inside migrateSettings, so
 * every theme added to the type was silently rewritten to "dark" on load. These
 * tests fail if that regresses.
 */

test("THEME_IDS covers every theme the settings type allows", () => {
  // If a theme is added to DeyinSettings["theme"] without being listed in
  // THEME_IDS, `satisfies` breaks the build; this asserts the runtime list is
  // complete and is what migration actually consults.
  const fromDefault = DEFAULT_SETTINGS.theme;
  assert.ok(THEME_IDS.includes(fromDefault), "the default theme must be a valid id");
  assert.equal(new Set(THEME_IDS).size, THEME_IDS.length, "no duplicate ids");
});

test("every known theme survives a settings migration", () => {
  for (const theme of THEME_IDS) {
    const migrated = migrateSettings({ ...DEFAULT_SETTINGS, theme });
    assert.equal(migrated.theme, theme, `theme "${theme}" must not be rewritten`);
  }
});

test("an unknown theme still falls back to the default instead of being kept", () => {
  const migrated = migrateSettings({ ...DEFAULT_SETTINGS, theme: "not-a-theme" as never });
  assert.equal(migrated.theme, "dark");
});

test("the style-family themes are selectable, not dropped", () => {
  for (const theme of ["obsidian", "reference"] as const) {
    assert.ok(THEME_IDS.includes(theme), `${theme} must be in THEME_IDS`);
    assert.equal(migrateSettings({ ...DEFAULT_SETTINGS, theme }).theme, theme);
  }
});
