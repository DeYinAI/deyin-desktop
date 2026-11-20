import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, migrateSettings, settingsFromStored } from "../src/defaults.js";
import { PRODUCT_IDS, isProductId } from "../src/products.js";

test("PRODUCT_IDS lists the three products in switcher order", () => {
  assert.deepEqual([...PRODUCT_IDS], ["code", "bot", "conductor"]);
});

test("isProductId accepts exactly the product ids", () => {
  for (const id of PRODUCT_IDS) assert.equal(isProductId(id), true);
  for (const bad of ["", "Code", "grok", "bot ", null, undefined, 3, {}, ["code"]]) {
    assert.equal(isProductId(bad), false, `rejects ${JSON.stringify(bad)}`);
  }
});

test("a fresh install opens Deyin Code", () => {
  assert.equal(DEFAULT_SETTINGS.activeProduct, "code");
  assert.equal(migrateSettings(undefined).activeProduct, "code");
});

test("the schema version covers the product switcher", () => {
  assert.ok(SETTINGS_SCHEMA_VERSION >= 24);
  assert.equal(migrateSettings({ schemaVersion: 23 }).schemaVersion, SETTINGS_SCHEMA_VERSION);
});

test("a saved activeProduct survives migration", () => {
  for (const id of PRODUCT_IDS) {
    assert.equal(migrateSettings({ schemaVersion: SETTINGS_SCHEMA_VERSION, activeProduct: id }).activeProduct, id);
  }
});

test("an unknown activeProduct falls back to Code instead of opening a shell that does not exist", () => {
  for (const bad of ["grok", "", 4, null, {}]) {
    assert.equal(migrateSettings({ activeProduct: bad }).activeProduct, "code", `falls back from ${JSON.stringify(bad)}`);
  }
});

test("settings written before v24 gain activeProduct and are flagged for write-back", () => {
  const old = JSON.stringify({ schemaVersion: 23, theme: "dark" });
  const { settings, needsWrite } = settingsFromStored(old);
  assert.equal(settings.activeProduct, "code");
  assert.equal(needsWrite, true);
  assert.equal(settings.schemaVersion, SETTINGS_SCHEMA_VERSION);
});
