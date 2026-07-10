/**
 * lib/transactions/transfer-matching.test.ts
 *
 * TI4 Slice 1 — composition tests: the PURE matcher feeding the liquidity engine.
 * Proves that a deterministically-resolved owned-account counterparty flips a
 * transfer from UNRESOLVED to the correct liquidity reason (Internal transfer /
 * Asset deployment / Asset liquidation) with NO double-counting, and that the
 * DTO projection rule (persisted-confirmed wins; KD-15 hides an invisible match)
 * behaves correctly. Pure — no DB. Runs under the tsx test runner.
 *
 *   npx tsx --test lib/transactions/transfer-matching.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchTransferCandidate,
  type RelationshipTransaction,
} from './RelationshipResolver';
import { chooseCounterpartyId } from './counterparty-visibility';
import {
  classifyLiquidity,
  deriveCashFlowAxes,
  tierResolver,
  type LiquidityTx,
} from './liquidity';

// fa_chk/fa_sav = liquid; fa_brk = asset (investment).
const liqCtx = tierResolver([
  { id: 'fa_chk', type: 'checking' },
  { id: 'fa_sav', type: 'savings' },
  { id: 'fa_brk', type: 'investment' },
]);

/** A transfer leg as the matcher sees it (date is a Date; currency required). */
function relLeg(id: string, faId: string, amount: number, over: Partial<RelationshipTransaction> = {}): RelationshipTransaction {
  return {
    id, accountId: null, financialAccountId: faId,
    plaidTransactionId: null, pendingTransactionRef: null,
    date: new Date('2026-06-01'), amount, merchant: '', pending: false,
    deletedAt: null, flowType: 'TRANSFER', currency: 'USD', ...over,
  };
}

/** The same leg as the liquidity engine sees it, with a (possibly resolved) counterparty. */
function liqLeg(faId: string, amount: number, cp: string | null): LiquidityTx {
  return {
    id: `${faId}:${amount}`, accountId: faId, financialAccountId: faId,
    date: '2026-06-01', merchant: 'm', category: 'Transfer', pending: false,
    amount, flowType: 'TRANSFER', flowDirection: amount > 0 ? 'INFLOW' : 'OUTFLOW',
    currency: 'USD', counterpartyAccountId: cp,
  } as LiquidityTx;
}

/** Resolve a leg's counterparty against the other legs (what the data layer does). */
function resolveCp(target: RelationshipTransaction, others: RelationshipTransaction[]): string | null {
  const m = matchTransferCandidate(target, others);
  return m.status === 'RESOLVED' ? m.counterpartyAccountId : null;
}

// ── checking ↔ savings → Internal transfer (both legs neutral) ─────────────────
test('checking → savings resolves both legs to INTERNAL_TRANSFER (was UNRESOLVED)', () => {
  const chk = relLeg('chk', 'fa_chk', -500);
  const sav = relLeg('sav', 'fa_sav', 500);

  // Before resolution: the liquid leg is honestly UNRESOLVED.
  assert.equal(classifyLiquidity(liqLeg('fa_chk', -500, null), liqCtx).effect, 'UNRESOLVED');

  const chkCp = resolveCp(chk, [sav]);
  const savCp = resolveCp(sav, [chk]);
  assert.equal(chkCp, 'fa_sav');
  assert.equal(savCp, 'fa_chk');

  const a = classifyLiquidity(liqLeg('fa_chk', -500, chkCp), liqCtx);
  const b = classifyLiquidity(liqLeg('fa_sav', 500, savCp), liqCtx);
  assert.equal(a.reason, 'INTERNAL_TRANSFER');
  assert.equal(a.effect, 'NEUTRAL');
  assert.equal(b.reason, 'INTERNAL_TRANSFER');
  assert.equal(b.effect, 'NEUTRAL');

  // No double-count: neither neutral leg moves spendable cash.
  const axes = deriveCashFlowAxes([liqLeg('fa_chk', -500, chkCp), liqLeg('fa_sav', 500, savCp)], liqCtx);
  assert.equal(axes.cashIn, 0);
  assert.equal(axes.cashOut, 0);
  assert.equal(axes.unresolved, 0);
});

// ── checking → brokerage contribution → Asset deployment ───────────────────────
test('checking → brokerage contribution: liquid leg = ASSET_DEPLOYMENT, asset leg neutral (no double count)', () => {
  const chk = relLeg('chk', 'fa_chk', -500);
  const brk = relLeg('brk', 'fa_brk', 500);
  const chkCp = resolveCp(chk, [brk]); // fa_brk (asset)
  const brkCp = resolveCp(brk, [chk]); // fa_chk (liquid)
  assert.equal(chkCp, 'fa_brk');

  const liquid = classifyLiquidity(liqLeg('fa_chk', -500, chkCp), liqCtx);
  const asset = classifyLiquidity(liqLeg('fa_brk', 500, brkCp), liqCtx);
  assert.equal(liquid.reason, 'ASSET_DEPLOYMENT');
  assert.equal(liquid.effect, 'CASH_OUT');
  assert.equal(asset.effect, 'NEUTRAL'); // the non-liquid leg is anchored out

  const axes = deriveCashFlowAxes([liqLeg('fa_chk', -500, chkCp), liqLeg('fa_brk', 500, brkCp)], liqCtx);
  assert.equal(axes.cashOut, 500); // counted ONCE, on the liquid leg
  assert.equal(axes.cashIn, 0);
});

// ── brokerage → checking withdrawal → Asset liquidation ────────────────────────
test('brokerage → checking withdrawal: liquid leg = ASSET_LIQUIDATION, asset leg neutral (no double count)', () => {
  const brk = relLeg('brk', 'fa_brk', -500);
  const chk = relLeg('chk', 'fa_chk', 500);
  const chkCp = resolveCp(chk, [brk]); // fa_brk (asset)
  const brkCp = resolveCp(brk, [chk]); // fa_chk (liquid)
  assert.equal(chkCp, 'fa_brk');

  const liquid = classifyLiquidity(liqLeg('fa_chk', 500, chkCp), liqCtx);
  const asset = classifyLiquidity(liqLeg('fa_brk', -500, brkCp), liqCtx);
  assert.equal(liquid.reason, 'ASSET_LIQUIDATION');
  assert.equal(liquid.effect, 'CASH_IN');
  assert.equal(asset.effect, 'NEUTRAL');

  const axes = deriveCashFlowAxes([liqLeg('fa_chk', 500, chkCp), liqLeg('fa_brk', -500, brkCp)], liqCtx);
  assert.equal(axes.cashIn, 500); // counted ONCE
  assert.equal(axes.cashOut, 0);
});

// ── DTO projection rule — persisted wins; KD-15 hides an invisible match ────────
test('chooseCounterpartyId: a persisted provider-confirmed link outranks a read-time match', () => {
  assert.equal(chooseCounterpartyId('fa_persisted', 'fa_sav'), 'fa_persisted'); // e.g. a BTC wallet link
  assert.equal(chooseCounterpartyId(null, 'fa_sav'), 'fa_sav');                  // read-time fills the gap
  assert.equal(chooseCounterpartyId(null, null), null);                          // neither → Unresolved
});

test('KD-15: a resolved id is projected only when its account is visible to the Space', () => {
  const chk = relLeg('chk', 'fa_chk', -500);
  const sav = relLeg('sav', 'fa_sav', 500);
  const resolved = matchTransferCandidate(chk, [sav]).counterpartyAccountId; // 'fa_sav'

  // The data layer passes the resolved id to chooseCounterpartyId ONLY when the
  // KD-15 gate says the account is visible; otherwise it passes null.
  const project = (visible: Set<string>) =>
    chooseCounterpartyId(null, resolved && visible.has(resolved) ? resolved : null);

  assert.equal(project(new Set(['fa_sav'])), 'fa_sav'); // shared into the Space → exposed
  assert.equal(project(new Set()), null);               // not shared → hidden, row stays Unresolved

  // And when hidden, the liquid leg falls back to UNRESOLVED on the liquidity axis.
  assert.equal(classifyLiquidity(liqLeg('fa_chk', -500, project(new Set())), liqCtx).effect, 'UNRESOLVED');
});
