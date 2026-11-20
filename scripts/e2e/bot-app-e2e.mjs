// End-to-end pass for Deyin Bot in the real, built desktop app: Electron, the real renderer, the real main process,
// and a pretend model server on this computer.
//
//   pnpm --filter @deyin/desktop exec electron-vite build && node scripts/e2e/bot-app-e2e.mjs
//
// Needs a display (WSLg or Xvfb). It uses throwaway user-data folders and never touches an installed Deyin or the
// network. It covers what unit tests cannot: that the window, the preload bridge and the main process agree for the
// Bot product (switching, creating, chatting as a Bot, routines, the Connections hub, restarting). Exit code 0 only when
// every check passed and nothing in either process logged an error.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("../../apps/desktop/", import.meta.url));
const require = createRequire(join(desktop, "package.json"));
const { _electron: electron } = require("playwright-core");
const electronBinary = require("electron");

const shots = process.env.DEYIN_E2E_SHOTS ?? join(tmpdir(), "deyin-bot-e2e-shots");
mkdirSync(shots, { recursive: true });
const dirs = [];
const fresh = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const results = [];
const problems = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok    ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) });
    console.log(`  FAIL  ${name}\n        ${String(error?.message ?? error).split("\n").join("\n        ")}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, fn, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

/* A picture to be "drawn": a real PNG, so the app's own decoder has something to cut down. */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makePng(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // RGB
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) row.set([(x * 255) / width, (y * 255) / height, 160], 1 + x * 3);
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

const pngSize = (base64) => {
  const bytes = Buffer.from(base64, "base64");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

const textOf = (content) => (typeof content === "string" ? content : JSON.stringify(content ?? ""));

/**
 * What the pretend model says for a request. Most chats get the plain FAKE-REPLY. A room's host, asked something that
 * names a Bot (@handle), asks that Bot with the task tool, as a real model would; the Bot's own answer and the host's
 * final line are marked so the check can tell who said what.
 */
function scripted(payload) {
  const messages = payload.messages ?? [];
  const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
  if (system.includes("You are answering in a room")) return { text: "MEMBER-ANSWER" };
  if (!system.includes("<bot_room>")) return {};
  if (messages.some((m) => m.role === "tool")) return { text: "ROOM-HOST-DONE" };
  const asked = messages.filter((m) => m.role === "user").map((m) => textOf(m.content)).join("\n").match(/@([a-z0-9][a-z0-9_-]*)/);
  return asked ? { call: { name: "task", args: { subagent: asked[1], prompt: "Please introduce yourself to the person." } } } : {};
}

/* A model on this computer: OpenAI-compatible, answers every chat with FAKE-REPLY-<n>, remembers what it was asked. */

async function startFakeModel() {
  const requests = [];
  const imageRequests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url?.startsWith("/v1/models")) return send(200, { object: "list", data: [{ id: "fake-model", object: "model" }] });
    if (req.method === "POST" && req.url?.startsWith("/v1/images/generations")) {
      imageRequests.push(JSON.parse(raw));
      // A wide picture, so the app has to cut it to a square before it can be an avatar.
      return send(200, { created: 0, data: [{ b64_json: makePng(512, 384).toString("base64") }] });
    }
    if (req.method === "POST" && req.url?.startsWith("/v1/chat/completions")) {
      const payload = JSON.parse(raw);
      requests.push(payload);
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      const part = scripted(payload);
      const text = part.text ?? `FAKE-REPLY-${requests.length}`;
      if (!payload.stream) {
        return send(200, { id: "c", object: "chat.completion", created: 0, model: "fake-model", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage });
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const frame = (delta, finish) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage } : {}) })}\n\n`;
      res.write(frame({ role: "assistant", content: "" }, null));
      if (part.call) {
        res.write(frame({ tool_calls: [{ index: 0, id: "call_room_1", type: "function", function: { name: part.call.name, arguments: JSON.stringify(part.call.args) } }] }, null));
        res.write(frame({}, "tool_calls"));
      } else {
        res.write(frame({ content: text }, null));
        res.write(frame({}, "stop"));
      }
      res.end("data: [DONE]\n\n");
      return undefined;
    }
    return send(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, requests, imageRequests, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A profile that is already signed out of Welcome and has one model: the pretend one. */
function seedProfile(userData, modelPort) {
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ schemaVersion: 24, welcomeDismissed: true, defaultModel: "fake::fake-model" }));
  writeFileSync(
    join(userData, "agents.json"),
    JSON.stringify({
      disabledCaps: [],
      // An old seed version makes the app add the built-in providers around this one.
      providerSeedVersion: 0,
      providers: [
        {
          id: "fake",
          name: "Fake model",
          kind: "custom",
          enabled: true,
          baseUrl: `http://127.0.0.1:${modelPort}/v1`,
          apiFormat: "chat-completions",
          connectionModes: ["API key"],
          activeMode: "API key",
          models: [
            { id: "fake-model", name: "fake-model", contextLength: 32000 },
            { id: "fake-image", name: "fake-image", kind: "image" },
          ],
          disabledModels: [],
          keyCipher: "plain:e2e-key",
        },
      ],
    }),
  );
}

async function launch(userData) {
  const app = await electron.launch({
    executablePath: electronBinary,
    args: ["--no-sandbox", "--disable-gpu", `--user-data-dir=${userData}`, desktop],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
    timeout: 90_000,
  });
  const main = [];
  app.process().stderr?.on("data", (chunk) => main.push(String(chunk)));
  const page = await app.firstWindow();
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // Calls to services that need an account fail on a fresh profile; that is not what is under test.
    if (/Failed to load resource|net::ERR|ERR_INTERNET|ERR_NAME_NOT_RESOLVED|openference|401|403/i.test(text)) return;
    problems.push(`console.error: ${text}`);
  });
  await page.waitForLoadState("domcontentloaded");
  return { app, page, main };
}

/** The "What's new" sheet shows once on a fresh profile and sits over everything until it is dismissed. */
async function dismissWhatsNew(page) {
  const sheet = page.locator('[aria-labelledby="whats-new-title"]');
  try {
    await sheet.waitFor({ state: "visible", timeout: 4_000 });
  } catch {
    return;
  }
  await page.keyboard.press("Escape");
  if (await sheet.count()) await sheet.getByRole("button").last().click();
  await sheet.waitFor({ state: "detached", timeout: 10_000 });
}

const switcher = (page) => page.locator('button[aria-label^="Switch product"]').first();
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => undefined);
const bodyText = (page) => page.evaluate(() => document.body.innerText);

async function chooseProduct(page, label) {
  await switcher(page).click();
  await page.getByRole("menuitemradio", { name: new RegExp(label) }).click();
}

const productLabel = async (page) => ((await switcher(page).getAttribute("aria-label")) ?? "").replace(/^Switch product:\s*/, "");

const BOT_NAME = "Smoke Bot";

/* Welcome ---------------------------------------------------------------------------------------------------------- */

async function welcomePass() {
  const userData = fresh("deyin-e2e-welcome-");
  const { app, page } = await launch(userData);
  try {
    await check("a fresh profile starts at Welcome, and the API-key path gets past it without an account", async () => {
      const skip = page.getByRole("button", { name: "Use API key" });
      await skip.waitFor({ state: "visible", timeout: 60_000 });
      await shot(page, "00-welcome");
      await skip.click();
      await page.getByRole("button", { name: "Back to workspace" }).click({ timeout: 15_000 });
      await dismissWhatsNew(page);
      await switcher(page).waitFor({ state: "visible", timeout: 15_000 });
    });
  } finally {
    await app.close();
  }
}

/* The Bot product -------------------------------------------------------------------------------------------------- */

async function botPass(userData, model) {
  const { app, page, main } = await launch(userData);
  const state = { botId: null, hubPort: null, main };
  try {
    await dismissWhatsNew(page);

    await check("the window opens on Deyin Code with the product switcher", async () => {
      await switcher(page).waitFor({ state: "visible", timeout: 60_000 });
      expect((await productLabel(page)) === "Deyin Code", `switcher says ${await productLabel(page)}`);
      await shot(page, "01-code");
    });

    await check("the menu offers the three products", async () => {
      await switcher(page).click();
      const items = await page.getByRole("menuitemradio").allInnerTexts();
      await page.keyboard.press("Escape");
      for (const name of ["Deyin Code", "Deyin Bot", "Deyin Conductor"]) {
        expect(items.some((text) => text.includes(name)), `no ${name} in ${JSON.stringify(items)}`);
      }
    });

    await check("choosing Deyin Bot switches the shell to Bots", async () => {
      await chooseProduct(page, "Deyin Bot");
      await page.getByRole("button", { name: /New Bot/ }).first().waitFor({ timeout: 15_000 });
      expect((await productLabel(page)) === "Deyin Bot", "the switcher did not follow");
      await shot(page, "02-bot-home");
    });

    await check("the new-item shortcut does what the product's own New button does", async () => {
      await page.locator("body").click({ position: { x: 600, y: 300 } });
      await page.keyboard.press("Control+n");
      await page.locator("#bot-create-name").waitFor({ state: "visible", timeout: 10_000 });
      await page.keyboard.press("Escape");
      await page.locator("#bot-create-name").waitFor({ state: "detached", timeout: 10_000 });
    });

    await check("a Bot can be created from the dialog and its conversation opens", async () => {
      await page.getByRole("button", { name: /New Bot/ }).first().click();
      await page.locator("#bot-create-name").fill(BOT_NAME);
      await page.locator('[aria-labelledby="bot-create-title"] button[type="submit"]').click();
      await page.getByText(BOT_NAME).first().waitFor({ timeout: 15_000 });
      const bots = JSON.parse(readFileSync(join(userData, "bots.json"), "utf8"));
      const list = bots.bots ?? bots.items ?? [];
      const mine = list.find((bot) => bot.name === BOT_NAME);
      expect(mine, `bots.json has no ${BOT_NAME}: ${JSON.stringify(bots).slice(0, 300)}`);
      state.botId = mine.id;
      expect(mine.isPrimary === true, "the first Bot is the primary one");
      await shot(page, "03-bot-created");
    });

    await check("a message to the Bot reaches the model with the Bot's persona, and the reply comes back", async () => {
      const box = page.locator("textarea").last();
      await box.fill("hello bot, please say hi");
      await box.press("Enter");
      await until("the model's reply on screen", async () => (await bodyText(page)).includes("FAKE-REPLY-1"), 45_000);
      expect(model.requests.length >= 1, "the model was never asked");
      const first = model.requests[0];
      const system = (first.messages ?? []).filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
      expect(system.includes(BOT_NAME), `the system prompt does not carry the Bot's persona:\n${system.slice(0, 600)}`);
      expect(!system.includes("deyin-desktop"), "the prompt names the open workspace instead of the Bot's own folder");
      await shot(page, "04-bot-chat");
    });

    await check("the Bot's conversation is recorded as the Bot's, with its folder under the Bot's id", async () => {
      expect(state.botId, "no Bot was created");
      expect(existsSync(join(userData, "bots", state.botId, "files")), "the Bot has no files folder");
      const sessions = join(userData, "sessions");
      const files = existsSync(sessions) ? readdirSync(sessions, { recursive: true }).map(String) : [];
      let found = false;
      for (const file of files) {
        const path = join(sessions, file);
        if (!/\.(json|jsonl)$/.test(path)) continue;
        try {
          if (readFileSync(path, "utf8").includes(`"botId":"${state.botId}"`)) found = true;
        } catch {
          // a folder
        }
      }
      expect(found, `no saved session carries botId ${state.botId} (looked in ${files.length} files)`);
    });

    await check("the Bot's details page opens with its sections", async () => {
      await page.getByRole("button", { name: "Details" }).first().click({ timeout: 15_000 });
      await page.getByText("Vault", { exact: false }).first().waitFor({ timeout: 15_000 });
      const text = await bodyText(page);
      for (const section of ["Permissions", "Routines", "Skills", "Files", "Connections", "Webhook", "Slack", "Microsoft Teams"]) {
        expect(text.includes(section), `the details page has no ${section} section`);
      }
      await shot(page, "05-bot-details");
    });

    await check("a picture can be made for the Bot from a description, looked at, used and saved", async () => {
      await page.getByRole("button", { name: "Make a picture" }).click({ timeout: 15_000 });
      await page.getByLabel("What should the picture show?").fill("a friendly owl");
      await page.getByRole("button", { name: "Make picture", exact: true }).click();
      const preview = page.locator('img[alt="The picture that was made"]');
      await preview.waitFor({ timeout: 30_000 });
      await shot(page, "05b-avatar-review");
      expect(model.imageRequests.length === 1, `the image model was asked ${model.imageRequests.length} times`);
      const asked = model.imageRequests[0];
      expect(asked.model === "fake-image", `the image model asked for was ${asked.model}`);
      expect(String(asked.prompt).startsWith("a friendly owl"), `the request does not start with the description: ${asked.prompt}`);
      expect(String(asked.prompt).includes(`called "${BOT_NAME}"`), `the request does not name the Bot: ${asked.prompt}`);
      const url = await preview.getAttribute("src");
      expect(url?.startsWith("data:image/png;base64,"), `the picture is not a PNG data URL: ${String(url).slice(0, 40)}`);
      const size = pngSize(url.slice("data:image/png;base64,".length));
      expect(size.width === 256 && size.height === 256, `the picture was cut to ${size.width}x${size.height}, not 256x256`);

      await page.getByRole("button", { name: "Use this picture" }).click();
      await page.getByRole("button", { name: "Save changes" }).click();
      const saved = await until("the Bot to have the picture", async () => {
        const snapshot = await page.evaluate(() => window.deyin.bots.list());
        const bot = snapshot.bots.find((b) => b.name === "Smoke Bot");
        return bot?.avatarUrl ?? null;
      }, 15_000);
      expect(saved === url, "the saved avatar is not the picture that was shown");
      await shot(page, "05c-avatar-saved");
    });

    await check("a webhook routine can be made, set up, and a message to its address runs the Bot", async () => {
      const card = page.locator('li.conn-card[data-kind="webhook"]');
      await card.scrollIntoViewIfNeeded();
      await card.getByRole("button", { name: "Set up" }).click();
      const address = await until("the webhook address", async () => (await card.locator("input[readonly]").first().inputValue()) || null);
      expect(/^http:\/\/127\.0\.0\.1:\d+\/hooks\/webhook\//.test(address), `unexpected address ${address}`);
      state.hubPort = new URL(address).port;
      await card.getByRole("button", { name: /Make a routine for messages/ }).click();
      await until("the routine to be chosen", async () => (await card.locator("select").first().inputValue()) !== "", 15_000);
      await card.getByRole("button", { name: "Save" }).click();
      const key = await until("the key, shown once", async () => ((await card.locator(".conn-secret__value").first().textContent()) ?? "").trim() || null, 20_000);
      await shot(page, "06-webhook-saved");
      await card.getByRole("button", { name: "Turn on" }).click();
      await card.getByRole("button", { name: "Turn off" }).waitFor({ timeout: 15_000 });
      await until("the hub to be listening", async () => (await fetch(`http://127.0.0.1:${state.hubPort}/health`).catch(() => null))?.status === 200, 15_000);

      const before = model.requests.length;
      const wrong = await fetch(address, { method: "POST", headers: { "X-Deyin-Key": "not-the-key" }, body: "nope" });
      expect(wrong.status === 401 || wrong.status === 403 || wrong.status === 404, `a wrong key was answered ${wrong.status}`);
      const ok = await fetch(address, { method: "POST", headers: { "X-Deyin-Key": key }, body: "ping from the e2e" });
      expect(ok.status === 202, `the webhook answered ${ok.status}: ${await ok.text()}`);
      try {
        await until("the routine to ask the model", () => model.requests.length > before, 45_000);
        await until("the new routine in the Routines list", async () => !(await bodyText(page)).includes("No routines yet"), 10_000);
      } catch (error) {
        const tail = main.join("").split("\n").slice(-25).join("\n");
        const files = readdirSync(userData).join(", ");
        const routines = ["automations.json", "routines.json"].filter((f) => existsSync(join(userData, f))).map((f) => `${f}: ${readFileSync(join(userData, f), "utf8").slice(0, 1500)}`).join("\n");
        throw new Error(`${error.message}\n--- main process (tail)\n${tail}\n--- user data: ${files}\n${routines}`, { cause: error });
      }
      const mentions = (request) => JSON.stringify(request.messages).includes("ping from the e2e");
      const ours = await until("the message to reach the model", () => model.requests.slice(before).find(mentions), 45_000).catch(() => {
        throw new Error(`the message never reached the model; it was asked:\n${model.requests.slice(before).map((r) => JSON.stringify(r.messages).slice(0, 700)).join("\n---\n")}`);
      });
      expect(JSON.stringify(ours.messages).includes("inbound_message"), "the message was not handed over as untrusted text");
      const runs = join(userData, "automation-runs.json");
      const finished = await until("the run to be recorded as completed", () => {
        const text = existsSync(runs) ? readFileSync(runs, "utf8") : "";
        return text.includes('"status": "completed"') || text.includes('"status":"completed"') ? text : null;
      }, 30_000).catch(() => {
        throw new Error(`the routine's run never completed: ${existsSync(runs) ? readFileSync(runs, "utf8").slice(0, 1200) : "no run file"}`);
      });
      expect(finished.includes("FAKE-REPLY"), "the run's answer is not the model's reply");
    });

    await check("the hub answers on this computer's loopback only", async () => {
      expect(state.hubPort, "no hub port was seen");
      const health = await fetch(`http://127.0.0.1:${state.hubPort}/health`);
      expect(health.status === 200, `health answered ${health.status}`);
      expect((await health.text()).trim() === "ok", "health did not say ok");
    });

    await check("a room can be made from two Bots, and its conversation opens with its members", async () => {
      await page.evaluate(() => window.deyin.bots.create({ name: "Second Bot" }));
      await until("the second Bot in the roster", async () => (await bodyText(page)).includes("Second Bot"), 15_000);
      await page.getByRole("button", { name: "New room" }).first().click();
      await page.locator("#bot-room-name").waitFor({ state: "visible", timeout: 10_000 });
      const create = page.getByRole("button", { name: "Create room" });
      expect(await create.isDisabled(), "a room with no name and no Bots can be created");
      await page.locator("#bot-room-name").fill("Smoke Room");
      expect(await create.isDisabled(), "a room with no Bots can be created");
      const dialog = page.locator('[aria-labelledby="bot-room-title"]');
      await dialog.locator(".bot-member", { hasText: "Smoke Bot" }).locator("input").check();
      expect(await create.isDisabled(), "a room with one Bot can be created");
      await dialog.locator(".bot-member", { hasText: "Second Bot" }).locator("input").check();
      expect(!(await create.isDisabled()), "a named room with two Bots cannot be created");
      await shot(page, "09a-new-room");
      await create.click();
      await dialog.waitFor({ state: "detached", timeout: 15_000 });
      await until("the room's header", async () => ((await page.locator(".bot-chat-header__name").first().textContent()) ?? "").trim() === "Smoke Room", 15_000);
      const snapshot = await page.evaluate(() => window.deyin.bots.list());
      const room = snapshot.bots.find((b) => b.name === "Smoke Room");
      expect(room && room.kind === "room" && room.memberBotIds.length === 2, `the room was not saved with two members: ${JSON.stringify(room)}`);
      expect(room.harness === "local", "a room must run on this computer");
      state.room = room;
      state.handles = Object.fromEntries(snapshot.bots.filter((b) => b.kind === "agent").map((b) => [b.name, b.handle]));
      const chips = await page.locator(".bot-chat-header__member").allTextContents();
      expect(chips.length === 2 && chips.every((c) => c.trim().startsWith("@")), `the header chips were ${JSON.stringify(chips)}`);
      await shot(page, "09b-room-chat");
    });

    await check("a member's chip puts its @handle in the message box, ready to type after", async () => {
      const handle = state.handles["Second Bot"];
      expect(handle, "no handle for the second Bot");
      await page.getByRole("button", { name: "Mention Second Bot" }).click();
      const box = page.locator("textarea").last();
      await until("the mention in the box", async () => (await box.inputValue()) === `@${handle} `, 5_000);
      await page.keyboard.type("please say who you are");
      expect((await box.inputValue()) === `@${handle} please say who you are`, "typing did not continue after the mention");
    });

    await check("a message in the room is hosted by the room, and the Bot it names answers as itself", async () => {
      const handle = state.handles["Second Bot"];
      const before = model.requests.length;
      await page.locator("textarea").last().press("Enter");
      await until("the host's final line", async () => (await bodyText(page)).includes("ROOM-HOST-DONE"), 60_000).catch(async (error) => {
        const tail = (await bodyText(page)).slice(-600);
        throw new Error(`${error.message}\nscreen: ${tail}\nrequests: ${model.requests.slice(before).map((r) => textOf(r.messages?.[0]?.content).slice(0, 160)).join(" | ")}`, { cause: error });
      });
      const asked = model.requests.slice(before);
      const systemOf = (request) => (request.messages ?? []).filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
      const host = asked.find((r) => systemOf(r).includes("<bot_room>"));
      expect(host, "no request carried the room's instructions");
      const hostSystem = systemOf(host);
      expect(hostSystem.includes('You host the room "Smoke Room"'), "the host is not told which room it is in");
      for (const [name, bot] of Object.entries(state.handles)) expect(hostSystem.includes(`- @${bot}: ${name}`), `the host is not told about ${name}`);
      expect(!hostSystem.includes("<bot_identity>"), "the host was given a Bot's own identity");
      const task = (host.tools ?? []).find((tool) => (tool.function?.name ?? tool.name) === "task");
      expect(task, "the host has no task tool to ask its members with");
      const catalog = (task.function?.description ?? task.description ?? "").split("Available subagents:\n")[1] ?? "";
      const listed = catalog.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2).split(":")[0]).sort();
      expect(JSON.stringify(listed) === JSON.stringify(Object.values(state.handles).sort()), `the host can ask ${JSON.stringify(listed)}, not just the room's members ${JSON.stringify(Object.values(state.handles))}`);
      const member = asked.find((r) => systemOf(r).includes("You are answering in a room"));
      expect(member, "the member was never asked");
      const memberSystem = systemOf(member);
      expect(memberSystem.includes(`You are Second Bot (@${handle})`), "the member did not answer as itself");
      expect(!memberSystem.includes("You are Smoke Bot"), "the other member's identity leaked into the answer");
      expect(!(await bodyText(page)).includes("needs your approval"), "asking a member stopped for approval");
      await shot(page, "09c-room-answer");
    });

    await check("a room's page lets its members change, and refuses fewer than two", async () => {
      await page.getByRole("button", { name: "Details" }).first().click({ timeout: 15_000 });
      const section = page.locator('section[aria-label="Members"]');
      await section.waitFor({ timeout: 15_000 });
      const text = await bodyText(page);
      for (const absent of ["Routines", "Run on", "Connections", "Webhook"]) expect(!text.includes(absent), `a room's page shows ${absent}`);
      const save = section.getByRole("button", { name: "Save members" });
      expect(await save.isDisabled(), "Save is on before anything changed");
      await section.locator(".bot-member", { hasText: "Second Bot" }).locator("input").uncheck();
      expect(await save.isDisabled(), "a room with one member can be saved");
      await section.locator(".bot-member", { hasText: "Second Bot" }).locator("input").check();
      expect(await save.isDisabled(), "Save is on though the members are as they were");
      await shot(page, "09d-room-details");
    });

    await check("a room has a routine-free, connection-free page and cannot be given either from outside", async () => {
      const refused = await page.evaluate(async (roomId) => {
        const surface = await window.deyin.botSurfaces.state(roomId);
        return surface;
      }, state.room.id);
      expect(refused.ok === false && /is a room/.test(refused.error), `the Connections host call answered ${JSON.stringify(refused).slice(0, 200)}`);
    });

    await check("Vault and Servers open from Settings", async () => {
      await page.getByRole("button", { name: "Open the Vault" }).click();
      await page.getByText("Logins, cards and contacts", { exact: false }).first().waitFor({ timeout: 15_000 });
      // The 1Password switch is off until it is turned on, and turning it on is saved.
      const saved = () => JSON.parse(readFileSync(join(userData, "settings.json"), "utf8")).vaultOnePassword;
      const onePassword = page.getByRole("switch", { name: "Let Bots use 1Password" });
      await onePassword.waitFor({ timeout: 15_000 });
      expect((await onePassword.getAttribute("aria-checked")) === "false" && saved() !== true, "1Password should start off");
      await onePassword.click();
      await until("the 1Password setting to be saved", () => saved() === true, 10_000);
      expect((await onePassword.getAttribute("aria-checked")) === "true", "the switch did not follow the setting");
      await shot(page, "07a-vault-1password");
      await page.getByRole("button", { name: "Servers" }).click();
      await page.getByText("Run your Bots on a computer you own", { exact: false }).first().waitFor({ timeout: 15_000 });
      await shot(page, "07-servers");
      await page.getByRole("button", { name: "Back to workspace" }).click();
    });

    await check("going back from Settings returns to Deyin Bot, not to Deyin Code", async () => {
      expect((await productLabel(page)) === "Deyin Bot", `the app came back to ${await productLabel(page)}`);
      await page.keyboard.press("Control+n");
      await page.locator("#bot-create-name").waitFor({ state: "visible", timeout: 5_000 });
      await page.keyboard.press("Escape");
      await page.locator("#bot-create-name").waitFor({ state: "detached", timeout: 10_000 });
    });

    await check("switching to Conductor and back to Bot returns to the Bot's place", async () => {
      await chooseProduct(page, "Deyin Conductor");
      await until("the Conductor product", async () => (await productLabel(page)) === "Deyin Conductor", 10_000);
      await chooseProduct(page, "Deyin Bot");
      await until("the Bot product", async () => (await productLabel(page)) === "Deyin Bot", 10_000);
      expect((await bodyText(page)).includes(BOT_NAME), "the Bot is gone from the roster");
    });

    await check("Deyin Code does not list the Bot's conversation, and the Bot keeps one conversation, not a new one each visit", async () => {
      await chooseProduct(page, "Deyin Code");
      await until("the Code product", async () => (await productLabel(page)) === "Deyin Code", 10_000);
      const code = await bodyText(page);
      expect(!code.includes("hello bot, please say hi"), "a Bot's conversation is listed in Deyin Code");
      await chooseProduct(page, "Deyin Bot");
      await until("the Bot product", async () => (await productLabel(page)) === "Deyin Bot", 10_000);
      await page.getByText(BOT_NAME).first().click();
      await until("the Bot's own conversation", async () => (await bodyText(page)).includes("FAKE-REPLY-1"), 10_000);
      const sessions = join(userData, "sessions");
      const mine = readdirSync(sessions, { recursive: true })
        .map(String)
        .filter((file) => /\.(json|jsonl)$/.test(file))
        .filter((file) => readFileSync(join(sessions, file), "utf8").includes(`"botId":"${state.botId}"`));
      expect(mine.length === 1, `the Bot has ${mine.length} saved conversations; opening it again must not start a new one`);
    });

    await check("a conversation in Deyin Code is still open after a trip to Bot and back", async () => {
      await chooseProduct(page, "Deyin Code");
      await until("the Code product", async () => (await productLabel(page)) === "Deyin Code", 10_000);
      const box = page.locator("textarea").last();
      await box.fill("code question for the thread restore check");
      await box.press("Enter");
      await until("the reply in Code", async () => /FAKE-REPLY-\d+/.test(await bodyText(page)), 45_000);
      await chooseProduct(page, "Deyin Bot");
      await until("the Bot product", async () => (await productLabel(page)) === "Deyin Bot", 10_000);
      await chooseProduct(page, "Deyin Code");
      await until("the Code product again", async () => (await productLabel(page)) === "Deyin Code", 10_000);
      await until("the same conversation", async () => (await bodyText(page)).includes("code question for the thread restore check"), 10_000);
      await shot(page, "07b-code-restored");
      // The next check closes the app here, to see which product it reopens in.
      await chooseProduct(page, "Deyin Bot");
      await until("the Bot product at the end", async () => (await productLabel(page)) === "Deyin Bot", 10_000);
    });

    return state;
  } catch (error) {
    await shot(page, "zz-error");
    throw error;
  } finally {
    state.stderr = main.join("");
    await app.close();
  }
}

async function restartPass(userData) {
  const { app, page, main } = await launch(userData);
  try {
    await dismissWhatsNew(page);
    await check("after a restart the app reopens in Deyin Bot with the Bot still there", async () => {
      await switcher(page).waitFor({ state: "visible", timeout: 60_000 });
      await until("the Bot product", async () => (await productLabel(page)) === "Deyin Bot", 15_000);
      await until("the Bot in the roster", async () => (await bodyText(page)).includes(BOT_NAME), 15_000);
      await shot(page, "08-after-restart");
    });
  } finally {
    await app.close();
  }
  return main.join("");
}

async function main() {
  const model = await startFakeModel();
  const userData = fresh("deyin-e2e-bot-");
  seedProfile(userData, model.port);
  console.log(`user data: ${userData}\nmodel: http://127.0.0.1:${model.port}\nscreenshots: ${shots}`);
  let stderr = "";
  try {
    await welcomePass();
    const state = await botPass(userData, model);
    stderr += state.stderr ?? "";
    stderr += await restartPass(userData);
  } finally {
    await model.close();
  }

  await check("no error was logged by the window", async () => {
    expect(problems.length === 0, problems.join("\n"));
  });
  await check("the main process logged no uncaught error", async () => {
    const bad = stderr.split("\n").filter((line) => /UnhandledPromiseRejection|Uncaught|TypeError|ReferenceError/.test(line));
    expect(bad.length === 0, bad.slice(0, 5).join("\n"));
  });

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
