import assert from "node:assert/strict";
import test from "node:test";
import { BOT_LIMITS, defaultBotAvatar, type DeyinBot } from "@deyin/host-core/shared";
import {
  AVATAR_MAX_DATA_URL_CHARS,
  AVATAR_MAX_FILE_BYTES,
  checkAvatarFile,
  formFromBot,
  formProblem,
  formToInput,
  followSavedBot,
  formToPatch,
  isFormDirty,
  newBotForm,
  pickAvatarFile,
  submitBotForm,
  type BotForm,
} from "../src/bots/botForm.js";

function bot(over: Partial<DeyinBot> = {}): DeyinBot {
  const avatar = defaultBotAvatar("bot_1");
  return {
    id: "bot_1",
    name: "Ada",
    handle: "ada",
    description: "Reads papers.",
    title: "Research assistant",
    avatarShape: avatar.shape,
    avatarColor: avatar.color,
    avatarVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    harness: "local",
    role: "researcher",
    visibility: "owner",
    kind: "agent",
    memberBotIds: [],
    purpose: "Find sources.",
    autoReview: { approvalMode: "auto_review" },
    isPrimary: false,
    archived: false,
    ...over,
  };
}

function form(over: Partial<BotForm> = {}): BotForm {
  return { ...formFromBot(bot()), ...over };
}

test("a new form is blank but starts with the avatar a Bot of that seed would get", () => {
  const f = newBotForm("seed-1");
  const avatar = defaultBotAvatar("seed-1");
  assert.deepEqual(f, {
    name: "",
    title: "",
    description: "",
    role: "",
    purpose: "",
    avatarShape: avatar.shape,
    avatarColor: avatar.color,
    avatarUrl: null,
  });
  assert.notEqual(f.avatarColor, "ink", "a default never starts on the darkest color");
  assert.deepEqual(newBotForm("seed-1"), f, "the same seed gives the same start");
});

test("a form made from a Bot round-trips with nothing to save", () => {
  const b = bot();
  assert.equal(isFormDirty(b, formFromBot(b)), false);
  assert.deepEqual(formToPatch(b, formFromBot(b)), {});
});

test("a Bot with no purpose or picture round-trips too", () => {
  const b = bot({ purpose: undefined });
  assert.equal(formFromBot(b).purpose, "");
  assert.equal(formFromBot(b).avatarUrl, null);
  assert.deepEqual(formToPatch(b, formFromBot(b)), {});
});

test("only the fields that changed are in the patch", () => {
  const b = bot();
  assert.deepEqual(formToPatch(b, form({ title: "Lead researcher" })), { title: "Lead researcher" });
  assert.deepEqual(formToPatch(b, form({ avatarColor: b.avatarColor === "coral" ? "teal" : "coral" })), {
    avatarColor: b.avatarColor === "coral" ? "teal" : "coral",
  });
  const many = formToPatch(b, form({ name: "Grace", purpose: "New purpose", role: "analyst" }));
  assert.deepEqual(many, { name: "Grace", role: "analyst", purpose: "New purpose" });
});

test("whitespace-only edits are not changes, because the host would store the same value", () => {
  const b = bot();
  assert.deepEqual(formToPatch(b, form({ name: "  Ada  ", title: "Research   assistant" })), {});
  assert.deepEqual(formToPatch(b, form({ description: "Reads papers.\n\n" })), {});
});

test("clearing an optional field is a real change, sent as an empty string", () => {
  const b = bot();
  assert.deepEqual(formToPatch(b, form({ title: "", role: "", description: "", purpose: "" })), {
    title: "",
    role: "",
    description: "",
    purpose: "",
  });
});

test("choosing a picture sets avatarUrl and removing it sends null", () => {
  const b = bot();
  const url = "data:image/png;base64,AAAA";
  assert.deepEqual(formToPatch(b, form({ avatarUrl: url })), { avatarUrl: url });
  const withPicture = bot({ avatarUrl: url });
  assert.deepEqual(formToPatch(withPicture, formFromBot(withPicture)), {});
  assert.deepEqual(formToPatch(withPicture, { ...formFromBot(withPicture), avatarUrl: null }), { avatarUrl: null });
});

test("the form is dirty exactly when the patch is not empty", () => {
  const b = bot();
  assert.equal(isFormDirty(b, form({ role: "analyst" })), true);
  assert.equal(isFormDirty(b, form({ role: " researcher " })), false);
});

test("create needs a name, and says so in the host's words", () => {
  assert.equal(formProblem(newBotForm("s"), "create"), "A Bot needs a name.");
  assert.equal(formProblem({ ...newBotForm("s"), name: "   " }, "create"), "A Bot needs a name.");
  assert.equal(formProblem({ ...newBotForm("s"), name: "Ada" }, "create"), null);
});

test("an edit may leave the name alone only because it is already valid", () => {
  assert.equal(formProblem(form(), "update"), null);
  assert.equal(formProblem(form({ name: "" }), "update"), "A Bot needs a name.");
});

test("over-long fields are refused with the limit named", () => {
  assert.match(formProblem(form({ name: "x".repeat(BOT_LIMITS.name + 1) }), "update") ?? "", new RegExp(String(BOT_LIMITS.name)));
  assert.match(formProblem(form({ purpose: "x".repeat(BOT_LIMITS.purpose + 1) }), "update") ?? "", new RegExp(String(BOT_LIMITS.purpose)));
  assert.equal(formProblem(form({ purpose: "x".repeat(BOT_LIMITS.purpose) }), "update"), null, "the limit itself is allowed");
});

test("an invalid picture is refused by the same rule the host applies", () => {
  assert.match(formProblem(form({ avatarUrl: "data:image/svg+xml;base64,AAAA" }), "update") ?? "", /PNG, JPEG or WebP/);
  assert.match(formProblem(form({ avatarUrl: "data:image/png;base64," + "A".repeat(BOT_LIMITS.avatarUrl) }), "update") ?? "", /too large/);
  assert.equal(formProblem(form({ avatarUrl: "data:image/webp;base64,AAAA" }), "update"), null);
});

test("creating sends the cleaned name and leaves empty optional fields out", () => {
  const input = formToInput({ ...newBotForm("s"), name: "  Ada\n", title: "  ", purpose: "Find sources." });
  assert.equal(input.name, "Ada");
  assert.equal("title" in input, false);
  assert.equal("role" in input, false);
  assert.equal("description" in input, false);
  assert.equal(input.purpose, "Find sources.");
  assert.ok(input.avatarShape && input.avatarColor);
});

test("a picture file is accepted only if it is PNG, JPEG or WebP and small enough", () => {
  assert.equal(checkAvatarFile({ type: "image/png", size: 10 }), "ok");
  assert.equal(checkAvatarFile({ type: "image/jpeg", size: AVATAR_MAX_FILE_BYTES }), "ok");
  assert.equal(checkAvatarFile({ type: "image/webp", size: 1 }), "ok");
  assert.equal(checkAvatarFile({ type: "image/jpeg", size: AVATAR_MAX_FILE_BYTES + 1 }), "size");
  assert.equal(checkAvatarFile({ type: "image/svg+xml", size: 10 }), "type", "SVG can carry script");
  assert.equal(checkAvatarFile({ type: "image/gif", size: 10 }), "type");
  assert.equal(checkAvatarFile({ type: "", size: 10 }), "type");
  assert.equal(checkAvatarFile({ type: "image/svg+xml", size: AVATAR_MAX_FILE_BYTES + 1 }), "type", "type is checked before size");
});

test("the biggest accepted file, once base64-encoded, still fits the host's data-URL limit", () => {
  const encoded = Math.ceil(AVATAR_MAX_FILE_BYTES / 3) * 4;
  const prefix = "data:image/jpeg;base64,".length;
  assert.ok(encoded + prefix <= AVATAR_MAX_DATA_URL_CHARS, `${encoded + prefix} <= ${AVATAR_MAX_DATA_URL_CHARS}`);
});

test("submitBotForm passes a success value through", async () => {
  assert.deepEqual(await submitBotForm(async () => ({ ok: true as const, value: 7 })), { kind: "done", value: 7 });
});

test("submitBotForm turns a host refusal into the host's own message", async () => {
  const outcome = await submitBotForm<number>(async () => ({ ok: false as const, error: "That handle is taken.", code: "conflict" as const }));
  assert.deepEqual(outcome, { kind: "failed", error: "That handle is taken." });
});

test("submitBotForm turns a rejected call into a failure, so a form is never left locked", async () => {
  const outcome = await submitBotForm<number>(async () => {
    throw new Error("channel closed");
  });
  assert.deepEqual(outcome, { kind: "failed", error: "channel closed" });
});

test("submitBotForm reports a non-Error rejection as text", async () => {
  const outcome = await submitBotForm<number>(() => Promise.reject("boom"));
  assert.deepEqual(outcome, { kind: "failed", error: "boom" });
});

test("an untouched form follows a Bot that changed underneath it", () => {
  const before = bot({ name: "Ada" });
  const after = { ...before, name: "Ada Lovelace", updatedAt: 9 };
  assert.equal(followSavedBot(before, after, formFromBot(before)).name, "Ada Lovelace");
});

test("a form with edits keeps them when the Bot changes underneath it", () => {
  const before = bot({ name: "Ada" });
  const after = { ...before, title: "Researcher", updatedAt: 9 };
  const editing = { ...formFromBot(before), name: "Ada W" };
  const kept = followSavedBot(before, after, editing);
  assert.equal(kept.name, "Ada W");
  assert.equal(kept, editing, "the very same form, not a copy");
});

test("an edit that was typed and then undone counts as untouched", () => {
  const before = bot({ name: "Ada" });
  const after = { ...before, title: "Researcher", updatedAt: 9 };
  const undone = { ...formFromBot(before), name: "Ada " };
  assert.equal(followSavedBot(before, after, undone).title, "Researcher");
});

/** A Blob reporting the given type and size (the real getters are read-only). */
const file = (type: string, size: number) =>
  Object.defineProperties(new Blob([]), { type: { value: type }, size: { value: size } }) as Blob & { type: string; size: number };

test("pickAvatarFile reads an accepted picture", async () => {
  assert.deepEqual(await pickAvatarFile(file("image/png", 10), async () => "data:image/png;base64,AAAA"), { kind: "ok", url: "data:image/png;base64,AAAA" });
});

test("pickAvatarFile refuses an SVG without reading it", async () => {
  let read = 0;
  const outcome = await pickAvatarFile(file("image/svg+xml", 10), async () => {
    read += 1;
    return "x";
  });
  assert.deepEqual(outcome, { kind: "rejected", why: "type" });
  assert.equal(read, 0);
});

test("pickAvatarFile refuses a file over the limit without reading it", async () => {
  let read = 0;
  const outcome = await pickAvatarFile(file("image/jpeg", AVATAR_MAX_FILE_BYTES + 1), async () => {
    read += 1;
    return "x";
  });
  assert.deepEqual(outcome, { kind: "rejected", why: "size" });
  assert.equal(read, 0);
});

test("pickAvatarFile accepts a file exactly at the limit", async () => {
  assert.equal((await pickAvatarFile(file("image/webp", AVATAR_MAX_FILE_BYTES), async () => "data:image/webp;base64,AA")).kind, "ok");
});

test("pickAvatarFile refuses when the encoded picture is over the host's data-URL limit", async () => {
  const huge = `data:image/png;base64,${"A".repeat(AVATAR_MAX_DATA_URL_CHARS)}`;
  assert.deepEqual(await pickAvatarFile(file("image/png", 10), async () => huge), { kind: "rejected", why: "size" });
});

test("pickAvatarFile reports a file that cannot be read", async () => {
  const outcome = await pickAvatarFile(file("image/png", 10), async () => {
    throw new Error("Could not read that file.");
  });
  assert.deepEqual(outcome, { kind: "unreadable", error: "Could not read that file." });
});
