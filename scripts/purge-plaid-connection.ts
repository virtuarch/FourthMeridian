/**
 * scripts/purge-plaid-connection.ts
 *
 * One-off, tightly-scoped purge of a single user's Plaid connection (matched by
 * institution name), for the case where the account needs to come back CLEAN —
 * with no stale/partial rows left behind to collide with a full resync.
 *
 * Immediate motivation (2026-07-13): an Amex connection Chris added tonight only
 * got a partial (~32-transaction) sync due to the bug fixed in the
 * transaction-sync / investment-history batch. He wants it gone PERMANENTLY —
 * not soft-deleted-and-reconnectable — so a later clean reconnect can't collide
 * with tonight's stale partial rows.
 *
 * Why this is NOT the existing DELETE route / cleanup-orphaned-plaid-items.ts:
 * those SOFT-delete (deletedAt) the FinancialAccount + AccountConnection. A soft
 * delete does NOT cascade transactions/holdings/positions away (cascade only
 * fires on a real row DELETE). This script does an actual HARD delete of the
 * matched FinancialAccount row(s), which cascades Transaction / Holding /
 * PositionObservation / InvestmentEvent / etc. per the schema's onDelete:
 * Cascade relations, then deletes the now-empty PlaidItem row itself.
 *
 * GLOBAL DATA IS UNTOUCHED BY CONSTRUCTION. Instrument and PriceObservation are
 * GLOBAL (shared across all users). They are PARENTS in the graph — Holding /
 * PositionObservation / PositionReconstruction / PriceObservation reference
 * Instrument via onDelete: Restrict FKs. A cascade only ever flows parent→child
 * (delete a FinancialAccount ⇒ delete its Holdings), never child→parent (delete
 * a Holding does NOT touch its Instrument). So a correct cascade-based deletion
 * cannot delete an Instrument or PriceObservation row. This script asserts that
 * empirically: it counts both tables globally before and after --apply and
 * aborts if either count changes. This script NEVER issues a delete against
 * Instrument or PriceObservation — if it ever needed to, that would be a bug.
 *
 * Plaid-side severance reuses lib/plaid/disconnect.ts's
 * disconnectPlaidItemIfOrphaned() (the same decrypt + plaidClient.itemRemove()
 * logic the manual-delete route and cleanup-orphaned-plaid-items.ts already
 * use) rather than reimplementing token decryption. That function only calls
 * itemRemove() once ZERO live AccountConnections remain on the item, so --apply
 * soft-deletes the item's live connections first (they are hard-deleted via the
 * FinancialAccount cascade moments later regardless) purely to satisfy that
 * contract. Best-effort: a failed itemRemove() is logged inside that function
 * and does not block local deletion (the Plaid token is gone at Plaid's end
 * either way; the user relinks via Plaid Link regardless).
 *
 * SCOPING: never operates on all PlaidItems or all users. It resolves exactly
 * one user (by email) and only matches PlaidItems whose institutionName matches
 * the institution filter (default: amex / american express, case-insensitive).
 *
 * Usage:
 *   npx tsx scripts/purge-plaid-connection.ts \
 *     [--email <login-email>] [--institution <substring>] [--apply]
 *
 *   (default)      DRY RUN. Resolves the user, finds matching PlaidItem(s),
 *                  prints full detail (item id, institution, status, createdAt,
 *                  every linked FinancialAccount name + mask, and the counts of
 *                  rows that WOULD be cascade-deleted). Zero DB writes, zero
 *                  Plaid calls. Irreversible when applied — read this output
 *                  carefully and confirm it is ONLY the intended connection.
 *   --email        Login email of the account to scope to.
 *                  Default: chr.hogan1997@gmail.com (confirm against the real
 *                  dev-DB user printed in the dry-run before applying).
 *   --institution  Case-insensitive substring matched against
 *                  PlaidItem.institutionName. Default: matches "amex" OR
 *                  "american express".
 *   --apply        Perform the severance + hard deletes for real.
 *
 * Irreversible. Do NOT run --apply without visually confirming the dry-run
 * output is the exact connection to remove and nothing else.
 */

import { db } from "@/lib/db";
import { disconnectPlaidItemIfOrphaned } from "@/lib/plaid/disconnect";

const APPLY = process.argv.includes("--apply");

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const EMAIL = (argValue("--email") ?? "chr.hogan1997@gmail.com").trim();
// Default institution matcher: amex OR american express (case-insensitive).
const INSTITUTION_ARG = argValue("--institution");
function institutionMatches(name: string): boolean {
  const n = name.toLowerCase();
  if (INSTITUTION_ARG) return n.includes(INSTITUTION_ARG.toLowerCase());
  return n.includes("amex") || n.includes("american express");
}

function hr() { console.log("──────────────────────────────────────────────────────────"); }

async function main() {
  console.log(`\n${APPLY ? "" : "[DRY RUN] "}Purge Plaid connection`);
  console.log(`Mode:        ${APPLY ? "LIVE — will sever at Plaid + HARD DELETE rows" : "dry-run (no writes, no Plaid calls)"}`);
  console.log(`User email:  ${EMAIL}`);
  console.log(`Institution: ${INSTITUTION_ARG ? `substring "${INSTITUTION_ARG}"` : `"amex" or "american express"`} (case-insensitive)\n`);

  // ── Resolve the user (never assume; print who this actually is) ─────────────
  const user = await db.user.findUnique({
    where:  { email: EMAIL },
    select: { id: true, email: true, name: true, username: true },
  });
  if (!user) {
    console.error(`❌ No user found with email "${EMAIL}". Aborting — nothing scoped, nothing touched.`);
    console.error(`   (Re-run with --email <the actual dev-DB login email>. Available emails:)`);
    const users = await db.user.findMany({ select: { email: true, username: true, name: true } });
    for (const u of users) console.error(`     - ${u.email}  (username=${u.username ?? "—"}, name=${u.name ?? "—"})`);
    process.exitCode = 1;
    return;
  }
  console.log(`Resolved user: id=${user.id}  email=${user.email}  username=${user.username ?? "—"}  name=${user.name ?? "—"}`);
  console.log(`(Confirm this is the account Chris is currently logged in as before --apply.)\n`);

  // ── Global safety baseline: Instrument + PriceObservation must never change ──
  const instrumentsBefore      = await db.instrument.count();
  const priceObservationsBefore = await db.priceObservation.count();
  console.log(`Global safety baseline — Instrument rows: ${instrumentsBefore}, PriceObservation rows: ${priceObservationsBefore}`);
  console.log(`(These are GLOBAL/shared and MUST be identical after --apply.)\n`);

  // ── Find matching PlaidItem(s) for THIS user only ───────────────────────────
  const items = await db.plaidItem.findMany({
    where:  { userId: user.id },
    select: { id: true, externalItemId: true, institutionName: true, institutionId: true, status: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const matched = items.filter((it) => institutionMatches(it.institutionName));

  if (matched.length === 0) {
    console.log(`No PlaidItem for user ${user.email} matches the institution filter. Nothing to do.`);
    console.log(`(User has ${items.length} PlaidItem(s) total: ${items.map((i) => i.institutionName).join(", ") || "none"}.)`);
    return;
  }

  console.log(`Matched ${matched.length} PlaidItem(s) for this user + institution filter:\n`);

  // Accumulators for the final summary
  let totalAccounts = 0;
  const cascadeTotals = { transactions: 0, holdings: 0, positionObservations: 0, investmentEvents: 0, positionReconstructions: 0, importBatches: 0, accountConnections: 0 };

  for (const item of matched) {
    hr();
    console.log(`PlaidItem ${item.id}`);
    console.log(`  institution:    ${item.institutionName} (institutionId=${item.institutionId})`);
    console.log(`  externalItemId: ${item.externalItemId}`);
    console.log(`  status:         ${item.status}`);
    console.log(`  createdAt:      ${item.createdAt.toISOString()}`);

    // Linked FinancialAccounts via this item's AccountConnections (live or not —
    // we hard-delete the accounts regardless of connection soft-delete state).
    const connections = await db.accountConnection.findMany({
      where:  { plaidItemDbId: item.id },
      select: {
        id: true, deletedAt: true, financialAccountId: true,
        financialAccount: { select: { id: true, name: true, mask: true, type: true, institution: true, plaidAccountId: true, deletedAt: true } },
      },
    });

    const accounts = connections
      .map((c) => c.financialAccount)
      .filter((a): a is NonNullable<typeof a> => a !== null);
    // de-dupe (an account could in principle have >1 connection to the item)
    const uniqueAccounts = [...new Map(accounts.map((a) => [a.id, a])).values()];

    console.log(`  AccountConnections on item: ${connections.length} (${connections.filter((c) => c.deletedAt === null).length} live, ${connections.filter((c) => c.deletedAt !== null).length} soft-deleted)`);
    console.log(`  Linked FinancialAccount(s): ${uniqueAccounts.length}`);

    const accountIds = uniqueAccounts.map((a) => a.id);
    totalAccounts += uniqueAccounts.length;
    cascadeTotals.accountConnections += connections.length;

    for (const a of uniqueAccounts) {
      console.log(`    • "${a.name}"  mask=${a.mask ?? "—"}  type=${a.type}  institution=${a.institution}  plaidAccountId=${a.plaidAccountId ?? "—"}${a.deletedAt ? "  [already soft-deleted]" : ""}`);
    }

    if (accountIds.length > 0) {
      const [tx, hold, pos, evt, recon, imports] = await Promise.all([
        db.transaction.count({ where: { financialAccountId: { in: accountIds } } }),
        db.holding.count({ where: { financialAccountId: { in: accountIds } } }),
        db.positionObservation.count({ where: { financialAccountId: { in: accountIds } } }),
        db.investmentEvent.count({ where: { financialAccountId: { in: accountIds } } }),
        db.positionReconstruction.count({ where: { financialAccountId: { in: accountIds } } }),
        db.importBatch.count({ where: { financialAccountId: { in: accountIds } } }),
      ]);
      cascadeTotals.transactions += tx;
      cascadeTotals.holdings += hold;
      cascadeTotals.positionObservations += pos;
      cascadeTotals.investmentEvents += evt;
      cascadeTotals.positionReconstructions += recon;
      cascadeTotals.importBatches += imports;
      console.log(`  Rows that WOULD cascade-delete for these account(s):`);
      console.log(`    transactions=${tx}  holdings=${hold}  positionObservations=${pos}  investmentEvents=${evt}  positionReconstructions=${recon}  importBatches=${imports}`);
    }
  }
  hr();

  console.log(`\nTOTAL to be removed across matched item(s):`);
  console.log(`  PlaidItems:              ${matched.length}`);
  console.log(`  FinancialAccounts:       ${totalAccounts}`);
  console.log(`  AccountConnections:      ${cascadeTotals.accountConnections}`);
  console.log(`  Transactions:            ${cascadeTotals.transactions}`);
  console.log(`  Holdings:                ${cascadeTotals.holdings}`);
  console.log(`  PositionObservations:    ${cascadeTotals.positionObservations}`);
  console.log(`  InvestmentEvents:        ${cascadeTotals.investmentEvents}`);
  console.log(`  PositionReconstructions: ${cascadeTotals.positionReconstructions}`);
  console.log(`  ImportBatches:           ${cascadeTotals.importBatches}`);
  console.log(`  Instrument / PriceObservation: 0 (global — untouched by construction)\n`);

  if (!APPLY) {
    console.log("DRY RUN — no rows written, no Plaid calls made.");
    console.log("If this is exactly the connection to remove, re-run with --apply.\n");
    return;
  }

  // ── APPLY ───────────────────────────────────────────────────────────────────
  console.log("APPLYING — this is irreversible.\n");
  for (const item of matched) {
    // (a) Sever at Plaid, reusing lib/plaid/disconnect.ts. That function only
    //     calls itemRemove() when zero live AccountConnections remain, so
    //     soft-delete the item's live connections first (they get hard-deleted
    //     by the FinancialAccount cascade in the transaction below regardless).
    const softDeleted = await db.accountConnection.updateMany({
      where: { plaidItemDbId: item.id, deletedAt: null },
      data:  { deletedAt: new Date() },
    });
    console.log(`[${item.id}] soft-deleted ${softDeleted.count} live connection(s) to satisfy disconnect gate; calling Plaid itemRemove…`);
    await disconnectPlaidItemIfOrphaned(item.id); // decrypt + plaidClient.itemRemove() + status=REVOKED (best-effort)

    // (b)+(c) Atomic local hard-delete: FinancialAccount rows (cascade), then
    //         the now-empty PlaidItem row. Re-derive the account ids from this
    //         item's connections (still present — soft-delete only set deletedAt).
    const connsForItem = await db.accountConnection.findMany({
      where: { plaidItemDbId: item.id }, select: { financialAccountId: true },
    });
    const acctIds = [...new Set(connsForItem.map((c) => c.financialAccountId))];

    await db.$transaction(async (tx) => {
      for (const id of acctIds) {
        await tx.financialAccount.delete({ where: { id } }); // cascades tx/holdings/positions/events/etc.
      }
      await tx.plaidItem.delete({ where: { id: item.id } });
    });
    console.log(`[${item.id}] hard-deleted ${acctIds.length} FinancialAccount(s) (cascaded) + the PlaidItem row.`);
  }

  // ── Global safety assertion ─────────────────────────────────────────────────
  const instrumentsAfter       = await db.instrument.count();
  const priceObservationsAfter  = await db.priceObservation.count();
  hr();
  console.log(`Global safety assertion:`);
  console.log(`  Instrument:       before=${instrumentsBefore} after=${instrumentsAfter}  ${instrumentsBefore === instrumentsAfter ? "✓ unchanged" : "✗ CHANGED"}`);
  console.log(`  PriceObservation: before=${priceObservationsBefore} after=${priceObservationsAfter}  ${priceObservationsBefore === priceObservationsAfter ? "✓ unchanged" : "✗ CHANGED"}`);
  if (instrumentsBefore !== instrumentsAfter || priceObservationsBefore !== priceObservationsAfter) {
    throw new Error("SAFETY VIOLATION: global Instrument/PriceObservation count changed — this must never happen. Investigate immediately.");
  }
  hr();
  console.log(`\n✅ Done. Severed at Plaid + hard-deleted: ${matched.length} PlaidItem(s), ${totalAccounts} FinancialAccount(s) and all cascaded rows.`);
  console.log(`   Global Instrument/PriceObservation rows untouched (asserted).`);
  console.log(`   A fresh Plaid Link reconnect of this Amex account should now be collision-free.\n`);
}

main()
  .catch((e) => { console.error("❌ purge-plaid-connection failed:", e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
