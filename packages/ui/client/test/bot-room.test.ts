import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BOT_LIMITS, defaultBotAvatar, type DeyinBot } from "@deyin/host-core/shared";
import { ConfirmDialogProvider } from "../src/components/ConfirmDialog.js";
import { BotChatHeader } from "../src/bots/BotChatHeader.js";
import { BotDetailView } from "../src/bots/BotDetailView.js";
import { BotHome } from "../src/bots/BotHome.js";
import { BotMemberPicker } from "../src/bots/BotMemberPicker.js";
import { BotRoomDialog } from "../src/bots/BotRoomDialog.js";
import { BotRoomMembers } from "../src/bots/BotRoomMembers.js";
import { BotRosterList } from "../src/bots/BotRosterList.js";
import { createBotsClient } from "../src/bots/botsClient.js";
import { followSavedMembers, memberRows, membersPatch, newRoomForm, roomFormToInput, roomIsFull, roomProblem, toggleMember } from "../src/bots/botRoom.js";

const noop = () => undefined;
const { actions } = createBotsClient(undefined);

function bot(id: string, over: Partial<DeyinBot> = {}): DeyinBot {
  const avatar = defaultBotAvatar(id);
  return {
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    handle: id,
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
    autoReview: { approvalMode: "auto_review" },
    isPrimary: false,
    archived: false,
    ...over,
  };
}

const room = (members: string[], over: Partial<DeyinBot> = {}) => bot("standup", { name: "Standup", kind: "room", memberBotIds: members, ...over });
const ids = (n: number) => Array.from({ length: n }, (_, i) => `bot${i}`);
const many = (n: number) => ids(n).map((id) => bot(id));

test("the picker offers active agents, and an archived member only while the room still has it", () => {
  const all = [bot("ada"), bot("bo", { archived: true }), bot("cy"), room(["ada", "cy"])];
  assert.deepEqual(
    memberRows(all, []).map((r) => [r.bot.id, r.selected, r.unavailable]),
    [["ada", false, false], ["cy", false, false]],
  );
  assert.deepEqual(
    memberRows(all, ["bo", "cy"]).map((r) => [r.bot.id, r.selected, r.unavailable]),
    [["ada", false, false], ["bo", true, true], ["cy", true, false]],
  );
});

test("choosing adds in order, choosing again removes, and nothing is added past the limit", () => {
  assert.deepEqual(toggleMember([], "a"), ["a"]);
  assert.deepEqual(toggleMember(["a"], "b"), ["a", "b"]);
  assert.deepEqual(toggleMember(["a", "b", "c"], "b"), ["a", "c"]);
  const full = ids(BOT_LIMITS.maxRoomMembers);
  assert.deepEqual(toggleMember(full, "extra"), full);
  assert.notEqual(toggleMember(full, "extra"), full, "a copy, never the same array");
  assert.deepEqual(toggleMember(full, "bot0"), full.slice(1), "a full room can still lose one");
  assert.equal(roomIsFull(full), true);
  assert.equal(roomIsFull(full.slice(1)), false);
});

test("a room needs a name and two Bots that can answer", () => {
  const all = [bot("ada"), bot("bo"), bot("cy", { archived: true })];
  assert.equal(roomProblem("", ["ada", "bo"], all), "name");
  assert.equal(roomProblem("   ", ["ada", "bo"], all), "name");
  assert.equal(roomProblem("Standup", [], all), "members");
  assert.equal(roomProblem("Standup", ["ada"], all), "members");
  assert.equal(roomProblem("Standup", ["ada", "cy"], all), "members", "an archived Bot does not count");
  assert.equal(roomProblem("Standup", ["ada", "ghost"], all), "members", "a Bot that is gone does not count");
  assert.equal(roomProblem("Standup", ["ada", "bo"], all), null);
  assert.equal(roomProblem("Standup", ["ada", "bo", "cy"], all), null);
  assert.equal(BOT_LIMITS.minRoomMembers, 2);
});

test("the room is made from the cleaned name and the Bots in the order they were chosen", () => {
  assert.deepEqual(newRoomForm(), { name: "", memberIds: [] });
  assert.deepEqual(roomFormToInput({ name: "  Stand\n up  ", memberIds: ["bo", "ada"] }), { name: "Stand up", kind: "room", memberBotIds: ["bo", "ada"] });
});

test("members are changed only when they are different, in either membership or order", () => {
  const r = room(["ada", "bo"]);
  assert.equal(membersPatch(r, ["ada", "bo"]), null);
  assert.deepEqual(membersPatch(r, ["ada", "bo", "cy"]), { memberBotIds: ["ada", "bo", "cy"] });
  assert.deepEqual(membersPatch(r, ["bo", "ada"]), { memberBotIds: ["bo", "ada"] });
  assert.deepEqual(membersPatch(r, ["ada"]), { memberBotIds: ["ada"] });
});

test("an untouched picker follows the saved room and one with edits keeps them", () => {
  const before = room(["ada", "bo"]);
  const after = room(["ada", "bo", "cy"]);
  assert.deepEqual(followSavedMembers(before, after, ["ada", "bo"]), ["ada", "bo", "cy"]);
  assert.deepEqual(followSavedMembers(before, after, ["ada"]), ["ada"]);
  const kept = ["ada"];
  assert.notEqual(followSavedMembers(before, after, kept), kept, "a copy");
});

const picker = (rows: ReturnType<typeof memberRows>, full = false) => renderToStaticMarkup(createElement(BotMemberPicker, { rows, full, onToggle: noop }));

test("the picker shows each Bot with its handle, ticks the chosen ones and marks an archived member", () => {
  const html = picker(memberRows([bot("ada"), bot("bo", { archived: true })], ["bo"]));
  assert.match(html, /<legend[^>]*>Bots in the room<\/legend>/);
  assert.match(html, /bot-member__name">Ada<\/span><span class="bot-member__handle">@ada</);
  assert.match(html, /<input type="checkbox" checked=""[^>]*\/>.*?bot-member__name">Bo</s);
  assert.match(html, /<span class="bot-row__badge">archived<\/span>/);
  assert.doesNotMatch(html, /A room holds at most/);
});

test("while a change is being sent the whole picker is locked, and otherwise it is not", () => {
  const rows = memberRows([bot("ada")], []);
  assert.match(renderToStaticMarkup(createElement(BotMemberPicker, { rows, full: false, disabled: true, onToggle: noop })), /<fieldset[^>]*disabled=""/);
  assert.doesNotMatch(picker(rows), /<fieldset[^>]*disabled/);
});

test("a full room disables the Bots that are not in it, keeps the ones that are, and says why", () => {
  const all = many(BOT_LIMITS.maxRoomMembers + 1);
  const chosen = ids(BOT_LIMITS.maxRoomMembers);
  const html = picker(memberRows(all, chosen), true);
  const inputs = html.match(/<input[^>]*>/g) ?? [];
  assert.equal(inputs.length, BOT_LIMITS.maxRoomMembers + 1);
  assert.equal(inputs.filter((tag) => tag.includes("disabled")).length, 1);
  assert.match(inputs[inputs.length - 1]!, /disabled/);
  assert.match(html, /A room holds at most 8 Bots\./);
});

const dialog = (bots: DeyinBot[]) => renderToStaticMarkup(createElement(BotRoomDialog, { bots, onCreate: async () => ({ ok: false, error: "x", code: "invalid" }), onCreated: noop, onCancel: noop }));

test("the new-room dialog asks for a name and the Bots, and cannot be submitted empty", () => {
  const html = dialog(many(3));
  assert.match(html, /role="dialog"/);
  assert.match(html, />New room<\/h2>/);
  assert.match(html, /<label[^>]*for="bot-room-name"[^>]*>Room name<\/label>/);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 3);
  assert.match(html, /Mention one with @/);
  assert.match(html, /<button[^>]*disabled=""[^>]*title="Give the room a name\."[^>]*>Create room<\/button>/);
});

test("with fewer than two Bots the dialog explains instead of offering a picker", () => {
  const html = dialog([bot("ada"), bot("bo", { archived: true })]);
  assert.match(html, /A room needs at least 2 Bots\. Create another Bot first\./);
  assert.doesNotMatch(html, /type="checkbox"/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Create room<\/button>/);
});

const members = (r: DeyinBot, bots: DeyinBot[]) => renderToStaticMarkup(createElement(BotRoomMembers, { room: r, bots, actions }));

test("a room's page lists its members ticked, offers the other Bots, and has nothing to save until something changes", () => {
  const bots = [bot("ada"), bot("bo"), bot("cy")];
  const html = members(room(["ada", "bo"]), bots);
  assert.match(html, /<h3[^>]*>Members<\/h3>/);
  const boxes = html.match(/<input[^>]*>/g) ?? [];
  assert.deepEqual(boxes.map((tag) => tag.includes('checked=""')), [true, true, false]);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Save members<\/button>/);
  assert.match(html, /role="alert" hidden=""/, "no warning while the room is fine");
});

test("a room whose Bot was archived still shows it, so it can be taken out", () => {
  const html = members(room(["ada", "bo"]), [bot("ada"), bot("bo", { archived: true })]);
  assert.match(html, /bot-member__name">Bo<\/span>.*?>archived</s);
});

const roomPage = (r: DeyinBot, extra: { roster?: DeyinBot[] } = {}) =>
  renderToStaticMarkup(createElement(ConfirmDialogProvider, null, createElement(BotDetailView, { bot: r, actions, onBack: noop, onDeleted: noop, ...extra })));

test("a room's page edits its name, label and description, and its members, but has no role, purpose or server", () => {
  const html = roomPage(room(["ada", "bo"]), { roster: [bot("ada"), bot("bo")] });
  assert.match(html, /id="bot-detail-name"/);
  assert.match(html, /id="bot-detail-description"/);
  assert.doesNotMatch(html, /id="bot-detail-role"/);
  assert.doesNotMatch(html, /id="bot-detail-purpose"/);
  assert.match(html, /aria-label="Members"/);
});

test("without the roster a room's members are not editable, and a Bot's page never shows the members section", () => {
  assert.doesNotMatch(roomPage(room(["ada", "bo"])), /aria-label="Members"/);
  const plain = roomPage(bot("ada"), { roster: [bot("ada")] });
  assert.doesNotMatch(plain, /aria-label="Members"/);
  assert.match(plain, /id="bot-detail-role"/);
  assert.match(plain, /id="bot-detail-purpose"/);
});

const header = (r: DeyinBot, props: { members?: DeyinBot[]; onMention?: (handle: string) => void } = {}) =>
  renderToStaticMarkup(createElement(BotChatHeader, { bot: r, onDetails: noop, onNewConversation: noop, ...props }));

test("a room's header shows its members as chips that mention them", () => {
  const html = header(room(["ada", "bo"]), { members: [bot("ada"), bot("bo")], onMention: noop });
  assert.match(html, /<ul class="bot-chat-header__members"[^>]*aria-label="Members"/);
  assert.match(html, /aria-label="Mention Ada"[^>]*><[^>]*>.*?<span>@ada<\/span>/s);
  assert.match(html, /aria-label="Mention Bo"/);
  assert.doesNotMatch(html, /aria-label="Mention [^"]*"[^>]*disabled/);
});

test("the chips are shown for a room only, and are off when the room is archived or there is no composer to mention in", () => {
  assert.doesNotMatch(header(bot("ada"), { members: [bot("bo")], onMention: noop }), /bot-chat-header__members/);
  assert.doesNotMatch(header(room(["ada", "bo"]), { members: [] }), /bot-chat-header__members/);
  assert.match(header(room(["ada", "bo"], { archived: true }), { members: [bot("ada")], onMention: noop }), /aria-label="Mention Ada"[^>]*disabled=""/);
  assert.match(header(room(["ada", "bo"]), { members: [bot("ada")] }), /aria-label="Mention Ada"[^>]*disabled=""/);
});

test("the header escapes a member's name", () => {
  assert.doesNotMatch(header(room(["x", "y"]), { members: [bot("x", { name: "<script>x</script>" })], onMention: noop }), /<script>/);
});

test("the home offers a room only when there are enough Bots for one", () => {
  assert.doesNotMatch(renderToStaticMarkup(createElement(BotHome, { activeCount: 2, onCreate: noop })), /New room/);
  assert.match(renderToStaticMarkup(createElement(BotHome, { activeCount: 2, onCreate: noop, onCreateRoom: noop })), /<button[^>]*>New room<\/button>/);
});

const rosterList = (extra: { onNewRoom?: () => void }) =>
  renderToStaticMarkup(
    createElement(
      ConfirmDialogProvider,
      null,
      createElement(BotRosterList, {
        bots: [bot("ada"), bot("bo")],
        layout: { sections: [], placements: {}, pinned: [], hidden: [] },
        ready: true,
        loadError: null,
        activeBotId: null,
        actions,
        onSelect: noop,
        onDetails: noop,
        onDeleted: noop,
        ...extra,
      }),
    ),
  );

test("the roster has a New room action when the app can make one", () => {
  assert.doesNotMatch(rosterList({}), /New room/);
  assert.match(rosterList({ onNewRoom: noop }), /<button[^>]*>New room<\/button>/);
});
