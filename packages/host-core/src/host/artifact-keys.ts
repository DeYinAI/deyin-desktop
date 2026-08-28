/** Sanitize a path segment for artifact object keys (R2 / S3). */
export function safeArtifactSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`Invalid ${label}.`);
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export type ArtifactKind = "images" | "pages";

/**
 * Build a user-scoped object key. The OAuth `sub` is the tenancy boundary — never
 * accept it from client messages; bind it at session auth time on the server.
 *
 * Layout: users/{sub}/{kind}/{threadId}/{fileName}
 */
export function buildArtifactObjectKey(params: {
  userSub: string;
  kind: ArtifactKind;
  threadId: string;
  fileName: string;
}): string {
  const sub = safeArtifactSegment(params.userSub, "user id");
  const threadId = safeArtifactSegment(params.threadId, "thread id");
  const fileName = safeArtifactSegment(params.fileName, "file name");
  return `users/${sub}/${params.kind}/${threadId}/${fileName}`;
}

/** True when a user subject is safe to use as an artifact tenancy prefix. */
export function isValidArtifactUserSub(sub: string | undefined): sub is string {
  if (!sub) return false;
  const trimmed = sub.trim();
  if (!trimmed || trimmed === "unknown") return false;
  try {
    safeArtifactSegment(trimmed, "user id");
    return true;
  } catch {
    return false;
  }
}
