/**
 * lib/snapshots/held-flat-liability-probe.test.ts  (PB-8)
 *
 * The write-time probe's WALKED vs UNVERIFIABLE split, pinned on a fixture that
 * reproduces the Production finding of 2026-11-01 (diagnosed read-only; no
 * customer data here — every number below is synthetic):
 *
 *   · one WALKED liability   a revolving card the ladder walks (null subtype +
 *                            a credit limit, as Plaid imports it);
 *   · one HELD-FLAT card     83 transactions since 2026-08-04 but NO credit
 *                            limit, so the ladder cannot walk it — the writer
 *                            holds it flat from its earliest transaction;
 *   · one HELD-FLAT mortgage zero transactions — held flat (REG-2) from the
 *                            30-day regeneration window's start, 2026-10-01.
 *
 * Both held-flat accounts were connected on 2026-10-30, so the as-of resolver
 * reports them `before-coverage` (0) on every earlier day. The former probe
 * compared stored debt to that 0 and failed on every day in between; the stored
 * side was the more accurate one. The probe now never compares a held-flat
 * liability against 0, reports it apart, and still flags genuine mismatches
 * among walked accounts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveAccountsOverWindow, type AsOfAccountInput } from "@/lib/data/accounts-asof.core";
import { reconstructDailyLiabilityBalances, isReconstructableCard, fromISO, addDaysUTC, isoDate } from "./backfill-core";
import { amountOwed } from "@/lib/debt/balance-semantics";
import { auditDebtReplay, SERIES_IDENTITY_TOLERANCE, type DebtReplayRow } from "./series-integrity.core";

const checks: string[] = [];
const ok = (label: string) => checks.push(label);

const TODAY = fromISO("2026-11-01");
const FROM = "2026-07-01";
const TO = "2026-10-31";

const CARD: AsOfAccountInput = { id: "card", type: "debt", balance: 1_000, debtSubtype: null, creditLimit: 5_000, floorISO: FROM };
const CAPONE: AsOfAccountInput = { id: "capone", type: "debt", balance: 12_800, debtSubtype: null, creditLimit: null, floorISO: "2026-10-30" };
const MORTGAGE: AsOfAccountInput = { id: "mortgage", type: "debt", balance: 323_800, debtSubtype: null, creditLimit: null, floorISO: "2026-10-30" };
const ACCOUNTS = [CARD, CAPONE, MORTGAGE];

// The walked card's posted ledger (owed ↑ on a charge = +amount on a debt account).
const CARD_DELTAS = new Map([["card", new Map([
  ["2026-07-15", 200], ["2026-08-20", -150], ["2026-09-10", 400], ["2026-10-05", 75],
])]]);

// What the WRITER stores (regenerate-history): the card walked, CapOne held flat
// from its earliest transaction, the mortgage held flat from the window start.
const CAPONE_WRITER_FLOOR = "2026-08-04";
const MORTGAGE_WRITER_FLOOR = "2026-10-01";
const walkedCard = reconstructDailyLiabilityBalances([{ id: "card", balance: CARD.balance }], CARD_DELTAS, TODAY, fromISO(FROM));
function storedRows(extra: (dISO: string) => number = () => 0): DebtReplayRow[] {
  const out: DebtReplayRow[] = [];
  for (let d = fromISO(FROM); d.getTime() <= fromISO(TO).getTime(); d = addDaysUTC(d, 1)) {
    const dISO = isoDate(d);
    const debt = amountOwed(walkedCard.get(dISO)!.get("card")!)
      + (dISO >= CAPONE_WRITER_FLOOR ? CAPONE.balance : 0)
      + (dISO >= MORTGAGE_WRITER_FLOOR ? MORTGAGE.balance : 0)
      + extra(dISO);
    out.push({ dateISO: dISO, debt, isEstimated: true });
  }
  return out;
}

// The resolver the probe replays through (getAccountBalancesOverWindow's core).
const byDate = resolveAccountsOverWindow(ACCOUNTS, new Map(), CARD_DELTAS, TODAY, fromISO(FROM), fromISO(TO));
const probeAccounts = ACCOUNTS.map((a) => ({ id: a.id, walked: isReconstructableCard(a), heldFlatOwed: amountOwed(a.balance) }));
const walkedOwedOn = (dISO: string, id: string) => amountOwed(byDate.get(dISO)?.get(id)?.balance ?? 0);

// ── 0 · the fixture reproduces the finding under the FORMER rule ─────────────
{
  const rows = storedRows();
  const legacy = rows.filter((r) => {
    const owed = ACCOUNTS.reduce((n, a) => n + amountOwed(byDate.get(r.dateISO)?.get(a.id)?.balance ?? 0), 0);
    return Math.abs(owed - r.debt) > SERIES_IDENTITY_TOLERANCE;
  });
  assert.equal(legacy[0].dateISO, CAPONE_WRITER_FLOOR, "the former probe first fails on the held-flat card's writer floor");
  assert.equal(legacy.at(-1)!.dateISO, "2026-10-29", "…and last fails the day before the connection floor");
  assert.equal(byDate.get("2026-10-15")!.get("mortgage")!.method, "before-coverage", "the resolver reports the held-flat mortgage as 0 before connection");
  assert.equal(byDate.get("2026-10-15")!.get("capone")!.method, "before-coverage");
  assert.equal(byDate.get("2026-10-30")!.get("capone")!.method, "held-flat");
  ok("0 · fixture reproduces the 2026-11-01 false positive under the former rule");
}

// ── A · held-flat liabilities are UNVERIFIABLE, not mismatches ───────────────
{
  const r = auditDebtReplay(storedRows(), probeAccounts, walkedOwedOn);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.walkedAccountIds, ["card"]);
  assert.deepEqual(r.unverifiableAccountIds, ["capone", "mortgage"]);
  assert.equal(r.checked, 123);
  // Every row from the held-flat card's writer floor (Aug 4 … Oct 31) rests on
  // an account the walked replay does not see.
  assert.equal(r.rowsRestingOnUnverifiable, 89);
  ok("A · walked card + held-flat card (83 tx) + held-flat mortgage (0 tx) ⇒ healthy, unverifiable reported apart");
}

// ── B · a genuine mismatch on the WALKED account is still caught ─────────────
{
  const phantom = storedRows((d) => (d < "2026-07-31" ? -145.98 : 0));
  const r = auditDebtReplay(phantom, probeAccounts, walkedOwedOn);
  assert.equal(r.violations.length, 30);
  assert.match(r.violations[0], /^2026-07-01 debt: stored .* != walked replay .*no held-flat subset of 2 unverifiable/);
  ok("B · a walked-account phantom is a violation even with held-flat accounts present");
}

// ── C · a residual no held-flat subset explains is a violation ───────────────
{
  const r = auditDebtReplay(storedRows((d) => (d === "2026-09-15" ? 5_000 : 0)), probeAccounts, walkedOwedOn);
  assert.deepEqual(r.violations.map((v) => v.slice(0, 10)), ["2026-09-15"]);
  // Double-counting a held-flat account is not a subset either.
  const dbl = auditDebtReplay(storedRows((d) => (d === "2026-10-10" ? MORTGAGE.balance : 0)), probeAccounts, walkedOwedOn);
  assert.equal(dbl.violations.length, 1);
  ok("C · unexplained residuals (incl. a held-flat account counted twice) are violations");
}

// ── D · with no unverifiable account the rule and message are unchanged ──────
{
  const only = [probeAccounts[0]];
  const rows = storedRows().map((r) => ({ ...r, debt: amountOwed(walkedCard.get(r.dateISO)!.get("card")!) }));
  assert.deepEqual(auditDebtReplay(rows, only, walkedOwedOn).violations, []);
  const bad = auditDebtReplay(rows.map((r, i) => (i === 0 ? { ...r, debt: r.debt + 1 } : r)), only, walkedOwedOn);
  assert.match(bad.violations[0], /^2026-07-01 debt: stored \d+\.\d{2} != replay \d+\.\d{2}$/);
  // Observations were never walked: skipped, as before.
  const obs = auditDebtReplay([{ dateISO: "2026-07-01", debt: 9_999, isEstimated: false }], only, walkedOwedOn);
  assert.equal(obs.checked, 0);
  assert.deepEqual(obs.violations, []);
  ok("D · walked-only Space: identical rule + message; observed rows skipped");
}

// ── Static · the binding routes through the split, ids-only logging ──────────
{
  const binding = readFileSync(new URL("./regenerate-history.ts", import.meta.url), "utf8");
  const probe = binding.slice(binding.indexOf("async function verifyLiabilitySeries"));
  assert.ok(/auditDebtReplay\(/.test(probe), "verifyLiabilitySeries uses auditDebtReplay");
  assert.ok(/walked:\s*isReconstructableCard\(a\)/.test(probe), "walked ⇔ the canonical card predicate");
  assert.ok(!/ids\.reduce\(/.test(probe.slice(0, probe.indexOf("function isManualRealAsset"))), "no Σ over every debt id against a 0 fallback");
  ok("static · verifyLiabilitySeries uses auditDebtReplay with the canonical walk predicate");
}

for (const c of checks) console.log("  ✓ " + c);
console.log(`held-flat-liability-probe: ${checks.length} checks passed`);
