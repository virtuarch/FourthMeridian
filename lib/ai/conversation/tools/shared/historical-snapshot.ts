/**
 * lib/ai/conversation/tools/shared/historical-snapshot.ts
 *
 * The historical position on a date — shared by `get_financial_snapshot`,
 * `get_investments`, the cash spine and `reconcile_projection`.
 *
 * Part of the tool surface split out of `tools.ts` (CQ-011). The facade
 * `lib/ai/conversation/tools.ts` owns the registry (`TOOLS`) and is the only
 * import path callers use; this module never imports the facade.
 *
 * Moved verbatim: every comment and invariant in `tools.ts`'s header applies
 * here — adapters, not authorities; read and calculate only; no Prisma client in
 * scope (the source scans in `lib/test-support/tools-source.ts` read this file).
 */

import { getRecentSnapshots } from '@/lib/data/snapshots';
import { projectSnapshotSection } from '@/lib/ai/assemblers/snapshot';
import type { Snapshot } from '@/types';
import { resolveExplorationNode } from '@/lib/history/exploration';
import type { ToolContext } from '../types';
import { SNAPSHOT_READ_ROWS } from './values';
import { absentIn } from './reads';

/**
 * The historical position on a date, composed from authorities that already exist.
 *
 * ⚠️ THREE AUTHORITIES, ZERO ARITHMETIC HERE. `projectSnapshotSection` supplies the
 * totals AND the crypto-coverage refusal; the exploration tree supplies the
 * account-level breakdown of each bucket. Nothing in this function adds two money
 * numbers together — `liquid`, `checking` and `savings` each come from a
 * different authority that already computed them, which is exactly why they can
 * be reported side by side without one being mistaken for another.
 */
export async function historicalSnapshot(ctx: ToolContext, asOf: string) {
  const rows = await getRecentSnapshots(ctx.readClient, { rows: SNAPSHOT_READ_ROWS }, { spaceId: ctx.spaceId });
  const section = projectSnapshotSection(rows as Snapshot[], 'full');
  if (!section) {
    return absentIn(ctx, 'no usable snapshot history for this Space', 'any usable snapshot history');
  }

  // The latest observation ON OR BEFORE the requested date. A date with no
  // observation reports the one it actually used rather than interpolating.
  const point = [...section.history].reverse().find((p) => p.date <= asOf);
  if (!point) {
    return { unavailable: `no snapshot on or before ${asOf}`,
      historyAvailableFrom: section.oldestDate, historyAvailableTo: section.newestDate };
  }

  const BUCKETS = ['cash', 'savings', 'investments', 'crypto', 'debt'] as const;
  const nodes = await Promise.all(BUCKETS.map((lens) => resolveExplorationNode(ctx.readClient, {
    spaceId: ctx.spaceId, lens, nodeType: 'lens', nodeId: null,
    dateISO: point.date, fromISO: point.date, toISO: point.date,
  })));

  return {
    asOf, basis: 'HISTORICAL_SNAPSHOT',
    observedOn: point.date,
    ...(point.date !== asOf
      ? { note: `No observation on ${asOf}; using the latest on or before it.` } : {}),
    netWorth: point.netWorth, totalAssets: point.totalAssets,
    /** Checking + savings — the spendable total. */
    liquid: point.liquid,
    /** Checking only. The `cash` lens covers exactly this. */
    checking: point.cashOnHand,
    investments: point.investments, digitalAssets: point.digitalAssets,
    debt: point.liabilities,
    coverage: {
      netWorthAssertable: point.netWorth !== null,
      ...(point.digitalAssetsUnavailableReason
        ? { unassertableBecause: point.digitalAssetsUnavailableReason,
            note: 'netWorth, totalAssets and digitalAssets are null because a component '
              + 'could not be valued on that date. They are NOT zero and NOT measured.' }
        : {}),
      // RWA-2B — a fact in the data: on this date the real-asset part of
      // netWorth / totalAssets is a straight-line model between two of the
      // user's dated estimates for a manual asset, not an observed value.
      ...(point.realAssetsModeled
        ? { realAssetsModeled: true,
            realAssetsNote: 'The real-asset component of netWorth and totalAssets on this date is MODELED '
              + '(a straight line between two of the user\'s dated estimates for a manual asset), '
              + 'not observed. Describe it as modeled or estimated, never as observed.' }
        : {}),
      historyAvailableFrom: section.oldestDate, historyAvailableTo: section.newestDate,
    },
    buckets: BUCKETS.map((lens, i) => {
      const n = nodes[i].node;
      return {
        bucket: lens, value: n?.displayedValue ?? null,
        assertable: n?.assertable ?? false,
        ...(n?.unavailableReason ? { unavailableReason: n.unavailableReason } : {}),
        // A bucket whose components do not sum to its value says so, rather than
        // presenting a partial breakdown as complete.
        explainedByAccounts: n?.explainedValue ?? null,
        accounts: (n?.components ?? []).map((c) => ({ name: c.label, value: c.displayedValue })),
      };
    }),
  };
}
