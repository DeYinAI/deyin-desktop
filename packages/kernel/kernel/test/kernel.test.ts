import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defineService,
  type HostEnvironment,
  type PluginDefinition,
  type PluginEvents,
  type PluginScope,
} from "@deyin/extension-api";
import { PluginKernel } from "../src/kernel.js";

// Test-only events: proves seams extend the shared map via module augmentation.
declare module "@deyin/extension-api" {
  interface PluginEvents {
    probe: undefined;
    "onTool:git:status": undefined;
    "onTool:fs": undefined;
  }
}
void (null as unknown as PluginEvents);

const env: HostEnvironment = {
  app: "desktop",
  platform: "linux",
  userDataPath: "/tmp/deyin-test",
};

const Tools = defineService<{ register(name: string): void }>("tools", "tool registry seam");
const Llm = defineService<{ complete(): string }>("llm", "llm adapter seam");

function row(plugin: string, id = plugin, config?: unknown) {
  return { id, plugin, config, enabled: true };
}

function makeKernel() {
  return new PluginKernel({ env, logLevel: "silent" });
}

test("inject orders provider before consumer regardless of row order", async () => {
  const order: string[] = [];
  const consumer: PluginDefinition = {
    name: "consumer",
    inject: ["llm"],
    apply: (ctx) => {
      order.push("consumer");
      ctx.get(Llm).complete();
    },
  };
  const secondConsumer: PluginDefinition = {
    name: "second-consumer",
    inject: ["llm"],
    apply: (ctx) => {
      order.push("second-consumer");
      ctx.get(Llm).complete();
    },
  };
  const statuses = await makeKernel()
    .register(consumer)
    .register(secondConsumer)
    .register({
      name: "llm-impl",
      provides: ["llm"],
      apply: (ctx) => {
        order.push("llm-impl");
        ctx.provide(Llm, { complete: () => "ok" });
      },
    })
    .start([{ name: "test", rows: [row("consumer"), row("second-consumer"), row("llm-impl")] }]);

  assert.deepEqual(order, ["llm-impl", "consumer", "second-consumer"]);
  assert.ok(statuses.every((s) => s.state === "active"));
});

test("a failing plugin is isolated: host and siblings keep running", async () => {
  const kernel = makeKernel();
  const statuses = await kernel
    .register({
      name: "boom",
      provides: ["nothing"],
      apply: () => {
        throw new Error("kaboom");
      },
    })
    .register({
      name: "healthy",
      apply: (ctx) => {
        ctx.effect(() => {});
      },
    })
    .start([{ name: "test", rows: [row("boom"), row("healthy")] }]);

  const boom = statuses.find((s) => s.name === "boom");
  const healthy = statuses.find((s) => s.name === "healthy");
  assert.equal(boom?.state, "failed");
  assert.match(boom?.error ?? "", /kaboom/);
  assert.equal(healthy?.state, "active");
});

test("failing plugin unwinds only its own registrations", async () => {
  const kernel = makeKernel();
  let disposed = false;
  await kernel
    .register({
      name: "half-then-fail",
      apply: (ctx) => {
        ctx.effect(() => {
          disposed = true;
        });
        throw new Error("after effect");
      },
    })
    .start([{ name: "test", rows: [row("half-then-fail")] }]);
  assert.equal(disposed, true, "effect registered before the throw must run during isolation");
});

test("consumer of a failed provider fails in isolation with a clear error", async () => {
  const statuses = await makeKernel()
    .register({
      name: "bad-provider",
      provides: ["tools"],
      apply: () => {
        throw new Error("provider exploded");
      },
    })
    .register({
      name: "needy",
      inject: ["tools"],
      apply: () => {},
    })
    .start([{ name: "test", rows: [row("bad-provider"), row("needy")] }]);

  const needy = statuses.find((s) => s.name === "needy");
  assert.equal(needy?.state, "failed");
  assert.match(needy?.error ?? "", /unresolvable dependencies/);
});

test("get on missing service throws MissingServiceError", async () => {
  const kernel = makeKernel();
  await kernel
    .register({
      name: "optimist",
      apply: (ctx) => {
        ctx.get(Llm);
      },
    })
    .start([{ name: "test", rows: [row("optimist")] }]);
  const status = kernel.status().find((s) => s.name === "optimist");
  assert.match(status?.error ?? "", /no provider for service "llm"/);
});

test("duplicate providers fail the second plugin", async () => {
  const statuses = await makeKernel()
    .register({
      name: "llm-a",
      provides: ["llm"],
      apply: (ctx) => ctx.provide(Llm, { complete: () => "a" }),
    })
    .register({
      name: "llm-b",
      provides: ["llm"],
      apply: (ctx) => ctx.provide(Llm, { complete: () => "b" }),
    })
    .start([{ name: "test", rows: [row("llm-a"), row("llm-b")] }]);
  assert.equal(statuses.find((s) => s.name === "llm-a")?.state, "active");
  assert.equal(statuses.find((s) => s.name === "llm-b")?.state, "failed");
});

test("disposal runs in reverse activation order", async () => {
  const order: string[] = [];
  const kernel = makeKernel();
  await kernel
    .register({
      name: "first",
      apply: (ctx) => {
        ctx.effect(() => {
          order.push("first");
        });
      },
    })
    .register({
      name: "second",
      apply: (ctx) => {
        ctx.effect(() => {
          order.push("second");
        });
      },
    })
    .start([{ name: "test", rows: [row("first"), row("second")] }]);
  await kernel.dispose();
  assert.deepEqual(order, ["second", "first"]);
});

test("effects, listeners, and services are torn down on dispose", async () => {
  const kernel = makeKernel();
  let effectRan = false;
  let listenerRan = false;
  await kernel
    .register({
      name: "wired",
      provides: ["llm"],
      apply: (ctx) => {
        ctx.provide(Llm, { complete: () => "ok" });
        ctx.effect(() => {
          effectRan = true;
        });
        ctx.on("probe", () => {
          listenerRan = true;
        });
      },
    })
    .start([{ name: "test", rows: [row("wired")] }]);
  await kernel.dispose();
  kernel.context.emit("probe", undefined);
  assert.equal(effectRan, true);
  assert.equal(listenerRan, false, "listener must be unsubscribed after dispose");
  assert.equal(kernel.tryGet(Llm), undefined, "service must be removed after dispose");
});

test("lazy plugin activates on matching event, prefix wildcard included", async () => {
  const activated: string[] = [];
  const kernel = makeKernel();
  await kernel
    .register({
      name: "eager-emitter",
      apply: () => {
        activated.push("eager");
      },
    })
    .register({
      name: "lazy-git",
      activateOn: ["onTool:git*"],
      apply: () => {
        activated.push("lazy-git");
      },
    })
    .start([{ name: "test", rows: [row("eager-emitter"), row("lazy-git")] }]);

  const before = kernel.status().find((s) => s.name === "lazy-git");
  assert.equal(before?.state, "lazy", "must not activate at startup");
  assert.deepEqual(activated, ["eager"]);

  kernel.context.emit("onTool:git:status", undefined);
  // Activation is async; pump the microtask queue.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(activated, ["eager", "lazy-git"]);
  assert.equal(kernel.status().find((s) => s.name === "lazy-git")?.state, "active");

  // Non-matching events must not wake anything.
  kernel.context.emit("onTool:fs", undefined);
  assert.deepEqual(activated, ["eager", "lazy-git"]);
});

test("waterfall chains run sequentially in registration order", async () => {
  const kernel = makeKernel();
  await kernel
    .register({
      name: "mw-one",
      apply: (ctx) => {
        ctx.onWaterfall<{ value: string[] }>("tools/pre-execute", (v) => ({
          value: [...v.value, "one"],
        }));
      },
    })
    .register({
      name: "mw-two",
      apply: (ctx) => {
        ctx.onWaterfall<{ value: string[] }>("tools/pre-execute", async (v) => ({
          value: [...v.value, "two"],
        }));
      },
    })
    .start([{ name: "test", rows: [row("mw-one"), row("mw-two")] }]);

  const result = await kernel.context.waterfall("tools/pre-execute", { value: [] });
  assert.deepEqual(result.value, ["one", "two"]);
});

test("applies() gate skips the plugin without failing it", async () => {
  const kernel = new PluginKernel({ env: { ...env, app: "web" }, logLevel: "silent" });
  await kernel
    .register({
      name: "desktop-only",
      applies: (host) => host.app === "desktop",
      apply: () => {},
    })
    .start([{ name: "test", rows: [row("desktop-only")] }]);
  const status = kernel.status().find((s) => s.name === "desktop-only");
  assert.equal(status?.state, "registered");
});

test("child scopes see parent services; root does not see child services", async () => {
  const kernel = makeKernel();
  let child!: PluginScope;
  await kernel
    .register({
      name: "scoped",
      apply: (ctx) => {
        ctx.provide(Llm, { complete: () => "root" });
        const run = ctx.scope("agent-run");
        run.provide(Tools, { register: () => {} });
        child = run;
      },
    })
    .start([{ name: "test", rows: [row("scoped")] }]);
  // Parent chain: the child sees both its own and the root's services.
  assert.equal(child.tryGet(Llm)?.complete(), "root");
  assert.notEqual(child.tryGet(Tools), undefined);
  // Root never sees services provided inside a child scope.
  assert.equal(kernel.tryGet(Tools), undefined);
});

test("activatePlugin/disposePlugin toggle a lazy plugin programmatically", async () => {
  let live = false;
  const kernel = makeKernel();
  await kernel
    .register({
      name: "toggleable",
      activateOn: ["never:fires"],
      apply: (ctx) => {
        live = true;
        ctx.effect(() => {
          live = false;
        });
      },
    })
    .start([{ name: "test", rows: [row("toggleable")] }]);
  assert.equal(live, false, "lazy plugin must not be live at startup");
  const status = await kernel.activatePlugin("toggleable");
  assert.equal(status.state, "active");
  assert.equal(live, true);
  await kernel.disposePlugin("toggleable");
  assert.equal(live, false, "dispose must run effects");
  assert.equal(kernel.status().find((s) => s.name === "toggleable")?.state, "disposed");
  // Re-activation after dispose works.
  const again = await kernel.activatePlugin("toggleable");
  assert.equal(again.state, "active");
});
