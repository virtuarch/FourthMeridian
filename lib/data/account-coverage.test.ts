/**
 * lib/data/account-coverage.test.ts
 *
 * The account historical-coverage policy. Pure — no DB, no clock.
 *
 * Every acceptance scenario from the coverage-floor brief is pinned here, and
 * several of them CANNOT be proven against the live database (no account
 * currently has a pending or deleted row older than its earliest posted one).
 * That is exactly why they are unit tests: the exclusion is load-bearing the
 * first time a provider backfills a stale pending row, not today.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  resolveAccountCoverage, coverageClassFor,
  type AccountCoverageInput,
} from "./account-coverage.core";

const checks: string[] = [];
const ok = (label: string) => checks.push(label);

const CONNECTED = "2026-07-19";

function input(over: Partial<AccountCoverageInput> = {}): AccountCoverageInput {
  return {
    accountId: "a1",
    coverageClass: "BALANCE_WALK",
    connectionFloorISO: CONNECTED,
    earliestPostedTxISO: null,
    earliestPositionObservationISO: null,
    earliestReconstructionAnchorISO: null,
    earliestInvestmentEventISO: null,
    ...over,
  };
}

// ── A · posted transactions before connection widen existence ────────────────
{
  const c = resolveAccountCoverage(input({ earliestPostedTxISO: "2024-07-22" }));
  assert.equal(c.existenceFromISO, "2024-07-22");
  assert.equal(c.replayFromISO, "2024-07-22");
  assert.equal(c.displayFromISO, "2024-07-22");
  assert.equal(c.state, "EVIDENCED");
  assert.ok(c.evidence.some((e) => e.kind === "POSTED_TRANSACTION" && e.dateISO === "2024-07-22"));
  ok("A · a posted transaction before connection widens existence, replay and display");
}

// ── B · an observed balance only, no earlier transactions ⇒ do NOT widen ─────
{
  const c = resolveAccountCoverage(input({ earliestPostedTxISO: "2026-08-01" }));
  assert.equal(c.existenceFromISO, null, "evidence AFTER connection tells us nothing new");
  assert.equal(c.displayFromISO, CONNECTED);
  assert.equal(c.state, "CONNECTION_FALLBACK");
  assert.ok(c.reasons.includes("NO_EVIDENCE_PRECEDES_CONNECTION"));
  ok("B · evidence dated after connection never widens the floor");
}

// ── F/G · pending and deleted rows never license coverage ───────────────────
//
// Enforced at the GATHER (the query filters them out), so the policy simply
// never sees them. Proven here by the absence of any input that could carry
// them, and by the static guard at the bottom of this file.
{
  const c = resolveAccountCoverage(input({ earliestPostedTxISO: null }));
  assert.equal(c.existenceFromISO, null);
  assert.equal(c.displayFromISO, CONNECTED);
  assert.ok(c.reasons.includes("NO_DATED_EVIDENCE"));
  ok("F/G · with no posted evidence the floor stays at connection");
}

// ── C · investment evidence works with ZERO Transaction rows ────────────────
{
  const c = resolveAccountCoverage(input({
    coverageClass: "POSITION_SPINE",
    earliestPostedTxISO: null,                       // investment accounts have none
    earliestPositionObservationISO: "2025-07-31",
    earliestReconstructionAnchorISO: "2025-07-31",
    earliestInvestmentEventISO: "2025-07-31",
  }));
  assert.equal(c.existenceFromISO, "2025-07-31");
  assert.equal(c.replayFromISO, "2025-07-31");
  assert.ok(c.reasons.includes("REPLAY_FROM_POSITION_SPINE"));
  ok("C · investment coverage resolves from the position spine without any Transaction row");
}

// ── D · existence without a usable spine: exists, but cannot be valued ──────
//
// An observation dated at/after connection proves nothing earlier, so there is
// no licence to reconstruct before it even though the account plainly exists.
{
  const c = resolveAccountCoverage(input({
    coverageClass: "POSITION_SPINE",
    earliestPositionObservationISO: "2026-08-01",
    earliestReconstructionAnchorISO: null,
  }));
  assert.equal(c.replayFromISO, null);
  assert.equal(c.displayFromISO, CONNECTED);
  assert.ok(c.reasons.includes("NO_POSITION_SPINE_BEFORE_CONNECTION"));
  ok("D · an account may exist while its valuation stays unavailable");
}

// ── E · wallet: existence from 2023, replay only with a complete ledger ─────
{
  const complete = resolveAccountCoverage(input({
    coverageClass: "WALLET_LEDGER",
    earliestPostedTxISO: "2023-03-18",
    walletLedgerComplete: true,
  }));
  assert.equal(complete.existenceFromISO, "2023-03-18");
  assert.equal(complete.replayFromISO, "2023-03-18");
  assert.ok(complete.reasons.includes("REPLAY_FROM_COMPLETE_WALLET_LEDGER"));

  // An incomplete ledger is not a SMALLER window — it is no window.
  const incomplete = resolveAccountCoverage(input({
    coverageClass: "WALLET_LEDGER",
    earliestPostedTxISO: "2023-03-18",
    walletLedgerComplete: false,
  }));
  assert.equal(incomplete.existenceFromISO, "2023-03-18", "existence still holds");
  assert.equal(incomplete.replayFromISO, null, "but nothing may be reconstructed");
  assert.equal(incomplete.displayFromISO, CONNECTED);
  assert.ok(incomplete.reasons.includes("WALLET_LEDGER_INCOMPLETE"));
  ok("E · wallet existence and wallet replay are separately licensed");
}

// ── THE SAFETY RULE · wider existence must NEVER widen a held-flat replay ───
//
// An installment loan has no ledger to walk. Knowing it is older changes what we
// can SAY, never what we can COMPUTE — widening it would carry today's balance
// backward across years and fabricate a series.
{
  const c = resolveAccountCoverage(input({
    coverageClass: "HELD_FLAT",
    earliestPostedTxISO: "2022-01-01",
  }));
  assert.equal(c.existenceFromISO, "2022-01-01");
  assert.equal(c.replayFromISO, null);
  assert.equal(c.displayFromISO, CONNECTED, "no value may be shown before connection");
  assert.ok(c.reasons.includes("NO_REPLAY_FOR_HELD_FLAT_ACCOUNT"));
  ok("wider existence never widens replay for a held-flat account (no fabricated series)");
}

// ── The display floor is the intersection, never the earliest input ─────────
{
  const c = resolveAccountCoverage(input({
    coverageClass: "HELD_FLAT", earliestPostedTxISO: "2020-01-01",
  }));
  assert.ok(c.displayFromISO > (c.existenceFromISO ?? ""),
    "display is bounded by replay, not by existence");
  ok("the display floor is the intersection of the intervals, not the earliest one");
}

// ── J · quiet empty account falls back to the connection date ───────────────
{
  const c = resolveAccountCoverage(input({ coverageClass: "WALLET_LEDGER" }));
  assert.equal(c.existenceFromISO, null);
  assert.equal(c.displayFromISO, CONNECTED);
  assert.equal(c.state, "CONNECTION_FALLBACK");
  ok("J · an account with no evidence keeps the connection date");
}

// ── Coverage classes ────────────────────────────────────────────────────────
{
  assert.equal(coverageClassFor("checking", false), "BALANCE_WALK");
  assert.equal(coverageClassFor("savings", false), "BALANCE_WALK");
  assert.equal(coverageClassFor("investment", false), "POSITION_SPINE");
  assert.equal(coverageClassFor("crypto", false), "WALLET_LEDGER");
  // A revolving card can be walked; an installment loan cannot.
  assert.equal(coverageClassFor("debt", true), "BALANCE_WALK");
  assert.equal(coverageClassFor("debt", false), "HELD_FLAT");
  assert.equal(coverageClassFor("other", false), "HELD_FLAT");
  ok("coverage class follows the canonical revolving-card verdict, not the raw type");
}

// ── I · no cross-account widening, and the ITEM-WIDE trap ──────────────────
//
// `InvestmentEventCoverage` is stamped per account but records the ITEM's
// response envelope: two brokerage accounts on one Plaid item carry the SAME
// `earliestReturnedDate` AND the same `fetchedCount`. Reading it as per-account
// evidence would license one account with its sibling's history. It must never
// appear in the gather.
{
  const src = readFileSync(new URL("./account-coverage.ts", import.meta.url), "utf8");
  const core = readFileSync(new URL("./account-coverage.core.ts", import.meta.url), "utf8");

  assert.ok(!/investmentEventCoverage\.(groupBy|findMany|findFirst|aggregate)/.test(src),
    "InvestmentEventCoverage is never read as per-account existence evidence");
  assert.ok(!/earliestReturnedDate/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")),
    "the item-wide returned-date field is not consumed");

  // Every gather is grouped by account, never by item or institution.
  for (const m of src.matchAll(/by:\s*\[([^\]]*)\]/g)) {
    assert.ok(m[1].includes("financialAccountId"),
      `evidence is grouped per account, got: ${m[1]}`);
  }
  assert.ok(!/plaidItemId|institutionId/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")),
    "no query is scoped by item or institution");

  // Pending and deleted rows are excluded at every transaction gather.
  const txGathers = [...src.matchAll(/client\.transaction\.groupBy\(\{[\s\S]*?\}\)/g)];
  assert.ok(txGathers.length >= 2, "both transaction gathers are present");
  for (const g of txGathers) {
    assert.ok(/pending:\s*false/.test(g[0]), "pending rows never license coverage");
    assert.ok(/deletedAt:\s*null/.test(g[0]), "deleted rows never license coverage");
  }

  // The authority resolves intervals; it must not value anything.
  assert.ok(!/balance\s*[*+]|unitPrice|reportingValue|convertMoney/.test(core),
    "the coverage authority performs no valuation");
  assert.ok(!/\.(create|update|delete|upsert|createMany|updateMany)\(/.test(src), "no writes");
  ok("I · evidence is per-account only; the item-wide coverage row is deliberately unread");
}

// ── One authority, not per-lens patches ────────────────────────────────────
{
  const asof = readFileSync(new URL("./accounts-asof.ts", import.meta.url), "utf8");
  const window = readFileSync(new URL("./accounts-asof-window.ts", import.meta.url), "utf8");
  for (const [name, src] of [["accounts-asof", asof], ["accounts-asof-window", window]] as const) {
    assert.ok(/getAccountCoverage\(/.test(src), `${name} resolves its floor through the coverage authority`);
    // The raw connection date may remain as the FALLBACK, but must never be the
    // floor a resolver receives on its own.
    assert.ok(!/floorISO:\s*isoDate\(maxDate\(/.test(src),
      `${name} no longer floors directly at the connection date`);
  }
  ok("both as-of bindings resolve coverage through the one authority");
}

for (const c of checks) console.log("  ✓ " + c);
console.log(`account-coverage: ${checks.length} checks passed`);
