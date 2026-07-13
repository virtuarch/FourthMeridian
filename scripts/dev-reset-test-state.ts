/**
 * scripts/dev-reset-test-state.ts
 *
 * Reusable clean-slate reset for ONE user's connected-account test state — run
 * before each retest so the next connect is against genuinely fresh state
 * (rather than purging one connection at a time with purge-plaid-connection.ts).
 *
 * Covers BOTH provider families: Plaid (PlaidItem-anchored) AND non-Plaid
 * provider connections (Connection-anchored — WALLET today, generalizing to any
 * future non-Plaid provider). The wallet branch was added because wallet
 * accounts have NO PlaidItem — they live in Connection(provider != PLAID),
 * ProviderAccountIdentity, and a wallet/crypto-typed FinancialAccount — so a
 * Plaid-only walk left them behind while Step 2's provider-agnostic snapshot
 * wipe cleared their history, stranding a no-history wallet entry.
 *
 * Scoped to a single user (default chr.hogan1997@gmail.com). Removes:
 *   1. ALL that user's PlaidItems — severed at Plaid first via
 *      disconnectPlaidItemIfOrphaned() (itemRemove), then HARD-deleted so the
 *      FinancialAccount / Transaction / Holding / PositionObservation /
 *      InvestmentEvent / PositionReconstruction / ImportBatch children cascade.
 *   1b. ALL that user's non-Plaid Connections (provider != PLAID). No external
 *      sever exists (wallets are watch-only), so each is HARD-deleted directly:
 *      the FinancialAccount delete cascades AccountConnection /
 *      ProviderAccountIdentity / Transaction / Holding / etc. (onDelete: Cascade),
 *      then the Connection row itself is deleted.
 *   2. ALL SpaceSnapshot rows for that user's PERSONAL Space — full history, for
 *      a genuine from-zero backfill test (not just today's row). Shared Spaces
 *      are deliberately left alone: their snapshots belong to all members.
 *   3. Recent-Activity noise NARROWLY — the ACCOUNT_ADD/ACCOUNT_REMOVE rows whose
 *      metadata.institution matches a removed Plaid item, AND the WALLET_ADD/
 *      WALLET_REMOVE rows whose metadata.name/.address matches a removed wallet
 *      connection. Never a blanket activity clear (append-only log).
 *
 * NEVER touches Instrument / PriceObservation (GLOBAL, shared across users) or
 * any other user's data — asserted empirically (global counts unchanged).
 *
 * Default = DRY RUN (zero writes, zero Plaid calls). Re-run with --apply.
 *   npx tsx scripts/dev-reset-test-state.ts                    # dry-run
 *   npx tsx scripts/dev-reset-test-state.ts --apply            # perform
 *   flags: --email <login-email>
 *
 * Irreversible when applied. Read the dry-run output before --apply.
 */

import { db } from "@/lib/db";
import { disconnectPlaidItemIfOrphaned } from "@/lib/plaid/disconnect";

const APPLY = process.argv.includes("--apply");
function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const EMAIL = (argValue("--email") ?? "chr.hogan1997@gmail.com").trim();

function hr() { console.log("──────────────────────────────────────────────────────────"); }
function isInstitutionMatch(institution: unknown, names: Set<string>): boolean {
  return typeof institution === "string" && names.has(institution.toLowerCase());
}

async function main() {
  console.log(`\n${APPLY ? "" : "[DRY RUN] "}dev reset test state`);
  console.log(`Mode:       ${APPLY ? "LIVE — sever at Plaid + HARD DELETE" : "dry-run (no writes, no Plaid calls)"}`);
  console.log(`User email: ${EMAIL}\n`);

  // ── Resolve the user (never assume; print who this is) ──────────────────────
  const user = await db.user.findUnique({
    where:  { email: EMAIL },
    select: { id: true, email: true, username: true, name: true },
  });
  if (!user) {
    console.error(`❌ No user "${EMAIL}". Available:`);
    for (const u of await db.user.findMany({ select: { email: true, username: true } })) {
      console.error(`   - ${u.email} (username=${u.username ?? "—"})`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Resolved user: id=${user.id} email=${user.email} username=${user.username ?? "—"} name=${user.name ?? "—"}\n`);

  // ── Global safety baseline (must be identical after --apply) ────────────────
  const instrumentsBefore       = await db.instrument.count();
  const priceObservationsBefore = await db.priceObservation.count();
  console.log(`Global safety baseline — Instrument: ${instrumentsBefore}, PriceObservation: ${priceObservationsBefore} (GLOBAL — must be unchanged)\n`);

  // ── 1. This user's PlaidItems + cascade preview ─────────────────────────────
  hr(); console.log("1. PlaidItems (all of this user's) + cascaded rows\n");
  const items = await db.plaidItem.findMany({
    where:  { userId: user.id },
    select: { id: true, externalItemId: true, institutionName: true, status: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const institutionNames = new Set(items.map((i) => i.institutionName.toLowerCase()));
  let totalAccounts = 0;
  const cascade = { transactions: 0, holdings: 0, positionObservations: 0, investmentEvents: 0, positionReconstructions: 0, importBatches: 0, accountConnections: 0 };
  const allAccountIds: string[] = [];

  if (items.length === 0) console.log("  (none)");
  for (const item of items) {
    const conns = await db.accountConnection.findMany({
      where:  { plaidItemDbId: item.id },
      select: { id: true, financialAccount: { select: { id: true, name: true, mask: true, type: true } } },
    });
    const accounts = [...new Map(conns.map((c) => c.financialAccount).filter((a): a is NonNullable<typeof a> => a != null).map((a) => [a.id, a])).values()];
    const accountIds = accounts.map((a) => a.id);
    allAccountIds.push(...accountIds);
    totalAccounts += accounts.length;
    cascade.accountConnections += conns.length;
    console.log(`  • ${item.institutionName} [${item.status}] item=${item.id} — ${accounts.length} account(s): ${accounts.map((a) => `"${a.name}"(${a.type})`).join(", ") || "none"}`);
    if (accountIds.length > 0) {
      const [tx, hold, pos, evt, recon, imports] = await Promise.all([
        db.transaction.count({ where: { financialAccountId: { in: accountIds } } }),
        db.holding.count({ where: { financialAccountId: { in: accountIds } } }),
        db.positionObservation.count({ where: { financialAccountId: { in: accountIds } } }),
        db.investmentEvent.count({ where: { financialAccountId: { in: accountIds } } }),
        db.positionReconstruction.count({ where: { financialAccountId: { in: accountIds } } }),
        db.importBatch.count({ where: { financialAccountId: { in: accountIds } } }),
      ]);
      cascade.transactions += tx; cascade.holdings += hold; cascade.positionObservations += pos;
      cascade.investmentEvents += evt; cascade.positionReconstructions += recon; cascade.importBatches += imports;
      console.log(`      cascade: transactions=${tx} holdings=${hold} positionObservations=${pos} investmentEvents=${evt} positionReconstructions=${recon} importBatches=${imports}`);
    }
  }
  console.log(`  TOTAL: ${items.length} PlaidItem(s), ${totalAccounts} FinancialAccount(s), ${cascade.accountConnections} connection(s), ${cascade.transactions} tx, ${cascade.holdings} holdings, ${cascade.positionObservations} positionObs, ${cascade.investmentEvents} events, ${cascade.positionReconstructions} recon, ${cascade.importBatches} importBatches\n`);

  // ── 1b. This user's non-Plaid provider Connections + cascade preview ────────
  // Wallet accounts (and any future non-Plaid provider) have NO PlaidItem, so
  // the Plaid walk above never sees them. Discover them via Connection anchored
  // by provider != PLAID (the same provider-agnostic condition Connection's own
  // schema uses), and resolve their FinancialAccount(s) through
  // AccountConnection.connectionId — the wallet counterpart to plaidItemDbId.
  hr(); console.log("1b. Non-Plaid provider Connections (provider != PLAID) + cascaded rows\n");
  const connections = await db.connection.findMany({
    where:  { userId: user.id, provider: { not: "PLAID" } },
    select: {
      id: true, provider: true, externalConnectionId: true, status: true, createdAt: true,
      accountConnections: { select: { financialAccountId: true, financialAccount: { select: { id: true, name: true, mask: true, type: true } } } },
      providerAccountIdentities: { select: { id: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  // Identifiers used to attribute WALLET_ADD/REMOVE audit rows in Step 3 below:
  // the FA display name and the wallet address (bare + the "CHAIN:addr" form).
  const walletAuditKeys = new Set<string>();
  const walletCascade = { transactions: 0, holdings: 0, positionObservations: 0, investmentEvents: 0, positionReconstructions: 0, importBatches: 0, accountConnections: 0, providerIdentities: 0 };
  const connAccountIds: string[] = [];
  let totalWalletAccounts = 0;

  if (connections.length === 0) console.log("  (none)");
  for (const conn of connections) {
    const accounts = [...new Map(conn.accountConnections.map((c) => c.financialAccount).filter((a): a is NonNullable<typeof a> => a != null).map((a) => [a.id, a])).values()];
    const accountIds = accounts.map((a) => a.id);
    connAccountIds.push(...accountIds);
    totalWalletAccounts += accounts.length;
    walletCascade.accountConnections += conn.accountConnections.length;
    walletCascade.providerIdentities += conn.providerAccountIdentities.length;
    accounts.forEach((a) => walletAuditKeys.add(a.name.toLowerCase()));
    if (conn.externalConnectionId) {
      walletAuditKeys.add(conn.externalConnectionId.toLowerCase());
      const bare = conn.externalConnectionId.includes(":") ? conn.externalConnectionId.slice(conn.externalConnectionId.indexOf(":") + 1) : conn.externalConnectionId;
      walletAuditKeys.add(bare.toLowerCase());
    }
    console.log(`  • ${conn.provider} [${conn.status}] connection=${conn.id} ext=${conn.externalConnectionId ?? "—"} — ${accounts.length} account(s): ${accounts.map((a) => `"${a.name}"(${a.type})`).join(", ") || "none"} | ${conn.providerAccountIdentities.length} identity(ies)`);
    if (accountIds.length > 0) {
      const [tx, hold, pos, evt, recon, imports] = await Promise.all([
        db.transaction.count({ where: { financialAccountId: { in: accountIds } } }),
        db.holding.count({ where: { financialAccountId: { in: accountIds } } }),
        db.positionObservation.count({ where: { financialAccountId: { in: accountIds } } }),
        db.investmentEvent.count({ where: { financialAccountId: { in: accountIds } } }),
        db.positionReconstruction.count({ where: { financialAccountId: { in: accountIds } } }),
        db.importBatch.count({ where: { financialAccountId: { in: accountIds } } }),
      ]);
      walletCascade.transactions += tx; walletCascade.holdings += hold; walletCascade.positionObservations += pos;
      walletCascade.investmentEvents += evt; walletCascade.positionReconstructions += recon; walletCascade.importBatches += imports;
      console.log(`      cascade: transactions=${tx} holdings=${hold} positionObservations=${pos} investmentEvents=${evt} positionReconstructions=${recon} importBatches=${imports}`);
    }
  }
  console.log(`  TOTAL: ${connections.length} Connection(s), ${totalWalletAccounts} FinancialAccount(s), ${walletCascade.accountConnections} accountConnection(s), ${walletCascade.providerIdentities} identity(ies), ${walletCascade.transactions} tx, ${walletCascade.holdings} holdings, ${walletCascade.positionObservations} positionObs, ${walletCascade.investmentEvents} events, ${walletCascade.positionReconstructions} recon, ${walletCascade.importBatches} importBatches\n`);

  // ── 2. SpaceSnapshot full-history wipe for the PERSONAL Space only ──────────
  hr(); console.log("2. SpaceSnapshot rows for the PERSONAL Space (full history)\n");
  const personal = await db.space.findFirst({
    where:  { type: "PERSONAL", members: { some: { userId: user.id, role: "OWNER" } } },
    select: { id: true, name: true },
  });
  let snapshotCount = 0;
  if (!personal) {
    console.log("  ⚠ no Personal Space found — nothing to wipe.");
  } else {
    snapshotCount = await db.spaceSnapshot.count({ where: { spaceId: personal.id } });
    console.log(`  Space "${personal.name}" (${personal.id}): ${snapshotCount} SpaceSnapshot row(s) will be deleted (full history).`);
    console.log(`  (Shared Spaces are NOT touched — their snapshots belong to all members.)\n`);
  }

  // ── 3. Narrow Recent-Activity noise (audit rows tied to the removed items) ──
  // Plaid rows carry metadata.institution (matched against removed items). Wallet
  // rows use action WALLET_ADD/WALLET_REMOVE with metadata.{name,address} instead
  // (no institution field), so they're matched against the removed wallet
  // connections' FA names / addresses collected in Step 1b.
  hr(); console.log("3. AuditLog rows tied to the removed items + wallet connections (Recent Activity)\n");
  const candidates = await db.auditLog.findMany({
    where:  { userId: user.id, action: { in: ["ACCOUNT_ADD", "ACCOUNT_REMOVE", "WALLET_ADD", "WALLET_REMOVE"] } },
    select: { id: true, action: true, metadata: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const isWalletMatch = (m: Record<string, unknown> | null): boolean => {
    if (!m) return false;
    const name = typeof m.name === "string" ? m.name.toLowerCase() : null;
    const address = typeof m.address === "string" ? m.address.toLowerCase() : null;
    return (name != null && walletAuditKeys.has(name)) || (address != null && walletAuditKeys.has(address));
  };
  const auditToDelete = candidates.filter((r) => {
    const m = r.metadata as Record<string, unknown> | null;
    return isInstitutionMatch(m?.institution, institutionNames) || isWalletMatch(m);
  });
  console.log(`  ${candidates.length} ACCOUNT/WALLET add/remove row(s) for this user; ${auditToDelete.length} match a removed Plaid item or wallet connection → DELETE:`);
  for (const r of auditToDelete) {
    const m = r.metadata as Record<string, unknown>;
    const tag = m.institution != null ? `institution=${JSON.stringify(m.institution)}` : `name=${JSON.stringify(m.name)} address=${JSON.stringify(m.address)}`;
    console.log(`    🗑 ${r.createdAt.toISOString()} ${r.action} ${tag}`);
  }
  if (institutionNames.size === 0 && walletAuditKeys.size === 0) console.log("  (no items/connections to attribute audit rows to — nothing deleted)");
  console.log();

  if (!APPLY) {
    hr();
    console.log("DRY RUN — nothing written, no Plaid calls. Re-run with --apply to perform.\n");
    return;
  }

  // ── APPLY ───────────────────────────────────────────────────────────────────
  hr(); console.log("APPLYING — irreversible.\n");

  // 1. Sever + hard-delete each PlaidItem (same shape as purge-plaid-connection.ts).
  for (const item of items) {
    const soft = await db.accountConnection.updateMany({ where: { plaidItemDbId: item.id, deletedAt: null }, data: { deletedAt: new Date() } });
    console.log(`  [${item.id}] soft-deleted ${soft.count} live connection(s); calling Plaid itemRemove…`);
    await disconnectPlaidItemIfOrphaned(item.id); // decrypt + itemRemove + status REVOKED (best-effort)
    const conns = await db.accountConnection.findMany({ where: { plaidItemDbId: item.id }, select: { financialAccountId: true } });
    const acctIds = [...new Set(conns.map((c) => c.financialAccountId))];
    await db.$transaction(async (tx) => {
      for (const id of acctIds) await tx.financialAccount.delete({ where: { id } }); // cascades children
      await tx.plaidItem.delete({ where: { id: item.id } });
    });
    console.log(`  [${item.id}] hard-deleted ${acctIds.length} FinancialAccount(s) (cascaded) + the PlaidItem.`);
  }

  // 1b. Hard-delete each non-Plaid Connection. No external sever (watch-only),
  //     so we go straight to the delete: the FinancialAccount delete cascades
  //     AccountConnection / ProviderAccountIdentity / Transaction / Holding /
  //     PositionObservation / InvestmentEvent / PositionReconstruction /
  //     ImportBatch / SpaceAccountLink (onDelete: Cascade), then the Connection
  //     row itself is deleted (AccountConnection/ProviderAccountIdentity →
  //     Connection are SetNull, and both are already cascade-gone, so nothing
  //     blocks it). Same $transaction shape as the Plaid branch.
  for (const conn of connections) {
    const acctIds = [...new Set(conn.accountConnections.map((c) => c.financialAccountId))];
    await db.$transaction(async (tx) => {
      for (const id of acctIds) await tx.financialAccount.delete({ where: { id } }); // cascades children + AccountConnection + ProviderAccountIdentity
      await tx.connection.delete({ where: { id: conn.id } });
    });
    console.log(`  [${conn.id}] hard-deleted ${acctIds.length} FinancialAccount(s) (cascaded) + the ${conn.provider} Connection.`);
  }

  // 2. Wipe the Personal Space's full snapshot history.
  if (personal) {
    const del = await db.spaceSnapshot.deleteMany({ where: { spaceId: personal.id } });
    console.log(`  Deleted ${del.count} SpaceSnapshot row(s) for "${personal.name}".`);
  }

  // 3. Delete the narrow audit rows.
  if (auditToDelete.length > 0) {
    const del = await db.auditLog.deleteMany({ where: { id: { in: auditToDelete.map((r) => r.id) } } });
    console.log(`  Deleted ${del.count} AuditLog row(s).`);
  }

  // ── Global safety assertion ─────────────────────────────────────────────────
  const instrumentsAfter       = await db.instrument.count();
  const priceObservationsAfter = await db.priceObservation.count();
  hr();
  console.log(`Global safety: Instrument ${instrumentsBefore}→${instrumentsAfter} ${instrumentsBefore === instrumentsAfter ? "✓" : "✗ CHANGED"}, PriceObservation ${priceObservationsBefore}→${priceObservationsAfter} ${priceObservationsBefore === priceObservationsAfter ? "✓" : "✗ CHANGED"}`);
  if (instrumentsBefore !== instrumentsAfter || priceObservationsBefore !== priceObservationsAfter) {
    throw new Error("SAFETY VIOLATION: global Instrument/PriceObservation count changed — investigate immediately.");
  }
  console.log(`\n✅ Clean slate for ${user.email}. A fresh Plaid connect will backfill from zero.\n`);
}

main()
  .catch((e) => { console.error("❌ dev-reset-test-state failed:", e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
