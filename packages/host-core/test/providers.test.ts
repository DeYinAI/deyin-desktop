import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PROVIDERS, PROVIDER_SEED_VERSION, mergePresetProviders } from "../src/defaults.js";

test("DEFAULT_PROVIDERS: openference stays primary, presets are custom with base URLs", () => {
  const ids = DEFAULT_PROVIDERS.map((p) => p.id);
  assert.equal(ids[0], "openference");
  assert.equal(DEFAULT_PROVIDERS[0]!.kind, "primary");
  assert.equal(DEFAULT_PROVIDERS[0]!.enabled, true);

  for (const id of ["deepseek", "openai", "anthropic", "google", "openrouter", "groq", "xai", "mistral", "ollama"]) {
    assert.ok(ids.includes(id), `missing preset ${id}`);
    const p = DEFAULT_PROVIDERS.find((x) => x.id === id)!;
    assert.equal(p.kind, "custom");
    assert.equal(p.preset, true);
    assert.equal(p.enabled, false, `${id} should be off by default`);
    assert.ok(p.baseUrl!.startsWith("http"), `${id} needs a baseUrl`);
  }

  // Anthropic uses its own wire format; everything else is OpenAI-compatible.
  assert.equal(DEFAULT_PROVIDERS.find((p) => p.id === "anthropic")!.apiFormat, "anthropic");
  assert.equal(DEFAULT_PROVIDERS.find((p) => p.id === "deepseek")!.apiFormat, "chat-completions");
  // Ollama is the one keyless local endpoint.
  assert.equal(DEFAULT_PROVIDERS.find((p) => p.id === "ollama")!.local, true);
});

test("mergePresetProviders: adds missing presets once, never touches existing records", () => {
  const existing = [
    { ...DEFAULT_PROVIDERS[0]! },
    { ...DEFAULT_PROVIDERS.find((p) => p.id === "deepseek")!, baseUrl: "https://proxy.example.com" },
  ];

  const first = mergePresetProviders(existing, undefined);
  assert.equal(first.seedVersion, PROVIDER_SEED_VERSION);
  assert.ok(first.providers.length > existing.length);
  // Existing entries are untouched (custom DeepSeek base URL survives).
  assert.equal(first.providers.find((p) => p.id === "deepseek")!.baseUrl, "https://proxy.example.com");
  assert.equal(first.providers.find((p) => p.id === "openai")!.baseUrl, "https://api.openai.com/v1");

  // Already-seeded stores are returned as-is.
  const second = mergePresetProviders(first.providers, first.seedVersion);
  assert.equal(second.providers, first.providers);
});

test("mergePresetProviders: user deletions of presets are respected after seeding", () => {
  const seeded = mergePresetProviders([], undefined).providers;
  const withoutOllama = seeded.filter((p) => p.id !== "ollama");
  // Once the seed version is recorded, deleted presets stay deleted.
  const again = mergePresetProviders(withoutOllama, PROVIDER_SEED_VERSION);
  assert.equal(again.providers, withoutOllama);
  assert.equal(again.providers.find((p) => p.id === "ollama"), undefined);
});
