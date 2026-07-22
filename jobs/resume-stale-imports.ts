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

export interface ResumeStaleImportsResult {
  candidates: number;
  attempted:  number;
  /** Pipeline actually ran for this item (it may still have failed inside). */
  ran:        number;
  /** Another sync held the lock — that run resolves the item, not this one. */
  skipped:    number;
  deferred:   number;
}

export async function resumeStaleImports(): Promise<ResumeStaleImportsResult> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);

  const where = {
    status:           PlaidItemStatus.ACTIVE,
    syncIncompleteAt: { lt: cutoff },
    // Same billing-honesty gate sync-banks uses: a deactivated user's items
    // shouldn't keep accruing Plaid calls.
    user: { deactivatedAt: null },
  } as const;

  const candidates = await db.plaidItem.count({ where });
  const items = await db.plaidItem.findMany({
    where,
    // Oldest first: the longest-stalled import is the one a user is most likely
    // staring at.
    orderBy: { syncIncompleteAt: "asc" },
    take:    MAX_ITEMS_PER_RUN,
    select:  { id: true, institutionName: true },
  });

  const deferred = Math.max(0, candidates - items.length);
  if (candidates === 0) {
    console.log("[resume-stale-imports] no stale imports.");
    return { candidates: 0, attempted: 0, ran: 0, skipped: 0, deferred: 0 };
  }

  console.log(
    `[resume-stale-imports] ${candidates} stale import(s) older than ${STALE_AFTER_MS / 1000}s; ` +
      `driving ${items.length}${deferred > 0 ? `, ${deferred} deferred to the next run` : ""}.`,
  );

  // The outcome is "ran" | "skipped-locked" — success is deliberately NOT in it.
  // A failed pipeline stamps item health itself and leaves syncIncompleteAt set,
  // so a genuinely broken import simply reappears as a candidate next run. That
  // is the retry, and it needs no bookkeeping here.
  let ran = 0, skipped = 0;
  for (const item of items) {
    const outcome = await syncPlaidItemFromWebhook(item.id); // never throws, by contract
    if (outcome === "skipped-locked") skipped++; else ran++;
    console.log(`[resume-stale-imports] ${item.institutionName} (${item.id}) → ${outcome}`);
  }

  return { candidates, attempted: items.length, ran, skipped, deferred };
}
