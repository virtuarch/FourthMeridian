/**
 * scripts/diagnose-snapshot-anomaly.ts
 *
 * READ-ONLY diagnostic for the July 2 snapshot anomaly in Christian's Space.
 * Prints the evidence needed to decide between: legitimate pre-payroll history,
 * live/estimated boundary artifact, intraday live-row timing, transaction-date
 * bucketing, flat non-cash limitation, and writer sequencing.
 *
 * Strictly SELECT-only — no create/update/delete/upsert anywhere. Changes no
 * application behavior and no data. Uses the existing db singleton (lib/db.ts
 * imports only PrismaClient — no server-only chain), so it runs under tsx:
 *
 *   npx tsx scripts/diagnose-snapshot-anomaly.ts
 */

import { db } from "@/lib/db";

const SPACE_ID = "cmr456dtb0004117fjb6qavmm";
const FROM = new Date("2026-06-28T00:00:00.000Z");
const TO   = new Date("2026-07-05T23:59:59.999Z");
const TX_FROM = new Date("2026-07-01T00:00:00.000Z");
const TX_TO   = new Date("2026-07-04T23:59:59.999Z");

// ── tiny table printer ────────────────────────────────────────────────────────
function fmt(n: number | null | undefined, w = 10): string {
  if (n === null || n === undefined) return "—".padStart(w);
  return (Math.round(n * 100) / 100).toString().padStart(w);
}
function pad(s: string, w: number): string {
  const t = s.length > w ? s.slice(0, w - 1) + "…" : s;
  return t.padEnd(w);
}
function iso(d: Date): string { return d.toISOString().slice(0, 10); }
function isoTime(d: Date): string { return d.toISOString().replace("T", " ").slice(0, 19); }

async function main(): Promise<void> {
  console.log(`\n=== Snapshot anomaly diagnostic — Space ${SPACE_ID} ===\n`);

  // ── 0. Resolve the owner user (for the audit/plaid timeline) ────────────────
  const links = await db.spaceAccountLink.findMany({
    where:  { spaceId: SPACE_ID, status: "ACTIVE", financialAccount: { deletedAt: null } },
    select: {
      createdAt: true,
      financialAccount: {
        select: {
          id: true, name: true, institution: true, type: true, balance: true,
          creditLimit: true, debtSubtype: true, ownerUserId: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  const ownerUserId = links.map((l) => l.financialAccount.ownerUserId).find((u) => u) ?? null;

  // ── 1. Snapshot rows ────────────────────────────────────────────────────────
  const snaps = await db.spaceSnapshot.findMany({
    where:   { spaceId: SPACE_ID, date: { gte: FROM, lte: TO } },
    orderBy: { date: "asc" },
    select: {
      date: true, createdAt: true, isEstimated: true,
      cash: true, savings: true, debt: true, stocks: true, crypto: true,
      totalAssets: true, netWorth: true, netLiquid: true,
    },
  });

  const rows = snaps.map((s) => ({
    ...s,
    derivedRealAssets: s.totalAssets - s.stocks - s.crypto - s.cash - s.savings,
  }));

  console.log("1) SNAPSHOT ROWS (2026-06-28 → 2026-07-05)");
  console.log(
    pad("date", 11) + pad("live?", 7) + ["cash","savings","debt","stocks","crypto","realAst","totAsset","netWorth","netLiq"]
      .map((h) => h.padStart(10)).join("") + "  createdAt",
  );
  for (const r of rows) {
    console.log(
      pad(iso(r.date), 11) +
      pad(r.isEstimated ? "est" : "LIVE", 7) +
      fmt(r.cash) + fmt(r.savings) + fmt(r.debt) + fmt(r.stocks) + fmt(r.crypto) +
      fmt(r.derivedRealAssets) + fmt(r.totalAssets) + fmt(r.netWorth) + fmt(r.netLiquid) +
      "  " + isoTime(r.createdAt),
    );
  }
  if (rows.length === 0) console.log("  (no snapshot rows in range)");

  // Q5 arithmetic verification
  console.log("\n   Q5 arithmetic check (netWorth == totalAssets − debt; total == stocks+crypto):");
  let ok = true;
  for (const r of rows) {
    const nwOk = Math.abs(r.netWorth - (r.totalAssets - r.debt)) < 0.01;
    const nlOk = Math.abs(r.netLiquid - (r.cash + r.savings - r.debt)) < 0.01;
    if (!nwOk || !nlOk) { ok = false; console.log(`   ✗ ${iso(r.date)} netWorthOk=${nwOk} netLiquidOk=${nlOk}`); }
  }
  console.log(ok ? "   ✓ all rows satisfy the stored-column identities" : "   ✗ identity violation(s) above");

  // ── 2. Delta table ──────────────────────────────────────────────────────────
  console.log("\n2) ADJACENT-DAY DELTAS");
  console.log(
    pad("from→to", 24) + ["Δcash","Δsav","Δdebt","Δstk","Δcry","ΔrealA","Δasset","ΔnetW"]
      .map((h) => h.padStart(9)).join("") + "  boundary",
  );
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    const boundary = a.isEstimated !== b.isEstimated
      ? (a.isEstimated ? "est→LIVE" : "LIVE→est")
      : (a.isEstimated ? "est" : "live");
    console.log(
      pad(`${iso(a.date)}→${iso(b.date)}`, 24) +
      fmt(b.cash - a.cash, 9) + fmt(b.savings - a.savings, 9) + fmt(b.debt - a.debt, 9) +
      fmt(b.stocks - a.stocks, 9) + fmt(b.crypto - a.crypto, 9) +
      fmt(b.derivedRealAssets - a.derivedRealAssets, 9) +
      fmt(b.totalAssets - a.totalAssets, 9) + fmt(b.netWorth - a.netWorth, 9) +
      "  " + boundary,
    );
  }

  // ── 3. Timeline: audit + plaid ──────────────────────────────────────────────
  console.log("\n3) TIMELINE (writer triggers around Jul 1–4)");
  if (ownerUserId) {
    const audit = await db.auditLog.findMany({
      where:   { userId: ownerUserId, createdAt: { gte: FROM, lte: TO } },
      orderBy: { createdAt: "asc" },
      select:  { createdAt: true, action: true, metadata: true },
    });
    if (audit.length === 0) console.log("   (no AuditLog rows in range)");
    for (const a of audit) {
      console.log(`   ${isoTime(a.createdAt)}  ${pad(a.action, 22)} ${JSON.stringify(a.metadata ?? {})}`);
    }
    const items = await db.plaidItem.findMany({
      where:  { userId: ownerUserId },
      select: { institutionName: true, lastSyncedAt: true, lastManualRefreshAt: true, cursor: true, status: true },
    });
    console.log("\n   PlaidItems:");
    for (const it of items) {
      console.log(`   ${pad(it.institutionName, 20)} status=${it.status} lastSynced=${it.lastSyncedAt ? isoTime(it.lastSyncedAt) : "—"} lastManual=${it.lastManualRefreshAt ? isoTime(it.lastManualRefreshAt) : "—"} cursor=${it.cursor ? "set" : "null"}`);
    }
  } else {
    console.log("   (could not resolve owner userId — audit/plaid timeline skipped)");
  }
  console.log("   NOTE: SpaceSnapshot has createdAt only (no updatedAt) — a row's VALUES reflect the LAST");
  console.log("   write that day, whose time is not recorded. Judge intraday timing from the events above.");

  // ── 4. Linked accounts ──────────────────────────────────────────────────────
  console.log("\n4) LINKED ACCOUNTS");
  console.log(pad("name", 22) + pad("institution", 16) + pad("type", 10) + "balance".padStart(12) + "creditLim".padStart(12) + "  debtSubtype");
  for (const l of links) {
    const a = l.financialAccount;
    console.log(pad(a.name, 22) + pad(a.institution, 16) + pad(a.type, 10) + fmt(a.balance, 12) + fmt(a.creditLimit, 12) + "  " + (a.debtSubtype ?? "—"));
  }

  // ── 5. Transaction detail Jul 1–4 (checking/savings/debt) ───────────────────
  console.log("\n5) TRANSACTIONS Jul 1–4 (checking / savings / debt)");
  const acctById = new Map(links.map((l) => [l.financialAccount.id, l.financialAccount]));
  const includedIds = links
    .filter((l) => ["checking", "savings", "debt"].includes(l.financialAccount.type))
    .map((l) => l.financialAccount.id);
  const txns = includedIds.length === 0 ? [] : await db.transaction.findMany({
    where:   { financialAccountId: { in: includedIds }, deletedAt: null, date: { gte: TX_FROM, lte: TX_TO } },
    orderBy: [{ financialAccountId: "asc" }, { date: "asc" }],
    select:  { financialAccountId: true, date: true, merchant: true, description: true, amount: true, category: true, flowType: true, pending: true },
  });
  console.log(pad("date", 11) + pad("account", 18) + pad("type", 9) + pad("merchant", 20) + "amount".padStart(10) + "  " + pad("cat", 12) + pad("flow", 12) + "pending");
  for (const t of txns) {
    const a = t.financialAccountId ? acctById.get(t.financialAccountId) : undefined;
    console.log(
      pad(iso(t.date), 11) + pad(a?.name ?? "?", 18) + pad(a?.type ?? "?", 9) +
      pad(t.merchant ?? t.description ?? "", 20) + fmt(t.amount, 10) + "  " +
      pad(String(t.category), 12) + pad(String(t.flowType ?? "—"), 12) + (t.pending ? "PENDING" : "posted"),
    );
  }
  if (txns.length === 0) console.log("  (no transactions in range for included accounts)");

  // ── 6. Component verdict ────────────────────────────────────────────────────
  console.log("\n6) COMPONENT VERDICT");
  let worst: { pair: string; field: string; delta: number; boundary: string } | null = null;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    const boundary = a.isEstimated !== b.isEstimated ? (a.isEstimated ? "est→LIVE" : "LIVE→est") : "none";
    const comps: Record<string, number> = {
      cash: b.cash - a.cash, savings: b.savings - a.savings, debt: b.debt - a.debt,
      stocks: b.stocks - a.stocks, crypto: b.crypto - a.crypto, realAssets: b.derivedRealAssets - a.derivedRealAssets,
    };
    for (const [field, delta] of Object.entries(comps)) {
      if (!worst || Math.abs(delta) > Math.abs(worst.delta)) {
        worst = { pair: `${iso(a.date)}→${iso(b.date)}`, field, delta, boundary };
      }
    }
  }
  if (worst) {
    console.log(`   Largest single-component move: ${worst.field} Δ${fmt(worst.delta).trim()} at ${worst.pair} (boundary: ${worst.boundary})`);
    const hint =
      worst.field === "debt" ? "→ debt movement (Slice 4B card reconstruction) — affects netWorth/netLiquid, NOT totalAssets"
      : (worst.field === "stocks" || worst.field === "crypto" || worst.field === "realAssets")
        ? (worst.boundary !== "none"
            ? "→ non-cash changed AT an estimated↔live boundary ⇒ FLAT-NON-CASH / LIVE-vs-ESTIMATED discontinuity"
            : "→ non-cash changed WITHOUT a boundary flip ⇒ unexpected (non-cash should be flat within estimated rows)")
      : /* cash / savings */
        (worst.boundary !== "none"
          ? "→ cash moved AT a boundary ⇒ check live-row timing (Section 3) vs a real Jul-2 txn (Section 5)"
          : "→ cash moved within estimated rows ⇒ driven by a transaction; check Section 5 (and its date for bucketing)");
    console.log(`   ${hint}`);
    console.log("   Cross-check: is the payroll in Section 5 dated 2026-07-02 (not 07-01/07-03)? If shifted ⇒ date bucketing.");
  } else {
    console.log("   (not enough rows to compute a verdict)");
  }

  console.log("\n=== end diagnostic (read-only; no data changed) ===\n");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
