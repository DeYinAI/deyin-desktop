import { cleanBotLine, cleanBotText, type DeyinBot } from "./types.js";

/** Tag that wraps the persona inside the system prompt. */
export const BOT_PERSONA_TAG = "bot_identity";

/** A field is the Bot's own text (possibly imported from a template), so it must not be able to end the block early. */
const PERSONA_TAG_PATTERN = new RegExp(`</?${BOT_PERSONA_TAG}[^>]*>`, "gi");

function inert(text: string): string {
  return text.replace(PERSONA_TAG_PATTERN, "").trim();
}

function line(value: unknown): string {
  return inert(cleanBotLine(value));
}

function block(value: unknown): string {
  return inert(cleanBotText(value));
}

/**
 * The standing instructions a Bot adds to its system prompt: who it is, what it is for, and where it keeps
 * things. Pure, so the same text can be previewed in the UI and sent to the model.
 *
 * `memoryTools: false` is for a Bot run somewhere that has no memory tools (a server): it is told it cannot save facts.
 *
 * Only fields the Bot actually has are mentioned. Rooms are not personas: a room has no single voice, so
 * callers must not pass one (it is refused rather than given an invented identity).
 */
export function buildBotPersona(bot: DeyinBot, options: { memoryTools?: boolean } = {}): string {
  const name = line(bot.name) || "this Bot";
  const handle = line(bot.handle);
  const title = line(bot.title);
  const role = line(bot.role);
  const description = block(bot.description);
  const purpose = block(bot.purpose);

  const lines: string[] = [
    `You are ${name}${handle ? ` (@${handle})` : ""}, a Deyin Bot${title ? `: ${title}` : ""}. ` +
      "Keep this identity for the whole conversation, and sign off work as yourself.",
  ];
  if (role) lines.push(`Your role: ${role}.`);
  if (description) lines.push(`About you:\n${description}`);
  if (purpose) lines.push(`What you are for:\n${purpose}`);
  lines.push("Your working directory belongs to you: files you create there are still there in later conversations.");
  lines.push(
    options.memoryTools === false
      ? "You cannot save new memories in this conversation. What you already remember is listed below; keep anything worth remembering in a file in your working directory."
      : "Your memory is yours. When you save a fact, scope `project` keeps it private to you; " +
          "scope `global` shares it with all of the user's other Bots, so use it only for facts about the user.",
  );
  return `<${BOT_PERSONA_TAG}>\n${lines.join("\n")}\n</${BOT_PERSONA_TAG}>`;
}
