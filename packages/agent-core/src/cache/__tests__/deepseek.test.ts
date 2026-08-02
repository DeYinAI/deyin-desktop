import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getDeepSeekBetaEndpoint,
  isDeepSeekEndpoint,
  shouldContinueResponse,
} from "../deepseek.js";

test("isDeepSeekEndpoint detects api.deepseek.com", () => {
  assert.equal(isDeepSeekEndpoint("https://api.deepseek.com/v1"), true);
  assert.equal(isDeepSeekEndpoint("https://api.deepseek.com"), true);
  assert.equal(isDeepSeekEndpoint("https://openrouter.ai/api/v1"), false);
});

test("getDeepSeekBetaEndpoint returns beta chat completions URL", () => {
  assert.equal(
    getDeepSeekBetaEndpoint("https://api.deepseek.com/chat/completions"),
    "https://api.deepseek.com/beta/chat/completions",
  );
  assert.equal(getDeepSeekBetaEndpoint("https://openrouter.ai/api/v1/chat/completions"), null);
});

test("shouldContinueResponse is true only for finish_reason length", () => {
  assert.equal(shouldContinueResponse("length"), true);
  assert.equal(shouldContinueResponse("stop"), false);
  assert.equal(shouldContinueResponse(undefined), false);
});
