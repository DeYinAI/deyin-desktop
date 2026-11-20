import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AVATAR_PROMPT_LIMIT, defaultBotAvatar, type DeyinBot, type ModelInfo, type ProviderInfo } from "@deyin/host-core/shared";
import { ConfirmDialogProvider } from "../src/components/ConfirmDialog.js";
import { BotDetailView } from "../src/bots/BotDetailView.js";
import { BotAvatarMakerView, type BotAvatarMakerViewProps } from "../src/bots/BotAvatarMaker.js";
import {
  AVATAR_MAKER_CLOSED,
  avatarMakerReducer,
  avatarModelChoices,
  chosenModel,
  makeAvatarPicture,
  type AvatarMakerApi,
  type AvatarMakerEvent,
  type AvatarMakerState,
  type AvatarModelChoice,
} from "../src/bots/botAvatarMaker.js";
import { createBotsClient } from "../src/bots/botsClient.js";

const noop = () => undefined;
const { actions } = createBotsClient(undefined);

const model = (id: string, over: Partial<ModelInfo> = {}): ModelInfo => ({ id, name: id, ...over });
const provider = (id: string, over: Partial<ProviderInfo> = {}): ProviderInfo => ({
  id,
  name: id.toUpperCase(),
  kind: "custom",
  status: "connected",
  enabled: true,
  apiFormat: "openai",
  hasKey: true,
  connectionModes: [],
  activeMode: "",
  models: [],
  disabledModels: [],
  ...over,
});

test("only text-to-image models are offered: the account's first, then each enabled provider's", () => {
  const choices = avatarModelChoices(
    [model("GLM-5.2"), model("flux-1", { name: "FLUX 1", kind: "image" }), model("clip", { kind: "video" }), model("nano", { imageOutput: true })],
    [
      provider("mine", { models: [model("sdxl", { name: "SDXL", kind: "image" }), model("chat")] }),
      provider("off", { enabled: false, models: [model("hidden", { kind: "image" })] }),
      provider("primary", { kind: "primary", models: [model("dup", { kind: "image" })] }),
    ],
  );
  assert.deepEqual(
    choices.map((c) => [c.key, c.providerId, c.model, c.label]),
    [
      ["openference::flux-1", "openference", "flux-1", "FLUX 1"],
      ["mine::sdxl", "mine", "sdxl", "SDXL (MINE)"],
    ],
  );
});

test("a model the person switched off is not offered, and a model with no name shows its id", () => {
  const choices = avatarModelChoices(
    [model("plain", { name: "", kind: "image" })],
    [provider("mine", { disabledModels: ["off-model"], models: [model("off-model", { kind: "image" }), model("on-model", { name: "", kind: "image" })] })],
  );
  assert.deepEqual(
    choices.map((c) => c.label),
    ["plain", "on-model (MINE)"],
  );
});

test("the same model id under two providers stays two choices", () => {
  const choices = avatarModelChoices(
    [model("flux", { kind: "image" })],
    [provider("mine", { models: [model("flux", { kind: "image" })] })],
  );
  assert.deepEqual(
    choices.map((c) => c.key),
    ["openference::flux", "mine::flux"],
  );
});

const CHOICES: AvatarModelChoice[] = [
  { key: "a::one", providerId: "a", model: "one", label: "One" },
  { key: "b::two", providerId: "b", model: "two", label: "Two" },
];

test("the chosen model is the one picked, or the first when that one is gone, or none at all", () => {
  assert.equal(chosenModel(CHOICES, "b::two")?.model, "two");
  assert.equal(chosenModel(CHOICES, "gone")?.model, "one");
  assert.equal(chosenModel(CHOICES, "")?.model, "one");
  assert.equal(chosenModel([], "a::one"), undefined);
});

const run = (events: AvatarMakerEvent[], from: AvatarMakerState = AVATAR_MAKER_CLOSED): AvatarMakerState => events.reduce(avatarMakerReducer, from);

test("the maker goes from closed to editing to making to review, and back to editing to ask again", () => {
  assert.deepEqual(run([{ type: "open" }]), { phase: "editing", error: null });
  assert.deepEqual(run([{ type: "open" }, { type: "start" }]), { phase: "making" });
  assert.deepEqual(run([{ type: "open" }, { type: "start" }, { type: "made", url: "data:image/png;base64,AA" }]), { phase: "review", url: "data:image/png;base64,AA" });
  assert.deepEqual(run([{ type: "open" }, { type: "start" }, { type: "made", url: "u" }, { type: "retry" }]), { phase: "editing", error: null });
});

test("a refusal returns to editing with the reason; trying again clears it", () => {
  const failed = run([{ type: "open" }, { type: "start" }, { type: "failed", error: "Signed out" }]);
  assert.deepEqual(failed, { phase: "editing", error: "Signed out" });
  assert.deepEqual(run([{ type: "start" }], failed), { phase: "making" });
  assert.deepEqual(run([{ type: "start" }, { type: "failed", error: "x" }, { type: "start" }, { type: "made", url: "u" }], failed), { phase: "review", url: "u" });
});

test("closing from any state closes it", () => {
  for (const from of [AVATAR_MAKER_CLOSED, { phase: "editing", error: null }, { phase: "making" }, { phase: "review", url: "u" }] as AvatarMakerState[]) {
    assert.deepEqual(run([{ type: "close" }], from), AVATAR_MAKER_CLOSED);
  }
});

test("an answer that arrives after the maker was closed, or reopened, changes nothing", () => {
  assert.deepEqual(run([{ type: "made", url: "late" }]), AVATAR_MAKER_CLOSED);
  assert.deepEqual(run([{ type: "failed", error: "late" }]), AVATAR_MAKER_CLOSED);
  const editing: AvatarMakerState = { phase: "editing", error: null };
  assert.deepEqual(run([{ type: "made", url: "late" }], editing), editing);
  assert.deepEqual(run([{ type: "failed", error: "late" }], editing), editing);
  const review: AvatarMakerState = { phase: "review", url: "chosen" };
  assert.deepEqual(run([{ type: "made", url: "late" }, { type: "failed", error: "late" }, { type: "start" }, { type: "open" }], review), review);
});

test("events that do not fit the state are ignored, so the panel never jumps", () => {
  const making: AvatarMakerState = { phase: "making" };
  assert.deepEqual(run([{ type: "open" }, { type: "start" }, { type: "retry" }], making), making);
  assert.deepEqual(run([{ type: "retry" }, { type: "start" }]), AVATAR_MAKER_CLOSED);
  const editing: AvatarMakerState = { phase: "editing", error: "kept" };
  assert.deepEqual(run([{ type: "open" }, { type: "retry" }], editing), editing);
});

test("a picture comes back as its address, and a refusal as its reason", async () => {
  const request = { prompt: "an owl", model: "flux-1" };
  const seen: unknown[] = [];
  const good: AvatarMakerApi = {
    generate: async (r) => {
      seen.push(r);
      return { ok: true, value: { url: "data:image/png;base64,AA" } };
    },
  };
  assert.deepEqual(await makeAvatarPicture(good, request), { kind: "made", url: "data:image/png;base64,AA" });
  assert.deepEqual(seen, [request]);
  const refused: AvatarMakerApi = { generate: async () => ({ ok: false, error: "Describe the picture you want.", code: "invalid" }) };
  assert.deepEqual(await makeAvatarPicture(refused, request), { kind: "failed", error: "Describe the picture you want." });
});

test("a call that rejects is a failure with text, not a maker stuck on making", async () => {
  const dropped: AvatarMakerApi = {
    generate: async () => {
      throw new Error("channel closed");
    },
  };
  assert.deepEqual(await makeAvatarPicture(dropped, { prompt: "x", model: "m" }), { kind: "failed", error: "channel closed" });
  const odd: AvatarMakerApi = {
    generate: async () => {
      throw "plain text";
    },
  };
  assert.deepEqual(await makeAvatarPicture(odd, { prompt: "x", model: "m" }), { kind: "failed", error: "plain text" });
});

function view(over: Partial<BotAvatarMakerViewProps> = {}): string {
  const props: BotAvatarMakerViewProps = {
    state: { phase: "editing", error: null },
    prompt: "",
    choices: CHOICES,
    modelKey: "a::one",
    onOpen: noop,
    onClose: noop,
    onPrompt: noop,
    onModel: noop,
    onMake: noop,
    onUse: noop,
    onRetry: noop,
    ...over,
  };
  return renderToStaticMarkup(createElement(BotAvatarMakerView, props));
}

const makeButton = (html: string): string => html.match(/<button[^>]*>Make picture<\/button>/)?.[0] ?? "";

test("closed, the maker is one button", () => {
  const html = view({ state: AVATAR_MAKER_CLOSED });
  assert.match(html, /<button[^>]*>Make a picture<\/button>/);
  assert.doesNotMatch(html, /textarea/);
  assert.match(view({ state: AVATAR_MAKER_CLOSED, disabled: true }), /<button[^>]*disabled=""[^>]*>Make a picture/);
});

test("editing asks what the picture should show, with the limit on the box", () => {
  const html = view();
  assert.match(html, /What should the picture show\?/);
  assert.match(html, new RegExp(`<textarea[^>]*maxLength="${AVATAR_PROMPT_LIMIT}"`));
  assert.match(html, /placeholder="A friendly owl in round glasses"/);
});

test("Make picture waits for a description that is allowed", () => {
  assert.match(makeButton(view({ prompt: "" })), /disabled=""/);
  assert.match(makeButton(view({ prompt: "   " })), /disabled=""/);
  assert.match(makeButton(view({ prompt: "a".repeat(AVATAR_PROMPT_LIMIT + 1) })), /disabled=""/);
  assert.doesNotMatch(makeButton(view({ prompt: "an owl" })), /disabled/);
  assert.doesNotMatch(makeButton(view({ prompt: "a".repeat(AVATAR_PROMPT_LIMIT) })), /disabled/);
});

test("the models are a list only when there is a choice to make", () => {
  assert.match(view(), /<select[^>]*aria-label="Image model"/);
  assert.match(view(), /<option value="a::one"[^>]*>One<\/option><option value="b::two">Two<\/option>/);
  assert.doesNotMatch(view({ choices: [CHOICES[0]!] }), /<select/);
  assert.doesNotMatch(view({ choices: [CHOICES[0]!], prompt: "an owl" }).match(/<button[^>]*>Make picture<\/button>/)?.[0] ?? "", /disabled/);
});

test("with no image model the maker says what to add and cannot start", () => {
  const html = view({ choices: [], modelKey: "", prompt: "an owl" });
  assert.match(html, /No image model is available\. Add one under Settings, Models\./);
  assert.match(makeButton(html), /disabled=""/);
  assert.doesNotMatch(view(), /No image model is available/);
});

test("a refusal is announced as an alert, and only while editing", () => {
  const html = view({ state: { phase: "editing", error: "Signed out — sign in to Openference to generate images." } });
  assert.match(html, /<p class="field__error" role="alert">Signed out — sign in to Openference to generate images\.<\/p>/);
  assert.doesNotMatch(view(), /role="alert"/);
});

test("while the picture is being made the box is locked and the wait is announced", () => {
  const html = view({ state: { phase: "making" }, prompt: "an owl" });
  assert.match(html, /<p class="hint" role="status">Making your picture…<\/p>/);
  assert.match(html, /<textarea[^>]*disabled=""/);
  assert.match(html, /<select[^>]*disabled=""/);
  assert.match(makeButton(html), /disabled=""/);
  assert.doesNotMatch(view({ prompt: "an owl" }), /Making your picture/);
});

test("the picture made is shown to look at, with the three things to do with it", () => {
  const html = view({ state: { phase: "review", url: "data:image/png;base64,AAAA" } });
  assert.match(html, /<img[^>]*src="data:image\/png;base64,AAAA"[^>]*alt="The picture that was made"/);
  assert.match(html, />Use this picture</);
  assert.match(html, />Try again</);
  assert.match(html, />Cancel</);
  assert.doesNotMatch(html, /textarea/);
});

const ADA: DeyinBot = (() => {
  const avatar = defaultBotAvatar("ada");
  return {
    id: "ada",
    name: "Ada",
    handle: "ada",
    description: "",
    title: "",
    avatarShape: avatar.shape,
    avatarColor: avatar.color,
    avatarVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    harness: "local",
    role: "assistant",
    visibility: "owner",
    kind: "agent",
    memberBotIds: [],
    isPrimary: false,
    archived: false,
  };
})();

function detail(avatarMaker?: { api: AvatarMakerApi; choices: AvatarModelChoice[] }): string {
  return renderToStaticMarkup(createElement(ConfirmDialogProvider, null, createElement(BotDetailView, { bot: ADA, actions, avatarMaker, onBack: noop, onDeleted: noop })));
}

test("the Bot's page offers Make a picture next to Upload where the host can make one, and not otherwise", () => {
  const api: AvatarMakerApi = { generate: async () => ({ ok: false, error: "", code: "invalid" }) };
  const html = detail({ api, choices: CHOICES });
  assert.match(html, />Upload image</);
  assert.match(html, />Make a picture</);
  assert.doesNotMatch(detail(), />Make a picture</);
});
