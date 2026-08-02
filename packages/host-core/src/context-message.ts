import type { ContextRef, ResolvedContextFile } from "./types.js";

/** Build the user message with structured context blocks. */
export function formatUserMessageWithContext(
  text: string,
  files: ResolvedContextFile[],
  linkedContext?: string,
): string {
  const parts: string[] = [];
  if (linkedContext?.trim()) {
    parts.push(`<linked_conversations>\n${linkedContext.trim()}\n</linked_conversations>`);
  }
  if (files.length > 0) {
    const blocks = files.map((f) => `## ${f.path}\n${f.content}`);
    parts.push(`<context>\n${blocks.join("\n\n")}\n</context>`);
  }
  parts.push(text);
  return parts.join("\n\n");
}

/** Collect unique @ refs from composer chips (not inline text). */
export function dedupeContextRefs(refs: ContextRef[]): ContextRef[] {
  const seen = new Set<string>();
  const out: ContextRef[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}
