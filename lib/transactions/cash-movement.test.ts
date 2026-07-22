/**
 * lib/transactions/cash-movement.test.ts
 *
 * CM-1 — proves the pure cash-movement derivation: a form change (bank↔cash) with
 * direction from sign, and null for non-cash rows. No DB, no Prisma.
 *   npx tsx --test lib/transactions/cash-movement.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { deriveCashMovement } from "./cash-movement";

test("bank → physical cash (outflow) is a WITHDRAWAL", () => {
  assert.deepEqual(deriveCashMovement({ transferMovementForm: "CASH", amount: -200 }), { direction: "WITHDRAWAL" });
});

test("physical cash → bank (inflow) is a DEPOSIT", () => {
  assert.deepEqual(deriveCashMovement({ transferMovementForm: "CASH", amount: 2500 }), { direction: "DEPOSIT" });
});

test("a non-cash transfer yields null (not a cash movement)", () => {
  assert.equal(deriveCashMovement({ transferMovementForm: null, amount: -200 }), null);
  assert.equal(deriveCashMovement({ transferMovementForm: "DEPOSITORY", amount: -200 }), null);
});

test("a zero amount has no direction (never guessed)", () => {
  assert.equal(deriveCashMovement({ transferMovementForm: "CASH", amount: 0 }), null);
});

test("pure & deterministic — same input, same output, input untouched", () => {
  const input = { transferMovementForm: "CASH", amount: -40 };
  const snap = JSON.stringify(input);
  assert.deepEqual(deriveCashMovement(input), deriveCashMovement(input));
  assert.equal(JSON.stringify(input), snap);
});

test("contains no provider strings (canonical only)", () => {
  // The input is TransferMovementForm ("CASH"), never a Plaid PFC code.
  assert.equal(deriveCashMovement({ transferMovementForm: "CASH", amount: -1 })!.direction, "WITHDRAWAL");
});
