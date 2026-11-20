import assert from "node:assert/strict";
import { test } from "node:test";
import { LOCALES, missingTranslations, translate, type MessageKey } from "../src/shared.js";

const FEATURE = /^(bot|product)\./;

test("every Deyin Bot and product-switcher string exists in every language", () => {
  for (const { id } of LOCALES) {
    const missing = missingTranslations(id).filter((key) => FEATURE.test(key));
    assert.deepEqual(missing, [], `${id} is missing ${missing.join(", ")}`);
  }
});

test("English is never missing anything", () => {
  assert.deepEqual(missingTranslations("en"), []);
});

test("a language really differs from English for the user-facing Bot strings", () => {
  // Brand-like words (Bot, Ada, Room in German) may match; the sentences must not.
  const sentences: MessageKey[] = ["bot.roster.emptyHint", "bot.manage.deleteMessage", "bot.detail.purposeHint", "bot.memory.empty"];
  for (const locale of ["zh", "de"] as const) {
    for (const key of sentences) assert.notEqual(translate(locale, key), translate("en", key), `${locale} ${key}`);
  }
});

test("the destructive confirmation names what is lost in every language", () => {
  assert.match(translate("en", "bot.manage.deleteMessage"), /memory/);
  assert.match(translate("en", "bot.manage.deleteMessage"), /conversations/);
  assert.match(translate("de", "bot.manage.deleteMessage"), /Gedächtnis/);
  assert.match(translate("de", "bot.manage.deleteMessage"), /Gespräche/);
  assert.match(translate("zh", "bot.manage.deleteMessage"), /记忆/);
  assert.match(translate("zh", "bot.manage.deleteMessage"), /对话/);
});

test("missingTranslations reports a key that is absent or blank, and only in the language that lacks it", () => {
  const fake = {
    en: { "bot.roster.title": "Bots", "bot.roster.empty": "No Bots yet", "bot.roster.pinned": "Pinned" },
    zh: { "bot.roster.title": "Bot", "bot.roster.empty": "" },
    de: { "bot.roster.title": "Bots", "bot.roster.empty": "Noch keine Bots", "bot.roster.pinned": "Angeheftet" },
  } as unknown as Parameters<typeof missingTranslations>[1];
  assert.deepEqual(missingTranslations("zh", fake), ["bot.roster.empty", "bot.roster.pinned"], "blank counts as missing");
  assert.deepEqual(missingTranslations("de", fake), []);
  assert.deepEqual(missingTranslations("en", fake), [], "English is the source and cannot be missing");
});
