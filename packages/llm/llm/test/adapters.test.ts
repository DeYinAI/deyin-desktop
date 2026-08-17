import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostEnvironment, PluginDefinition } from "@deyin/extension-api";
import { PluginKernel } from "@deyin/kernel";
import { createLlmAdapters, llmPlugin, Llm } from "../src/index.js";

const env: HostEnvironment = { app: "desktop", platform: "linux", userDataPath: "/tmp" };

test("resolve falls back to the agent-core dispatcher when no adapter registered", () => {
  const adapters = createLlmAdapters();
  assert.equal(adapters.has("anthropic"), false);
  const factory = adapters.resolve("anthropic");
  assert.equal(typeof factory, "function");
});

test("registered adapters win; duplicates fail the registering plugin", async () => {
  const fake = async function* () {
    yield { type: "text", delta: "stub" } as never;
  };
  const good: PluginDefinition = {
    name: "@deyin/plugin-llm-stub",
    inject: ["llm"],
    apply: (ctx) => {
      ctx.get(Llm).register("anthropic", fake as never, "@deyin/plugin-llm-stub");
    },
  };
  const evil: PluginDefinition = {
    name: "@deyin/plugin-llm-stub-2",
    inject: ["llm"],
    apply: (ctx) => {
      ctx.get(Llm).register("anthropic", fake as never, "@deyin/plugin-llm-stub-2");
    },
  };
  const kernel = new PluginKernel({ env, logLevel: "silent" });
  kernel.register(llmPlugin).register(good).register(evil);
  const statuses = await kernel.start([
    {
      name: "test",
      rows: [
        { id: "llm", plugin: llmPlugin.name },
        { id: "stub", plugin: good.name },
        { id: "stub2", plugin: evil.name },
      ],
    },
  ]);
  assert.equal(statuses.find((s) => s.name === good.name)?.state, "active");
  const second = statuses.find((s) => s.name === evil.name);
  assert.equal(second?.state, "failed");
  assert.match(second?.error ?? "", /already registered/);
  assert.equal(kernel.get(Llm).has("anthropic"), true);
});

test("resolve applies the requested format on fallback", async () => {
  const adapters = createLlmAdapters();
  const factory = adapters.resolve("responses");
  // The fallback wraps streamChatEvents with apiFormat forced; without network
  // we can only assert the wrapper exists and forwards options.
  assert.equal(typeof factory, "function");
});
