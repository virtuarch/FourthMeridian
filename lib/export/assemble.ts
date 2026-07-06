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
 *      getHoldings, getRecentSnapshots). Shared accounts are then narrowed to
 *      FULL only (isFullVisibility); the transaction/holding readers already
 *      fail closed to FULL (KD-15/KD-19), so their rows need no re-filtering.
 *
 * Excluded everywhere: secrets/hashes/tokens (passwordHash, totpSecret, raw
 * dateOfBirthEncrypted, RecoveryCode.codeHash, PlaidItem.encryptedToken,
 * Connection.credential, sessionToken), other members' data, raw audit rows
 * beyond the SECURITY_HISTORY_ACTIONS allowlist, and system tables.
 */

import "server-only";
import { db } from "@/lib/db";
import { getAccountsWithVisibility, getHoldings } from "@/lib/data/accounts";
import { getTransactions } from "@/lib/data/transactions";
import { getRecentSnapshots } from "@/lib/data/snapshots";
import { resolvePersonalSpaceId } from "@/lib/accounts/space-account-link";
import { SECURITY_HISTORY_ACTIONS, securityHistoryLabel } from "@/lib/security-history";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import {
  capTransactions,
  dedupById,
  filterVisibleContributions,
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
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, username: true, name: true, firstName: true,
      lastName: true, dateOfBirthEncrypted: true, employmentStatus: true,
      useCase: true, reportingCurrency: true, role: true, totpEnabled: true,
      emailVerifiedAt: true, pendingEmail: true, preferredSpaceId: true,
      deactivatedAt: true, lastBriefViewedAt: true, createdAt: true, updatedAt: true,
    },
  });
  if (!user) throw new Error(`assembleUserExport: user ${userId} not found`);

  // Decrypt the user's own DOB (theirs to export). Non-fatal on failure.
  let dateOfBirth: string | null = null;
  if (user.dateOfBirthEncrypted) {
    try {
      dateOfBirth = decryptWithPurpose(user.dateOfBirthEncrypted, EncryptionPurpose.DATE_OF_BIRTH);
    } catch {
      dateOfBirth = null;
    }
  }

  const personalSpaceId = await resolvePersonalSpaceId(userId);

  // ── ACTIVE memberships in non-deleted Spaces ───────────────────────────────
  const memberships = await db.spaceMember.findMany({
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

  // ── Per-Space visibility lens (composes the existing readers) ───────────────
  const accounts: ExportAccount[] = [];
  const transactions: ExportTransaction[] = [];
  const holdings: ExportHolding[] = [];
  const snapshots: ExportSnapshot[] = [];
  const goals: Record<string, unknown>[] = [];

  for (const m of memberships) {
    const spaceId = m.spaceId;
    const spaceName = m.space.name;

    const withVis = await getAccountsWithVisibility({ spaceId, userId });
    // D3 — owned accounts (FULL HOME link) + FULL-shared only.
    const fullAccountIds = new Set<string>();
    for (const row of withVis) {
      if (!isFullVisibility(row.visibilityLevel)) continue;
      fullAccountIds.add(row.account.id);
      accounts.push({ ...row.account, spaceId, spaceName });
    }

    const spaceTxns = await getTransactions({ spaceId });
    for (const t of spaceTxns) transactions.push({ ...t, spaceId });

    const spaceHoldings = await getHoldings({ spaceId });
    for (const h of spaceHoldings) holdings.push({ ...h, spaceId });

    const spaceSnapshots = await getRecentSnapshots(ALL_SNAPSHOTS, { spaceId });
    for (const s of spaceSnapshots) snapshots.push({ ...s, spaceId, spaceName });

    // Goals belong to the Space; contributions are narrowed to FULL-visible
    // accounts (D4). Check-ins carry no member attribution.
    const spaceGoals = await db.spaceGoal.findMany({
      where:  { spaceId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      include: {
        contributions: { select: { financialAccountId: true, includeBalance: true, createdAt: true } },
        checkIns:      { select: { note: true, checkedAt: true } },
      },
    });
    for (const g of spaceGoals) {
      const visibleContributions = filterVisibleContributions(g.contributions, fullAccountIds);
      goals.push({
        id: g.id, spaceId, name: g.name, description: g.description,
        category: g.category, goalType: g.goalType, status: g.status,
        targetAmount: g.targetAmount, currentAmount: g.currentAmount,
        targetDate: g.targetDate?.toISOString() ?? null,
        habitFrequency: g.habitFrequency, currentStreak: g.currentStreak,
        longestStreak: g.longestStreak, lastCheckIn: g.lastCheckIn?.toISOString() ?? null,
        spendingCategory: g.spendingCategory,
        completedAt: g.completedAt?.toISOString() ?? null,
        archivedAt: g.archivedAt?.toISOString() ?? null,
        createdAt: g.createdAt.toISOString(),
        contributions: visibleContributions.map((c) => ({
          financialAccountId: c.financialAccountId,
          includeBalance: c.includeBalance,
          createdAt: c.createdAt.toISOString(),
        })),
        checkIns: g.checkIns.map((c) => ({ note: c.note, checkedAt: c.checkedAt.toISOString() })),
      });
    }
  }

  // Dedup rows that appear via multiple Spaces (e.g. an owned account shared
  // FULL into another Space the user is also in).
  const dedupedAccounts = dedupById(accounts);
  const dedupedHoldings = dedupById(holdings);
  const { rows: cappedTransactions, truncated } = capTransactions(dedupById(transactions));

  // ── Ownership lens (direct personal queries — no shared-account tables) ─────
  const [
    sessions, recoveryCodes, creditScores, auditRows,
    accountConnections, plaidItems, connections,
    importBatches, mappingProfiles,
  ] = await Promise.all([
    db.userSession.findMany({
      where:  { userId },
      orderBy: { createdAt: "desc" },
      select: { ipAddress: true, userAgent: true, lastActiveAt: true, revokedAt: true, createdAt: true },
    }),
    db.recoveryCode.findMany({
      where:  { userId },
      orderBy: { createdAt: "desc" },
      select: { usedAt: true, expiresAt: true, createdAt: true }, // never codeHash
    }),
    db.creditScore.findMany({
      where:  { userId },
      orderBy: { recordedAt: "desc" },
      select: { score: true, source: true, recordedAt: true },
    }),
    db.auditLog.findMany({
      where:  { userId, action: { in: SECURITY_HISTORY_ACTIONS } },
      orderBy: { createdAt: "desc" },
      select: { action: true, ipAddress: true, metadata: true, createdAt: true },
    }),
    db.accountConnection.findMany({
      where:  { connectedByUserId: userId, deletedAt: null },
      select: {
        id: true, financialAccountId: true, syncStatus: true, isCanonical: true,
        lastSyncedAt: true, createdAt: true, // never plaidItem token
      },
    }),
    db.plaidItem.findMany({
      where:  { userId },
      select: { institutionName: true, institutionId: true, status: true, lastSyncedAt: true, createdAt: true },
    }),
    db.connection.findMany({
      where:  { userId },
      select: { provider: true, status: true, lastSyncedAt: true, createdAt: true }, // never credential
    }),
    db.importBatch.findMany({
      where:  { createdByUserId: userId },
      orderBy: { createdAt: "desc" },
      select: {
        source: true, originalFilename: true, status: true, rowCount: true,
        importedCount: true, skippedCount: true, matchedCount: true,
        failedCount: true, createdAt: true, completedAt: true,
      },
    }),
    db.importMappingProfile.findMany({
      where:  { createdByUserId: userId },
      select: { name: true, source: true, institutionLabel: true, lastUsedAt: true, useCount: true, createdAt: true },
    }),
  ]);

  // AI advice — PERSONAL Space only (approved decision D5).
  const aiAdvice = personalSpaceId
    ? await db.aiAdvice.findMany({
        where:  { spaceId: personalSpaceId },
        orderBy: { generatedAt: "desc" },
        select: { summary: true, adviceText: true, riskLevel: true, generatedAt: true },
      })
    : [];

  // Settings — PERSONAL Space dashboard customisations (Space property elsewhere).
  const dashboardSections = personalSpaceId
    ? await db.spaceDashboardSection.findMany({
        where:  { spaceId: personalSpaceId },
        orderBy: { order: "asc" },
        select: { key: true, label: true, tab: true, enabled: true, order: true, config: true },
      })
    : [];

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
      pendingEmail: user.pendingEmail, deactivatedAt: iso(user.deactivatedAt),
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
    goals,
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
    goals: data.goals.length,
    auditHistory: data.auditHistory.length,
    importBatches: data.imports.batches.length,
    aiAdvice: data.aiAdvice.length,
    sessions: data.security.sessions.length,
  };

  const notes = [
    "Shared-Space data is limited to what you own or can see at FULL visibility; other members' private data is excluded.",
    "Converted / snapshot totals are estimates when a currency conversion was applied.",
    "Transactions cover banking activity; investment positions are in holdings.csv.",
  ];
  if (truncated) {
    notes.push(`Transactions were capped at the newest ${data.transactions.length} rows (KD-7 5,000-row limit).`);
  }

  return {
    manifest: {
      app: "fourth-meridian",
      kind: "personal-data-export",
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      userId,
      files: ["manifest.json", "data.json", "transactions.csv", "accounts.csv", "holdings.csv", "snapshots.csv"],
      counts,
      truncated,
      notes,
    },
    ...data,
  };
}
