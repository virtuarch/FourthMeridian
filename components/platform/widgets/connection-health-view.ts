/**
 * components/platform/widgets/connection-health-view.ts  (UX-P1 · Agent 3)
 *
 * THE PURE VIEW-MODEL behind the connection-health table — shared by the
 * Providers/Pipeline widget (OpsConnectionHealthWidget) and the Overview block
 * (ConnectionHealthBlock). No React, no fetch, no clock of its own: every
 * duration takes the instant it is measured against as an argument, so the
 * same row renders the same words on the server, in a test and in a browser.
 *
 * AUTHORITY RULE. The words and tones here MAP the connection authority's own
 * vocabulary (lib/connections/health.ts `HealthState`); nothing is re-judged.
 * "Stale for" is the gap between the row's `lastSyncedAt` and the response's
 * `checkedAt` — the instant the authority judged the row — not the browser's
 * clock, so a tab left open does not drift the number away from the verdict.
 * "Needs action" is a presentation SELECTION (a fault, as opposed to lateness),
 * not a new state.
 *
 * PRIVACY. The row type this module consumes carries no identity; the owner
 * label arrives separately (the CUSTOMER_SUCCESS route) and is joined here by
 * row key only. The test pins at the type level that no identity key exists.
 */

import type { ConnectionHealthRow, ConnectionHealthResult, HealthState } from "@/lib/connections/health";
import type { ConnectionOwner } from "@/lib/platform/customer/connection-owners";
import type { StatusTone } from "../platform-surface";

// ── Vocabulary → tone (the authority's words, our colours) ───────────────────

export const HEALTH_WORD: Record<HealthState, string> = {
  HEALTHY:      "Healthy",
  STALE:        "Stale",
  DEGRADED:     "Degraded",
  NEEDS_REAUTH: "Needs re-auth",
  ERROR:        "Error",
  REVOKED:      "Revoked",
};

export const HEALTH_TONE: Record<HealthState, StatusTone> = {
  HEALTHY:      "ok",
  STALE:        "warn",
  DEGRADED:     "warn",
  NEEDS_REAUTH: "bad",
  ERROR:        "bad",
  REVOKED:      "muted",
};

export function healthBadge(state: HealthState): { word: string; tone: StatusTone } {
  return { word: HEALTH_WORD[state] ?? state, tone: HEALTH_TONE[state] ?? "muted" };
}

// ── Row identity ─────────────────────────────────────────────────────────────

/** The one key every surface and the owner join agree on. */
export function rowKey(row: Pick<ConnectionHealthRow, "source" | "id">): string {
  return `${row.source}:${row.id}`;
}

// ── Connection cell ──────────────────────────────────────────────────────────

const SOURCE_WORD: Record<string, string> = {
  PLAID:     "Bank",
  WALLET:    "Wallet",
  EXCHANGE:  "Exchange",
  BROKERAGE: "Brokerage",
};

/**
 * `TwoLine(institution, "Bank · Plaid")` for a bank; `TwoLine(label, "Wallet · ETH")`
 * for a wallet. A wallet whose account records no chain says so in words.
 */
export function describeConnection(row: ConnectionHealthRow): { title: string; qualifier: string } {
  const word = SOURCE_WORD[row.source] ?? row.source;
  if (row.source === "PLAID") {
    return { title: row.institution ?? row.label, qualifier: `${word} · Plaid` };
  }
  return { title: row.label, qualifier: `${word} · ${row.network ?? "chain not recorded"}` };
}

// ── Time cells ───────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "14 Oct 21:05 UTC" — UTC-stable, the same on every machine. */
export function fmtUtcInstant(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** A span in words: "<1m", "45m", "3h 20m", "2d 4h". Negative or unparseable ⇒ null. */
export function formatSpan(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return "<1m";
  if (totalMin < 60) return `${totalMin}m`;
  const totalH = Math.floor(totalMin / 60);
  if (totalH < 24) return `${totalH}h ${totalMin % 60}m`;
  const d = Math.floor(totalH / 24);
  return `${d}d ${totalH % 24}h`;
}

/**
 * Past-only relative time: "3h 20m ago"; null when not in the past. `nowMs`
 * defaults to the wall clock HERE, in a plain util — never inside a component
 * (react-hooks/purity) — the relTime idiom; tests inject a clock.
 */
export function agoWords(iso: string | null, nowMs: number = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const span = formatSpan(nowMs - t);
  return span == null ? null : `${span} ago`;
}

/**
 * The Last-sync cell. `null` ⇒ the row never synced: the caller renders the
 * sentence, never an em-dash on its own and never a fabricated time.
 */
export function lastSyncCell(row: ConnectionHealthRow, nowMs: number = Date.now()): { value: string; qualifier: string } | null {
  if (row.neverSynced || !row.lastSyncedAt) return null;
  const rel = agoWords(row.lastSyncedAt, nowMs) ?? "just now";
  return { value: rel, qualifier: fmtUtcInstant(row.lastSyncedAt) ?? row.lastSyncedAt };
}

/**
 * "Stale for": lastSyncedAt → checkedAt (the authority's clock). Only
 * meaningful when the authority judged the row STALE; for other states the
 * gap is still a true duration, so it is returned and the caller decides.
 * Never-synced ⇒ null (there is no sync to measure from).
 */
export function staleFor(row: ConnectionHealthRow, checkedAtIso: string): string | null {
  if (row.neverSynced || !row.lastSyncedAt) return null;
  const from = Date.parse(row.lastSyncedAt);
  const to = Date.parse(checkedAtIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return formatSpan(to - from);
}

/** "24 h policy" — the threshold the authority applied, in its own unit. */
export function thresholdLabel(row: Pick<ConnectionHealthRow, "overdueAfterHours">): string {
  return `${row.overdueAfterHours} h policy`;
}

// ── Composition ──────────────────────────────────────────────────────────────

export interface CompositionSegment { word: string; count: number; tone: StatusTone }

/**
 * The DistributionBar segments over the authority's counts. REVOKED is
 * omitted because the population excludes it by construction (`retired`),
 * so a zero there would be a tautology, not a fact.
 */
export function compositionSegments(counts: Record<HealthState, number>): CompositionSegment[] {
  return (["HEALTHY", "STALE", "DEGRADED", "NEEDS_REAUTH", "ERROR"] as const).map((s) => ({
    word: HEALTH_WORD[s], count: counts[s] ?? 0, tone: HEALTH_TONE[s],
  }));
}

/** How much of the unhealthy population the capped list shows. */
export function listCoverage(r: Pick<ConnectionHealthResult, "total" | "counts" | "unhealthy" | "cap">): { shown: number; unhealthyTotal: number; capped: boolean } {
  const unhealthyTotal = Math.max(0, r.total - (r.counts.HEALTHY ?? 0));
  const shown = r.unhealthy.length;
  return { shown, unhealthyTotal, capped: shown < unhealthyTotal };
}

/** The sentence under the bar. Floors are said in words. */
export function compositionCaption(r: ConnectionHealthResult): string {
  const { shown, unhealthyTotal, capped } = listCoverage(r);
  const when = fmtUtcInstant(r.checkedAt) ?? r.checkedAt;
  const retired = [
    r.retired.revoked > 0 ? `${r.retired.revoked} revoked` : null,
    r.retired.ownerInactive > 0 ? `${r.retired.ownerInactive} with a deactivated owner` : null,
  ].filter((s): s is string => s != null);
  const parts = [
    `${r.total} live connection${r.total === 1 ? "" : "s"} judged at ${when}`,
    capped ? `listing the ${shown} most severe of ${unhealthyTotal} unhealthy (cap ${r.cap})` : null,
    retired.length ? `not counted: ${retired.join(", ")} (retired, not unhealthy)` : null,
  ].filter((s): s is string => s != null);
  return parts.join(" · ");
}

// ── Filter (a selection, not a verdict) ──────────────────────────────────────

export type ConnectionFilter = "all" | "needs-action";

/** A FAULT as opposed to lateness: anything the authority judged worse than STALE. */
const NEEDS_ACTION: readonly HealthState[] = ["ERROR", "NEEDS_REAUTH", "DEGRADED", "REVOKED"];

export function needsAction(row: Pick<ConnectionHealthRow, "healthState">): boolean {
  return NEEDS_ACTION.includes(row.healthState);
}

export function filterRows(rows: readonly ConnectionHealthRow[], filter: ConnectionFilter): ConnectionHealthRow[] {
  return filter === "all" ? [...rows] : rows.filter(needsAction);
}

export function filterOptions(rows: readonly ConnectionHealthRow[]): readonly { value: ConnectionFilter; label: string }[] {
  const faults = rows.filter(needsAction).length;
  return [
    { value: "all", label: `All ${rows.length}` },
    { value: "needs-action", label: `Needs action ${faults}` },
  ];
}

// ── Owner join (the CUSTOMER_SUCCESS route) ──────────────────────────────────

export const CONNECTION_OWNERS_ROUTE = "/api/platform/customer-success/connection-owners";
/** Mirrors CONNECTION_OWNERS_MAX on the reader; the list is capped at 20 so this never binds today. */
export const OWNERS_REQUEST_MAX = 50;

/** The keyed-fetch url for the rows on screen, or null when there is nothing to resolve. */
export function ownersUrl(rows: readonly Pick<ConnectionHealthRow, "source" | "id">[]): string | null {
  if (rows.length === 0) return null;
  const ids = rows.slice(0, OWNERS_REQUEST_MAX).map(rowKey);
  return `${CONNECTION_OWNERS_ROUTE}?ids=${encodeURIComponent(ids.join(","))}`;
}

/** Row key → label. */
export function ownersByRow(owners: readonly ConnectionOwner[]): Map<string, string> {
  return new Map(owners.map((o) => [rowKey(o), o.owner.label] as const));
}

// ── Actions ──────────────────────────────────────────────────────────────────

export const ACTION_WORD: Record<ConnectionHealthRow["availableActions"][number], string> = {
  "resync":         "Resync",
  "request-reauth": "Request re-auth",
};

export const NO_ACTION_REASON = "no operator route for this provider";

/** "Resync · Request re-auth", or null when the routes admit nothing for this row. */
export function actionWords(row: Pick<ConnectionHealthRow, "availableActions">): string | null {
  if (row.availableActions.length === 0) return null;
  return row.availableActions.map((a) => ACTION_WORD[a]).join(" · ");
}

// ── Type-level privacy pin ───────────────────────────────────────────────────

/**
 * The row the table consumes carries NO identity key. If someone adds one to
 * ConnectionHealthRow, this type stops being `never` and the view test's
 * assignment fails to compile.
 */
export type ConnectionRowIdentityKeys = Extract<
  keyof ConnectionHealthRow,
  "userId" | "email" | "user" | "ownerEmail" | "walletAddress" | "address" | "credential" | "accessToken" | "encryptedToken" | "token"
>;
