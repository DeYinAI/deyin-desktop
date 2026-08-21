import { formatAskQuestionResponse } from "../interaction.js";
import type { AskQuestionItem, ToolDefinition } from "../types.js";

function normalizeQuestions(raw: unknown): AskQuestionItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q): q is Record<string, unknown> => typeof q === "object" && q !== null)
    .map((q, i) => {
      const options = Array.isArray(q.options)
        ? q.options
            .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
            .map((o, j) => ({
              id: typeof o.id === "string" && o.id ? o.id : `opt-${j + 1}`,
              label: typeof o.label === "string" ? o.label : "",
              description: typeof o.description === "string" && o.description ? o.description : undefined,
              recommended: o.recommended === true ? true : undefined,
            }))
            .filter((o) => o.label.length > 0)
        : [];
      return {
        id: typeof q.id === "string" && q.id ? q.id : `q-${i + 1}`,
        prompt: typeof q.prompt === "string" ? q.prompt : "",
        options,
        allow_multiple: q.allow_multiple === true,
      };
    })
    .filter((q) => q.prompt.length > 0 && q.options.length >= 2);
}

export const askQuestionTool: ToolDefinition = {
  name: "ask_question",
  description:
    "REQUIRED for presenting questions to the user. Creates an inline picker above the composer with clickable options and a free-text 'Other' field. You MUST use this tool for ANY question that needs a user decision — writing questions as plain text in chat is not supported and will not be shown to the user. The turn pauses until the user answers. Each question needs a prompt and at least 2 options (max 2 questions per call). Give every option a short label plus a one-sentence description, and mark the option you recommend.",
  tier: "interaction",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Optional dialog title." },
      questions: {
        type: "array",
        description: "One or more questions (max 2 per call).",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            prompt: { type: "string", description: "The question text." },
            allow_multiple: { type: "boolean", description: "Allow multiple selections." },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  label: { type: "string", description: "Short option name (2-6 words)." },
                  description: {
                    type: "string",
                    description: "One sentence on what choosing this option means or costs.",
                  },
                  recommended: {
                    type: "boolean",
                    description: "Set on the single option you recommend; it is badged in the UI.",
                  },
                },
                required: ["id", "label"],
              },
            },
          },
          required: ["prompt", "options"],
        },
      },
    },
    required: ["questions"],
  },
  summarize: (args) => {
    const questions = normalizeQuestions(args.questions);
    return questions.length === 1 ? questions[0]!.prompt : `${questions.length} questions`;
  },
  async execute(args, ctx): Promise<string> {
    const questions = normalizeQuestions(args.questions);
    if (questions.length === 0) {
      return "ERROR: ask_question requires at least one question with 2+ options.";
    }
    if (questions.length > 2) {
      return "ERROR: ask_question supports at most 2 questions per call.";
    }
    if (!ctx.resolveInteraction) {
      return "AskQuestion is not available in this environment.";
    }
    const title = typeof args.title === "string" ? args.title : undefined;
    const raw = await ctx.resolveInteraction({ type: "ask-question", questions, title });
    return formatAskQuestionResponse(raw);
  },
};
