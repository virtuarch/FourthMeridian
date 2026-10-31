/**
 * lib/account-deletion/purge.ts  (OPS-2 S7c · IDEMP-002 / PRIV-001 / DB-002 / DB-011)
 *
 * The irreversible account-deletion purge orchestrator. Executes the pipeline
 * in the order ratified by the S5 decision record
 * (OPS2_S5_DELETION_INVENTORY.md §4) for a single user whose grace window has
 * elapsed. Called only by jobs/process-deletions.ts (the Vercel-cron job).
 *
 * ── Pre-beta remediation (2026-10-22, IDEMP-002) ─────────────────────────────
 * The runtime audit ran two concurrent process-deletions wakes and BOTH
 * executed the destructive tail: four ACCOUNT_DELETED rows for two users, two
 * deletion e-mails each, and a P2025 at the final user.delete. The pipeline
 * validated "due" once at the top and then issued ~15 independent writes.
 *
 * Now:
 *   0. CLAIM FIRST. One conditional UPDATE sets `purgeStartedAt` where
 *      deletionScheduledAt <= now AND (purgeStartedAt IS NULL OR stale).
 *      count === 1 or this worker owns nothing and returns "claimed-elsewhere".
 *      A claim older than PURGE_CLAIM_STALE_MS belongs to a crashed worker and
 *      is re-claimable — the crash-safe retry.
 *   1. revoke sessions                    — revokeAllUserSessions (S1/S4)
 *   2. revoke provider connections        — Plaid itemRemove, best-effort, OUTSIDE
 *      any transaction (KD-4). Idempotent across retries: only ACTIVE items are
 *      attempted and a CONFIRMED removal flips the row to REVOKED, so a retry
 *      never calls itemRemove twice for the same item. A HOLD releases the claim.
 *   3. revoke SALs the user added         — status REVOKED (account-DELETE route)
 *   4. canonical AccountConnection resolve — re-elect on SPACE-owned accounts (S5 §4c)
 *   5–8. ONE TRANSACTION, fenced on the claim:
 *      5a. re-validate — the row must still be due AND still carry THIS
 *          worker's claim (the cancel-vs-purge race: a cancel-at-login clears
 *          deletionScheduledAt, so the fence update matches nothing and the
 *          tail is abandoned with the user intact);
 *      5b. delete USER-owned FinancialAccounts and every account owned by a
 *          Space that is about to go (PERSONAL, and — PRIV-001 — every SHARED
 *          Space whose ONLY active member is this user; DB-011 — their
 *          Space-owned accounts go with them, never orphaned);
 *      6.  delete those Spaces (cascade);
 *      6b. DB-002 soft-reference scrub: AiInvocation.userId → null,
 *          BetaAccessRequest(+Event) rows for the e-mail deleted,
 *          MerchantMergeDecision.decidedByUserId / PlatformSetting.updatedById → null;
 *      7.  write ONE ACCOUNT_DELETED audit row (sha256(email) only; survives
 *          anonymised through the SetNull FK);
 *      8.  delete the User (final cascade).
 *   9. AFTER COMMIT: the deletion-complete e-mail, exactly once — it is sent
 *      only by the worker whose transaction committed in THIS run (the commit
 *      is the marker; no other worker can hold the claim, and after commit
 *      there is no row to claim).
 *
 * Retained, by design and documented in TEST-009's census
 * (lib/account-deletion/purge-census.test.ts): AuditLog rows (SetNull,
 * forensic), and operator-identity columns that name the user as an ACTOR on
 * someone else's record (UserSession.revokedById, SpaceMember.revokedById,
 * BetaAccessRequest.decidedById, …) — those identify an operator, not the
 * subject, and the id is an opaque cuid with no PII once the User row is gone.
 */

import "server-only";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { revokeAllUserSessions } from "@/lib/sessions";
import { sendEmail } from "@/lib/email/send";
import { accountDeletedAlert } from "@/lib/email/security-alerts";
import { recipientHash } from "@/lib/notifications/delivery/record";
import { AuditAction } from "@/lib/audit-actions";
import { plaidClient } from "@/lib/plaid/client";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { getPlaidErrorCode, redactedErrorForLog } from "@/lib/plaid/errors";
import {
  classifyRevocationFailure, decideRevocation, countPriorFailureDays,
  MAX_REVOCATION_ATTEMPT_DAYS,
} from "@/lib/account-deletion/revocation";
import { ShareStatus, PlaidItemStatus, SpaceMemberRole, SpaceMemberStatus, SpaceType, type Prisma } from "@prisma/client";

/** A claim older than this belongs to a crashed worker and may be re-claimed. */
export const PURGE_CLAIM_STALE_MS = 30 * 60_000;

/** The interactive-transaction budget for the destructive tail. */
const PURGE_TX_TIMEOUT_MS = 120_000;

export interface PurgeResult {
  userId:          string;
  purged:          boolean;
  /**
   * PRE-BETA-OPS-CLOSE Phase 3 — "pending-provider-revocation" means the purge
   * ran but was deliberately HELD: upstream Plaid revocation failed retryably
   * and the daily attempt budget is not spent. The User row, the PlaidItem and
   * its encrypted token all survive so the next cron run can retry.
   *
   * IDEMP-002 — "claimed-elsewhere": another worker holds a live claim on this
   * user; this worker did nothing. "cancelled": the user cancelled between the
   * claim and the destructive tail; nothing irreversible happened.
   */
  skipped?: "already-deleted" | "not-due" | "pending-provider-revocation" | "claimed-elsewhere" | "cancelled";
  providerRevoked: number;
  providerFailed:  number;
  deletedAccounts: number;
  personalSpaces:  number;
  /** PRIV-001 — SHARED Spaces deleted because this user was their only active member. */
  soleMemberSharedSpaces: number;
}

// ── Narrow client contract (injection seam for the DB-free tests) ────────────
//
// Typed against exactly the operations the purge performs. The shared client
// is cast once below (the lib/jobs/run.ts idiom), so the module stays
// compile-independent of Prisma client regeneration and the tests can inject
// an in-memory fake that evaluates these where-clauses the way Postgres would.

type UserSnapshot = { id: string; email: string; deletionScheduledAt: Date | null; purgeStartedAt: Date | null };

export interface PurgeTxClient {
  user: {
    updateMany(args: { where: Prisma.UserWhereInput; data: Prisma.UserUpdateManyMutationInput }): Promise<{ count: number }>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
  financialAccount: {
    deleteMany(args: { where: Prisma.FinancialAccountWhereInput }): Promise<{ count: number }>;
  };
  space: {
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
  aiInvocation: {
    updateMany(args: { where: Prisma.AiInvocationWhereInput; data: Prisma.AiInvocationUpdateManyMutationInput }): Promise<{ count: number }>;
  };
  betaAccessRequest: {
    deleteMany(args: { where: Prisma.BetaAccessRequestWhereInput }): Promise<{ count: number }>;
  };
  betaAccessRequestEvent: {
    deleteMany(args: { where: Prisma.BetaAccessRequestEventWhereInput }): Promise<{ count: number }>;
  };
  merchantMergeDecision: {
    updateMany(args: { where: Prisma.MerchantMergeDecisionWhereInput; data: Prisma.MerchantMergeDecisionUpdateManyMutationInput }): Promise<{ count: number }>;
  };
  platformSetting: {
    updateMany(args: { where: Prisma.PlatformSettingWhereInput; data: Prisma.PlatformSettingUpdateManyMutationInput }): Promise<{ count: number }>;
  };
  merchantRule: {
    deleteMany(args: { where: Prisma.MerchantRuleWhereInput }): Promise<{ count: number }>;
  };
  investmentEvent: {
    updateMany(args: { where: Prisma.InvestmentEventWhereInput; data: Prisma.InvestmentEventUpdateManyMutationInput }): Promise<{ count: number }>;
  };
  commsDelivery: {
    updateMany(args: { where: Prisma.CommsDeliveryWhereInput; data: Prisma.CommsDeliveryUpdateManyMutationInput }): Promise<{ count: number }>;
  };
  auditLog: {
    create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown>;
  };
}

export interface PurgeClient extends PurgeTxClient {
  user: PurgeTxClient["user"] & {
    findUnique(args: { where: { id: string }; select: { id: true; email: true; deletionScheduledAt: true; purgeStartedAt: true } }): Promise<UserSnapshot | null>;
  };
  plaidItem: {
    findMany(args: { where: Prisma.PlaidItemWhereInput; select: { id: true; encryptedToken: true; institutionName: true } }): Promise<{ id: string; encryptedToken: string; institutionName: string }[]>;
    update(args: { where: { id: string }; data: Prisma.PlaidItemUpdateInput }): Promise<unknown>;
  };
  auditLog: PurgeTxClient["auditLog"] & {
    findMany(args: { where: Prisma.AuditLogWhereInput; select: { createdAt: true } }): Promise<{ createdAt: Date }[]>;
  };
  spaceAccountLink: {
    updateMany(args: { where: Prisma.SpaceAccountLinkWhereInput; data: Prisma.SpaceAccountLinkUncheckedUpdateManyInput }): Promise<{ count: number }>;
  };
  accountConnection: {
    findMany(args: { where: Prisma.AccountConnectionWhereInput; select: { id: true; financialAccountId: true } }): Promise<{ id: string; financialAccountId: string }[]>;
    findFirst(args: { where: Prisma.AccountConnectionWhereInput; select: { id: true } }): Promise<{ id: string } | null>;
    update(args: { where: { id: string }; data: Prisma.AccountConnectionUpdateInput }): Promise<unknown>;
  };
  financialAccount: PurgeTxClient["financialAccount"] & {
    update(args: { where: { id: string }; data: Prisma.FinancialAccountUpdateInput }): Promise<unknown>;
  };
  space: PurgeTxClient["space"] & {
    findMany(args: { where: Prisma.SpaceWhereInput; select: { id: true } }): Promise<{ id: string }[]>;
  };
  $transaction<T>(fn: (tx: PurgeTxClient) => Promise<T>, options?: { timeout?: number; maxWait?: number }): Promise<T>;
}

const purgeDb = db as unknown as PurgeClient;

export interface PurgeDeps {
  /** Test injection seam — production callers never pass this. */
  client?: PurgeClient;
  plaid?: Pick<typeof plaidClient, "itemRemove">;
  sendEmail?: typeof sendEmail;
  revokeSessions?: (userId: string) => Promise<unknown>;
  now?: () => Date;
}

/** The where-clause of the claim — exported so the test can assert its shape. */
export function purgeClaimWhere(userId: string, now: Date): Prisma.UserWhereInput {
  const staleBefore = new Date(now.getTime() - PURGE_CLAIM_STALE_MS);
  return {
    id: userId,
    deletionScheduledAt: { lte: now },
    OR: [{ purgeStartedAt: null }, { purgeStartedAt: { lte: staleBefore } }],
  };
}

/**
 * PRIV-001 — the SHARED Spaces that die with this user: every non-PERSONAL
 * Space in which the user is an ACTIVE member and NO OTHER user is. Exported
 * so the test can assert the predicate rather than a query's syntax.
 */
export function soleMemberSharedSpaceWhere(userId: string): Prisma.SpaceWhereInput {
  return {
    type: { not: SpaceType.PERSONAL },
    platformArea: null,
    members: { some: { userId, status: SpaceMemberStatus.ACTIVE } },
    NOT: { members: { some: { userId: { not: userId }, status: SpaceMemberStatus.ACTIVE } } },
  };
}

export async function purgeUser(userId: string, deps: PurgeDeps = {}): Promise<PurgeResult> {
  const client = deps.client ?? purgeDb;
  const plaid = deps.plaid ?? plaidClient;
  const email = deps.sendEmail ?? sendEmail;
  const revokeSessions = deps.revokeSessions ?? revokeAllUserSessions;
  const clock = deps.now ?? (() => new Date());

  const base: PurgeResult = {
    userId, purged: false, providerRevoked: 0, providerFailed: 0,
    deletedAccounts: 0, personalSpaces: 0, soleMemberSharedSpaces: 0,
  };

  // Load the minimal snapshot we need (email for the final notice + audit hash).
  const user = await client.user.findUnique({
    where:  { id: userId },
    select: { id: true, email: true, deletionScheduledAt: true, purgeStartedAt: true },
  });
  if (!user) return { ...base, skipped: "already-deleted" };

  const now = clock();

  // Safety re-check: only purge accounts that are genuinely due.
  if (!user.deletionScheduledAt || user.deletionScheduledAt > now) {
    return { ...base, skipped: "not-due" };
  }

  // ── 0. CLAIM — exactly one worker proceeds ─────────────────────────────────
  const claim = await client.user.updateMany({ where: purgeClaimWhere(userId, now), data: { purgeStartedAt: now } });
  if (claim.count !== 1) {
    console.log(`[purge] user ${userId} — claim refused (another worker holds it, or it is no longer due); nothing done.`);
    return { ...base, skipped: "claimed-elsewhere" };
  }
  const claimedAt = now;
  const releaseClaim = () =>
    client.user.updateMany({ where: { id: userId, purgeStartedAt: claimedAt }, data: { purgeStartedAt: null } })
      .catch((e) => console.error(`[purge] failed to release claim for user ${userId}:`, redactedErrorForLog(e)));

  // ── 1. Revoke all sessions (idempotent) ────────────────────────────────────
  await revokeSessions(userId);

  // ── 2. Provider revocation — Plaid first, best-effort, OUTSIDE any tx ───────
  // At full-account deletion every PlaidItem is orphaned by definition, so we
  // apply lib/plaid/disconnect.ts's core (decrypt → itemRemove → mark REVOKED)
  // to each ACTIVE item directly. A failure is logged and counted, never fatal.
  const items = await client.plaidItem.findMany({
    where:  { userId, status: PlaidItemStatus.ACTIVE },
    select: { id: true, encryptedToken: true, institutionName: true },
  });

  // PRE-BETA-OPS-CLOSE Phase 3 — BOUNDED revocation retry.
  //
  // Only a CONFIRMED revocation (or a proven already-absent item) marks
  // REVOKED. A retryable failure leaves the item ACTIVE and holds the deletion,
  // so the existing daily cron — already documented as idempotent and resumable
  // — retries it tomorrow with the token still intact.
  const retryableFailures: { itemId: string; institution: string; reason: string }[] = [];

  for (const item of items) {
    let revoked = false;
    let failure: { reason: string } | null = null;
    try {
      const accessToken = decryptWithPurpose(item.encryptedToken, EncryptionPurpose.PLAID_ACCESS_TOKEN);
      await plaid.itemRemove({ access_token: accessToken });
      revoked = true;
      base.providerRevoked++;
    } catch (err) {
      const code = getPlaidErrorCode(err);
      if (classifyRevocationFailure(code) === "already-gone") {
        // ITEM_NOT_FOUND: Plaid invalidates the token on a successful
        // /item/remove, so the item is definitively absent upstream. Nothing
        // left to revoke — reconciled, not failed.
        revoked = true;
        base.providerRevoked++;
        console.log(`[purge] Plaid item ${item.id} already absent upstream (${code}) — treated as revoked.`);
      } else {
        base.providerFailed++;
        // Sanitized: a Plaid error_code or a generic label. Never a token, and
        // never a raw provider payload that might embed one.
        failure = { reason: code ?? "PLAID_ITEM_REMOVE_FAILED" };
        console.error(`[purge] Plaid itemRemove failed for item ${item.id} (code=${code ?? "unknown"}) — deletion held for retry.`);
      }
    }

    if (revoked) {
      // Mark REVOKED only on a CONFIRMED outcome. Keeps the ACTIVE filter above
      // an honest work-list for the next run — and makes the provider call
      // once-only across retries (IDEMP-002 d).
      try {
        await client.plaidItem.update({ where: { id: item.id }, data: { status: PlaidItemStatus.REVOKED } });
      } catch { /* row will be cascade-deleted at step 8 regardless */ }
    } else if (failure) {
      retryableFailures.push({ itemId: item.id, institution: item.institutionName, reason: failure.reason });
    }
  }

  // ── Bounded-attempt decision ───────────────────────────────────────────────
  // Attempts are counted in DISTINCT CALENDAR DAYS of prior failure, not audit
  // rows: the policy is "3 daily attempts", and day-counting makes a duplicate
  // or manually re-run cron on the same day ONE attempt-day.
  const priorFailureAudits = await client.auditLog.findMany({
    where:  { userId, action: AuditAction.ACCOUNT_DELETION_REVOCATION_FAILED },
    select: { createdAt: true },
  });
  const priorFailureDays = countPriorFailureDays(priorFailureAudits.map((a) => a.createdAt), now);
  const decision = decideRevocation({ retryableFailures: retryableFailures.length, priorFailureDays });

  if (decision.action !== "proceed") {
    // One durable, non-secret record per failed item for THIS attempt.
    for (const f of retryableFailures) {
      await client.auditLog.create({
        data: {
          userId,
          action:   AuditAction.ACCOUNT_DELETION_REVOCATION_FAILED,
          metadata: {
            provider:    "PLAID",
            plaidItemId: f.itemId,
            institution: f.institution,
            attemptDay:  decision.attemptDay,
            maxAttempts: MAX_REVOCATION_ATTEMPT_DAYS,
            reason:      f.reason,
          },
        },
      });
    }
  }

  if (decision.action === "hold") {
    // HOLD: do NOT delete the User, do NOT destroy the token, do NOT clear
    // deletionScheduledAt. Sessions are already revoked (step 1), so the user
    // cannot use the account meanwhile — deletion is genuinely in progress, and
    // the next daily run retries with the token intact. The claim is released
    // so tomorrow's worker does not have to wait for it to go stale.
    await releaseClaim();
    console.warn(
      `[purge] user ${userId} — deletion HELD pending provider revocation ` +
      `(attempt ${decision.attemptDay}/${MAX_REVOCATION_ATTEMPT_DAYS}, ${retryableFailures.length} item(s) unrevoked). Retrying next run.`,
    );
    return { ...base, skipped: "pending-provider-revocation" };
  }

  if (decision.action === "proceed-unrevoked") {
    // TERMINAL: the budget is spent. Complete the deletion the user asked for —
    // a provider outage must not hold their data hostage — but record honestly
    // that upstream revocation was NEVER confirmed. This row is written BEFORE
    // the User delete and survives it (AuditLog.userId is SetNull), carrying
    // enough non-secret detail for an operator to revoke by hand in the Plaid
    // dashboard. It is a DISTINCT action from ACCOUNT_DELETED precisely so no
    // reader can mistake a completed deletion for a completed revocation.
    await client.auditLog.create({
      data: {
        userId,
        action:   AuditAction.ACCOUNT_DELETED_UNREVOKED,
        metadata: {
          provider:       "PLAID",
          attemptDays:    decision.attemptDay,
          unrevokedItems: retryableFailures.map((f) => ({
            plaidItemId: f.itemId, institution: f.institution, reason: f.reason,
          })),
          note: "Local deletion completed. Upstream Plaid consent was NOT confirmed revoked — manual revocation required.",
        },
      },
    });
    console.error(
      `[purge][CRITICAL] user ${userId} — deletion COMPLETING WITHOUT CONFIRMED PROVIDER REVOCATION ` +
      `after ${decision.attemptDay} daily attempts. Unrevoked items: ${retryableFailures.map((f) => f.itemId).join(", ")}. ` +
      `Manual revocation required in the Plaid dashboard.`,
    );
    // Mark them REVOKED locally now — not a claim about upstream (the audit row
    // above is the truth), just local state consistency before the cascade.
    for (const f of retryableFailures) {
      try {
        await client.plaidItem.update({ where: { id: f.itemId }, data: { status: PlaidItemStatus.REVOKED } });
      } catch { /* cascade-deleted below regardless */ }
    }
  }

  // MANUAL / WALLET Connections have nothing to revoke upstream (S5) — no-op.

  // ── 3. Revoke SALs the user added, in surviving Spaces ─────────────────────
  // status REVOKED (SAL doctrine); the S5 FK flip nulls addedByUserId harmlessly
  // at step 8. Idempotent: an already-REVOKED link does not match.
  await client.spaceAccountLink.updateMany({
    where: { addedByUserId: userId, status: ShareStatus.ACTIVE },
    data:  { status: ShareStatus.REVOKED, revokedAt: now, revokedByUserId: userId },
  });

  // ── 4. Canonical AccountConnection resolution (SPACE-owned accounts) ────────
  // Where the user's connection is the authoritative (isCanonical) source for a
  // surviving SPACE-owned account, re-elect another live connection, else mark
  // the account stale. The account survives; the user's connection is cascade-
  // deleted at step 8. (S5 §4c.)
  const canonicalConns = await client.accountConnection.findMany({
    where: {
      connectedByUserId: userId,
      deletedAt:         null,
      isCanonical:       true,
      financialAccount:  { ownerType: "SPACE", deletedAt: null },
    },
    select: { id: true, financialAccountId: true },
  });
  for (const conn of canonicalConns) {
    const replacement = await client.accountConnection.findFirst({
      where:  { financialAccountId: conn.financialAccountId, deletedAt: null, connectedByUserId: { not: userId } },
      select: { id: true },
    });
    if (replacement) {
      await client.accountConnection.update({ where: { id: replacement.id }, data: { isCanonical: true } });
      await client.accountConnection.update({ where: { id: conn.id }, data: { isCanonical: false, deletedAt: now } });
    } else {
      await client.financialAccount.update({ where: { id: conn.financialAccountId }, data: { syncStatus: "stale" } });
      await client.accountConnection.update({ where: { id: conn.id }, data: { deletedAt: now } });
    }
  }

  // ── Scope of the destructive tail ──────────────────────────────────────────
  // PERSONAL Spaces this user OWNS (role: OWNER, status: ACTIVE — without this
  // filter any personal-type Space the user was ever added to would match and
  // be destroyed; the step is irreversible, so it gets the filter regardless
  // of what the invariant elsewhere promises), plus — PRIV-001 — every SHARED
  // Space whose only active member is this user. The preflight blocks deletion
  // only while OTHER active members remain, so a sole-member SHARED Space is
  // exactly the row that used to survive "permanent" deletion with its
  // accounts and transactions.
  const personalSpaces = await client.space.findMany({
    where:  { type: SpaceType.PERSONAL, members: { some: { userId, role: SpaceMemberRole.OWNER, status: SpaceMemberStatus.ACTIVE } } },
    select: { id: true },
  });
  const soleShared = await client.space.findMany({ where: soleMemberSharedSpaceWhere(userId), select: { id: true } });
  const personalSpaceIds = personalSpaces.map((s) => s.id);
  const soleSharedIds = soleShared.map((s) => s.id).filter((id) => !personalSpaceIds.includes(id));
  const dyingSpaceIds = [...personalSpaceIds, ...soleSharedIds];

  const emailHash = createHash("sha256").update(user.email.toLowerCase()).digest("hex");

  // ── 5–8. The destructive tail — ONE transaction, fenced on the claim ───────
  let committed = false;
  await client.$transaction(async (tx) => {
    // 5a. Re-validate IMMEDIATELY before anything irreversible. The row must
    //     still be due and still carry THIS worker's claim. A cancel-at-login
    //     (lib/auth.ts clears deletionScheduledAt) between the claim and here
    //     makes this match nothing, and the tail is abandoned.
    const fence = await tx.user.updateMany({
      where: { id: userId, deletionScheduledAt: { lte: now }, purgeStartedAt: claimedAt },
      data:  { purgeStartedAt: claimedAt },
    });
    if (fence.count !== 1) return;

    // 5b. Delete USER-owned FinancialAccounts (explicit — SetNull ≠ cascade)
    //     and every account owned by a Space that goes in step 6 (DB-011), so
    //     no ownerless "ghost" account with its full history is left behind.
    //     Deleting a FinancialAccount cascades its transactions, holdings,
    //     connections, debtProfile, provider identities, SALs, goal
    //     contributions and imports.
    const deleted = await tx.financialAccount.deleteMany({
      where: { OR: [{ ownerUserId: userId }, { ownerSpaceId: { in: dyingSpaceIds } }] },
    });
    base.deletedAccounts = deleted.count;

    // 6. Delete the Spaces (existing cascade: SpaceMember, SpaceInvite, AiAgent,
    //    AiAdvice, SpaceGoal, SpaceDashboardSection, SpaceSnapshot,
    //    ImportMappingProfile, SpaceMemory, DailyBrief, …).
    for (const id of dyingSpaceIds) {
      await tx.space.delete({ where: { id } });
    }
    base.personalSpaces = personalSpaceIds.length;
    base.soleMemberSharedSpaces = soleSharedIds.length;

    // 6b. DB-002 — scrub the soft references the FK cascade cannot reach.
    //     Pseudonymous ids are still identifiers; the subject's e-mail on the
    //     waitlist is PII outright (PRIV-012).
    await tx.aiInvocation.updateMany({ where: { userId }, data: { userId: null } });
    await tx.betaAccessRequest.deleteMany({ where: { email: { equals: user.email, mode: "insensitive" } } });
    await tx.betaAccessRequestEvent.deleteMany({ where: { email: { equals: user.email, mode: "insensitive" } } });
    await tx.merchantMergeDecision.updateMany({ where: { decidedByUserId: userId }, data: { decidedByUserId: null } });
    await tx.platformSetting.updateMany({ where: { updatedById: userId }, data: { updatedById: null } });
    await tx.merchantRule.deleteMany({ where: { ownerUserId: userId } });
    await tx.investmentEvent.updateMany({ where: { createdByUserId: userId }, data: { createdByUserId: null } });
    // Comms Center A-2a — the delivery ledger keeps its COUNTS but forgets who:
    // the soft recipientUserId, and the salted recipient hash of the address
    // (rows sent before an account existed, e.g. a beta invite), are nulled.
    // ALWAYS by userId (whether or not a salt is configured), then — when the
    // salt is set — by the hash of the CURRENT address (rows sent to this
    // person before they had an account). An address the user changed away
    // from cannot be re-derived; those rows carry no userId and only an HMAC.
    await tx.commsDelivery.updateMany({
      where: { recipientUserId: userId },
      data:  { recipientUserId: null, recipientHash: null },
    });
    const ledgerHash = recipientHash(user.email, process.env);
    if (ledgerHash) {
      await tx.commsDelivery.updateMany({
        where: { recipientHash: ledgerHash },
        data:  { recipientUserId: null, recipientHash: null },
      });
    }

    // 7. ACCOUNT_DELETED audit (written BEFORE the delete). userId is set now;
    //    the user delete below SetNulls it, so the row survives anonymized
    //    (S5 §5). Email is stored only as a one-way hash — the raw address must
    //    not persist on an anonymized row.
    await tx.auditLog.create({
      data: {
        userId,
        action:   AuditAction.ACCOUNT_DELETED,
        metadata: {
          emailHash,
          deletedAccounts:        base.deletedAccounts,
          personalSpaces:         base.personalSpaces,
          soleMemberSharedSpaces: base.soleMemberSharedSpaces,
          providerRevoked:        base.providerRevoked,
          providerFailed:         base.providerFailed,
        },
      },
    });

    // 8. Delete the User (final cascade).
    await tx.user.delete({ where: { id: userId } });
    committed = true;
  }, { timeout: PURGE_TX_TIMEOUT_MS, maxWait: 10_000 });

  if (!committed) {
    console.warn(`[purge] user ${userId} — deletion cancelled or re-claimed between the claim and the destructive tail; nothing irreversible happened.`);
    return { ...base, skipped: "cancelled" };
  }

  // ── 9. Final notice — AFTER commit, exactly once ───────────────────────────
  // Reuses the security-alert template. NON-THROWING: delivery failure never
  // blocks. Only the worker whose transaction committed reaches this line.
  const emailResult = await email("security-alert", user.email, { ...accountDeletedAlert() }, {
    // The account no longer exists: no userId, and no recipient hash either —
    // nothing on the ledger may link back to the purged person.
    key: "ACCOUNT_DELETED", recipientUserId: null, hashRecipient: false,
  });
  if (emailResult.status === "error") {
    console.error("[purge] deletion-complete security-alert email failed to send:", redactedErrorForLog(emailResult.error));
  }

  base.purged = true;
  return base;
}
