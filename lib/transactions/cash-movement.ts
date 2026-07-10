/**
 * lib/transactions/cash-movement.ts
 *
 * CM-1 — canonical read-time Cash Movement derivation. A physical-cash movement is
 * a LIQUIDITY FORM CHANGE, not spending, income, or a transfer purpose:
 *
 *     bank money  →  physical cash   (a withdrawal, e.g. an ATM)
 *     physical cash  →  bank money   (a deposit)
 *
 * It reads the already-persisted, provider-neutral transfer evidence
 * (transferMovementForm = "CASH", from the TE-1 adapter) plus the row's signed
 * amount for direction. Pure, deterministic, Prisma-free, provider-string-free.
 *
 * Strictly a derivation: NO schema/persistence change, NO FlowType change, NO
 * liquidity-math change, NO Cash In / Cash Out change. It only names, at read
 * time, what a cash-form transfer was.
 */

/** Which way the cash form changed. */
export type CashMovementDirection = "WITHDRAWAL" | "DEPOSIT";

export interface CashMovement {
  direction: CashMovementDirection;
}

/** Minimal canonical facts CM-1 reads (no provider fields). */
export interface CashMovementInput {
  /** Canonical TransferMovementForm value ("CASH" when a cash form was attested). */
  transferMovementForm: string | null;
  /** Fourth-Meridian-signed amount (negative = money out of the bank = withdrawal). */
  amount: number;
}

/**
 * Derive the cash-movement disposition, or null when the row is not a physical-cash
 * movement. Direction comes only from the signed amount — bank→cash (outflow) is a
 * WITHDRAWAL, cash→bank (inflow) is a DEPOSIT. A zero amount has no direction and
 * yields null (we never guess).
 */
export function deriveCashMovement(t: CashMovementInput): CashMovement | null {
  if (t.transferMovementForm !== "CASH") return null;
  if (t.amount < 0) return { direction: "WITHDRAWAL" };
  if (t.amount > 0) return { direction: "DEPOSIT" };
  return null;
}
