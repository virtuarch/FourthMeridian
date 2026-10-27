/**
 * lib/balances/adjusted-basis.ts   (v2.7-P0 — adjusted cash balance; v2.7-P5 — cutover semantics)
 *
 * The basis boundary of the adjusted-cash contract, and the ONE wording that
 * discloses it. Pure: no DB, no React, no clock — safe for client and server.
 *
 * Snapshot rows written BEFORE the basis went live stored total cash / assets /
 * net worth on the provider-REPORTED ledger basis (they may count a pending
 * internal transfer in two accounts). Rows written after it use the ADJUSTED
 * basis (lib/balances/account-balances.ts#adjustedDepositoryBalance). Observed
 * rows are immutable (frozen-row invariant) and no schema stamp is authorised,
 * so the cutover marker below is the only record of where the basis changes. A
 * chart window that spans it says so; nothing is rewritten.
 *
 * ── CUTOVER SEMANTICS (v2.7-P5; runbook docs/plans/V2.7-ADJUSTED-CASH-CUTOVER-RUNBOOK-2026-10-27.md)
 *
 * SpaceSnapshot rows are keyed by UTC calendar day (`date @db.Date`). The live
 * writer (lib/snapshots/regenerate.ts) upserts TODAY's (UTC) row every time a
 * refresh/webhook/cron/account change triggers it, and never touches an earlier
 * day. So when the adjusted code goes live at instant T on UTC day C:
 *
 *   • days  < C  — every write happened before T            ⇒ REPORTED
 *   • day   = C  — the CHANGEOVER day: the row is ADJUSTED iff its LAST write
 *                  came after T. A row first written before T and never touched
 *                  again before 24:00 UTC stays REPORTED. Unknowable from the
 *                  row (only `createdAt` exists: createdAt ≥ T proves adjusted;
 *                  createdAt < T proves nothing) ⇒ MAY BE EITHER.
 *   • days  > C  — every write happened after T             ⇒ ADJUSTED
 *
 *   The one exception: T exactly 00:00:00.000Z — no day is mixed, C is adjusted.
 *
 * Hence the marker is the CHANGEOVER DAY (or the exact instant), not "the first
 * adjusted day": a date-only "first adjusted day" set to the deploy day would
 * mislabel that day whenever its row was not rewritten after T, and set to the
 * day after it would mislabel the deploy day whenever it was.
 *
 * Per environment, the marker is the build-time public env var
 * NEXT_PUBLIC_ADJUSTED_CASH_BASIS_CUTOVER (inlined by Next into server AND
 * client bundles, so the server render and hydration always agree — the same
 * pattern as NEXT_PUBLIC_TURNSTILE_SITE_KEY). Accepted values:
 *   "YYYY-MM-DD"                          — the UTC changeover day (time unknown ⇒ mixed)
 *   "YYYY-MM-DDTHH:MM[:SS[.sss]](Z|±HH:MM)" — the exact go-live instant (zone REQUIRED)
 * Absent, malformed, zone-less, impossible (2026-02-30) or earlier than the
 * develop release ⇒ the code default (develop/Preview), never a crash.
 * Production MUST set it in its promotion (runbook §2).
 *
 * All dates are UTC calendar days and are rendered with timeZone "UTC", so a
 * viewer in Kuwait (UTC+3) or Los Angeles reads the same day the chart's own
 * axis shows (chart points ARE these UTC snapshot dates).
 */

/**
 * develop/Preview changeover: PR #56 merged as f84feac at 2026-10-27T01:51:54Z
 * and the Preview deployment went live ~02:00Z the same UTC day. Rows dated
 * 2026-10-26 and earlier are reported; 2026-10-27 may be either; 2026-10-28
 * onward are adjusted. Date-only (the exact go-live second is not recorded).
 */
export const ADJUSTED_CASH_BASIS_CUTOVER_DEFAULT = "2026-10-27";

/** The earliest changeover any environment can have (the code did not exist before). */
const EARLIEST_CHANGEOVER_DAY = "2026-10-27";

export interface AdjustedCashBasisCutover {
  /** Where the marker came from. `invalidEnv` = an override was present but refused. */
  source: "env" | "default";
  invalidEnv: boolean;
  /** The UTC day containing the go-live instant. */
  changeoverDay: string;
  /** True when the changeover day's row may be on either basis. */
  mixed: boolean;
  /** Last UTC day whose row MAY be reported (changeoverDay if mixed, else the day before). */
  lastReportedDay: string;
  /** First UTC day whose row can only have been written by adjusted code. */
  firstAdjustedDay: string;
  /** The exact go-live instant (UTC ISO) when known, else null. */
  at: string | null;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

function isRealDay(day: string): boolean {
  const m = DATE_RE.exec(day);
  if (!m) return false;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return new Date(t).toISOString().slice(0, 10) === day;
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function fromDay(day: string, mixed: boolean, at: string | null, source: "env" | "default", invalidEnv: boolean): AdjustedCashBasisCutover {
  return {
    source, invalidEnv, changeoverDay: day, mixed, at,
    lastReportedDay: mixed ? day : addDays(day, -1),
    firstAdjustedDay: mixed ? addDays(day, 1) : day,
  };
}

/** Parse one marker value; null when it is not a valid, plausible cutover. */
export function parseAdjustedCashBasisCutover(raw: string | null | undefined, source: "env" | "default" = "env"): AdjustedCashBasisCutover | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return null;
  if (DATE_RE.test(v)) {
    if (!isRealDay(v) || v < EARLIEST_CHANGEOVER_DAY) return null;
    return fromDay(v, true, null, source, false);
  }
  const m = INSTANT_RE.exec(v);
  if (!m) return null;
  const [, day, hh, mm, ss = "00"] = m;
  if (!isRealDay(day) || +hh > 23 || +mm > 59 || +ss > 59) return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  const iso = new Date(t).toISOString();
  const utcDay = iso.slice(0, 10);
  if (utcDay < EARLIEST_CHANGEOVER_DAY) return null;
  const midnight = iso.slice(11) === "00:00:00.000Z";
  return fromDay(utcDay, !midnight, iso, source, false);
}

function readEnv(): string | undefined {
  // Literal reference so Next inlines it into client bundles at build time.
  try { return process.env.NEXT_PUBLIC_ADJUSTED_CASH_BASIS_CUTOVER; } catch { return undefined; }
}

/**
 * The cutover in force: the env override when valid, else the code default.
 * `raw` is injectable for tests; production callers pass nothing.
 */
export function resolveAdjustedCashBasisCutover(raw: string | null | undefined = readEnv()): AdjustedCashBasisCutover {
  const fromEnv = parseAdjustedCashBasisCutover(raw, "env");
  if (fromEnv) return fromEnv;
  const present = typeof raw === "string" && raw.trim() !== "";
  return { ...parseAdjustedCashBasisCutover(ADJUSTED_CASH_BASIS_CUTOVER_DEFAULT, "default")!, invalidEnv: present };
}

/**
 * @deprecated v2.7-P5 — the first UTC day whose row is guaranteed adjusted under
 * the CODE DEFAULT (develop/Preview): 2026-10-28. It ignores the per-environment
 * override; readers use resolveAdjustedCashBasisCutover(). Kept for re-exports.
 */
export const ADJUSTED_CASH_BASIS_SINCE = parseAdjustedCashBasisCutover(ADJUSTED_CASH_BASIS_CUTOVER_DEFAULT, "default")!.firstAdjustedDay;

/**
 * True when the plotted window [fromISO, toISO] (UTC snapshot days) can show a
 * basis discontinuity: it holds a day that may be reported AND a later day that
 * may be adjusted. A single-day window never does.
 */
export function spansAdjustedCashBasis(
  fromISO: string | null | undefined,
  toISO: string | null | undefined,
  cutover: AdjustedCashBasisCutover = resolveAdjustedCashBasisCutover(),
): boolean {
  if (!fromISO || !toISO) return false;
  const from = fromISO.slice(0, 10);
  const to = toISO.slice(0, 10);
  return from < to && from <= cutover.lastReportedDay && to >= cutover.changeoverDay;
}

function formatDay(day: string, withYear: boolean): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC",
  });
}

/** The disclosure sentence, or null when the window does not span the change. */
export function adjustedCashBasisNote(
  fromISO: string | null | undefined,
  toISO: string | null | undefined,
  cutover: AdjustedCashBasisCutover = resolveAdjustedCashBasisCutover(),
): string | null {
  if (!spansAdjustedCashBasis(fromISO, toISO, cutover)) return null;
  const since = formatDay(cutover.firstAdjustedDay, true);
  const lead = `From ${since} (UTC), cash is net of pending bank activity not yet deducted from the bank's balance; `;
  if (!cutover.mixed) return `${lead}earlier points use bank-reported balances.`;
  const sameYear = cutover.changeoverDay.slice(0, 4) === cutover.firstAdjustedDay.slice(0, 4);
  const c = formatDay(cutover.changeoverDay, !sameYear);
  return `${lead}points before ${c} use bank-reported balances, and ${c}, the changeover day, may use either.`;
}
