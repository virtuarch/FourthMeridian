/**
 * lib/plaid/backgroundHistorySync.ts
 *
 * D2.x Slice 2 — background history continuation.
 *
 * Thin, best-effort wrapper that runs the full initial transaction history
 * import for a just-connected PlaidItem AFTER the fast Link response has
 * already been sent to the user (Slice 1 fast-path split). It is invoked from
 * app/api/plaid/exchange-token/route.ts via Next.js `after()`, so nothing here
 * runs on the request's critical path.
 *
 * Design rules (D2.x Slice 2):
 *  - Reuses the existing engine `syncTransactionsForItem()` UNCHANGED — no
 *    duplicated sync logic, no engine edits. The item's cursor is still null
 *    at this point (Slice 1 deferred the inline sync), so this is the ordinary
 *    "first sync ever = full available history" path.
 *  - Best-effort / non-fatal: this runs after the response, so a failure here
 *    can never affect Link success. It additionally never rethrows, so it can
 *    never surface as an unhandled rejection in the `after()` callback.
 *  - On failure, classifies the error via the SAME classifyPlaidErrorForHealth
 *    used by app/api/plaid/sync + refreshAllActiveItemsForUser and, when it
 *    returns health data (e.g. ITEM_LOGIN_REQUIRED → NEEDS_REAUTH), updates the
 *    existing PlaidItem.status / errorCode fields (no schema change). Transient
 *    / rate-limit errors classify to null and are left for the daily
 *    sync-banks cron to retry.
 *  - On success, syncTransactionsForItem itself already sets
 *    status = ACTIVE, errorCode = null, lastSyncedAt, and advances the cursor —
 *    so no extra success write is needed here beyond logging.
 */

import { db } from "@/lib/db";
import { ShareStatus } from "@prisma/client";
import { syncTransactionsForItem } from "@/lib/plaid/syncTransactions";
import { classifyPlaidErrorForHealth, plaidErrorSummary } from "@/lib/plaid/errors";
import { notifyItemSyncFailed } from "@/lib/plaid/sync-notifications";
import { backfillSpaceSnapshots } from "@/lib/snapshots/backfill";
import {
  regenerateWealthHistoryForAccounts,
  wealthRegenerationEnabled,
} from "@/lib/snapshots/regenerate-history";
import {
  reconstructAccount,
  investmentReconstructionEnabled,
} from "@/lib/investments/reconstruction-runner";

/** yesterday-anchored ISO day helpers — same convention as the snapshot
 *  backfill window and scripts/regenerate-wealth-history.ts. */
function isoDayUTC(d: Date): string {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x.toISOString().slice(0, 10);
}
function minusDaysISO(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * D2.x Slice 4 — after first-run history has synced, reconstruct up to 30 days
 * of historical snapshots for every genuinely-new Space the item's accounts are
 * shared into. Best-effort / non-fatal: a backfill failure can never affect the
 * sync result or the already-sent Link response, and the new-Space gate inside
 * backfillSpaceSnapshots() makes existing Spaces no-ops. Runs only on a
 * successful sync (full transaction history is required first).
 */
async function backfillHistoryForItem(plaidItemId: string): Promise<void> {
  try {
    const conns = await db.accountConnection.findMany({
      where:  { plaidItemDbId: plaidItemId, deletedAt: null },
      select: { financialAccountId: true },
    });
    const faIds = conns.map((c) => c.financialAccountId);
    if (faIds.length === 0) return;

    const links = await db.spaceAccountLink.findMany({
      where:  { financialAccountId: { in: faIds }, status: ShareStatus.ACTIVE },
      select: { spaceId: true },
    });
    const spaceIds = [...new Set(links.map((l) => l.spaceId))];

    for (const spaceId of spaceIds) {
      try {
        const written = await backfillSpaceSnapshots(spaceId);
        if (written > 0) {
          console.log(`[plaid][D2x-slice4] backfilled ${written} snapshot(s) for space ${spaceId} (item ${plaidItemId})`);
        }
      } catch (e) {
        console.error(`[plaid][D2x-slice4] snapshot backfill failed for space ${spaceId} (non-fatal):`, e);
      }
    }

    // A4 + A9 — investment-history refinement for a just-connected item.
    // Resolve the item's investment accounts ONCE (both stages need them) and
    // skip the query entirely when neither stage is enabled, preserving the
    // zero-extra-work default and honoring the 60s background budget. Both
    // stages are best-effort / non-fatal and already post-response via after(),
    // so they can never affect connect latency. A pure cash/card connect finds
    // no investment accounts and does nothing.
    if (investmentReconstructionEnabled() || wealthRegenerationEnabled()) {
      const investmentFaIds = (
        await db.financialAccount.findMany({
          where:  { id: { in: faIds }, type: "investment", deletedAt: null },
          select: { id: true },
        })
      ).map((a) => a.id);

      if (investmentFaIds.length > 0) {
        // A4 — bootstrap per-holding quantity reconstruction from the canonical
        // InvestmentEvents already ingested inline at connect (exchangeToken).
        // The one-time reconstructAccount is what SEEDS the PositionReconstruction
        // summaries (the app's live paths only ever call the incremental
        // repairReconstructionForAccount, which no-ops until a summary exists —
        // this is the missing bootstrap). Gated on its own kill switch,
        // per-account best-effort/non-fatal, idempotent (a re-run rewrites only
        // its own DERIVED rows), and it MUST run BEFORE wealth regen, which reads
        // the DERIVED PositionObservation rows it produces.
        if (investmentReconstructionEnabled()) {
          for (const faId of investmentFaIds) {
            try {
              const m = await reconstructAccount({ financialAccountId: faId, now: new Date() });
              console.log(
                `[plaid][A4] reconstructed account ${faId} (item ${plaidItemId}) — ` +
                  `${m.instruments} instrument(s): ${m.complete} complete, ${m.partial} partial, ` +
                  `${m.failed} failed, ${m.conflicted} conflicted, ${m.derivedRows} derived row(s)`,
              );
            } catch (e) {
              console.error(`[plaid][A4] reconstruction failed for account ${faId} (item ${plaidItemId}, non-fatal):`, e);
            }
          }
        }

        // A9 — accurate wealth-history regeneration. The Slice-4 backfill above
        // holds every investment account's value FLAT at today's value on each
        // historical day. Re-derive those days from the canonical A8 historical
        // valuation (which now reads the A4 DERIVED quantity rows produced just
        // above), over the SAME 30-day window the backfill wrote — refining it,
        // never instead of it. Gated on WEALTH_REGENERATION_ENABLED.
        if (wealthRegenerationEnabled()) {
          try {
            const toDate   = minusDaysISO(isoDayUTC(new Date()), 1); // yesterday — today's live row is frozen
            const fromDate = minusDaysISO(toDate, 30);               // matches the 30-day snapshot backfill window
            const spaces = await regenerateWealthHistoryForAccounts(investmentFaIds, { fromDate, toDate });
            console.log(
              `[plaid][A9] regenerated wealth history for ${spaces.length} space(s) over [${fromDate} … ${toDate}] ` +
                `(item ${plaidItemId}, ${investmentFaIds.length} investment account(s))`,
            );
          } catch (e) {
            console.error(`[plaid][A9] wealth-history regeneration failed for item ${plaidItemId} (non-fatal):`, e);
          }
        }
      }
    }
  } catch (e) {
    console.error(`[plaid][D2x-slice4] snapshot backfill resolution failed for item ${plaidItemId} (non-fatal):`, e);
  }
}

/**
 * Runs the deferred first-run transaction history import for one PlaidItem.
 * Never throws. Intended to be scheduled with Next.js `after()`.
 *
 * @param plaidItemId  Our internal PlaidItem.id (primary key), not Plaid's item_id.
 */
export async function runDeferredHistorySync(plaidItemId: string): Promise<void> {
  try {
    const r = await syncTransactionsForItem(plaidItemId);
    console.log(
      `[plaid][D2x-slice2] background history sync complete for item ${plaidItemId} — ` +
        `added ${r.added}, modified ${r.modified}, removed ${r.removed} ` +
        `(created ${r.created}, updatedByPlaidId ${r.updatedByPlaidId}, updatedByFingerprint ${r.updatedByFingerprint}, skippedMissingAccount ${r.skippedMissingAccount})`,
    );

    // D2.x Slice 4 — reconstruct historical snapshots now that full history
    // exists. Best-effort/non-fatal and gated to new Spaces inside.
    await backfillHistoryForItem(plaidItemId);
  } catch (e) {
    console.error(
      `[plaid][D2x-slice2] background history sync FAILED for item ${plaidItemId} (non-fatal — Link already succeeded): ${plaidErrorSummary(e)}`,
      e,
    );

    // Write an EXPLICIT incomplete-sync marker so the item is never left
    // looking as healthy as a fully-synced one: syncIncompleteAt = now() is
    // visible to both the UI (renders "importing") and the client auto-resume
    // (lib/sync/status.ts + ConnectionsList). This is written for EVERY failure
    // classification — the history genuinely did not complete. On top of it,
    // reflect a genuine item-health problem (needs re-auth / unrecoverable) on
    // the status/errorCode fields; transient / 429 errors classify to null and
    // leave status ACTIVE so the resume path (and cron backstop) keep retrying.
    // This update is itself best-effort.
    try {
      const health = classifyPlaidErrorForHealth(e);
      await db.plaidItem.update({
        where: { id: plaidItemId },
        data:  {
          syncIncompleteAt: new Date(),
          ...(health ? { status: health.status, errorCode: health.errorCode } : {}),
        },
      });
      if (health) {
        // OPS-3 S5 Wave 3 — ping the owner (suppress-deduped; best-effort).
        await notifyItemSyncFailed(plaidItemId);
      }
    } catch (updateErr) {
      console.error(
        `[plaid][D2x-slice2] failed to persist PlaidItem health for item ${plaidItemId} (non-fatal):`,
        updateErr,
      );
    }
  }
}
