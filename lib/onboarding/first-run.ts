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
import { randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";
import { decideFirstRun, NO_ONBOARDING, type FirstRunDecision } from "./first-run.core";

/**
 * Every account this user is accountable for, by ANY of the three ownership
 * answers: owned by them (ownerType USER), created by them, or owned by a Space
 * they OWN — a SPACE-owned account in their personal Space has ownerUserId NULL
 * by design (schema D11), so ownerUserId alone made such a user look new.
 */
function accountsOf(userId: string, live: boolean): Prisma.FinancialAccountWhereInput {
  return {
    ...(live ? { deletedAt: null } : {}),
    OR: [
      { ownerUserId: userId },
      { createdByUserId: userId },
      { ownerSpace: { members: { some: { userId, role: "OWNER", status: "ACTIVE" } } } },
      { connections: { some: { connectedByUserId: userId, ...(live ? { deletedAt: null } : {}) } } },
    ],
  };
}

export async function readFirstRun(userId: string): Promise<FirstRunDecision> {
  try {
    const facts = await withTenantDb(userId, async (tx) => {
      const [itemsEver, itemsLive, walletsEver, accountsEver, accountsLive, shared, markers] = await Promise.all([
        tx.plaidItem.count({ where: { userId } }),
        tx.plaidItem.count({ where: { userId, status: { not: "REVOKED" } } }),
        tx.connection.count({ where: { userId } }),
        tx.financialAccount.count({ where: accountsOf(userId, false) }),
        tx.financialAccount.count({ where: accountsOf(userId, true) }),
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
        tx.financialAccount.findFirst({ where: accountsOf(userId, true), select: { id: true } }),
      ]);
      return !dismissed && !item && !account;
    });
  } catch {
    return false;
  }
}

export type OnboardingEvent = "presented" | "dismissed";

/**
 * Idempotent: at most one row per (user, marker), in ONE statement — the
 * product-events writer's pattern (lib/analytics/product-events.ts): INSERT …
 * WHERE NOT EXISTS, nothing read back (no RETURNING, so no dependence on the
 * SELECT policy for the new row). fm_app may INSERT any AuditLog row (WITH CHECK
 * true) and the NOT EXISTS reads the user's own rows, which fm_app_sel admits.
 * Throws on failure: the route must not report a marker it did not write.
 */
export async function recordOnboardingEvent(userId: string, event: OnboardingEvent): Promise<void> {
  const action = event === "presented" ? AuditAction.ONBOARDING_PRESENTED : AuditAction.ONBOARDING_DISMISSED;
  const id = randomUUID();
  await withTenantDb(userId, (tx) => tx.$executeRaw`
    INSERT INTO "AuditLog" ("id", "userId", "action", "metadata")
    SELECT ${id}::text, ${userId}::text, ${action}::text, ${JSON.stringify({ actorType: "USER", result: "SUCCESS" })}::jsonb
     WHERE NOT EXISTS (SELECT 1 FROM "AuditLog" WHERE "userId" = ${userId}::text AND "action" = ${action}::text)`);
}
