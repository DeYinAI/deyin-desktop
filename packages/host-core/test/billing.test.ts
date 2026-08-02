import assert from "node:assert/strict";
import { test } from "node:test";
import { isCheckoutCanceledUrl, isCheckoutSuccessUrl } from "../src/billing.js";

const issuer = "https://auth.openference.dev";

test("isCheckoutSuccessUrl matches pricing success on issuer origin", () => {
  assert.equal(isCheckoutSuccessUrl(issuer, `${issuer}/pricing/success`), true);
  assert.equal(isCheckoutSuccessUrl(`${issuer}/`, `${issuer}/pricing/success?session_id=abc`), true);
});

test("isCheckoutSuccessUrl rejects other paths and origins", () => {
  assert.equal(isCheckoutSuccessUrl(issuer, `${issuer}/pricing/canceled`), false);
  assert.equal(isCheckoutSuccessUrl(issuer, `${issuer}/dashboard`), false);
  assert.equal(isCheckoutSuccessUrl(issuer, "https://evil.example/pricing/success"), false);
  assert.equal(isCheckoutSuccessUrl(issuer, "not-a-url"), false);
});

test("isCheckoutCanceledUrl matches pricing canceled on issuer origin", () => {
  assert.equal(isCheckoutCanceledUrl(issuer, `${issuer}/pricing/canceled`), true);
  assert.equal(isCheckoutCanceledUrl(`${issuer}/`, `${issuer}/pricing/canceled`), true);
});

test("isCheckoutCanceledUrl rejects other paths and origins", () => {
  assert.equal(isCheckoutCanceledUrl(issuer, `${issuer}/pricing/success`), false);
  assert.equal(isCheckoutCanceledUrl(issuer, "https://other.test/pricing/canceled"), false);
  assert.equal(isCheckoutCanceledUrl(issuer, ""), false);
});
