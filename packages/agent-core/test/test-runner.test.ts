import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTestOutput } from "../src/tools/test-runner.js";

test("formatTestOutput formats passing test run cleanly", () => {
  const output = `
 PASS  test/calculator.test.ts
  ✓ adds two numbers (2 ms)
  ✓ subtracts two numbers (1 ms)

Test Suites: 1 passed, 1 total
Tests:       2 passed, 2 total
Snapshots:   0 total
Time:        0.45 s
`;

  const formatted = formatTestOutput(output, 0, "pnpm test");
  assert.ok(formatted.includes("Test Suite PASSED"));
  assert.ok(formatted.includes("Command: pnpm test"));
  assert.ok(formatted.includes("Tests:       2 passed, 2 total"));
});

test("formatTestOutput isolates failure sections on failing test run", () => {
  const output = `
 PASS  test/passing.test.ts
 FAIL  test/failing.test.ts
  ✕ calculation fails (5 ms)

  ● calculation fails

    AssertionError: expected 4 to equal 5
      at Object.<anonymous> (test/failing.test.ts:12:14)

Tests: 1 failed, 1 passed, 2 total
`;

  const formatted = formatTestOutput(output, 1, "pnpm test");
  assert.ok(formatted.includes("Test Suite FAILED"));
  assert.ok(formatted.includes("FAIL  test/failing.test.ts"));
  assert.ok(formatted.includes("AssertionError: expected 4 to equal 5"));
  assert.ok(formatted.includes("Tests: 1 failed, 1 passed, 2 total"));
});
