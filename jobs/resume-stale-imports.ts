/**
 * jobs/resume-stale-imports.ts
 *
 * Finish first-run imports that nothing else is going to finish.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * A connect starts an import that routinely needs more than one pass: Plaid
 * prepares history asynchronously and delivers it over the following minutes.
 * Until 2026-07-23 the only things that drove the remaining passes were:
 *
 *   1. A Plaid webhook — reliable when it arrives, but a webhook that lands
 *      while a sync holds the lock is answered "skipped-locked" and is NOT
 *      redelivered. If no further webhook follows, nothing retries.
 *   2. The client poller in components/connections/ConnectionsList — which only
 *      runs WHILE THE CONNECTIONS PAGE IS OPEN.
 *   3. sync-banks, on the dispatcher cron (0,30 past 0,6,7,12,18 UTC) — hours away.
 *
 * (2) is the weak one, and raising RESUME_GRACE_MS to 315s (to match the
 * server's overlap guard) made it weaker: the user must now keep the page open
 * for five minutes. On mobile — where a connect is often the last thing someone
 * does before locking the phone — that essentially never happens. Observed the
 * same day: a Schwab import stopped 7 seconds after connect and sat untouched,
 * its wealth window frozen at the 30-day fallback, waiting on a browser tab that
 * had long since closed.
 *
 * First-run completion must not depend on a browser tab. This job is the
 * server-side backstop: every few minutes, find imports that have been sitting
 * incomplete longer than the grace window and drive them forward.
 *
 * ── Design ──────────────────────────────────────────────────────────────────
 * Delegates to syncPlaidItemFromWebhook — the SAME entrypoint the webhook
 * receiver uses. That gives the sync lock (so this can never race a webhook, a
 * client resume, or another instance of itself), the full deferred pipeline
 * (balances, snapshots, A9 wealth-history recompute) and its never-throws
 * contract, with no second implementation to keep in step.
 *
 * STALE_AFTER_MS mirrors RESUME_MIN_AGE_MS: below that age an import may still
 * be legitimately in flight and must be left alone.
 *
 * Bounded per run, oldest first, and it LOGS what it left behind — a silent cap
 * would read as "everything is handled" while a backlog quietly grew.
 */

import { db } from "@/lib/db";
import { PlaidItemStatus } from "@prisma/client";
import { syncPlaidItemFromWebhook } from "@/lib/plaid/webhook-sync";
// OPS-2D-4 — canonical admission, resolved once per dispatch.
import { admitOperationalWork } from "@/lib/platform/admission/facts";
import type { StampedAdmissionVerdict } from "@/lib/platform/admission/types";
import type { WebhookSyncOutcome } from "@/lib/plaid/webhook-sync";
import {
  createBillableBatchGate, tallyBillableDenial,
  type BillableBatchLoader, type BillableDecision, type BillableDenialTally,
} from "@/lib/entitlements/billable-gate";

/** The canonical per-candidate driver. Only tests replace it. The batch decision is threaded (no second read). */
const driveCandidate = (itemId: string, admission: StampedAdmissionVerdict, billable: BillableDecision) =>
  syncPlaidItemFromWebhook(itemId, "RESUME", "IMPORT_RECOVERY", admission, { billable });

/**
 * Minimum age of the syncIncompleteAt marker before this job will touch an item.
 * Mirrors RESUME_MIN_AGE_MS in app/api/plaid/resume-sync/route.ts, which sits
 * just above the 300s connect/sync budget — younger than that and the original
 * pass may still be running. The lock makes an overlap harmless, but not
 * pointless work, so the age gate stays.
 */
const STALE_AFTER_MS = 315_000;

/** Items driven per run. Bounded so one invocation cannot exceed its budget. */
const MAX_ITEMS_PER_RUN = 5;

/** One stale-import candidate, as the loader yields it. */
export interface StaleImportCandidate {
  id: string;
  institutionName: string;
  /** BETA LIFECYCLE L2 — the connector (the billed customer). */
  userId?: string | null;
}

/**
 * Injection seam — production callers never pass this.
 *
 * WHY IT EXISTS (OPS-2D-4A follow-up): a runtime proof of the recovery path
 * called this job directly against the persistent development database. The job
 * is an UNSCOPED FAN-OUT — it selects every stale item on the platform — so the
 * proof drove two unrelated real connections through a mocked provider and
 * overwrote their Plaid cursors. The mistake was not the mock; it was that a
 * test could not express "only these items" at all.
 *
 * With `loadCandidates` injected, the set of records a run can touch is exactly
 * the set the caller supplies. A scoped test is now the easy path, and
 * `recovery-isolation.test.ts` asserts no tracked test uses the unscoped form.
 *
 * `drive` is separate so a test can choose between the real pipeline on fixture
 * items and a fully mocked driver.
 */
/**
 * IDEMP-007 — delay before the NEXT resume attempt after the Nth failed one
 * (the first attempt is STALE_AFTER_MS after the marker): 15 min, 1 h, 6 h,
 * then daily. A failed attempt is a "ran" outcome after which the Item is
 * still incomplete; a lost lock race or a denied admission is not an attempt.
 */
export const RESUME_BACKOFF_MS: readonly number[] = [15 * 60_000, 60 * 60_000, 6 * 3_600_000, 24 * 3_600_000];
export function resumeBackoffMs(failedAttempts: number): number {
  return RESUME_BACKOFF_MS[Math.min(Math.max(failedAttempts, 1), RESUME_BACKOFF_MS.length) - 1];
}

export interface ResumeStaleImportsDeps {
  /** Returns the candidate population. Defaults to the platform-wide query. */
  loadCandidates?: (cutoff: Date, take: number, opts?: { excludeUserIds?: readonly string[] }) => Promise<{ candidates: number; items: StaleImportCandidate[] }>;
  /**
   * BETA LIFECYCLE L2 — the DISTINCT connectors of every stale candidate (not
   * just the first page), so restricted customers can be EXCLUDED from the
   * page instead of occupying its slots forever. Default: one distinct query;
   * when only `loadCandidates` is injected (scoped tests), the loaded page's users.
   */
  loadCandidateUsers?: (cutoff: Date) => Promise<string[]>;
  /** Drives one candidate. Defaults to the shared webhook/recovery wrapper. */
  drive?: (itemId: string, admission: StampedAdmissionVerdict, billable: BillableDecision) => Promise<WebhookSyncOutcome>;
  /**
   * BETA LIFECYCLE L2 — the batch billable decision for the candidates'
   * connectors (ONE policy read per pass). Default: billableAllowedForUsers.
   */
  billable?: BillableBatchLoader;
  /**
   * Resolves the dispatch-level admission verdict. Defaults to the canonical
   * evaluator. Injected only so a scoped test can be hermetic — without it a
   * test with no database reachable resolves UNAVAILABLE and every run is
   * denied, which would make the isolation assertions vacuously true.
   */
  admit?: () => Promise<StampedAdmissionVerdict>;
  /** IDEMP-007 — record a "ran" attempt's result (backoff when still incomplete). Default writes PlaidItem. */
  recordAttempt?: (itemId: string, now: Date) => Promise<void>;
  /** IDEMP-007 — reset the counter on Items that have since completed. */
  resetCompleted?: () => Promise<void>;
  now?: () => Date;
}

export interface ResumeStaleImportsResult {
  candidates: number;
  attempted:  number;
  /** Pipeline actually ran for this item (it may still have failed inside). */
  ran:        number;
  /** Another sync held the lock — that run resolves the item, not this one. */
  skipped:    number;
  deferred:   number;
  /**
   * BETA LIFECYCLE L2 — candidates refused by the billable gate (frozen /
   * paused / ended / unverifiable / no billing owner). NOT attempts: no
   * backoff recorded, no marker touched; they stay candidates and resume after
   * the restriction lifts. Reasons tallied in `planRestrictedReasons`.
   */
  planRestricted?: number;
  planRestrictedReasons?: BillableDenialTally;
  /** BETA LIFECYCLE L2 — distinct restricted connectors whose stale Items were excluded from this pass's page. */
  planRestrictedUsers?: number;
  /**
   * OPS-2D-4 — the typed admission reason when the platform declined this pass.
   * Null on every admitted run. This is the DISPATCH-level finding: the job ran,
   * policy said no, and no candidate was attempted.
   */
  notAdmitted?: string;
}

/**
 * THE canonical, platform-wide candidate query. The scheduled path always uses
 * this; only tests replace it.
 */
function staleWhere(cutoff: Date, excludeUserIds: readonly string[] = []) {
  return {
    status:           PlaidItemStatus.ACTIVE,
    syncIncompleteAt: { lt: cutoff },
    user: { deactivatedAt: null },
    OR: [{ syncResumeNextAt: null }, { syncResumeNextAt: { lte: new Date() } }],
    ...(excludeUserIds.length > 0 ? { userId: { notIn: [...excludeUserIds] } } : {}),
  };
}

/** BETA LIFECYCLE L2 — every stale candidate's connector, distinct (bounded by the user count). */
async function loadStaleCandidateUsers(cutoff: Date): Promise<string[]> {
  const rows = await db.plaidItem.findMany({ where: staleWhere(cutoff), distinct: ["userId"], select: { userId: true } });
  return rows.map((r) => r.userId);
}

async function loadStaleCandidates(
  cutoff: Date,
  take: number,
  opts: { excludeUserIds?: readonly string[] } = {},
): Promise<{ candidates: number; items: StaleImportCandidate[] }> {
  if (opts.excludeUserIds && opts.excludeUserIds.length > 0) {
    // BETA LIFECYCLE L2 — the same population minus restricted connectors.
    const where = staleWhere(cutoff, opts.excludeUserIds);
    const candidates = await db.plaidItem.count({ where });
    const items = await db.plaidItem.findMany({ where, orderBy: { syncIncompleteAt: "asc" }, take, select: { id: true, institutionName: true, userId: true } });
    return { candidates, items };
  }
  const where = {
    status:           PlaidItemStatus.ACTIVE,
    syncIncompleteAt: { lt: cutoff },
    // Same billing-honesty gate sync-banks uses: a deactivated user's items
    // shouldn't keep accruing Plaid calls.
    user: { deactivatedAt: null },
    // IDEMP-007 — only Items whose backoff has elapsed.
    OR: [{ syncResumeNextAt: null }, { syncResumeNextAt: { lte: new Date() } }],
  };

  const candidates = await db.plaidItem.count({ where });
  const items = await db.plaidItem.findMany({
    where,
    // Oldest first: the longest-stalled import is the one a user is most likely
    // staring at.
    orderBy: { syncIncompleteAt: "asc" },
    take,
    select:  { id: true, institutionName: true, userId: true },
  });
  return { candidates, items };
}

export async function resumeStaleImports(
  deps: ResumeStaleImportsDeps = {},
): Promise<ResumeStaleImportsResult> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
  // IDEMP-007 — Items that completed since their last failed resume start over.
  // Deliberately BEFORE admission: it touches only rows with syncIncompleteAt
  // null (never a candidate) and makes no provider call, so a paused platform
  // still converges its backoff bookkeeping; a stale counter would otherwise
  // delay that Item's first resume after its next stall.
  await (deps.resetCompleted ?? resetCompletedResumes)().catch((e) =>
    console.warn("[resume-stale-imports] backoff reset failed (non-fatal):", e instanceof Error ? e.message : String(e)));
  const { candidates, items } = await (deps.loadCandidates ?? loadStaleCandidates)(cutoff, MAX_ITEMS_PER_RUN);

  const deferred = Math.max(0, candidates - items.length);
  if (candidates === 0) {
    console.log("[resume-stale-imports] no stale imports.");
    return { candidates: 0, attempted: 0, ran: 0, skipped: 0, deferred: 0 };
  }

  // ── OPS-2D-4 — ADMISSION, once per dispatch ─────────────────────────────────
  // Resolved ONCE, before the loop, and only after there is real work to
  // consider. Platform-wide facts do not change between items, so asking per
  // item would be N reads answering one question — and a mid-loop flip would
  // make a single dispatch behave two ways.
  //
  // Evidence is ONE dispatch-level finding, not one denied execution per
  // candidate. This job fires every five minutes; per-candidate rows would add
  // thousands of identical entries to the refresh ledger during a pause and bury
  // the real executions the surface exists to show.
  //
  // Critically: this returns BEFORE the loop, so no syncIncompleteAt is
  // re-stamped and no recovery timestamp moves. A denied pass leaves every
  // candidate exactly as stale as it was, which is the truth — the work did not
  // happen, so the item is not one attempt closer to being resolved.
  const admission = await (deps.admit ?? (() => admitOperationalWork({ work: "REFRESH_EXECUTION" })))();
  if (admission.decision === "DENY") {
    console.log(
      `[resume-stale-imports] ${candidates} stale import(s) present but NOT ADMITTED — ${admission.reason}; ` +
        "no candidate attempted, no recovery marker touched.",
    );
    return { candidates, attempted: 0, ran: 0, skipped: 0, deferred: candidates, notAdmitted: admission.reason! };
  }

  console.log(
    `[resume-stale-imports] ${candidates} stale import(s) older than ${STALE_AFTER_MS / 1000}s; ` +
      `driving ${items.length}${deferred > 0 ? `, ${deferred} deferred to the next run` : ""}.`,
  );

  // The outcome is "ran" | "skipped-locked" — success is deliberately NOT in it.
  // A failed pipeline stamps item health itself and leaves syncIncompleteAt set,
  // so a genuinely broken import simply reappears as a candidate next run. That
  // is the retry, and it needs no bookkeeping here.
  // BETA LIFECYCLE L2 — ONE batch policy read for EVERY stale candidate's
  // connector, then the page is re-taken WITHOUT the restricted ones. Refusing
  // inside the first page instead would let five frozen customers hold all
  // MAX_ITEMS_PER_RUN slots forever (a refusal records no backoff), starving
  // every allowed customer's import (review P1-1).
  const allUsers = deps.loadCandidateUsers
    ? await deps.loadCandidateUsers(cutoff)
    : deps.loadCandidates ? items.map((i) => i.userId).filter((u): u is string => !!u) : await loadStaleCandidateUsers(cutoff);
  const gate = createBillableBatchGate([...allUsers, ...items.map((i) => i.userId)], "plaid_resume_sync", deps.billable ? { load: deps.billable } : {});
  const restrictedUsers: string[] = [];
  for (const u of new Set(allUsers)) if (!(await gate.decide(u)).allowed) restrictedUsers.push(u);
  let page = items;
  if (restrictedUsers.length > 0) {
    page = (await (deps.loadCandidates ?? loadStaleCandidates)(cutoff, MAX_ITEMS_PER_RUN, { excludeUserIds: restrictedUsers })).items;
  }
  let ran = 0, skipped = 0, planRestricted = 0;
  const planRestrictedReasons: BillableDenialTally = {};
  for (const item of page) {
    const billable = await gate.decide(item.userId);
    if (!billable.allowed) {
      // Not an attempt: no drive, no backoff, no marker — the same as a denied admission.
      planRestricted++;
      tallyBillableDenial(planRestrictedReasons, billable.reason);
      console.log(`[resume-stale-imports] ${item.institutionName} (${item.id}) → plan-restricted (${billable.reason})`);
      continue;
    }
    // OPS-2D-1 — this backstop is neither a webhook nor a reconnect: nothing was
    // pushed to us and no token changed hands. It continues an incomplete
    // first-run import, so it records RESUME / IMPORT_RECOVERY. The BODY is the
    // shared deferred pipeline, unchanged.
    // The verdict is THREADED, not re-resolved: one decision governs the whole
    // dispatch (see the admission block above).
    const outcome = await (deps.drive ?? driveCandidate)(item.id, admission, billable); // never throws, by contract
    if (outcome === "plan-restricted") { planRestricted++; continue; }
    if (outcome === "skipped-locked") skipped++; else ran++;
    if (outcome === "ran") {
      await (deps.recordAttempt ?? recordResumeAttempt)(item.id, now).catch((e) =>
        console.warn(`[resume-stale-imports] backoff record failed for ${item.id} (non-fatal):`, e instanceof Error ? e.message : String(e)));
    }
    console.log(`[resume-stale-imports] ${item.institutionName} (${item.id}) → ${outcome}`);
  }

  return { candidates, attempted: page.length - planRestricted, ran, skipped, deferred,
    ...(planRestricted > 0 ? { planRestricted, planRestrictedReasons } : {}),
    ...(restrictedUsers.length > 0 ? { planRestrictedUsers: restrictedUsers.length } : {}) };
}

// ── IDEMP-007 backoff bookkeeping (declared after the job body so the source
// order matches the runtime order the admission ratchet pins: these run only
// after admission) ──────────────────────────────────────────────────────────

/** IDEMP-007 — after a "ran": still incomplete ⇒ attempts+1 and the next slot pushed out. */
async function recordResumeAttempt(itemId: string, now: Date): Promise<void> {
  const row = await db.plaidItem.findUnique({ where: { id: itemId }, select: { syncIncompleteAt: true, syncResumeAttempts: true } });
  if (!row || row.syncIncompleteAt === null) return; // completed — resetCompleted clears the counter
  const attempts = row.syncResumeAttempts + 1;
  await db.plaidItem.update({
    where: { id: itemId },
    data:  { syncResumeAttempts: attempts, syncResumeNextAt: new Date(now.getTime() + resumeBackoffMs(attempts)) },
  });
}

async function resetCompletedResumes(): Promise<void> {
  await db.plaidItem.updateMany({
    where: { syncIncompleteAt: null, OR: [{ syncResumeAttempts: { gt: 0 } }, { syncResumeNextAt: { not: null } }] },
    data:  { syncResumeAttempts: 0, syncResumeNextAt: null },
  });
}
