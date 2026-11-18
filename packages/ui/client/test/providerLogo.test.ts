import assert from "node:assert/strict";
import test from "node:test";
import { modelLogoFor, providerLogoFor } from "../src/components/ProviderLogo.js";
import { PROVIDER_LOGOS } from "../src/components/providerLogoData.js";

test("providerLogoFor matches seeded provider ids and display names", () => {
  assert.equal(providerLogoFor("deepseek", "DeepSeek"), "deepseek");
  assert.equal(providerLogoFor("google", "Google Gemini"), "gemini");
  assert.equal(providerLogoFor("xai", "xAI"), "xai");
  assert.equal(providerLogoFor("ollama", "Ollama (local)"), "ollama");
  assert.equal(providerLogoFor("", "LM Studio"), "lmstudio");
  assert.equal(providerLogoFor("", "Zhipu GLM"), "zhipu");
  assert.equal(providerLogoFor("", "SiliconFlow"), "siliconcloud");
  assert.equal(providerLogoFor("", "Moonshot"), "kimi");
});

test("providerLogoFor lets a vendor-prefixed name take that vendor's mark", () => {
  assert.equal(providerLogoFor("p_1", "Together AI"), "together");
  assert.equal(providerLogoFor("p_2", "Azure OpenAI"), "azure");
});

test("providerLogoFor does not claim endpoints that are only compatible with a vendor", () => {
  assert.equal(providerLogoFor("p_3", "OpenAI-compatible"), undefined);
  assert.equal(providerLogoFor("p_4", "My gateway"), undefined);
  assert.equal(providerLogoFor(undefined, ""), undefined);
});

test("modelLogoFor resolves the lab behind a model id or name", () => {
  assert.equal(modelLogoFor("deepseek-v4-flash"), "deepseek");
  assert.equal(modelLogoFor("glm-5.3", "GLM 5.3"), "zhipu");
  assert.equal(modelLogoFor("kimi-k3"), "kimi");
  assert.equal(modelLogoFor("qwen-max"), "qwen");
  assert.equal(modelLogoFor("claude-sonnet-4"), "anthropic");
  assert.equal(modelLogoFor("gpt-5"), "openai");
  assert.equal(modelLogoFor("o3-mini"), "openai");
  assert.equal(modelLogoFor("meta-llama/llama-4"), "meta");
  assert.equal(modelLogoFor("some-unknown-model"), undefined);
  // "o1" inside a longer token is not an OpenAI reasoning model.
  assert.equal(modelLogoFor("pro1x-model"), undefined);
});

test("every logo is drawable and gradient references resolve to a gradient in the same logo", () => {
  for (const [id, logo] of Object.entries(PROVIDER_LOGOS)) {
    assert.ok(logo.nodes.length > 0, `${id} has no shapes`);
    assert.match(logo.viewBox, /^0 0 \d+ \d+$/, `${id} viewBox`);
    const json = JSON.stringify(logo.nodes);
    const defined = new Set([...json.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]));
    for (const ref of json.matchAll(/url\(#([^)]+)\)/g)) {
      assert.ok(defined.has(ref[1] as string), `${id} references missing gradient ${ref[1]}`);
    }
  }
});
