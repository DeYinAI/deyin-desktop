import { defaultBotAvatar, type DeyinBot } from "@deyin/host-core";

/** A Bot record for tests that need one without a store. */
export function makeBot(over: Partial<DeyinBot> = {}): DeyinBot {
  const avatar = defaultBotAvatar("bot_1");
  return {
    id: "bot_1",
    name: "Ada",
    handle: "ada",
    description: "",
    title: "",
    avatarShape: avatar.shape,
    avatarColor: avatar.color,
    avatarVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    harness: "server",
    hostId: "host_1",
    role: "",
    visibility: "owner",
    kind: "agent",
    memberBotIds: [],
    autoReview: { approvalMode: "read_only" },
    isPrimary: false,
    archived: false,
    ...over,
  };
}
