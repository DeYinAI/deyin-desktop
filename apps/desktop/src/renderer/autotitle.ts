import { streamChat } from "./api/openference.js";
import { deriveTitle } from "./threads.js";

const TITLE_SYSTEM =
  "You generate short chat session titles. Reply with only a 3-6 word title summarizing the user's message. No quotes, punctuation, or explanation.";

export interface GenerateThreadTitleOptions {
  apiBaseUrl: string;
  token: string;
  model: string;
  text: string;
}

function sanitizeTitle(raw: string): string | null {
  let title = raw
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:;!?]+$/g, "")
    .trim();
  if (!title) return null;
  if (title.length > 60) title = deriveTitle(title, 60);
  return title;
}

/** LLM-generated short title; returns null on failure or unusable output. */
export async function generateThreadTitle(opts: GenerateThreadTitleOptions): Promise<string | null> {
  const userSnippet = opts.text.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!userSnippet) return null;

  let acc = "";
  try {
    for await (const delta of streamChat({
      apiBaseUrl: opts.apiBaseUrl,
      token: opts.token,
      model: opts.model,
      messages: [
        { role: "system", content: TITLE_SYSTEM },
        { role: "user", content: userSnippet },
      ],
    })) {
      acc += delta;
    }
  } catch {
    return null;
  }

  return sanitizeTitle(acc);
}
