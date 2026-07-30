import type { ToolDefinition } from "../types.js";
import { asString } from "./util.js";

export const sendMessageTool: ToolDefinition = {
  name: "send_message",
  description: "Send a message to another agent or teammate channel. Use for inter-agent coordination.",
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient agent or channel name." },
      content: { type: "string", description: "Message body." },
    },
    required: ["to", "content"],
  },
  summarize: (args) => `message to ${String(args.to ?? "")}`,
  async execute(args, ctx): Promise<string> {
    const to = asString(args.to, "to");
    const content = asString(args.content, "content");
    if (!ctx.sendMessage) {
      return `SendMessage is not available. Message to ${to} was not delivered:\n${content}`;
    }
    return ctx.sendMessage(to, content);
  },
};
