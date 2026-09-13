/**
 * lib/connections/space-data-health.core.ts
 *
 * WHEN THE MONEY IN THIS SPACE WAS LAST OBSERVED — per source, derived, pure.
 *
 * A Daily Brief has two clocks: when the Brief was written, and when the data it
 * was written over was last received. This module is the second clock, for the
 * sources behind ONE Space, as a viewer is allowed to see them.
 *
 * ⚠️ EXISTING AUTHORITIES, NOT A NEW HEALTH MODEL. Status precedence is the one
 * `deriveConnectionHealthState` (lib/connections/health.ts) and
 * `deriveConnectionState` / `deriveWalletConnectionState` (lib/sync/status.ts)
 * already use; ages are graded by the customer freshness bands in
 * lib/freshness/observation.ts. No TTL is invented here.
 *
 * ⚠️ OVERDUE IS POLICY, AGE IS A BAND. When a caller passes a resolved refresh
 * policy (lib/platform/refresh-policy.core.ts), a synced source is OUT_OF_DATE
 * once its last success is older than cadence + grace — a wallet at 10h under a
 * 6h policy, though still a "recent" age. Without a policy the general stale
 * band applies. Provider failure and reauth outrank either; age alone never
 * becomes CONNECTION_ERROR.
 *
 * ⚠️ THE CLOCK IS SUCCESS-ONLY, AND THE OLDEST WINS. A source's `lastUpdatedAt` is
 * the older of "balances last written after a successful read" (the oldest
 * `FinancialAccount.lastUpdated` among ITS accounts in this Space — never the
 * newest, which is how one fresh account hid stale ones on the Connections card)
 * and, for banks, "transactions last completed a full sync" (`PlaidItem.lastSyncedAt`).
 * Attempt clocks (`lastManualRefreshAt`, `syncLockedAt`) and `updatedAt` columns
 * are never read: they move when nothing was received.
 *
 * ⚠️ A SUMMARY NEVER HIDES A CHILD. A provider group reports how many of its
 * sources need attention and the OLDEST update among them. "Banks: today" cannot
 * be said while one bank has been silent for three weeks.
 *
 * ⚠️ STATES, NOT REASONS. NEEDS_RECONNECT is the provider's own verdict (status
 * NEEDS_REAUTH); OUT_OF_DATE says only that nothing arrived since a date. No
 * cause is guessed, and no provider error code, id or token crosses out of here.
 *
 * ⚠️ NAMES FOLLOW THE DETAIL GRANT. An institution or wallet name is shown only
 * when the viewer may see the account's detail (or owns the account); otherwise
 * the source is described generically, as the accounts assembler already does.
 */

import { bandForAge, isStaleBand, VERY_STALE_AFTER_DAYS } from "@/lib/freshness/observation";
import { isOverdue, type RefreshPolicy } from "@/lib/platform/refresh-policy.core";

export type DataSourceKind = "BANK" | "WALLET" | "MANUAL";

/**
 * CURRENT          received within the freshness bands' "recent" window
 * IMPORTING        a first sync (or resumable discovery) is genuinely in progress
 * OUT_OF_DATE      nothing received since `lastUpdatedAt`, old enough to be stale
 * NEEDS_RECONNECT  the provider requires the connection's owner to sign in again
 * CONNECTION_ERROR the provider reports the connection in error
 * SYNC_INCOMPLETE  the last sync did not finish (a wallet error); data may be behind
 * DISCONNECTED     the connection was revoked; its accounts no longer update
 * NEVER_UPDATED    no successful update has ever been recorded
 */
export type DataSourceState =
  | "CURRENT" | "IMPORTING" | "OUT_OF_DATE" | "NEEDS_RECONNECT"
  | "CONNECTION_ERROR" | "SYNC_INCOMPLETE" | "DISCONNECTED" | "NEVER_UPDATED";

export interface DataSourceView {
  kind:  DataSourceKind;
  /** The institution or wallet name when the viewer may see it; otherwise generic. */
  label: string;
  state: DataSourceState;
  /** The last successful update Fourth Meridian recorded for this source. ISO-8601, or null. */
  lastUpdatedAt: string | null;
  /** Accounts in this Space that this source feeds. */
  accountCount: number;
  needsAttention: boolean;
  /** The viewer can resolve it on the Connections page (they own the connection). */
  actionable: boolean;
}

export interface DataGroupView {
  kind: DataSourceKind;
  sources: number;
  attention: number;
  /** The OLDEST last update among the group's sources — never the newest. */
  oldestUpdatedAt: string | null;
}

export interface SpaceDataHealth {
  /** Attention first (most severe), then oldest first. */
  sources: DataSourceView[];
  groups:  DataGroupView[];
  attention: number;
}

// ── Input (one row per ACTIVE link to a live account) ─────────────────────────

export interface DataHealthAccountInput {
  /** The viewer may see this account's identifying detail. */
  detailVisible: boolean;
  accountName:   string;
  /** When Fourth Meridian last wrote this account after a successful read. */
  lastUpdated:   Date | null;
  syncStatus:    string | null;
  /** The live, canonical connection behind the account, if any. `key` groups only; it is never output. */
  plaid: {
    key: string; ownerUserId: string; institutionName: string;
    status: string; lastSyncedAt: Date | null; syncIncompleteAt: Date | null; historyBuildStartedAt: Date | null;
  } | null;
  wallet: {
    key: string; ownerUserId: string;
    status: string; errorCode: string | null; lastSyncedAt: Date | null; discoveryCursor: boolean;
  } | null;
}

const SEVERITY: Record<DataSourceState, number> = {
  NEEDS_RECONNECT: 7, CONNECTION_ERROR: 6, DISCONNECTED: 5, SYNC_INCOMPLETE: 4,
  OUT_OF_DATE: 3, NEVER_UPDATED: 2, IMPORTING: 1, CURRENT: 0,
};

const DAY_MS = 86_400_000;
const minDate = (ds: (Date | null)[]): Date | null => {
  const xs = ds.filter((d): d is Date => d instanceof Date);
  return xs.length ? new Date(Math.min(...xs.map((d) => d.getTime()))) : null;
};
const ageDays = (d: Date | null, now: Date) => (d ? Math.max(0, (now.getTime() - d.getTime()) / DAY_MS) : null);
const stale = (d: Date | null, now: Date) => isStaleBand(bandForAge(ageDays(d, now)));
/** Operationally late: past the refresh policy when one is given, else past the general stale band. */
const late = (clock: Date, now: Date, policy: SourceHealthInput["policy"]) =>
  policy ? isOverdue(clock, policy, now) : stale(clock, now);

function bankState(p: SourceHealthInput["plaid"] & object, clock: Date | null, now: Date, policy: SourceHealthInput["policy"]): DataSourceState {
  if (p.status === "NEEDS_REAUTH") return "NEEDS_RECONNECT";
  if (p.status === "ERROR") return "CONNECTION_ERROR";
  if (p.status === "REVOKED") return "DISCONNECTED";
  // A stalled import that has aged is out of date, not "importing".
  if (clock && late(clock, now, policy)) return "OUT_OF_DATE";
  if (p.syncIncompleteAt !== null || p.historyBuildStartedAt !== null) return "IMPORTING";
  return clock ? "CURRENT" : "NEVER_UPDATED";
}

function walletState(w: SourceHealthInput["wallet"] & object, clock: Date | null, now: Date, policy: SourceHealthInput["policy"]): DataSourceState {
  if (w.status === "REVOKED") return "DISCONNECTED";
  // Wallets never reauthenticate: NEEDS_REAUTH is an error (lib/sync/status.ts).
  if (w.status === "ERROR" || w.status === "NEEDS_REAUTH") return "CONNECTION_ERROR";
  if (w.errorCode !== null) return "SYNC_INCOMPLETE";
  if (w.lastSyncedAt === null && w.discoveryCursor) return "IMPORTING";
  if (!clock) return "NEVER_UPDATED";
  return late(clock, now, policy) ? "OUT_OF_DATE" : "CURRENT";
}

/** One source's raw provider fields — what any page that shows a source's health must pass. */
export interface SourceHealthInput {
  kind: DataSourceKind;
  /** When Fourth Meridian last wrote each of the source's relevant accounts after a successful read. */
  accountsUpdated: (Date | null)[];
  plaid?: { status: string; lastSyncedAt: Date | null; syncIncompleteAt: Date | null; historyBuildStartedAt: Date | null } | null;
  wallet?: { status: string; errorCode: string | null; lastSyncedAt: Date | null; discoveryCursor: boolean } | null;
  /** The resolved refresh policy for this source's kind. Omitted ⇒ the general stale band. */
  policy?: Pick<RefreshPolicy, "overdueAfterHours"> | null;
}

export interface SourceHealth {
  state: DataSourceState;
  /** The OLDEST relevant successful update. ISO-8601, or null. */
  lastUpdatedAt: string | null;
  needsAttention: boolean;
}

/**
 * THE per-source health rule — the Brief's data health and the Connections page
 * both call this, so they cannot disagree about a source they both show.
 */
export function deriveSourceHealth(input: SourceHealthInput, now: Date): SourceHealth {
  const accountsClock = minDate(input.accountsUpdated);
  if (input.plaid) {
    const clock = minDate([accountsClock, input.plaid.lastSyncedAt]);
    const state = bankState(input.plaid, clock, now, input.policy);
    return { state, lastUpdatedAt: clock?.toISOString() ?? null, needsAttention: state !== "CURRENT" && state !== "IMPORTING" };
  }
  if (input.wallet) {
    const clock = minDate([accountsClock, input.wallet.lastSyncedAt]);
    const state = walletState(input.wallet, clock, now, input.policy);
    return { state, lastUpdatedAt: clock?.toISOString() ?? null, needsAttention: state !== "CURRENT" && state !== "IMPORTING" };
  }
  // Manual balances are entered, not synced: they are out of date only past
  // the very-stale band (the accounts assembler's existing 30-day rule).
  const age = ageDays(accountsClock, now);
  const state: DataSourceState = age === null ? "NEVER_UPDATED" : age >= VERY_STALE_AFTER_DAYS ? "OUT_OF_DATE" : "CURRENT";
  return { state, lastUpdatedAt: accountsClock?.toISOString() ?? null, needsAttention: state !== "CURRENT" };
}

export function deriveSpaceDataHealth(
  rows: DataHealthAccountInput[], viewerUserId: string, now: Date,
  /** Resolved refresh policies by kind (lib/platform/refresh-policy.ts). Manual accounts take none. */
  policies?: Partial<Record<"BANK" | "WALLET", Pick<RefreshPolicy, "overdueAfterHours">>>,
): SpaceDataHealth {
  const bySource = new Map<string, { kind: DataSourceKind; rows: DataHealthAccountInput[] }>();
  for (const r of rows) {
    const key = r.plaid ? `p:${r.plaid.key}` : r.wallet ? `w:${r.wallet.key}` : r.syncStatus === "manual" ? "manual" : null;
    if (!key) continue;   // no connection and not manual: there is no update clock to report honestly
    const kind: DataSourceKind = r.plaid ? "BANK" : r.wallet ? "WALLET" : "MANUAL";
    const entry = bySource.get(key) ?? { kind, rows: [] };
    entry.rows.push(r);
    bySource.set(key, entry);
  }

  const sources: DataSourceView[] = [];
  for (const { kind, rows: rs } of bySource.values()) {
    const p = rs[0].plaid;
    const w = rs[0].wallet;
    const policy = kind === "BANK" ? policies?.BANK : kind === "WALLET" ? policies?.WALLET : null;
    const health = deriveSourceHealth({ kind, accountsUpdated: rs.map((r) => r.lastUpdated), plaid: p, wallet: w, policy }, now);
    const named = rs.find((r) => r.detailVisible);
    const label = kind === "BANK" ? (named ? p!.institutionName : "A bank connection")
      : kind === "WALLET" ? (named ? named.accountName : "A crypto wallet")
      : rs.length === 1 && rs[0].detailVisible ? rs[0].accountName : "Manual accounts";
    const actionable = kind === "BANK" ? p!.ownerUserId === viewerUserId
      : kind === "WALLET" ? w!.ownerUserId === viewerUserId : false;
    sources.push({ kind, label, state: health.state, lastUpdatedAt: health.lastUpdatedAt,
      accountCount: rs.length, needsAttention: health.needsAttention, actionable });
  }

  sources.sort((a, b) => SEVERITY[b.state] - SEVERITY[a.state]
    || (a.lastUpdatedAt ?? "").localeCompare(b.lastUpdatedAt ?? "")
    || a.label.localeCompare(b.label));

  const groups: DataGroupView[] = (["BANK", "WALLET", "MANUAL"] as const).flatMap((kind) => {
    const g = sources.filter((s) => s.kind === kind);
    if (g.length === 0) return [];
    const dated = g.map((s) => s.lastUpdatedAt).filter((x): x is string => x !== null).sort();
    return [{ kind, sources: g.length, attention: g.filter((s) => s.needsAttention).length, oldestUpdatedAt: dated[0] ?? null }];
  });

  return { sources, groups, attention: sources.filter((s) => s.needsAttention).length };
}

/**
 * The sources a Brief's conclusions may need qualifying by — for the evidence
 * package. Names and states only, dated to the day; nothing the page does not
 * already show the same viewer.
 */
export function staleSourcesForBrief(health: SpaceDataHealth | null):
  { label: string; state: DataSourceState; lastUpdated: string | null }[] {
  return (health?.sources ?? []).filter((s) => s.needsAttention)
    .map((s) => ({ label: s.label, state: s.state, lastUpdated: s.lastUpdatedAt?.slice(0, 10) ?? null }));
}
