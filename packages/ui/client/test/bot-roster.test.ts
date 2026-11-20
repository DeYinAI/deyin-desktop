import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EMPTY_BOT_LAYOUT, defaultBotAvatar, type BotRosterLayout, type DeyinBot } from "@deyin/host-core/shared";
import { ConfirmDialogProvider } from "../src/components/ConfirmDialog.js";
import { BotRosterList, ROSTER_CONVERSATION_LIMIT, type BotConversation } from "../src/bots/BotRosterList.js";
import { createBotsClient } from "../src/bots/botsClient.js";

const { actions } = createBotsClient(undefined);

function bot(id: string, over: Partial<DeyinBot> = {}): DeyinBot {
  const avatar = defaultBotAvatar(id);
  return {
    id,
    name: id,
    handle: id.toLowerCase(),
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

interface Props {
  bots?: DeyinBot[];
  layout?: BotRosterLayout;
  ready?: boolean;
  loadError?: string | null;
  activeBotId?: string | null;
  conversations?: BotConversation[];
  activeThreadId?: string | null;
  onBrowse?: () => void;
}

function render(props: Props = {}): string {
  const noop = () => undefined;
  return renderToStaticMarkup(
    createElement(
      ConfirmDialogProvider,
      null,
      createElement(BotRosterList, {
        bots: props.bots ?? [],
        layout: props.layout ?? EMPTY_BOT_LAYOUT,
        ready: props.ready ?? true,
        loadError: props.loadError ?? null,
        activeBotId: props.activeBotId ?? null,
        conversations: props.conversations,
        activeThreadId: props.activeThreadId ?? null,
        onSelectConversation: noop,
        actions,
        onSelect: noop,
        onDetails: noop,
        onDeleted: noop,
        ...(props.onBrowse ? { onBrowse: props.onBrowse } : {}),
      }),
    ),
  );
}

const names = (html: string): string[] => [...html.matchAll(/class="bot-row__name">([^<]*)</g)].map((m) => m[1]!);

test("while loading it says so and shows no Bots", () => {
  const html = render({ ready: false, bots: [bot("Ada")] });
  assert.match(html, /Loading Bots…/);
  assert.deepEqual(names(html), []);
});

test("a load failure is announced as an alert instead of an empty roster", () => {
  const html = render({ loadError: "disk unreadable" });
  assert.match(html, /role="alert"/);
  assert.match(html, /Could not load your Bots\./);
  assert.doesNotMatch(html, /No Bots yet/);
});

test("with no Bots it explains what a Bot is", () => {
  const html = render();
  assert.match(html, /No Bots yet/);
  assert.match(html, /persistent assistant with its own memory and files/);
});

test("Bots are listed with name, label and the primary mark, primary first", () => {
  const html = render({
    bots: [bot("Bo", { createdAt: 1 }), bot("Ada", { createdAt: 2, isPrimary: true, title: "Research assistant" })],
  });
  assert.deepEqual(names(html), ["Ada", "Bo"]);
  assert.match(html, /bot-row__title">Research assistant</);
  assert.equal(html.match(/bot-row__badge">Primary</g)?.length, 1);
});

test("the open Bot's row is marked active", () => {
  const html = render({ bots: [bot("Ada"), bot("Bo")], activeBotId: "Bo" });
  assert.equal(html.match(/bot-row--active/g)?.length, 1);
  assert.match(html, /bot-row--active"><button[^>]*>.*?bot-row__name">Bo</s);
});

test("pinned Bots appear once, in their own section above the rest", () => {
  const html = render({ bots: [bot("Ada"), bot("Bo"), bot("Cy")], layout: { ...EMPTY_BOT_LAYOUT, pinned: ["Cy"] } });
  assert.match(html, /aria-label="Pinned"/);
  assert.deepEqual(names(html), ["Cy", "Ada", "Bo"]);
});

test("user sections group their Bots under the section name with rename and remove controls", () => {
  const layout: BotRosterLayout = { pinned: [], hidden: [], sections: [{ id: "s1", name: "Work", botIds: ["Bo"] }] };
  const html = render({ bots: [bot("Ada"), bot("Bo")], layout });
  assert.match(html, /aria-label="Work"/);
  assert.match(html, /aria-label="Rename section: Work"/);
  assert.match(html, /aria-label="Remove section: Work"/);
  assert.deepEqual(names(html), ["Ada", "Bo"]);
});

test("an empty section is still shown, so a Bot can be filed into it", () => {
  const layout: BotRosterLayout = { pinned: [], hidden: [], sections: [{ id: "s1", name: "Later", botIds: [] }] };
  assert.match(render({ bots: [bot("Ada")], layout }), /aria-label="Later"/);
});

test("hidden and archived Bots start collapsed behind a count, and are not in the main list", () => {
  const html = render({ bots: [bot("Ada"), bot("Bo"), bot("Cy", { archived: true })], layout: { ...EMPTY_BOT_LAYOUT, hidden: ["Bo"] } });
  assert.deepEqual(names(html), ["Ada"]);
  assert.match(html, /Hidden \(1\)/);
  assert.match(html, /Archived \(1\)/);
  assert.equal(html.match(/class="sidebar__section bot-roster__toggle" aria-expanded="false"/g)?.length, 2);
});

test("an archive on its own is not an empty roster, so the empty-state prompt does not hide it", () => {
  const html = render({ bots: [bot("Old", { archived: true })] });
  assert.doesNotMatch(html, /No Bots yet/);
  assert.match(html, /Archived \(1\)/);
});

test("every row has its own labelled actions menu trigger", () => {
  const html = render({ bots: [bot("Ada"), bot("Bo")] });
  assert.match(html, /aria-label="Bot actions: Ada"/);
  assert.match(html, /aria-label="Bot actions: Bo"/);
  assert.equal(html.match(/aria-haspopup="menu"/g)?.length, 2);
});

test("a Bot's name is escaped, never injected", () => {
  const html = render({ bots: [bot("x", { name: "<img src=x onerror=alert(1)>" })] });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

const convos = (n: number): BotConversation[] => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `Chat ${i}` }));
const convoTitles = (html: string): string[] => [...html.matchAll(/bot-row__thread-title">([^<]*)</g)].map((m) => m[1]!);

test("the open Bot's conversations are listed under its row, in the order given", () => {
  const html = render({ bots: [bot("Ada"), bot("Bo")], activeBotId: "Ada", conversations: convos(3) });
  assert.deepEqual(convoTitles(html), ["Chat 0", "Chat 1", "Chat 2"]);
  assert.match(html, /aria-label="Conversations: Ada"/);
  assert.ok(html.indexOf("bot-row__threads") > html.indexOf('bot-row__name">Ada<'));
  assert.ok(html.indexOf("bot-row__threads") < html.indexOf('bot-row__name">Bo<'), "listed directly under Ada, before Bo");
});

test("conversations are only listed for the open Bot, never for another", () => {
  const html = render({ bots: [bot("Ada"), bot("Bo")], activeBotId: "Bo", conversations: convos(2) });
  assert.equal(html.match(/bot-row__threads/g)?.length, 1);
  assert.ok(html.indexOf("bot-row__threads") > html.indexOf('bot-row__name">Bo<'));
});

test("with no open Bot, no conversation list appears", () => {
  assert.doesNotMatch(render({ bots: [bot("Ada")], conversations: convos(2) }), /bot-row__threads/);
});

test("a Bot with no conversations shows no empty list", () => {
  assert.doesNotMatch(render({ bots: [bot("Ada")], activeBotId: "Ada", conversations: [] }), /bot-row__threads/);
});

test("only the newest few conversations are listed", () => {
  const html = render({ bots: [bot("Ada")], activeBotId: "Ada", conversations: convos(ROSTER_CONVERSATION_LIMIT + 5) });
  assert.equal(convoTitles(html).length, ROSTER_CONVERSATION_LIMIT);
  assert.equal(convoTitles(html)[0], "Chat 0");
});

test("the open conversation is marked current", () => {
  const html = render({ bots: [bot("Ada")], activeBotId: "Ada", conversations: convos(3), activeThreadId: "t1" });
  assert.equal(html.match(/aria-current="true"/g)?.length, 1);
  assert.match(html, /sb-row--active"[^>]*aria-current="true"[^>]*><span class="bot-row__thread-dot"[^>]*><\/span><span class="bot-row__thread-title">Chat 1</);
});

test("every listed conversation has a dot to the left of its title", () => {
  const html = render({ bots: [bot("Ada")], activeBotId: "Ada", conversations: convos(3) });
  assert.equal(html.match(/<span class="bot-row__thread-dot" aria-hidden="true"><\/span><span class="bot-row__thread-title">/g)?.length, 3);
});

test("the open Bot's row is selected until one of its conversations is open, then that conversation is", () => {
  const closed = render({ bots: [bot("Ada")], activeBotId: "Ada", conversations: convos(3), activeThreadId: null });
  assert.equal(closed.match(/bot-row--active/g)?.length, 1, "no conversation open: the Bot's row carries the selection");

  const open = render({ bots: [bot("Ada")], activeBotId: "Ada", conversations: convos(3), activeThreadId: "t1" });
  assert.equal(open.match(/bot-row--active/g)?.length ?? 0, 0, "a conversation is open: the Bot's row steps back");
  assert.equal(open.match(/sb-row--active/g)?.length, 1, "and that conversation is the one filled row");
});

test("a conversation open but not listed leaves the selection on the Bot's row", () => {
  const html = render({
    bots: [bot("Ada")],
    activeBotId: "Ada",
    conversations: convos(ROSTER_CONVERSATION_LIMIT + 2),
    activeThreadId: `t${ROSTER_CONVERSATION_LIMIT + 1}`,
  });
  assert.equal(html.match(/sb-row--active/g)?.length ?? 0, 0, "the open conversation is past the listed few");
  assert.equal(html.match(/bot-row--active/g)?.length, 1, "so the Bot's row still shows where you are");
});

test("a conversation title is escaped", () => {
  const html = render({ bots: [bot("Ada")], activeBotId: "Ada", conversations: [{ id: "x", title: "<b>hi</b>" }] });
  assert.doesNotMatch(html, /<b>hi/);
});

test("the roster links to the marketplace only where there is one", () => {
  assert.doesNotMatch(render({ bots: [bot("Ada")] }), /Discover Bots/);
  assert.match(render({ bots: [bot("Ada")], onBrowse: () => undefined }), /<button[^>]*>Discover Bots<\/button>/);
  assert.match(render({ onBrowse: () => undefined }), /Discover Bots/, "an empty roster is where a first Bot is most likely found");
});

test("the sidebar's own title is not repeated above a roster that has only the one group", () => {
  const lone = render({ bots: [bot("Ada"), bot("Bo")] });
  assert.doesNotMatch(lone, /bot-roster__section/);
  assert.match(lone, /<section aria-label="Bots">/, "the group is still named for screen readers");
  assert.deepEqual(names(lone), ["Ada", "Bo"]);
});

test("the group is titled when something else sits beside it: a pinned Bot or a section", () => {
  const pinned = render({ bots: [bot("Ada"), bot("Bo")], layout: { pinned: ["Ada"], hidden: [], sections: [] } });
  assert.match(pinned, /<span>Bots<\/span>/);
  const sectioned = render({ bots: [bot("Ada"), bot("Bo")], layout: { pinned: [], hidden: [], sections: [{ id: "s1", name: "Work", botIds: ["Bo"] }] } });
  assert.match(sectioned, /<span>Bots<\/span>/);
  assert.match(sectioned, /<span>Work<\/span>/);
});
