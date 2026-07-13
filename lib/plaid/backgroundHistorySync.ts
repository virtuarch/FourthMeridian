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
import { ShareStatus, SpaceType } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";
import { syncTransactionsForItem } from "@/lib/plaid/syncTransactions";
import { classifyPlaidErrorForHealth, plaidErrorSummary } from "@/lib/plaid/errors";
import { notifyItemSyncFailed, notifyItemSyncComplete } from "@/lib/plaid/sync-notifications";
import { setPlaidItemHealth } from "@/lib/connections/health-transitions";
import { backfillSpaceSnapshots } from "@/lib/snapshots/backfill";
import {
  regenerateWealthHistoryForAccounts,
  wealthRegenerationEnabled,
} from "@/lib/snapshots/regenerate-history";
import {
  reconstructAccount,
  investmentReconstructionEnabled,
} from "@/lib/investments/reconstruction-runner";
import { defaultPriceRegistry } from "@/lib/prices/registry";
import { backfillPricesForInstruments } from "@/lib/prices/backfill";

/**
 * Soft budget for the connect-time price backfill, so this slow (one HTTP call
 * per instrument, chunked) step cannot consume the whole 60s after() budget and
 * starve the wealth-regen step that runs after it. A budget-truncated backfill
 * resumes on the NEXT connect (missing-only/idempotent) — the daily cron does
 * not backfill historical windows.
 */
const PRICE_BACKFILL_BUDGET_MS = 25_000;

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

    // A4 + A8-3B + A9 — investment-history refinement for a just-connected item:
    // reconstruct per-holding quantity → backfill historical prices → regenerate
    // wealth history. Resolve the item's investment accounts ONCE (all stages
    // need them) and skip the query entirely when no stage is enabled, preserving
    // the zero-extra-work default and honoring the 60s background budget. Every
    // stage is best-effort / non-fatal and already post-response via after(), so
    // none can affect connect latency. A pure cash/card connect finds no
    // investment accounts and does nothing.
    const priceRegistry = defaultPriceRegistry();
    const priceBackfillEnabled = priceRegistry.adapters.length > 0; // TIINGO_API_KEY set
    if (investmentReconstructionEnabled() || priceBackfillEnabled || wealthRegenerationEnabled()) {
      // Investment accounts drive A4 reconstruction + A8-3B equity price backfill;
      // CRYPTO accounts (Part-A) additionally drive A9 wealth regen, which values
      // them per-day via CoinGecko (constant quantity × historical price). Both
      // are "wealth-relevant" for the A9 step.
      const relevant = await db.financialAccount.findMany({
        where:  { id: { in: faIds }, type: { in: ["investment", "crypto"] }, deletedAt: null },
        select: { id: true, type: true },
      });
      const investmentFaIds = relevant.filter((a) => a.type === "investment").map((a) => a.id);
      const wealthFaIds     = relevant.map((a) => a.id); // investment + crypto → A9

      if (relevant.length > 0) {
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

        // A8-3B — auto-trigger the historical price backfill for the newly-held
        // instruments so Wealth shows real historical valuation without anyone
        // running the CLI script by hand. Shares lib/prices/backfill.ts with the
        // script. Runs AFTER reconstruction (needs PositionObservation qty>0 rows
        // to know which instruments to fetch) and BEFORE wealth regen (which reads
        // the PriceObservation rows it writes). Gated on a configured vendor, so
        // it's a clean no-op when TIINGO_API_KEY is unset. Best-effort/non-fatal,
        // and soft-bounded (PRICE_BACKFILL_BUDGET_MS) so it can't starve regen; a
        // truncated run resumes on the next connect (missing-only/idempotent).
        if (priceBackfillEnabled) {
          try {
            const heldRows = await db.positionObservation.findMany({
              where:    { financialAccountId: { in: investmentFaIds }, supersededById: null, deletedAt: null, quantity: { gt: 0 } },
              select:   { instrumentId: true },
              distinct: ["instrumentId"],
            });
            const heldInstrumentIds = [...new Set(heldRows.map((r) => r.instrumentId))];
            if (heldInstrumentIds.length > 0) {
              const m = await backfillPricesForInstruments(heldInstrumentIds, {
                apply:           true,
                registry:        priceRegistry,
                deadlineEpochMs: Date.now() + PRICE_BACKFILL_BUDGET_MS,
              });
              console.log(
                `[plaid][A8-3B] price backfill (item ${plaidItemId}) — ${heldInstrumentIds.length} held instrument(s): ` +
                  `planned ${m.planned}, fetched ${m.fetchedInstruments}, stored ${m.inserted} row(s)` +
                  (m.skippedForBudget ? `, deferred ${m.skippedForBudget} to next connect (budget)` : ""),
              );
            }
          } catch (e) {
            console.error(`[plaid][A8-3B] price backfill failed for item ${plaidItemId} (non-fatal):`, e);
          }
        }

        // A9 — accurate wealth-history regeneration. The Slice-4 backfill above
        // holds every investment account's value FLAT at today's value on each
        // historical day. Re-derive those days from the canonical A8 historical
        // valuation (which now reads the A4 DERIVED quantity rows produced just
        // above AND the A8-3B prices backfilled just above), over the SAME 30-day
        // window the backfill wrote — refining it, never instead of it. Gated on
        // WEALTH_REGENERATION_ENABLED.
        if (wealthRegenerationEnabled()) {
          try {
            const toDate   = minusDaysISO(isoDayUTC(new Date()), 1); // yesterday — today's live row is frozen
            const fromDate = minusDaysISO(toDate, 30);               // matches the 30-day snapshot backfill window
            const spaces = await regenerateWealthHistoryForAccounts(wealthFaIds, { fromDate, toDate });
            console.log(
              `[plaid][A9] regenerated wealth history for ${spaces.length} space(s) over [${fromDate} … ${toDate}] ` +
                `(item ${plaidItemId}, ${wealthFaIds.length} investment+crypto account(s))`,
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
/**
 * Part-3 — record the "full history pipeline complete" event ONCE and fan it out
 * to both surfaces. Writes a single PLAID_HISTORY_SYNCED AuditLog row (the record
 * the Recent-Activity feed reads), then links the SYNC_COMPLETED bell
 * notification to it via auditLogId — so the bell and the activity entry can't
 * drift. The audit write lives here (a pipeline/domain concern), keeping the
 * notification producer a thin chokepoint-only helper. Best-effort/non-throwing.
 */
async function recordSyncComplete(plaidItemId: string): Promise<void> {
  try {
    const item = await db.plaidItem.findUnique({
      where:  { id: plaidItemId },
      select: { userId: true, institutionName: true },
    });
    if (!item) return;

    // Space to surface the activity entry in: the item's accounts' ACTIVE-linked
    // spaces, preferring the user's PERSONAL space (the connect home).
    const conns = await db.accountConnection.findMany({
      where:  { plaidItemDbId: plaidItemId, deletedAt: null },
      select: { financialAccountId: true },
    });
    const faIds = conns.map((c) => c.financialAccountId);
    let spaceId: string | null = null;
    if (faIds.length > 0) {
      const links = await db.spaceAccountLink.findMany({
        where:  { financialAccountId: { in: faIds }, status: ShareStatus.ACTIVE },
        select: { space: { select: { id: true, type: true } } },
      });
      const spaces = links.map((l) => l.space);
      spaceId = spaces.find((s) => s.type === SpaceType.PERSONAL)?.id ?? spaces[0]?.id ?? null;
    }

    // ONE record anchors both surfaces.
    const audit = await db.auditLog.create({
      data: {
        userId:   item.userId,
        spaceId,
        action:   AuditAction.PLAID_HISTORY_SYNCED,
        metadata: { institutionName: item.institutionName ?? "", plaidItemId },
      },
      select: { id: true },
    });

    await notifyItemSyncComplete({
      userId:          item.userId,
      plaidItemId,
      institutionName: item.institutionName,
      spaceId,
      auditLogId:      audit.id,
    });
  } catch (e) {
    console.error(`[plaid][sync-complete] non-fatal record/notify failure for item ${plaidItemId}:`, e);
  }
}

export async function runDeferredHistorySync(plaidItemId: string): Promise<boolean> {
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

    // Part-3 — the FULL deferred pipeline is done: record it + notify the owner
    // (bell + Recent Activity, from ONE AuditLog record). Only reached on a
    // successful sync — a failure skips to the catch.
    await recordSyncComplete(plaidItemId);

    // Success: the item is fully synced as of now. Signal it so a webhook-lock
    // holder (syncPlaidItemFromWebhook) can clear any stale syncIncompleteAt a
    // concurrent duplicate delivery stamped via its skipped-locked branch.
    return true;
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
      if (health) {
        // CH-2 — the health flip goes through the chokepoint (live columns +
        // durable transition row only on change), co-writing the incomplete
        // marker in the same update. Transient/429 errors classify to null and
        // must NOT touch status, so they still write the marker inline below.
        await setPlaidItemHealth(
          plaidItemId,
          { status: health.status, errorCode: health.errorCode },
          { syncIncompleteAt: new Date() },
        );
        // OPS-3 S5 Wave 3 — ping the owner (suppress-deduped; best-effort).
        await notifyItemSyncFailed(plaidItemId);
      } else {
        await db.plaidItem.update({
          where: { id: plaidItemId },
          data:  { syncIncompleteAt: new Date() },
        });
      }
    } catch (updateErr) {
      console.error(
        `[plaid][D2x-slice2] failed to persist PlaidItem health for item ${plaidItemId} (non-fatal):`,
        updateErr,
      );
    }
    // Failure: history genuinely did not complete — the incomplete marker set
    // above must stand. Signal it so the caller does NOT clear it.
    return false;
  }
}
