/**
 * lib/history/account-series.test.ts
 *
 * V27-C — the account level. DB-free: the Prisma client is a stub, so this runs
 * in the unit runner without `prisma generate`.
 */

import assert from "node:assert/strict";
import { eachDate } from "./account-series";
import { expandBucketNode } from "./bucket-node";
import type { HistoricalBucketNode } from "./historical-node.core";

const checks: string[] = [];
const ok = (label: string) => checks.push(label);

const TODAY = new Date().toISOString().slice(0, 10);

function bucket(over: Partial<HistoricalBucketNode> = {}): HistoricalBucketNode {
  return {
    nodeType: "bucket", id: "bucket:cash", label: "Cash", bucketKind: "cash", subtracts: false,
    dateISO: "2026-01-15", fromISO: "2025-01-15", toISO: "2026-01-15", currency: "USD",
    displayedValue: 1000, explainedValue: null, unattributedObservedAmount: null,
    reconciliation: "EXACT", assertable: true, unavailableReason: null,
    provenance: { basis: "observed", tier: "observed", supportedFromISO: null, supportedToISO: null, note: null },
    breadcrumb: [{ id: "net-worth", label: "Net worth", nodeType: "lens" }],
    components: [], drilldown: { available: true, reason: null },
    historicalCount: 0, valuedCount: 0,
    ...over,
  };
}

/** A Prisma stand-in serving one checking account and its transactions. */
function stubClient(accounts: { id: string; name: string; balance: number; floor: string }[],
                    txs: { financialAccountId: string; date: string; amount: number }[]) {
  return {
    spaceAccountLink: {
      findMany: async () => accounts.map((a) => ({
        createdAt: new Date(`${a.floor}T00:00:00Z`),
        financialAccount: {
          id: a.id, name: a.name, type: "checking", institution: "Test", balance: a.balance,
          debtSubtype: null, creditLimit: null, createdAt: new Date(`${a.floor}T00:00:00Z`),
          nativeBalance: null, lastUpdated: new Date(), currency: "USD",
        },
      })),
    },
    transaction: {
      // POSTED-ONLY by construction: the stub asserts the caller asked for it,
      // because reversing an unsettled row against a posted anchor is exactly
      // the phantom the reconstruction-basis guard exists to prevent.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      groupBy: async (q: any) => {
        assert.equal(q.where.pending, false, "the delta gather is posted-only");
        assert.equal(q.where.deletedAt, null, "the delta gather excludes deleted rows");
        return txs.map((t) => ({
          financialAccountId: t.financialAccountId,
          date: new Date(`${t.date}T00:00:00Z`),
          _sum: { amount: t.amount },
        }));
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function run() {
  // ── eachDate: inclusive on BOTH bounds ────────────────────────────────────
  assert.deepEqual(eachDate("2026-01-01", "2026-01-03"), ["2026-01-01", "2026-01-02", "2026-01-03"]);
  assert.deepEqual(eachDate("2026-01-01", "2026-01-01"), ["2026-01-01"]);
  assert.deepEqual(eachDate("2026-01-03", "2026-01-01"), []);
  ok("eachDate is inclusive on both bounds and empty when reversed");

  // ── A bucket the lens already refused is NOT expanded ──────────────────────
  //
  // Expanding it would render a composition beneath a value nothing may assert.
  const refused = bucket({ assertable: false, reconciliation: "UNAVAILABLE", displayedValue: null,
    drilldown: { available: false, reason: "AGGREGATE_COMPONENT_UNASSERTABLE" } });
  assert.deepEqual(await expandBucketNode({ spaceId: "s", bucket: refused, client: stubClient([], []) }), refused);
  ok("a refused bucket is returned unchanged, never expanded");

  // ── Real assets have no account level AT ALL ──────────────────────────────
  //
  // Distinct from "no accounts": there is no such level, not an empty one.
  const real = await expandBucketNode({
    spaceId: "s", client: stubClient([], []),
    bucket: bucket({ bucketKind: "real-assets", id: "bucket:real-assets", label: "Real assets" }),
  });
  assert.equal(real.drilldown.available, false);
  assert.equal(real.drilldown.reason, "NO_ACCOUNT_LEVEL_FOR_THIS_BUCKET");
  assert.equal(real.components.length, 0);
  ok("real assets report NO_ACCOUNT_LEVEL, not an empty account set");

  // ── The walk: today anchors, transactions are subtracted going back ────────
  //
  // Balance today 1000; a +200 deposit dated yesterday ⇒ 800 the day before.
  const yday = eachDate(TODAY, TODAY)[0];
  const client = stubClient(
    [{ id: "a1", name: "Everyday", balance: 1000, floor: "2020-01-01" }],
    [{ financialAccountId: "a1", date: yday, amount: 200 }],
  );
  const expanded = await expandBucketNode({
    spaceId: "s", client,
    bucket: bucket({ dateISO: TODAY, fromISO: "2026-01-01", toISO: TODAY, displayedValue: 1000 }),
  });

  assert.equal(expanded.components.length, 1);
  const acct = expanded.components[0];
  assert.equal(acct.nodeType, "account");
  assert.equal(acct.displayedValue, 1000);
  // PRECEDENCE RULE 1 — the present is an OBSERVATION, never a reconstruction.
  assert.equal(acct.provenance.basis, "observed");
  assert.equal(acct.provenance.tier, "observed");
  ok("the present date resolves as observed, not reconstructed");

  // ── Window inheritance: the child series spans the PARENT's window ─────────
  assert.equal(acct.fromISO, "2026-01-01");
  assert.equal(acct.toISO, TODAY);
  assert.ok(acct.series && acct.series.length > 1, "a series was produced");
  assert.equal(acct.series![0].dateISO, "2026-01-01");
  assert.equal(acct.series![acct.series!.length - 1].dateISO, TODAY);
  ok("an account series spans exactly the inherited window");

  // ── Before the account existed is UNAVAILABLE, never a projected balance ───
  const early = await expandBucketNode({
    spaceId: "s", client: stubClient([{ id: "a1", name: "New", balance: 500, floor: "2026-06-01" }], []),
    bucket: bucket({ dateISO: "2026-01-15", fromISO: "2026-01-01", toISO: "2026-01-15" }),
  });
  const newAcct = early.components[0];
  assert.equal(newAcct.displayedValue, null);
  assert.equal(newAcct.unavailableReason, "BEFORE_ACCOUNT_COVERAGE");
  assert.equal(newAcct.provenance.tier, "incomplete");
  assert.equal(newAcct.provenance.supportedFromISO, "2026-06-01");
  ok("a date before the account's floor is UNAVAILABLE, not a back-projected balance");

  // ── Reconciliation: children UNDER the parent leave a remainder … ──────────
  const under = await expandBucketNode({
    spaceId: "s", client: stubClient([{ id: "a1", name: "One", balance: 800, floor: "2020-01-01" }], []),
    bucket: bucket({ dateISO: TODAY, toISO: TODAY, displayedValue: 1000 }),
  });
  assert.equal(under.reconciliation, "PARTIALLY_ATTRIBUTED");
  assert.equal(under.explainedValue, 800);
  assert.equal(under.unattributedObservedAmount, 200);
  ok("children under the parent yield PARTIALLY_ATTRIBUTED with a stated remainder");

  // ── … but children OVER the parent are a CONTRADICTION ────────────────────
  //
  // A remainder is what the parent has left to explain. Children that EXCEED it
  // cannot be a remainder in any direction, so the evidence disagrees with
  // itself and the composition is refused rather than shown with a negative gap.
  const over = await expandBucketNode({
    spaceId: "s", client: stubClient([{ id: "a1", name: "One", balance: 5000, floor: "2020-01-01" }], []),
    bucket: bucket({ dateISO: TODAY, toISO: TODAY, displayedValue: 1000 }),
  });
  assert.equal(over.reconciliation, "CONTRADICTORY");
  assert.equal(over.unavailableReason, "ACCOUNTS_CONTRADICT_BUCKET_TOTAL");
  // The VALUE is still assertable — only its COMPOSITION is refused.
  assert.equal(over.assertable, true);
  ok("children exceeding the parent are CONTRADICTORY, and only the composition is refused");

  // ── A bucket with no accounts says so ─────────────────────────────────────
  const none = await expandBucketNode({ spaceId: "s", bucket: bucket(), client: stubClient([], []) });
  assert.equal(none.drilldown.available, false);
  assert.equal(none.drilldown.reason, "NO_ACCOUNTS_IN_BUCKET");
  assert.equal(none.explainedValue, null);
  ok("an empty bucket reports NO_ACCOUNTS_IN_BUCKET and explains nothing");

  // ── The authority owns no reconstruction of its own ──────────────────────
  //
  // Asserting INTENT, not a lexical proxy: this module must route every asset
  // class through an authority that already exists, and must NOT reach the
  // walk-back primitives itself. A second importer of those is a second
  // reconstruction basis — the failure the reconstruction-basis guard exists to
  // catch, and the one that once reversed unsettled rows against a posted
  // anchor and put phantom cash in Assets.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./account-series.ts", import.meta.url), "utf8");

  assert.ok(!/reconstructDaily(Cash|Liability)Balances/.test(src),
    "the historical layer does not touch the walk-back primitives directly");
  for (const authority of [
    "getAccountBalancesOverWindow",  // cash / savings / debt — the sanctioned resolver
    "historicalHoldingsForWindow",   // investments — the one holdings authority
    "valueCryptoDay",                // crypto — the one day valuation
    "licenseConstantQuantityCarry",  // crypto — the carry licence
    "reconcileWalletLedger",         // crypto — ledger completeness gates history
    "classifyAccounts",              // FX — the path every stored total took
  ]) {
    assert.ok(src.includes(authority), `${authority} is consumed, not reimplemented`);
  }
  assert.ok(!/\.(create|update|delete|upsert|createMany|updateMany)\(/.test(src), "no writes");
  ok("every asset class routes through an existing authority; no walk primitives, no writes");

  for (const c of checks) console.log("  ✓ " + c);
  console.log(`account-series: ${checks.length} checks passed`);
}

run().catch((e) => { console.error(e); process.exit(1); });
