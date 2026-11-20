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

test("modelLogoFor resolves every lab in the live Openference catalog", () => {
  // Ids copied from GET https://api.openference.com/v1/models — each one must
  // draw a mark, so a newly added lab shows up as a failing test rather than a
  // silently blank slot in the settings list.
  const catalog = [
    "GLM-5.2", "GLM-5.3", "GLM-5.3-Flash", "GLM-5.3-Flash-Free", "GLM-5.1", "GLM-4.7-Flash",
    "GLM-5.3-Flash-Uncensored",
    "DeepSeek-V4-Flash-0731", "DeepSeek-V4.1-Flash", "DeepSeek-V4.1-Flash-1017",
    "DeepSeek-V4-Pro-0813", "DeepSeek-V4.1-Flash-1017-Free", "DeepSeek-V4.1-Flash-1017-Uncensored",
    "ERNIE-5.5-Flash-Preview",
    "Kimi K3",
    "Qwen3.8 27b", "Qwen3.8 Flash",
    "Agnes-Image-2.5-Flash", "Agnes-Video-2.5-Flash",
    "Gemma 4 26B", "GPT-OSS-120B", "GPT-OSS-20B", "Llama 4 Scout",
    "MiMo-V2.6-Pro", "MiMo-V2.6-Flash",
    "Hy4", "Hy4 Flash",
    "Step-5 Preview",
    "Claude Fable 5.2", "Claude Fable 5.1", "Claude Fable 5", "Claude Opus 5.5", "Claude Opus 5",
    "Claude Opus 4.8", "Claude Opus 4.7", "Claude Opus 4.6", "Claude Sonnet 5.5", "Claude Sonnet 5",
    "Claude Sonnet 4.6", "Claude Haiku 5.5", "Claude Haiku 4.5",
    "GPT-6 Luna", "GPT-6.1 Terra",
    "Gemini 3.8 Flash", "Gemini 3 Pro Image", "Gemini 3.1 Flash Image",
    "MiniMax M3",
  ];
  const missing = catalog.filter((id) => !modelLogoFor(id, id));
  assert.deepEqual(missing, [], `models with no mark: ${missing.join(", ")}`);
});

test("each lab maps to its own mark rather than a parent company's", () => {
  assert.equal(modelLogoFor("ERNIE-5.5-Flash-Preview"), "ernie");
  assert.equal(modelLogoFor("Hy4"), "hunyuan");
  assert.equal(modelLogoFor("Hunyuan-T1"), "hunyuan");
  assert.equal(modelLogoFor("MiMo-V2.6-Pro"), "mimo");
  assert.equal(modelLogoFor("Step-5 Preview"), "stepfun");
  assert.equal(modelLogoFor("Agnes-Image-2.5-Flash"), "agnes");
  // Vendor-level providers still resolve, so a custom endpoint named after the
  // company is identifiable.
  assert.equal(providerLogoFor("baidu", "Baidu"), "baidu");
  assert.equal(providerLogoFor("tencent", "Tencent"), "tencent");
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
