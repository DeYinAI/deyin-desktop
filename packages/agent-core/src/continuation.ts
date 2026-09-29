/**
 * Turn-end diagnosis: telling "the model is done" apart from "the model stopped
 * mid-thought".
 *
 * The agent loop ends a run the moment a response carries no tool calls — that
 * is the standard contract (Codex, Claude Code and Cursor all use it) and it is
 * right whenever the model deliberately answers. It is wrong when the turn was
 * cut short by the model itself: it says "Let me check the file:" and then emits
 * a stop token, or returns nothing at all. Nothing in the protocol distinguishes
 * that from a real final answer, so the loop has to look at the text.
 *
 * Everything here is pure (no I/O, no state) so the heuristics can be tested and
 * calibrated against recorded sessions without running a model.
 */

/** Longest tail of the model's message quoted back in a nudge. */
const QUOTE_CHARS = 160;

/**
 * Consecutive continuation nudges allowed without the model making a tool call
 * in between. A model that keeps stalling after two reminders is not going to
 * be argued into working, so the turn is allowed to end.
 */
export const STALL_NUDGE_STREAK_LIMIT = 2;
/** Consecutive `finish_reason: length` resumes before giving up on a response. */
export const LENGTH_RECOVERY_LIMIT = 3;
/** Replays of a step whose stream said "tool_calls" but delivered none. */
export const LOST_TOOL_CALL_RETRY_LIMIT = 2;

/** What is wrong with a turn that ended without any tool call. */
export type UnfinishedTurn =
  | { kind: "empty" }
  | { kind: "announced"; tail: string };

/**
 * Verbs that make "I'll <verb> …" a promise of imminent tool work rather than
 * a sign-off. Deliberately an allowlist: "let me know", "I'll be", "I'll leave
 * it there" must never match.
 */
const ACTION_VERBS = [
  "check",
  "look",
  "read",
  "open",
  "view",
  "search",
  "find",
  "grep",
  "run",
  "execute",
  "try",
  "fix",
  "update",
  "edit",
  "modify",
  "write",
  "create",
  "add",
  "implement",
  "apply",
  "make",
  "change",
  "install",
  "build",
  "test",
  "verify",
  "inspect",
  "examine",
  "explore",
  "investigate",
  "review",
  "start",
  "begin",
  "continue",
  "proceed",
  "use",
  "call",
  "fetch",
  "analy[sz]e",
  "list",
  "scan",
  "clone",
  "commit",
  "push",
  "configure",
  "set up",
  "refactor",
  "rewrite",
  "replace",
  "remove",
  "delete",
  "move",
  "rename",
  "restart",
  "reload",
  "launch",
  "deploy",
  "debug",
  "patch",
  "revert",
  "compare",
  "gather",
  "collect",
  "dig",
  "double-check",
  "re-?run",
  "retry",
  "navigate",
  "browse",
  "download",
  "generate",
  "compile",
  "lint",
  "format",
  "validate",
  "locate",
  "trace",
  "finish",
  "complete",
  "go through",
  "work on",
  "look into",
  "figure out",
  "clean up",
  "fill in",
  "do (?:a|an|the|another|one|some|that|this|it)",
  "take (?:a|another) (?:quick |closer |second |fresh )?look",
  "replicate",
  "reproduce",
  "simulate",
  "mimic",
  "confirm",
  "walk through",
  "step through",
  "spin up",
  "pull up",
  "see (?:if|what|how|whether|why|where)",
];

const LEAD_IN = String.raw`(?:(?:ok(?:ay)?|alright|great|good|perfect|right|so|now|next|first|then|finally|also|and|but)[,.:!]?\s+)*`;
const PROMISE = String.raw`(?:let me|let['’]s|i['’]ll|i will|i['’]m going to|i am going to|i['’]m gonna|i need to|i should|i must)`;
const ADVERB = String.raw`(?:(?:now|first|also|just|quickly|then|next|again|go ahead and|start by|begin by|proceed to|try to)\s+)*`;

/** "Let me check…", "Now I'll run the tests." — English announcements of imminent work. */
const ANNOUNCE_EN = new RegExp(`^${LEAD_IN}${PROMISE}\\s+${ADVERB}(?:${ACTION_VERBS.join("|")})\\b`, "i");
/**
 * Progress narration in the gerund ("Searching for that error message.",
 * "Looking at the config."). Narrow on purpose: a bare "Testing passed." or
 * "Checking is done." is a report, not a promise, so each opener needs the
 * preposition or article that makes it an action in progress.
 */
const ANNOUNCE_GERUND =
  /^(?:searching (?:for|through|the)|looking (?:at|into|for|through)|reading (?:the|through)|checking (?:the|if|whether|how)|scanning (?:the|for)|inspecting (?:the|how)|examining (?:the|how)|exploring (?:the|how)|investigating (?:the|how|why)|fetching (?:the|it))\b/i;
/** The same, in Chinese ("让我检查一下", "接下来我来运行测试"). */
const ANNOUNCE_ZH = /^(?:好的?[，,]?\s*)?(?:让我|我来|我先|我将|我会|我需要|接下来[，,]?\s*(?:我|让我)|现在[，,]?\s*(?:我|让我)|下面(?:我|让我))/;

/**
 * Phrases meaning the model is deliberately handing control back to the user.
 * A message containing one is a question or a checkpoint, not a stall — pushing
 * the model to "continue" would make it act without the confirmation it asked for.
 */
const WAIT_CUE =
  /\b(?:let me know|would you like|do you want|should i|shall i|if you(?:['’]d| would)? (?:like|want|prefer|need)|want me to|which (?:one|option|approach|of)|please (?:confirm|choose|tell|provide|let|advise|review)|your (?:call|choice|decision|preference|input|approval|confirmation)|before (?:i|we) (?:proceed|continue|go|start|begin)|waiting (?:for|on)|once you|when you(?:['’]re| are) ready|any (?:preference|thoughts))\b|是否|需要我|要我|请确认|请选择|你希望|您希望/i;

/** Sentence-ish split on terminal punctuation; keeps the terminator with its sentence. */
function lastSentence(paragraph: string): string {
  const parts = paragraph.match(/[^.!?。！？\n]+[.!?。！？]*/g);
  const last = parts
    ?.map((p) => p.trim())
    .filter((p) => p.length > 0)
    .at(-1);
  return last ?? paragraph.trim();
}

/**
 * Diagnose a turn that ended without a tool call.
 *
 * Returns `null` when the message reads like a genuine final answer (or an
 * intentional question to the user), otherwise what went wrong. Conservative by
 * design: a false positive costs one extra request, but a false positive on a
 * *question* would make the agent barrel past a confirmation the user was owed.
 */
export function diagnoseTurnEnd(content: string): UnfinishedTurn | null {
  const text = content.trim();
  if (text.length === 0) return { kind: "empty" };

  // A closed code block is the end of an answer, not of a sentence.
  if (text.endsWith("```")) return null;

  // Strip trailing markdown decoration and closing punctuation so "Let me look:**"
  // and "…the config file:`" still read as ending in a colon.
  const stripped = text.replace(/[\s*_`"'”’)\]]+$/u, "");
  const lastParagraph = text.split(/\n\s*\n/).at(-1)?.trim() ?? text;
  const sentence = lastSentence(lastParagraph);

  // The model is asking the user something, or waiting on them. Only the final
  // sentence counts: a question asked earlier and then followed by "Let me read
  // the file:" was not waited on — the model carried on and then stopped.
  if (/[?？]/.test(sentence) || WAIT_CUE.test(sentence)) return null;

  const tail = text.slice(-QUOTE_CHARS).replace(/\s+/g, " ").trim();

  // The strongest signal by far: a colon or ellipsis promises that something
  // follows, and nothing did.
  if (/[:：]$/u.test(stripped) || /(?:\.{3}|…)$/u.test(stripped)) {
    return { kind: "announced", tail };
  }

  // "Now let me fix the bug." — a full sentence, but an announcement all the same.
  if (ANNOUNCE_EN.test(sentence) || ANNOUNCE_ZH.test(sentence) || ANNOUNCE_GERUND.test(sentence)) {
    return { kind: "announced", tail };
  }
  return null;
}

/** Host nudge for a turn that ended without a tool call and without finishing. */
export function unfinishedTurnNudge(turn: UnfinishedTurn): string {
  switch (turn.kind) {
    case "empty":
      return "[continue] Your last response was empty: no text and no tool call, so the turn ended with nothing done. Continue the task with a tool call — or, if it is genuinely finished, reply with a short final summary.";
    case "announced":
      return `[continue] Your last message ended by announcing an action (“…${turn.tail}”) without making a tool call, so the turn ended before the action happened. Do it now: call the tool. If the task is actually complete, reply with a final summary that does not end by promising more work.`;
    default: {
      const unreachable: never = turn;
      return unreachable;
    }
  }
}

/** `evidence-gate` event code for a nudge, so a UI can word each case on its own. */
export function unfinishedTurnCode(turn: UnfinishedTurn): "empty_response" | "unfinished_turn" {
  switch (turn.kind) {
    case "empty":
      return "empty_response";
    case "announced":
      return "unfinished_turn";
    default: {
      const unreachable: never = turn;
      return unreachable;
    }
  }
}

/** One-line description of a nudge for the timeline (the model never sees this). */
export function unfinishedTurnNotice(turn: UnfinishedTurn): string {
  switch (turn.kind) {
    case "empty":
      return "The model returned an empty response; asked it to continue.";
    case "announced":
      return "The model stopped after announcing an action without doing it; asked it to continue.";
    default: {
      const unreachable: never = turn;
      return unreachable;
    }
  }
}

/** Host nudge after a text response was cut off by the output-token limit. */
export const LENGTH_RECOVERY_NUDGE =
  "[output limit] Your previous response was cut off because it hit the output token limit. Continue exactly where it stopped: no apology, no recap, do not restart. If you were about to write a large file, split it into several smaller writes.";

/** Tool result for a call whose arguments were truncated by the output-token limit. */
export const TRUNCATED_TOOL_CALL_RESULT =
  "ERROR: your response hit the output token limit while writing this tool call, so its arguments were cut off and nothing was executed. Do not resend the same large payload: split it into several smaller calls (for a big file, write a first part, then append or edit in further calls).";
