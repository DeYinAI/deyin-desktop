import assert from "node:assert/strict";
import test from "node:test";
import type { SecurityFinding } from "@deyin/contract";
import {
  formatFindingFixPrompt,
  formatAllFindingsFixPrompt,
} from "../src/securityFixPrompt.js";

const sampleFinding1: SecurityFinding = {
  id: "f1",
  ruleId: "hardcoded-secret",
  severity: "high",
  message: "Potential hardcoded secret",
  source: "regex",
  location: {
    file: "C:\\Users\\Anh\\OneDrive\\Desktop\\deyin-audit-sandbox\\vuln.py",
    line: 3,
  },
};

const sampleFinding2: SecurityFinding = {
  id: "f2",
  ruleId: "eval-usage",
  severity: "medium",
  message: "Potential eval usage",
  source: "regex",
  location: {
    file: "C:\\Users\\Anh\\OneDrive\\Desktop\\deyin-audit-sandbox\\vuln.py",
    line: 6,
  },
};

const sampleFindingDiff: SecurityFinding = {
  id: "f3",
  ruleId: "sql-concat",
  severity: "high",
  message: "Potential SQL concatenation in query",
  source: "regex",
  location: {
    file: "<diff>",
    line: 10,
  },
};

const sampleFindingNoLoc: SecurityFinding = {
  id: "f4",
  ruleId: "npm-audit:semver",
  severity: "low",
  message: "Regular Expression Denial of Service",
  source: "npm-audit",
};

test("formatFindingFixPrompt formats single finding with file and line", () => {
  const prompt = formatFindingFixPrompt(sampleFinding1);
  assert.match(prompt, /Fix security finding: hardcoded-secret \(HIGH\)/);
  assert.match(prompt, /Rule: hardcoded-secret/);
  assert.match(prompt, /Severity: high/);
  assert.match(prompt, /Source: regex/);
  assert.match(prompt, /Location: C:\\Users\\Anh\\OneDrive\\Desktop\\deyin-audit-sandbox\\vuln\.py:3/);
  assert.match(prompt, /Description: Potential hardcoded secret/);
  assert.match(prompt, /Please analyze this issue and apply the necessary fix/);
});

test("formatFindingFixPrompt handles <diff> and missing locations gracefully", () => {
  const promptDiff = formatFindingFixPrompt(sampleFindingDiff);
  assert.ok(!promptDiff.includes("Location: <diff>"));
  assert.match(promptDiff, /Rule: sql-concat/);

  const promptNoLoc = formatFindingFixPrompt(sampleFindingNoLoc);
  assert.ok(!promptNoLoc.includes("Location:"));
  assert.match(promptNoLoc, /Rule: npm-audit:semver/);
});

test("formatAllFindingsFixPrompt formats multiple findings correctly", () => {
  const prompt = formatAllFindingsFixPrompt([sampleFinding1, sampleFinding2]);
  assert.match(prompt, /Fix all 2 security findings:/);
  assert.match(prompt, /1\. \[HIGH\] hardcoded-secret in C:\\Users\\Anh\\OneDrive\\Desktop\\deyin-audit-sandbox\\vuln\.py:3: Potential hardcoded secret/);
  assert.match(prompt, /2\. \[MEDIUM\] eval-usage in C:\\Users\\Anh\\OneDrive\\Desktop\\deyin-audit-sandbox\\vuln\.py:6: Potential eval usage/);
  assert.match(prompt, /Please inspect each of these security findings and apply the appropriate fixes/);
});

test("formatAllFindingsFixPrompt delegates to formatFindingFixPrompt when only 1 finding is provided", () => {
  const prompt = formatAllFindingsFixPrompt([sampleFinding1]);
  assert.equal(prompt, formatFindingFixPrompt(sampleFinding1));
});

test("formatAllFindingsFixPrompt handles empty list", () => {
  const prompt = formatAllFindingsFixPrompt([]);
  assert.match(prompt, /Fix all 0 security findings:/);
});
