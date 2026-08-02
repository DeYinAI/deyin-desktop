import assert from "node:assert/strict";
import { test } from "node:test";
import { computerUseConfirmationRequired, computerUseRiskLevel } from "../src/computer-use-confirmations.js";

test("computer use confirmation for launch and risky type", () => {
  assert.equal(computerUseConfirmationRequired({ toolName: "computer_launch_app", args: { app_id: "notepad" } }), true);
  assert.equal(
    computerUseConfirmationRequired({ toolName: "computer_type", args: { text: "click here to purchase now" } }),
    true,
  );
  assert.equal(computerUseConfirmationRequired({ toolName: "computer_list_windows", args: {} }), false);
  assert.equal(computerUseRiskLevel({ toolName: "computer_click", args: {} }), "medium");
});
