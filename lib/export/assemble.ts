/**
 * lib/export/assemble.ts  (OPS-2 S6)
 *
 * Server-only. Assembles the full personal-data export bundle for one user by
 * COMPOSING the existing read layer — it introduces no visibility logic of its
 * own and never queries the shared FinancialAccount / Transaction / Holding
 * tables directly.
 *
 * Two lenses (approved decision D3):
 *   1. Ownership — rows FK'd to the user (User, UserSession, RecoveryCode,
 *      CreditScore, AuditLog, ImportBatch/Profile, AccountConnection/PlaidItem/
 *      Connection they made). Queried directly by userId; these carry no other
 *      member's data by construction.
 *   2. Visibility — for every ACTIVE membership, exactly what that Space read
 *      surface returns, via lib/data/* (getAccountsWithVisibility, getTransactions,
 *      getRecentSnapshots) and the canonical current-position seam
 *      (getCurrentPositions). Shared accounts are then narrowed to FULL only
 *      (isFullVisibility); the transaction reader and the position seam already
 *      fail closed to FULL (KD-15/KD-19/KD-21a), so their rows need no re-filtering.
 *
 * Investment positions (P2-5, completed by W5/P2-6): sourced from
 * getCurrentPositions — the ratified FULL-authorized current-position authority
 * (value + FX + completeness), NOT any legacy `Holding` read. `value`/`currency`
 * stay native (the pre-P2-5 contract) and `reportingValue` adds the converted
 * figure. Self-custody crypto wallets arrive through this same seam as
 * PositionObservations valued at dated archive prices; the crypto-only bridge
 * was DELETED at W5, and a wallet with no observations is honestly absent.
 *
 * Excluded everywhere: secrets/hashes/tokens (passwordHash, totpSecret, raw
 * dateOfBirthEncrypted, RecoveryCode.codeHash, PlaidItem.encryptedToken,
 * Connection.credential, sessionToken), other members' data, raw audit rows
 * beyond the SECURITY_HISTORY_ACTIONS allowlist, and system tables.
 *
 * ── RLS-T1: WHY THIS FILE IS PHASES AND NOT ONE TRANSACTION ─────────────────
 *
 * RLS-C-S2, RLS-C-S3 and RLS-AI-S7 each deliberately left this assembler on the
 * migration principal, and all three recorded the same reason: it walks EVERY
 * Space the user is an ACTIVE member of, performs a DECRYPT, and then serialises
 * a whole bundle. `withTenantDb` is a SECURITY BOUNDARY, not a request-lifetime
 * container, so one transaction around that would hold a tenant transaction open
 * across the entire export — unbounded in the number of Spaces, and across work
 * that is not a database read at all.
 *
 * So it is a PHASE SPLIT. Three kinds of phase, each its own short transaction:
 *
 *   PHASE 1 (one)        the user row + personal-Space resolution + memberships
 *   PHASE 2..N (per Space) that Space's accounts, transactions, positions, snapshots
 *   PHASE Z (one)        the ownership lens — rows FK'd to the user
 *
 * ⚠️ DO NOT "SIMPLIFY" THIS INTO A SINGLE `withTenantDb`. The things that happen
 * BETWEEN the phases are exactly what the split exists for, and they are not
 * incidental:
 *   · the AES decrypt of `dateOfBirthEncrypted` (CPU, between phase 1 and 2)
 *   · `mergeSpaceExportHoldings` and the per-Space row pushes (pure)
 *   · `dedupById` / `capTransactions` across every Space (between 2..N and Z)
 *   · the whole manifest/notes/CSV-selection tail (after Z)
 * A phase loop also means the transaction count scales with the Space count
 * while each transaction's DURATION does not, which is the property that matters
 * to a pooled connection.
 *
 * THE IDENTITY IS THE SUBJECT OF THE EXPORT. `assembleUserExport(userId)` is
 * called from exactly one place — `POST /api/user/export` — with the id of the
 * freshly re-authenticated caller (`requireFreshUser`), so binding the tenant
 * identity to `userId` is binding it to server-side session state. There is no
 * admin "export someone else" path; if one is ever added it must pass a system
 * authority deliberately, not borrow this one.
 *
 * ⚠️ AND THE OWNERSHIP LENS GETS GENUINELY NARROWER — RECORDED, NOT DISCOVERED.
 * Two of its collections are keyed on the user in the application `where` but on
 * something else by POLICY:
 *   · `ImportBatch` is in the account subtree (RLS §15,
 *     `fm_account_visible("financialAccountId")`), so a batch this user created
 *     for an account that is no longer ACTIVE-linked into any Space they can see
 *     drops out of their own export.
 *   · `ImportMappingProfile` is Space-scoped (RLS §7), so a profile created in a
 *     Space the user has since left drops out.
 * Both are fail-closed and both are arguably MORE correct than before — the
 * export has always promised "exactly what that Space read surface returns" —
 * but the population is not byte-identical to the pre-RLS one, and pretending
 * otherwise is how a quiet data change ships.
 */

import "server-only";
import { withTenantDb } from "@/lib/db/tenant-context";
import { getAccountsWithVisibility } from "@/lib/data/accounts";
import { getCurrentPositions } from "@/lib/investments/current-positions";
import { mergeSpaceExportHoldings } from "@/lib/export/holdings";
import { getTransactions } from "@/lib/data/transactions";
import { getRecentSnapshots } from "@/lib/data/snapshots";
import { resolvePersonalSpaceId } from "@/lib/accounts/space-account-link";
import { SECURITY_HISTORY_ACTIONS, securityHistoryLabel } from "@/lib/security-history";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import {
  capTransactions,
  EXPORT_TRANSACTION_CAP,
  dedupById,
  isFullVisibility,
} from "@/lib/export/select";
import type {
  ExportAccount,
  ExportData,
  ExportHolding,
  ExportSnapshot,
  ExportTransaction,
} from "@/lib/export/types";

const SCHEMA_VERSION = "1.0";
// Effectively "all snapshots" — getRecentSnapshots takes the last N rows.
const ALL_SNAPSHOTS = 100_000;

/**
 * Build the complete, privacy-safe export bundle for `userId`. Throws only if
 * the user does not exist (the caller has already authenticated them, so this
 * is a should-not-happen guard).
 */
export async function assembleUserExport(userId: string): Promise<ExportData> {
  // ── PHASE 1 — the subject, their personal Space, and their memberships ─────
  // One short transaction. `User` is admitted by `"id" = current_fm_user_id()`
  // (RLS §10) and `SpaceMember` by `"userId" = current_fm_user_id()` (§12), so
  // this phase reads exactly the identity it is bound to.
  const phase1 = await withTenantDb(userId, async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        id: true, email: true, username: true, name: true, firstName: true,
        lastName: true, dateOfBirthEncrypted: true, employmentStatus: true,
        useCase: true, reportingCurrency: true, role: true, totpEnabled: true,
        emailVerifiedAt: true, pendingEmail: true, preferredSpaceId: true,
        deactivatedAt: true, lastBriefViewedAt: true, createdAt: true, updatedAt: true,
      },
    });
    // RLS slice B — `resolvePersonalSpaceId` requires its client; it gets this
    // phase's.
    const personalSpaceId = await resolvePersonalSpaceId(tx, userId);
    // ── ACTIVE memberships in non-deleted Spaces ─────────────────────────────
    const memberships = await tx.spaceMember.findMany({
      where:  { userId, status: "ACTIVE", space: { deletedAt: null } },
      orderBy: { joinedAt: "asc" },
      include: {
        space: {
          select: {
            id: true, name: true, description: true, type: true, category: true,
            reportingCurrency: true, isPublic: true, archivedAt: true, createdAt: true,
          },
        },
      },
    });
    return { user, personalSpaceId, memberships };
  });
  const { user, personalSpaceId, memberships } = phase1;
  if (!user) throw new Error(`assembleUserExport: user ${userId} not found`);

  // ── BETWEEN PHASES — the decrypt. NOT inside a transaction, by design ──────
  // Decrypt the user's own DOB (theirs to export). Non-fatal on failure. This is
  // the single most-cited reason this file is phases: a crypto operation is not a
  // database read and must not be covered by a tenant boundary.
  let dateOfBirth: string | null = null;
  if (user.dateOfBirthEncrypted) {
    try {
      dateOfBirth = decryptWithPurpose(user.dateOfBirthEncrypted, EncryptionPurpose.DATE_OF_BIRTH);
    } catch {
      dateOfBirth = null;
    }
  }

  // ── Per-Space visibility lens (composes the existing readers) ───────────────
  const accounts: ExportAccount[] = [];
  const transactions: ExportTransaction[] = [];
  const holdings: ExportHolding[] = [];
  const snapshots: ExportSnapshot[] = [];
  // W2 — the goals collection was deleted with the Goals retirement (no rows
  // exist anywhere; the export carries no retired-concept section).

  // ── PHASES 2..N — ONE SHORT TRANSACTION PER SPACE ─────────────────────────
  // The boundary is per Space, not per export. Each phase holds four pure reads
  // over ONE Space with no decrypt, no serialisation and no network inside it;
  // the pure work (`mergeSpaceExportHoldings`, the row pushes) is done after the
  // phase closes. Sequential rather than `Promise.all`ed on purpose: a user in
  // twelve Spaces must not open twelve concurrent tenant transactions against a
  // pooled connection.
  for (const m of memberships) {
    const spaceId = m.spaceId;
    const spaceName = m.space.name;

    const phase = await withTenantDb(userId, async (tx) => {
      const withVis = await getAccountsWithVisibility(tx, { spaceId, userId });
      // TX-2E — move the export cap into the QUERY (per space) so no single space
      // materializes its full multi-year history in memory. The final combined cap
      // (capTransactions below) still trims to EXPORT_TRANSACTION_CAP total, and the
      // result is identical: the global most-recent N are a subset of each space's
      // most-recent N. Streaming a larger export remains deferred (TX-3/4).
      const spaceTxns = await getTransactions(tx, { spaceId, limit: EXPORT_TRANSACTION_CAP });
      // Investment positions: the ONE canonical seam (FULL-authorized, valued +
      // FX). W5 — crypto wallets ride the same seam; the legacy bridge and its
      // merge args are gone (mergeSpaceExportHoldings is now the passthrough its
      // own doc promised at P2-6 completion).
      const positions = await getCurrentPositions(tx, { spaceId });
      const spaceSnapshots = await getRecentSnapshots(tx, { rows: ALL_SNAPSHOTS }, { spaceId });
      return { withVis, spaceTxns, positions, spaceSnapshots };
    });

    // ── Between phases: pure projection only ────────────────────────────────
    // D3 — owned accounts (FULL HOME link) + FULL-shared only.
    // W2 — the fullAccountIds set died with the goal export block below; it
    // existed only to narrow goal contributions to FULL-visible accounts.
    //
    // KD-15/KD-19/KD-21a still decide this, not RLS: the migration's own rule is
    // that `visibilityLevel` is a COLUMN-level redaction tier and stays in
    // application code, so the policy admitting a row never means the row may be
    // exported at FULL detail. Both gates, as before.
    for (const row of phase.withVis) {
      if (!isFullVisibility(row.visibilityLevel)) continue;
      accounts.push({ ...row.account, spaceId, spaceName });
    }
    for (const t of phase.spaceTxns.rows) transactions.push({ ...t, spaceId });
    holdings.push(...mergeSpaceExportHoldings({
      canonicalRows: phase.positions.rows,
      spaceId,
    }));
    for (const s of phase.spaceSnapshots) snapshots.push({ ...s, spaceId, spaceName });

    // W2 — the per-Space goal export block (SpaceGoal + contributions +
    // check-ins, D4 visibility-narrowed) was deleted with the Goals retirement.
  }

  // ── BETWEEN PHASES — cross-Space dedup + cap. No transaction held. ─────────
  // Dedup rows that appear via multiple Spaces (e.g. an owned account shared
  // FULL into another Space the user is also in).
  const dedupedAccounts = dedupById(accounts);
  const dedupedHoldings = dedupById(holdings);
  const { rows: cappedTransactions, truncated } = capTransactions(dedupById(transactions));

  // ── PHASE Z — ownership lens (direct personal queries) ────────────────────
  // One short transaction over nine collections, every one of them keyed on the
  // bound identity. Classified, because "keyed on the user in the `where`" and
  // "keyed on the user by POLICY" are not the same claim:
  //   TENANT, userId policy (RLS §9/§10/§18): UserSession, RecoveryCode,
  //     CreditScore, PlaidItem, Connection, AuditLog
  //     (AuditLog's arm is `"userId" = current_fm_user_id() OR "spaceId" IN
  //     visible`; the `userId` arm is the one this query rides, and the
  //     SECURITY_HISTORY_ACTIONS allowlist is unchanged beside it)
  //   TENANT, account-subtree policy (RLS §15): AccountConnection, ImportBatch
  //     — ImportBatch is one of the two NARROWINGS recorded in the header
  //   TENANT, spaceId policy (RLS §7): ImportMappingProfile, AiAdvice,
  //     SpaceDashboardSection — ImportMappingProfile is the other narrowing
  // Nothing here is global reference data and nothing is operator-forensic; the
  // tables fm_app may not reach at all (RLS §4) are not in the export.
  const [
    sessions, recoveryCodes, creditScores, auditRows,
    accountConnections, plaidItems, connections,
    importBatches, mappingProfiles, aiAdvice, dashboardSections,
  ] = await withTenantDb(userId, (tx) => Promise.all([
    tx.userSession.findMany({
      where:  { userId },
      orderBy: { createdAt: "desc" },
      select: { ipAddress: true, userAgent: true, lastActiveAt: true, revokedAt: true, createdAt: true },
    }),
    tx.recoveryCode.findMany({
      where:  { userId },
      orderBy: { createdAt: "desc" },
      select: { usedAt: true, expiresAt: true, createdAt: true }, // never codeHash
    }),
    tx.creditScore.findMany({
      where:  { userId },
      orderBy: { recordedAt: "desc" },
      select: { score: true, source: true, recordedAt: true },
    }),
    tx.auditLog.findMany({
      where:  { userId, action: { in: SECURITY_HISTORY_ACTIONS } },
      orderBy: { createdAt: "desc" },
      select: { action: true, ipAddress: true, metadata: true, createdAt: true },
    }),
    tx.accountConnection.findMany({
      where:  { connectedByUserId: userId, deletedAt: null },
      select: {
        id: true, financialAccountId: true, syncStatus: true, isCanonical: true,
        lastSyncedAt: true, createdAt: true, // never plaidItem token
      },
    }),
    tx.plaidItem.findMany({
      where:  { userId },
      select: { institutionName: true, institutionId: true, status: true, lastSyncedAt: true, createdAt: true },
    }),
    tx.connection.findMany({
      where:  { userId },
      select: { provider: true, status: true, lastSyncedAt: true, createdAt: true }, // never credential
    }),
    tx.importBatch.findMany({
      where:  { createdByUserId: userId },
      orderBy: { createdAt: "desc" },
      select: {
        source: true, originalFilename: true, status: true, rowCount: true,
        importedCount: true, skippedCount: true, matchedCount: true,
        failedCount: true, createdAt: true, completedAt: true,
      },
    }),
    tx.importMappingProfile.findMany({
      where:  { createdByUserId: userId },
      select: { name: true, source: true, institutionLabel: true, lastUsedAt: true, useCount: true, createdAt: true },
    }),
    // AI advice — PERSONAL Space only (approved decision D5).
    personalSpaceId
      ? tx.aiAdvice.findMany({
          where:  { spaceId: personalSpaceId },
          orderBy: { generatedAt: "desc" },
          select: { summary: true, adviceText: true, riskLevel: true, generatedAt: true },
        })
      : [],
    // Settings — PERSONAL Space dashboard customisations (Space property elsewhere).
    personalSpaceId
      ? tx.spaceDashboardSection.findMany({
          where:  { spaceId: personalSpaceId },
          orderBy: { order: "asc" },
          select: { key: true, label: true, tab: true, enabled: true, order: true, config: true },
        })
      : [],
  ] as const));

  const auditHistory = auditRows.map((r) => {
    const meta = (r.metadata ?? null) as { reason?: unknown } | null;
    return {
      action:    r.action,
      label:     securityHistoryLabel(r.action),
      createdAt: r.createdAt.toISOString(),
      ipAddress: r.ipAddress,
      reason:    meta && typeof meta.reason === "string" ? meta.reason : null,
    };
  });

  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

  const data: Omit<ExportData, "manifest"> = {
    profile: {
      email: user.email, username: user.username, name: user.name,
      firstName: user.firstName, lastName: user.lastName, dateOfBirth,
      employmentStatus: user.employmentStatus, useCase: user.useCase,
      role: user.role, emailVerifiedAt: iso(user.emailVerifiedAt),
      // A completed email change leaves pendingEmail == email until the token's
      // TTL lapses (OPS-2 idempotent-confirm fix) — that is not a real pending
      // change, so don't surface it as one.
      pendingEmail: user.pendingEmail && user.pendingEmail !== user.email ? user.pendingEmail : null,
      deactivatedAt: iso(user.deactivatedAt),
      lastBriefViewedAt: iso(user.lastBriefViewedAt),
      createdAt: iso(user.createdAt), updatedAt: iso(user.updatedAt),
    },
    settings: {
      reportingCurrency: user.reportingCurrency, useCase: user.useCase,
      employmentStatus: user.employmentStatus, preferredSpaceId: user.preferredSpaceId,
      personalDashboardSections: dashboardSections,
    },
    security: {
      totpEnabled: user.totpEnabled,
      sessions: sessions.map((s) => ({
        ipAddress: s.ipAddress, userAgent: s.userAgent,
        lastActiveAt: iso(s.lastActiveAt), revokedAt: iso(s.revokedAt), createdAt: iso(s.createdAt),
      })),
      recoveryCodes: recoveryCodes.map((c) => ({
        usedAt: iso(c.usedAt), expiresAt: iso(c.expiresAt), createdAt: iso(c.createdAt),
      })),
    },
    spaces: memberships.map((m) => ({
      spaceId: m.spaceId, name: m.space.name, description: m.space.description,
      type: m.space.type, category: m.space.category,
      reportingCurrency: m.space.reportingCurrency, isPublic: m.space.isPublic,
      archivedAt: iso(m.space.archivedAt), spaceCreatedAt: iso(m.space.createdAt),
      role: m.role, membershipStatus: m.status, joinedAt: iso(m.joinedAt),
    })),
    accounts: dedupedAccounts,
    connections: {
      accountConnections: accountConnections.map((c) => ({
        id: c.id, financialAccountId: c.financialAccountId, syncStatus: c.syncStatus,
        isCanonical: c.isCanonical, lastSyncedAt: iso(c.lastSyncedAt), createdAt: iso(c.createdAt),
      })),
      plaidItems: plaidItems.map((p) => ({
        institutionName: p.institutionName, institutionId: p.institutionId,
        status: p.status, lastSyncedAt: iso(p.lastSyncedAt), createdAt: iso(p.createdAt),
      })),
      connections: connections.map((c) => ({
        provider: c.provider, status: c.status, lastSyncedAt: iso(c.lastSyncedAt), createdAt: iso(c.createdAt),
      })),
    },
    transactions: cappedTransactions,
    holdings: dedupedHoldings,
    snapshots,
    creditHistory: creditScores.map((c) => ({
      score: c.score, source: c.source, recordedAt: iso(c.recordedAt),
    })),
    auditHistory,
    imports: {
      batches: importBatches.map((b) => ({
        source: b.source, originalFilename: b.originalFilename, status: b.status,
        rowCount: b.rowCount, importedCount: b.importedCount, skippedCount: b.skippedCount,
        matchedCount: b.matchedCount, failedCount: b.failedCount,
        createdAt: iso(b.createdAt), completedAt: iso(b.completedAt),
      })),
      mappingProfiles: mappingProfiles.map((p) => ({
        name: p.name, source: p.source, institutionLabel: p.institutionLabel,
        lastUsedAt: iso(p.lastUsedAt), useCount: p.useCount, createdAt: iso(p.createdAt),
      })),
    },
    aiAdvice: aiAdvice.map((a) => ({
      summary: a.summary, adviceText: a.adviceText, riskLevel: a.riskLevel, generatedAt: iso(a.generatedAt),
    })),
  };

  const counts: Record<string, number> = {
    spaces: data.spaces.length,
    accounts: data.accounts.length,
    transactions: data.transactions.length,
    holdings: data.holdings.length,
    snapshots: data.snapshots.length,
    creditHistory: data.creditHistory.length,
    auditHistory: data.auditHistory.length,
    importBatches: data.imports.batches.length,
    aiAdvice: data.aiAdvice.length,
    sessions: data.security.sessions.length,
  };

  const notes = [
    "Shared-Space data is limited to what you own or can see at FULL visibility; other members' private data is excluded.",
    "Converted / snapshot totals are estimates when a currency conversion was applied.",
  ];
  if (data.holdings.length) {
    notes.push("Transactions cover banking activity; investment positions are in holdings.csv.");
  }
  if (truncated) {
    notes.push(`Transactions were capped at the newest ${data.transactions.length} rows (KD-7 5,000-row limit).`);
  }
  // V26-CRYPTO-STATUS-1 — the export keeps every stored number, so a reader must
  // be told which ones may not be asserted. Stated once, in the manifest, and
  // only when such rows are actually present.
  const unassertableCrypto = data.snapshots.filter((s) => s.cryptoAssertable === false).length;
  // v2.6-A/B — the same rows, counted by the AGGREGATE that refuses. Stated
  // separately because a reader auditing net worth needs the aggregate's answer,
  // not an inference from a component's.
  const unassertableNetWorth = data.snapshots.filter(
    (s) => s.aggregateAuthorisation?.netWorth.assertable === false,
  ).length;
  if (unassertableCrypto > 0) {
    notes.push(
      `${unassertableCrypto} snapshot row(s) carry a historical crypto value that cannot be asserted. ` +
      `Their raw stored total_crypto, total_assets and net_worth are preserved unchanged for audit, ` +
      `but crypto_assertable is false and asset_side_contaminated is true — net_worth and total_assets ` +
      `on those rows are composed from the unassertable crypto figure. See crypto_unavailable_reason.`,
    );
  }
  if (unassertableNetWorth > 0) {
    notes.push(
      `${unassertableNetWorth} snapshot row(s) carry a net_worth that may not be asserted, because at least ` +
      `one component it is composed from may not be. Raw values are preserved unchanged; see ` +
      `net_worth_state, net_worth_assertable and total_assets_state.`,
    );
  }

  // Tabular CSVs are included only when their section has rows — no empty files
  // ship. data.json (below) stays stable and always carries every section
  // (empty arrays included). buildExportZip() honours exactly this list.
  const files = ["manifest.json", "data.json"];
  if (data.transactions.length) files.push("transactions.csv");
  if (data.accounts.length)     files.push("accounts.csv");
  if (data.holdings.length)     files.push("holdings.csv");
  if (data.snapshots.length)    files.push("snapshots.csv");

  return {
    manifest: {
      app: "fourth-meridian",
      kind: "personal-data-export",
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      userId,
      files,
      counts,
      truncated,
      notes,
    },
    ...data,
  };
}
