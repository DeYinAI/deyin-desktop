import assert from "node:assert/strict";
import { test } from "node:test";
import { buildArtifactObjectKey, isValidArtifactUserSub, safeArtifactSegment } from "../src/host/artifact-keys.js";

test("buildArtifactObjectKey scopes objects under the OAuth sub", () => {
  const key = buildArtifactObjectKey({
    userSub: "oauth|12345",
    kind: "pages",
    threadId: "thread-abc",
    fileName: "landing.html",
  });
  assert.equal(key, "users/oauth_12345/pages/thread-abc/landing.html");
});

test("buildArtifactObjectKey rejects traversal in segments", () => {
  assert.throws(() =>
    buildArtifactObjectKey({
      userSub: "user-a",
      kind: "images",
      threadId: "../other-thread",
      fileName: "pic.png",
    }),
  );
});

test("isValidArtifactUserSub rejects missing and placeholder subs", () => {
  assert.equal(isValidArtifactUserSub("user-42"), true);
  assert.equal(isValidArtifactUserSub(undefined), false);
  assert.equal(isValidArtifactUserSub("unknown"), false);
  assert.equal(isValidArtifactUserSub("  "), false);
});

test("safeArtifactSegment normalizes unsafe characters", () => {
  assert.equal(safeArtifactSegment("oauth|abc", "user id"), "oauth_abc");
});
