/**
 * lib/account-privacy.proof.test.ts
 *
 * REVIEW-3 B-1 — the required PROOF, end to end across the real consumers.
 *
 * Scenario (the audit's §1.4 falsification): one Space with
 *   - Alice's FULL credit card owing  $1,000
 *   - Bob's BALANCE_ONLY cards at    +$500  and  −$200  (same owner, same
 *     type, same currency → ONE aggregate row on the widget path)
 *   - plus, where stated, a SUMMARY_ONLY card at $10,000 (fail closed)
 *
 * Proves:
 *   (a) every "how much is owed" surface answers $1,500 for its permitted
 *       population — never the netted $1,300:
 *         · normalizeSharedAccounts → computeDebtKpis (KPI strip / DebtHero)
 *         · normalizeSharedAccounts → computePayoffAggregate (planner)
 *         · computeDebtAggregate directly over the aggregate rows
 *         · debt lens core over the per-account lens path (real ids)
 *   (b) the −$200 issuer credit is DISCLOSED (aggregate.creditTotal / the
 *       detail-row creditTotal) and discharges NOTHING — removing it moves no
 *       owed total;
 *   (c) the reachable-cash aggregate uses currentState-RESOLVED values, and the
 *       widget headline and the lens verdict resolve the IDENTICAL population
 *       (same member account ids) to the identical number;
 *   (d) a SUMMARY_ONLY row contributes to NO balance total on either path.
 *
 * Standalone tsx:  npx tsx lib/account-privacy.proof.test.ts
 * (self-shims `server-only`, same mechanism as scripts/lib/server-only-preload.cjs)
 */

import Module from "node:module";
import path from "node:path";

// ── server-only shim (must precede loading lib/account-privacy) ──────────────
const NOOP_PATH = path.join(process.cwd(), "scripts", "lib", "server-only-noop.cjs");
type ResolveFn = (request: string, ...rest: unknown[]) => string;
const moduleInternals = Module as unknown as { _resolveFilename: ResolveFn };
const originalResolve = moduleInternals._resolveFilename;
moduleInternals._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]): string {
  if (request === "server-only") return NOOP_PATH;
  return originalResolve.call(this, request, ...rest) as string;
};

import { computeDebtAggregate } from "./debt/aggregates";
import { computeDebt, type DebtAccountRow } from "./perspective-engine/lenses/debt.core";
import { computeLiquidity, type LiquidityAccountRow } from "./perspective-engine/lenses/liquidity.core";
import type { ComputeOptions, PerspectiveScope } from "./perspective-engine/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const SCOPE: PerspectiveScope = { spaceId: "space_b1", userId: "user_viewer" };
const OPTS:  ComputeOptions  = { now: () => new Date("2026-08-17T12:00:00.000Z") };
const T = new Date("2026-08-15T00:00:00.000Z");

async function main(): Promise<void> {
  const { normalizeSharedAccounts, aggregateCurrentCashState } = await import("./account-privacy");
  type ShareRow = import("./account-privacy").ShareRow;
  // Client widget consumers (the SAME modules the Space surfaces render from).
  const { computeDebtKpis, computePayoffAggregate } = await import("../components/space/widgets/debt/debt-kpis");
  const { reachableNow } = await import("../components/space/widgets/liquidity-adapters");

  const debtShare = (over: { id: string; balance: number; visibilityLevel?: string; owner?: string }): ShareRow => ({
    visibilityLevel: over.visibilityLevel ?? "BALANCE_ONLY",
    addedByUserId:   over.owner ?? "user_bob",
    addedByUser:     { firstName: "Bob", name: "Bob B" },
    financialAccount: {
      id: over.id, name: `Real ${over.id}`, type: "debt", institution: "Chase",
      balance: over.balance, currency: "USD", lastUpdated: T,
      creditLimit: null, debtSubtype: "credit_card", interestRate: null, minimumPayment: null,
    },
  });

  // ── The widget path: what the Space payload actually carries ───────────────
  const { accounts: widgetRows } = normalizeSharedAccounts([
    { ...debtShare({ id: "fa_alice", balance: 1000, visibilityLevel: "FULL", owner: "user_alice" }) },
    debtShare({ id: "fa_bob_1", balance:  500 }),
    debtShare({ id: "fa_bob_2", balance: -200 }),
  ]);
  const aggRow = widgetRows.find((a) => a.id.startsWith("balance-only:"))!;
  // Structural shape every debt widget consumes (DebtPerspectiveAccount).
  const widgetAccounts = widgetRows.map((a) => ({
    id: a.id, name: a.name, type: a.type, institution: a.institution ?? "",
    balance: a.balance, currency: a.currency,
    interestRate: a.interestRate ?? undefined, minimumPayment: a.minimumPayment ?? undefined,
    creditLimit: a.creditLimit ?? undefined,
  }));

  // ── The lens path: per-account rows with real ids (lib/data/accounts.ts) ───
  const lensRows: DebtAccountRow[] = [
    { id: "fa_alice", type: "debt", balance: 1000, currency: "USD", lastUpdated: T.toISOString(), visibilityLevel: "FULL" },
    { id: "fa_bob_1", type: "debt", balance:  500, currency: "USD", lastUpdated: T.toISOString(), visibilityLevel: "BALANCE_ONLY" },
    { id: "fa_bob_2", type: "debt", balance: -200, currency: "USD", lastUpdated: T.toISOString(), visibilityLevel: "BALANCE_ONLY" },
  ];

  console.log("(a) Every 'how much is owed' surface answers $1,500 — not $1,300");
  {
    const kpis = computeDebtKpis(widgetAccounts);
    check("KPI strip / DebtHero totalDebt = 1500", kpis.totalDebt === 1500, String(kpis.totalDebt));
    check("KPI totalDebt is NOT the netted 1300", kpis.totalDebt !== 1300);

    const payoff = computePayoffAggregate(widgetAccounts);
    check("planner aggregate total = 1500", payoff.total === 1500, String(payoff.total));

    const agg = computeDebtAggregate(widgetAccounts.map((a) => ({
      balance: a.balance, apr: a.interestRate ?? null, minimumPayment: a.minimumPayment ?? null,
    })));
    check("debt-aggregates authority over the widget rows = 1500 (its per-row clamp holds structurally)",
      agg.totalOwed === 1500, String(agg.totalOwed));

    const lens = computeDebt(SCOPE, OPTS, lensRows);
    check("debt lens (verdict/headline population) = 1500", lens.headline?.value === 1500, String(lens.headline?.value));
    check("lens verdict prose states $1,500",
      (lens.verdict ?? "").includes("$1,500"), lens.verdict);
    check("widget headline and lens headline are the SAME number",
      computeDebtKpis(widgetAccounts).totalDebt === lens.headline?.value);
  }

  console.log("(b) The −$200 issuer credit is disclosed and discharges nothing");
  {
    check("aggregate row balance is the owed 500 (per-member clamps), not 300", aggRow.balance === 500);
    check("issuer credit disclosed on the aggregate row (creditTotal 200)",
      aggRow.aggregate?.creditTotal === 200, String(aggRow.aggregate?.creditTotal));

    // Discharges nothing: with the credit card REMOVED, every owed total is
    // unchanged — the credit never offset any other account's obligation.
    const { accounts: without } = normalizeSharedAccounts([
      debtShare({ id: "fa_alice", balance: 1000, visibilityLevel: "FULL", owner: "user_alice" }),
      debtShare({ id: "fa_bob_1", balance: 500 }),
    ]);
    const totalWithout = computeDebtKpis(without.map((a) => ({
      id: a.id, name: a.name, type: a.type, institution: a.institution ?? "",
      balance: a.balance, currency: a.currency,
    }))).totalDebt;
    check("removing the credit-balance card changes NO owed total (1500 either way)", totalWithout === 1500);

    // The detail surface (AccountsLedger) receives it as `creditTotal` and the
    // member count — mirrored from aggregate meta by the detail route.
    check("member count rides with the row (2 links behind 1 row)", aggRow.aggregate?.memberCount === 2);
  }

  console.log("(c) Reachable cash: currentState-resolved, headline ≡ lens population");
  {
    // Cash scenario: Alice FULL checking (reachable 800 of a 1200 ledger);
    // Bob's two BALANCE_ONLY checkings (reachable 400 and 250; ledgers 450/300).
    const cashShare = (over: { id: string; balance: number; visibilityLevel?: string; owner?: string }): ShareRow => ({
      visibilityLevel: over.visibilityLevel ?? "BALANCE_ONLY",
      addedByUserId:   over.owner ?? "user_bob",
      addedByUser:     { firstName: "Bob", name: "Bob B" },
      financialAccount: {
        id: over.id, name: `Real ${over.id}`, type: "checking", institution: "Chase",
        balance: over.balance, currency: "USD", lastUpdated: T,
        creditLimit: null, debtSubtype: null, interestRate: null, minimumPayment: null,
      },
    });
    const { accounts: cashRows } = normalizeSharedAccounts([
      cashShare({ id: "fa_a_chk", balance: 1200, visibilityLevel: "FULL", owner: "user_alice" }),
      cashShare({ id: "fa_b_chk1", balance: 450 }),
      cashShare({ id: "fa_b_chk2", balance: 300 }),
    ]);
    // Server-resolved per-member claims (lib/balances) — what mount-composition
    // resolves per REAL account id before composing the payload.
    const claimByAccount = new Map([
      ["fa_a_chk",  { reachable: 800, unexplained: 0, state: "EXACT", pendingCount: 1 }],
      ["fa_b_chk1", { reachable: 400, unexplained: 0, state: "EXACT", pendingCount: 0 }],
      ["fa_b_chk2", { reachable: 250, unexplained: 0, state: "EXACT", pendingCount: 2 }],
    ]);
    const cashAgg = cashRows.find((a) => a.id.startsWith("balance-only:"))!;
    // mount-composition's composition rule, verbatim: aggregate rows compose
    // their members' resolved claims; FULL rows look up their own.
    const withState = cashRows.map((a) => ({
      id: a.id, name: a.name, type: a.type, institution: a.institution ?? "",
      balance: a.balance, currency: a.currency,
      currentState: a.aggregate
        ? aggregateCurrentCashState(a.aggregate.memberAccountIds.map((id) => claimByAccount.get(id)))
        : claimByAccount.get(a.id),
    }));

    check("aggregate row carries a composed currentState (no more synthetic-id miss)",
      withState.find((a) => a.id === cashAgg.id)?.currentState?.reachable === 650);

    // The widget headline (LiquidityWorkspace / section widgets all total
    // through reachableNow).
    const headline = reachableNow(withState);
    check("widget reachable-now = 1450 (currentState-resolved), NOT the 1950 ledger sum",
      headline.total === 1450 && headline.complete, String(headline.total));

    // The lens path: per-account rows, each with its own resolved claim.
    const liqRows: LiquidityAccountRow[] = [
      { id: "fa_a_chk",  type: "checking", balance: 1200, currency: "USD", lastUpdated: T.toISOString(), visibilityLevel: "FULL",         reachableCash: 800, unexplainedHold: 0 },
      { id: "fa_b_chk1", type: "checking", balance:  450, currency: "USD", lastUpdated: T.toISOString(), visibilityLevel: "BALANCE_ONLY", reachableCash: 400, unexplainedHold: 0 },
      { id: "fa_b_chk2", type: "checking", balance:  300, currency: "USD", lastUpdated: T.toISOString(), visibilityLevel: "BALANCE_ONLY", reachableCash: 250, unexplainedHold: 0 },
    ];
    const lens = computeLiquidity(SCOPE, OPTS, liqRows);
    check("lens 'Available as cash now' = 1450 — identical to the widget headline",
      lens.headline?.value === 1450 && lens.headline?.value === headline.total, String(lens.headline?.value));
    check("lens verdict prose states $1,450", (lens.verdict ?? "").includes("$1,450"), lens.verdict);

    // POPULATION IDENTITY: the lens's contributing account ids equal the widget
    // path's population — FULL ids plus the aggregate row's member ids.
    const widgetPopulation = cashRows
      .flatMap((a) => (a.aggregate ? a.aggregate.memberAccountIds : [a.id]))
      .sort();
    check("headline and lens resolve the IDENTICAL population (same real account ids)",
      JSON.stringify(widgetPopulation) === JSON.stringify([...lens.provenance.accountIds].sort()),
      `${widgetPopulation} vs ${lens.provenance.accountIds}`);

    // Weakest-member honesty: one member unknown → the aggregate claims null
    // and the widget EXCLUDES it under the word "reachable" (never the ledger).
    const oneUnknown = withState.map((a) =>
      a.id === cashAgg.id
        ? { ...a, currentState: aggregateCurrentCashState([claimByAccount.get("fa_b_chk1"), { reachable: null, unexplained: null, state: "UNAVAILABLE", pendingCount: 0 }]) }
        : a);
    const partial = reachableNow(oneUnknown);
    check("a member with UNKNOWN reachable fails the group closed (excluded + counted, ledger never substituted)",
      partial.total === 800 && partial.unknownCount === 1 && !partial.complete, String(partial.total));
  }

  console.log("(d) A SUMMARY_ONLY row contributes to NO balance total");
  {
    const { accounts: withSummary, redactedCount } = normalizeSharedAccounts([
      debtShare({ id: "fa_alice", balance: 1000, visibilityLevel: "FULL", owner: "user_alice" }),
      debtShare({ id: "fa_bob_1", balance:  500 }),
      debtShare({ id: "fa_bob_2", balance: -200 }),
      debtShare({ id: "fa_secret", balance: 10_000, visibilityLevel: "SUMMARY_ONLY" }),
    ]);
    const total = computeDebtKpis(withSummary.map((a) => ({
      id: a.id, name: a.name, type: a.type, institution: a.institution ?? "",
      balance: a.balance, currency: a.currency,
    }))).totalDebt;
    check("widget path: totals unchanged (1500) with the SUMMARY_ONLY card present", total === 1500, String(total));
    check("widget path: the withheld link is disclosed as redacted, not silently dropped", redactedCount === 1);
    check("widget path: the withheld balance appears in NO row",
      !JSON.stringify(withSummary).includes("10000"));

    // Lens path: the tier partition excludes it from every sum and every id,
    // and discloses it as a redaction (debt.core.ts fail-closed rule).
    const lens = computeDebt(SCOPE, OPTS, [
      ...lensRows,
      { id: "fa_secret", type: "debt", balance: 10_000, currency: "USD", lastUpdated: T.toISOString(), visibilityLevel: "SUMMARY_ONLY" },
    ]);
    check("lens path: total still 1500", lens.headline?.value === 1500, String(lens.headline?.value));
    check("lens path: summary-only counted + disclosed as a redaction",
      lens.provenance.tierCounts.summaryOnly === 1 &&
      lens.provenance.redactions.some((r) => r.includes("summary-only")));
    check("lens path: withheld id never in the contributing population",
      !lens.provenance.accountIds.includes("fa_secret"));
  }

  if (failures > 0) {
    console.error(`\naccount-privacy proof: ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll REVIEW-3 B-1 proof checks passed.");
}

main().catch((e) => {
  console.error("TEST CRASHED:", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
