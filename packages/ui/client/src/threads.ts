/** Renderer-side session model: projects hold threads, threads hold a timeline of
 * structured events (plain chat plus agent activity cards). The types live in
 * @deyin/host-core so the ProjectsStore and both transports share them. */
export type { Project, Thread, ThreadEvent, ProjectsState } from "@deyin/host-core/shared";

import type { Project, Thread, ThreadEvent } from "@deyin/host-core/shared";

let counter = 0;
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export const DEFAULT_THREAD_TITLE = "New task";

/** Provisional title from the first user message (truncated at a word boundary). */
export function deriveTitle(text: string, maxLen = 48): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return DEFAULT_THREAD_TITLE;
  if (collapsed.length <= maxLen) return collapsed;
  const slice = collapsed.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > maxLen * 0.5 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trim()}…`;
}

export function emptyThread(title = DEFAULT_THREAD_TITLE): Thread {
  return { id: newId("thread"), title, updatedAt: Date.now(), events: [] };
}

/** Short relative label for the sidebar: "now", "12m", "2h", "4d", "3w", "1y". */
export function formatThreadAge(updatedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 52) return `${weeks}w`;
  return `${Math.floor(days / 365)}y`;
}

/** Threads written before `updatedAt` existed carry a frozen `age` label instead,
 * so recover their time from the timestamp baked into the generated id. */
type StoredThread = Omit<Thread, "updatedAt"> & { updatedAt?: number; age?: string };

const THREAD_ID_TIME = /^thread-([0-9a-z]+)-\d+$/;
const EARLIEST_PLAUSIBLE_TIME = Date.UTC(2024, 0, 1);

function threadTime(thread: StoredThread): number {
  if (typeof thread.updatedAt === "number" && Number.isFinite(thread.updatedAt)) return thread.updatedAt;
  const encoded = THREAD_ID_TIME.exec(thread.id)?.[1];
  const created = encoded ? Number.parseInt(encoded, 36) : Number.NaN;
  return created >= EARLIEST_PLAUSIBLE_TIME && created <= Date.now() ? created : Date.now();
}

/** Normalize the persisted project tree read back from the host on startup. */
export function hydrateProjects(projects: Project[]): Project[] {
  return projects.map((project) => ({
    ...project,
    threads: project.threads.map((stored) => {
      const { age: _age, ...thread } = stored as StoredThread;
      return { ...thread, updatedAt: threadTime(stored) };
    }),
  }));
}

/** First markdown heading, else a stable plan.md label for the chat artifact card. */
export function planTitleFromMarkdown(markdown: string): string {
  const heading = markdown.match(/^#{1,3}\s+(.+)$/m);
  const title = heading?.[1]?.replace(/\s+/g, " ").trim();
  return title || "plan.md";
}

/** Opening slice of a plan, used for the preview body of the chat plan card.
 *  Frontmatter and the title heading are dropped (the card shows the title
 *  separately) and the text is cut on a line boundary so markdown stays valid. */
export function planPreviewFromMarkdown(markdown: string, maxChars = 700): string {
  let body = markdown.trim();
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end >= 0) body = body.slice(end + 4).trimStart();
  }
  body = body.replace(/^#{1,3}\s+.+\n+/, "");
  if (body.length <= maxChars) return body.trim();
  const cut = body.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf("\n");
  return (lastBreak > maxChars * 0.4 ? cut.slice(0, lastBreak) : cut).trim();
}

/** True when assistant text looks like a structured plan (not casual chat). */
export function looksLikePlan(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 40) return false;

  if (trimmed.startsWith("---\n") && trimmed.includes("name:")) return true;

  const hasHeading = /^#{1,3}\s+.+$/m.test(trimmed);
  const numberedSteps = (trimmed.match(/^\d+\.\s+/gm) ?? []).length;
  const bullets = (trimmed.match(/^[-*]\s+/gm) ?? []).length;

  if (hasHeading && numberedSteps >= 2) return true;
  if (hasHeading && bullets >= 3) return true;
  if (numberedSteps >= 3) return true;

  return false;
}

/** Prefer the longer plan draft so a short follow-up cannot wipe a full document. */
export function isBetterPlanDoc(candidate: string, current: string): boolean {
  const next = candidate.trim();
  const prev = current.trim();
  if (!next) return false;
  if (!prev) return true;
  return next.length >= prev.length;
}

/** Stable file-card name for a plan artifact. */
export function planFileNameFromTitle(title: string): string {
  const slug = title
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug ? `${slug}.md` : "plan.md";
}

/** Reduce a thread's timeline to plain chat messages for the completion API. */
export function toChatMessages(events: ThreadEvent[]): { role: "user" | "assistant"; content: string }[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const e of events) {
    if (e.kind === "user") out.push({ role: "user", content: e.text });
    else if (e.kind === "assistant") out.push({ role: "assistant", content: e.text });
  }
  return out;
}
