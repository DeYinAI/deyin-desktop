import { BOT_PERSONA_TAG, BotError, RUNTIME_LIMITS, SKILLS_TAG, skillsPromptSection, type BotSkillInput, type MemoryFact } from "@deyin/host-core";

/** What a Bot's memory may take of the prompt, and of it per fact. A server has no memory tools, so it is read from here. */
export const SERVER_MEMORY_LIMIT = 8_000;
export const SERVER_FACT_LIMIT = 1_000;

export const MEMORY_TAG = "bot_memory";
export const CONVERSATION_TAG = "conversation_so_far";
const OMITTED = "(Earlier messages are left out.)";

export interface ServerTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ServerPromptInput {
  /** `buildBotPersona(bot, { memoryTools: false })`. */
  persona: string;
  /** The Bot's active facts, its own and the shared ones. */
  memory: readonly Pick<MemoryFact, "title" | "description" | "body">[];
  /** What the Bot has learned to do. A server cannot read this app's files, so they are written into the prompt. */
  skills?: readonly BotSkillInput[];
  /** Turns before this one, oldest first. */
  history: readonly ServerTurn[];
  /** What the person just said, or what a routine is to do. */
  task: string;
  /** The line that introduces the task. Chat by default; a routine says nobody is chatting. */
  lead?: string;
}

export const CHAT_LEAD = "The person now says:";

const OWN_TAGS = new RegExp(`</?\\s*(?:${MEMORY_TAG}|${CONVERSATION_TAG}|${BOT_PERSONA_TAG}|${SKILLS_TAG})\\b[^>]*>`, "gi");

/** Text a person, a model or a file wrote must not be able to close the sections this prompt is built from. */
export function inert(text: string): string {
  return text.replace(OWN_TAGS, "").replace(/\u0000/g, "");
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function oneLine(text: string): string {
  return inert(text).replace(/\s+/g, " ").trim();
}

/** The facts a Bot remembers, as a section of the prompt, in the order given until the limit is reached. Empty when it remembers nothing. */
export function renderMemory(facts: readonly Pick<MemoryFact, "title" | "description" | "body">[], limit = SERVER_MEMORY_LIMIT): string {
  const entries: string[] = [];
  let used = 0;
  for (const fact of facts) {
    const head = `- ${clip(oneLine(fact.title), 120)}${fact.description.trim() ? `: ${clip(oneLine(fact.description), 240)}` : ""}`;
    const body = clip(inert(fact.body).trim(), SERVER_FACT_LIMIT);
    const entry = body ? `${head}\n${body.replace(/^/gm, "  ")}` : head;
    if (used + entry.length + 1 > limit) break;
    entries.push(entry);
    used += entry.length + 1;
  }
  if (entries.length === 0) return "";
  const omitted = facts.length - entries.length;
  const note = omitted > 0 ? `\n(${omitted} more ${omitted === 1 ? "fact is" : "facts are"} left out to keep this short.)` : "";
  return `<${MEMORY_TAG}>\nThings you remember (the person told you, or you learned them earlier):\n${entries.join("\n")}${note}\n</${MEMORY_TAG}>`;
}

function renderTurn(turn: ServerTurn): string {
  return `${turn.role === "user" ? "User" : "You"}: ${inert(turn.content).trim()}`;
}

/**
 * The one prompt a server run gets. The engine runs the agent from a prompt on stdin, so what a local run is
 * given piece by piece (persona, memory, earlier turns) is written out here, most important last: the task.
 *
 * Earlier turns are kept newest first until the prompt reaches the engine's limit, then the rest are left out.
 * A task too long to fit at all is refused rather than cut: a clipped instruction is a different instruction.
 */
export function buildServerPrompt(input: ServerPromptInput): string {
  // The persona is built by `buildBotPersona`, which has already made what the person typed inert, so it keeps its own tags.
  const persona = input.persona.trim();
  const memory = renderMemory(input.memory);
  // A skill is text a person, a Bot or an imported template wrote, so it cannot close the sections around it either.
  const skills = skillsPromptSection((input.skills ?? []).map((skill) => ({ name: skill.name, description: inert(skill.description), body: inert(skill.body) })));
  const task = inert(input.task).trim();
  if (!task) throw new BotError("invalid", "There is nothing to send.");
  const lead = inert(input.lead ?? CHAT_LEAD).replace(/\s+/g, " ").trim() || CHAT_LEAD;
  const taskBlock = `${lead}\n${task}`;
  const fixed = [persona, memory, skills, taskBlock].filter(Boolean).join("\n\n");
  const frame = `<${CONVERSATION_TAG}>\n${OMITTED}\n\n</${CONVERSATION_TAG}>\n\n`.length;
  const budget = RUNTIME_LIMITS.promptLength - fixed.length - frame;
  if (budget < 0) throw new BotError("invalid", "That message is too long to send to a Bot on a server. Shorten it, or move the long part into a file.");
  const turns = input.history.filter((turn) => inert(turn.content).trim() !== "");
  const kept: string[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const text = renderTurn(turns[index]!);
    if (used + text.length + 2 > budget) break;
    kept.unshift(text);
    used += text.length + 2;
  }
  const leftOut = kept.length < turns.length ? `${OMITTED}\n\n` : "";
  const conversation = kept.length > 0 ? `<${CONVERSATION_TAG}>\n${leftOut}${kept.join("\n\n")}\n</${CONVERSATION_TAG}>` : "";
  return [persona, memory, skills, conversation, taskBlock].filter(Boolean).join("\n\n");
}
