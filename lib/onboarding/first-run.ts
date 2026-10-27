/**
 * lib/onboarding/first-run.ts  (Connections pass PR 2 — first-time onboarding)
 *
 * Reads the facts decideFirstRun needs, AS THE USER (withTenantDb — every row
 * here is the caller's own), in one tenant transaction. Counts and existence
 * only: no names, balances or identifiers leave this module.
 *
 * ⚠️ FAILS OPEN. Any read failure returns NO_ONBOARDING — no redirect and no
 * invitation — so a database hiccup can never route an established user into
 * onboarding, and never blocks a page.
 */

import "server-only";
import { withTenantDb } from "@/lib/db/tenant-context";
import { AuditAction } from "@/lib/audit-actions";
import { decideFirstRun, NO_ONBOARDING, type FirstRunDecision } from "./first-run.core";

export async function readFirstRun(userId: string): Promise<FirstRunDecision> {
  try {
    const facts = await withTenantDb(userId, async (tx) => {
      const [itemsEver, itemsLive, walletsEver, accountsEver, accountsLive, shared, markers] = await Promise.all([
        tx.plaidItem.count({ where: { userId } }),
        tx.plaidItem.count({ where: { userId, status: { not: "REVOKED" } } }),
        tx.connection.count({ where: { userId } }),
        tx.financialAccount.count({ where: { ownerUserId: userId } }),
        tx.financialAccount.count({ where: { ownerUserId: userId, deletedAt: null } }),
        tx.spaceMember.count({ where: { userId, status: "ACTIVE", space: { type: { not: "PERSONAL" } } } }),
        tx.auditLog.findMany({
          where: { userId, action: { in: [AuditAction.ONBOARDING_PRESENTED, AuditAction.ONBOARDING_DISMISSED] } },
          select: { action: true },
          distinct: ["action"],
        }),
      ]);
      // A live wallet always owns a live account, so accountsLive covers wallets.
      return {
        sourcesEver: itemsEver + walletsEver + accountsEver,
        sourcesLive: itemsLive + accountsLive,
        sharedMemberships: shared,
        presented: markers.some((m) => m.action === AuditAction.ONBOARDING_PRESENTED),
        dismissed: markers.some((m) => m.action === AuditAction.ONBOARDING_DISMISSED),
      };
    });
    return decideFirstRun(facts);
  } catch (err) {
    console.error("[onboarding] first-run read failed (fail-open):", err);
    return NO_ONBOARDING;
  }
}

/**
 * The notice rail's invitation, read on every dashboard render — so it is the
 * CHEAP half of the rule: one live-source probe per kind and one marker probe,
 * each an indexed findFirst. Fails quiet (false).
 */
export async function readConnectInvitation(userId: string): Promise<boolean> {
  try {
    return await withTenantDb(userId, async (tx) => {
      const [dismissed, item, account] = await Promise.all([
        tx.auditLog.findFirst({ where: { userId, action: AuditAction.ONBOARDING_DISMISSED }, select: { id: true } }),
        tx.plaidItem.findFirst({ where: { userId, status: { not: "REVOKED" } }, select: { id: true } }),
        tx.financialAccount.findFirst({ where: { ownerUserId: userId, deletedAt: null }, select: { id: true } }),
      ]);
      return !dismissed && !item && !account;
    });
  } catch {
    return false;
  }
}

export type OnboardingEvent = "presented" | "dismissed";

/** Idempotent: at most one row per (user, marker). */
export async function recordOnboardingEvent(userId: string, event: OnboardingEvent): Promise<void> {
  const action = event === "presented" ? AuditAction.ONBOARDING_PRESENTED : AuditAction.ONBOARDING_DISMISSED;
  await withTenantDb(userId, async (tx) => {
    const already = await tx.auditLog.findFirst({ where: { userId, action }, select: { id: true } });
    if (already) return;
    await tx.auditLog.create({ data: { userId, action } });
  });
}
