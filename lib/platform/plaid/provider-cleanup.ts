/**
 * lib/platform/plaid/provider-cleanup.ts
 *
 * THE OPERATOR READ FOR "PLAID STILL OWES US A REMOVAL", AND THE ONE THING IT
 * REFUSES TO INFER.
 *
 * f339e57 made a failed `itemRemove` durable instead of silent: the PRODUCT
 * status still goes REVOKED unconditionally (a failed upstream removal must not
 * make the institution reappear on the Connections hub, which loads with
 * `status: { not: REVOKED }`), while the separate question — was the removal
 * CONFIRMED upstream — is recorded as a pair of AuditLog markers. This module is
 * the operator-facing read of that second question, so nobody has to remember to
 * run `plaid:cleanup-orphans` to discover the obligation.
 *
 * ══ TWO STATES, NEVER CONFLATED ═════════════════════════════════════════════
 *
 *   PRODUCT state           PlaidItem.status = REVOKED        the user's view
 *   PROVIDER cleanup state  newest marker CONFIRMED/UNCONFIRMED   ours
 *
 * ⚠️ `status === REVOKED` IS NOT EVIDENCE OF PROVIDER CLEANUP, AND THIS FILE
 * MUST NEVER TREAT IT AS SUCH. That exact inference is the defect f339e57
 * fixed: `scripts/cleanup-orphaned-plaid-items.ts` verified its own work by
 * re-reading `status === REVOKED` after calling a function that writes REVOKED
 * unconditionally — a check that could not fail, reporting success for removals
 * Plaid had refused. Everything here keys on the MARKERS.
 *
 * ══ NEWEST MARKER WINS ══════════════════════════════════════════════════════
 * An item owes cleanup when its most recent marker is UNCONFIRMED. A later
 * CONFIRMED resolves the obligation ADDITIVELY — the failure rows stay, so
 * history survives and `attemptCount` below is a real count of attempts rather
 * than a count of outstanding items.
 *
 * ⚠️ FOLDED IN JS, NOT QUERIED BY JSON PATH. The marker names its item in
 * `metadata.plaidItemId`, and a Postgres JSON-path filter would work — but
 * "newest row per item wins" is a window function Prisma cannot express, and
 * mixing a JSON filter with a client-side fold would make the authority live in
 * two places. These rows are only written when an orphaned item is revoked,
 * which is rare by construction, so reading both kinds in creation order and
 * keeping the last per item is exact and cheap. Ascending order is load-bearing:
 * the LAST write per item is the verdict.
 *
 * ══ PRIVACY ════════════════════════════════════════════════════════════════
 * Operational metadata only, matching lib/platform/connection-diagnostics.ts's
 * binding boundary: item id (already the operator handle used by resync and
 * request-reauth), institution label, an OPAQUE owner reference (last 6 of the
 * user id — enough to correlate two items of one owner and to hand to Customer
 * Success, which holds the directory), timestamps, counts, and the provider's
 * own error CODE. No access tokens, no encrypted token, no email, no balances,
 * no transaction content. The marker metadata this reads contains no secret: it
 * carries `plaidItemId`, `provider`, `outcome` and `plaidErrorCode` and nothing
 * else — see lib/plaid/disconnect.ts.
 */

import { db } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";

/** The two markers that constitute the provider-cleanup lifecycle. */
const MARKERS = [
  AuditAction.PLAID_ITEM_REVOCATION_UNCONFIRMED,
  AuditAction.PLAID_ITEM_REVOCATION_CONFIRMED,
] as const;

export type ProviderCleanupItem = {
  /** The operator handle — the same PlaidItem.id resync/request-reauth take. */
  plaidItemId: string;
  institution: string | null;
  /** PLATFORM OPS PRIVACY — last 6 of the owner's user id, never the email. */
  ownerRef: string;
  /** The PRODUCT state. Reported for contrast, never as cleanup evidence. */
  productStatus: string | null;
  /** True when the PlaidItem row no longer exists (the marker outlives it). */
  itemGone: boolean;
  /** When the still-unresolved obligation was first recorded. */
  owedSinceISO: string;
  /** Whole hours since `owedSinceISO`, so a widget needs no clock of its own. */
  owedForHours: number;
  /** How many UNCONFIRMED attempts this item has accumulated, ever. */
  attemptCount: number;
  /** The provider's own code on the latest failure, when it gave one. */
  latestErrorCode: string | null;
};

export type ProviderCleanupStatus = {
  /** Items whose NEWEST marker is UNCONFIRMED. Empty = nothing owed. */
  owed: ProviderCleanupItem[];
  owedCount: number;
  /** The oldest outstanding obligation, or null when nothing is owed. */
  oldestOwedSinceISO: string | null;
  oldestOwedForHours: number | null;
  /** Items whose newest marker is CONFIRMED — the healthy, resolved population. */
  confirmedCount: number;
  /** Total markers read, so a zero owed-count is distinguishable from a zero read. */
  markersRead: number;
};

type MarkerRow = {
  action: string;
  createdAt: Date;
  metadata: unknown;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const hoursSince = (d: Date, now: Date) => Math.floor((now.getTime() - d.getTime()) / 3_600_000);

/**
 * Read the provider-cleanup lifecycle for every Plaid item that has one.
 *
 * `now` is injectable so the age arithmetic is testable without freezing a
 * global clock — the same reason the forecast engine takes its `asOf`.
 */
export async function getProviderCleanupStatus(now: Date = new Date()): Promise<ProviderCleanupStatus> {
  const rows = await db.auditLog.findMany({
    where:   { action: { in: [...MARKERS] } },
    orderBy: { createdAt: "asc" },
    select:  { action: true, createdAt: true, metadata: true },
  });

  // Which items are owed, so only those rows are fetched.
  const owedIdsForLookup = owedItemIds(rows);
  const items = owedIdsForLookup.length === 0 ? [] : await db.plaidItem.findMany({
    where:  { id: { in: owedIdsForLookup } },
    select: { id: true, status: true, institutionName: true, userId: true },
  });
  return foldCleanupStatus(rows, items, now);
}

/** plaidItemId values whose NEWEST marker is UNCONFIRMED. */
function owedItemIds(rows: MarkerRow[]): string[] {
  const byItem = groupByItem(rows);
  const out: string[] = [];
  for (const [id, markers] of byItem) {
    if (markers[markers.length - 1].action === AuditAction.PLAID_ITEM_REVOCATION_UNCONFIRMED) out.push(id);
  }
  return out;
}

function groupByItem(rows: MarkerRow[]): Map<string, MarkerRow[]> {
  const byItem = new Map<string, MarkerRow[]>();
  for (const r of rows) {
    const id = str((r.metadata as { plaidItemId?: unknown } | null)?.plaidItemId);
    if (!id) continue;
    const list = byItem.get(id);
    if (list) list.push(r);
    else byItem.set(id, [r]);
  }
  return byItem;
}

type OwnerItem = { id: string; status: string; institutionName: string | null; userId: string };

/**
 * THE PURE FOLD. Separated from the two reads on purpose: the marker lifecycle
 * is a LOGIC question — newest wins, order decides, age is the obligation's and
 * not the latest retry's — and every branch of it can be forced directly with
 * no database. A lifecycle whose branches cannot be forced in isolation is how
 * the vacuous `status === REVOKED` check survived.
 *
 * Exported under a `__` name because it is a test seam, not API.
 */
export function foldCleanupStatus(rows: MarkerRow[], items: OwnerItem[], now: Date): ProviderCleanupStatus {
  const byItem = groupByItem(rows);
  const owedIds: string[] = [];
  let confirmedCount = 0;
  for (const [id, markers] of byItem) {
    // NEWEST WINS. `rows` is ascending, so the last element is the verdict.
    if (markers[markers.length - 1].action === AuditAction.PLAID_ITEM_REVOCATION_UNCONFIRMED) owedIds.push(id);
    else confirmedCount++;
  }

  // A marker deliberately OUTLIVES its item (AuditLog is forensic and not
  // cascaded), so a missing row is normal and is reported as `itemGone` rather
  // than dropped — dropping it would hide an obligation whose item was deleted
  // while still owed.
  const itemById = new Map(items.map((i) => [i.id, i]));

  const owed: ProviderCleanupItem[] = owedIds.map((id) => {
    const markers = byItem.get(id)!;
    const unconfirmed = markers.filter((m) => m.action === AuditAction.PLAID_ITEM_REVOCATION_UNCONFIRMED);
    // ⚠️ THE AGE IS MEASURED FROM THE FIRST UNCONFIRMED MARKER AFTER THE LAST
    // CONFIRMED ONE — i.e. how long THIS obligation has stood, not how long the
    // item has existed and not the age of the newest retry. A retry every hour
    // would otherwise keep resetting the age of a problem that is days old.
    const lastConfirmedAt = markers
      .filter((m) => m.action === AuditAction.PLAID_ITEM_REVOCATION_CONFIRMED)
      .map((m) => m.createdAt.getTime())
      .reduce((a, b) => Math.max(a, b), 0);
    const owedSince = unconfirmed.find((m) => m.createdAt.getTime() > lastConfirmedAt) ?? unconfirmed[0];
    const latest = unconfirmed[unconfirmed.length - 1];
    const row = itemById.get(id);
    return {
      plaidItemId:     id,
      institution:     row?.institutionName ?? null,
      ownerRef:        row ? row.userId.slice(-6) : "(gone)",
      productStatus:   row?.status ?? null,
      itemGone:        row === undefined,
      owedSinceISO:    owedSince.createdAt.toISOString(),
      owedForHours:    hoursSince(owedSince.createdAt, now),
      attemptCount:    unconfirmed.length,
      latestErrorCode: str((latest.metadata as { plaidErrorCode?: unknown } | null)?.plaidErrorCode),
    };
  }).sort((a, b) => a.owedSinceISO.localeCompare(b.owedSinceISO));

  return {
    owed,
    owedCount:          owed.length,
    oldestOwedSinceISO: owed[0]?.owedSinceISO ?? null,
    oldestOwedForHours: owed[0]?.owedForHours ?? null,
    confirmedCount,
    markersRead:        rows.length,
  };
}

/**
 * Is this ONE item still owed? Used to RE-READ durable state after a retry,
 * rather than trusting the action's own return value — and never by looking at
 * `PlaidItem.status`.
 */
export async function isProviderCleanupOwed(plaidItemId: string): Promise<boolean> {
  const { owed } = await getProviderCleanupStatus();
  return owed.some((o) => o.plaidItemId === plaidItemId);
}

/** @internal test seam — see foldCleanupStatus. */
export const __foldForTest = foldCleanupStatus;
