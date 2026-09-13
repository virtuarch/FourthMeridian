/**
 * lib/platform/refresh-policy.core.ts
 *
 * HOW OLD SHOULD A FINANCIAL SOURCE BE? — the expected refresh cadence, as policy.
 *
 * Three different things, kept apart:
 *
 *   last successful refresh   a FACT, written by the sync that succeeded
 *   expected cadence          POLICY, declared here (runtime-editable PlatformSetting)
 *   overdue                   DERIVED: age past cadence + a code-owned grace
 *
 * A provider failure or a reauth requirement is a fourth, separate fact, and it
 * always outranks age (lib/connections/space-data-health.core.ts).
 *
 * ⚠️ PURE, AND THE ONLY PARSER. Consumers receive a resolved `RefreshPolicy`;
 * nobody parses the raw setting string but this file. The server loader
 * (refresh-policy.ts) does the one read.
 *
 * ⚠️ GRACE IS CODE-OWNED. max(2h, 25% of cadence): the 2h floor is the job-health
 * checker's slot-jitter allowance (lib/jobs/health.ts GRACE_HOURS); the 25% share
 * absorbs sync duration and provider latency at longer cadences. Operators edit
 * the cadence, never the grace.
 *
 * ⚠️ POLICY IS NOT A PROMISE THE SCHEDULER CAN KEEP BY ITSELF. The dispatcher
 * fires on fixed half-hour slots (vercel.json), so a source kind is ATTEMPTED at
 * a fixed period (lib/jobs/cadence.ts derives it from the registry — nothing here
 * copies it). A cadence is honourable only when it is a MULTIPLE of that period:
 * faster than the period, nothing attempts it; not a multiple (8h on 6-hourly
 * slots), the due filter lands on the next slot and the real interval is 12h.
 * `assessCadence` is the one authority for that judgement and for its reason;
 * the future write path refuses what it rejects. The enum keeps 4h and 8h for
 * the day the scheduler can.
 *
 * ⚠️ TIER SEAM, NOT TIERS. `RefreshPolicyRequest.tier` is reserved and typed
 * `never`: a future Free/Paid override is added HERE, and every consumer keeps
 * receiving a resolved policy.
 */

export type RefreshSourceKind = 'BANK' | 'WALLET';

export const REFRESH_CADENCES = ['4h', '6h', '8h', '12h', '24h'] as const;
export type RefreshCadence = typeof REFRESH_CADENCES[number];

/** PlatformSetting keys. Declared here (pure) and re-exported by lib/platform-settings.ts. */
export const REFRESH_CADENCE_SETTING_KEY = {
  BANK:   'refresh_cadence_bank',
  WALLET: 'refresh_cadence_wallet',
} as const satisfies Record<RefreshSourceKind, string>;

/**
 * The product contract: banks are expected daily (the 06:00 UTC sync, plus
 * webhooks), wallets every six hours (the crypto sweep at 00/06/12/18 UTC).
 */
export const DEFAULT_REFRESH_CADENCE: Readonly<Record<RefreshSourceKind, RefreshCadence>> = {
  BANK:   '24h',
  WALLET: '6h',
};

export const GRACE_FLOOR_HOURS = 2;
export const GRACE_SHARE = 0.25;

export interface RefreshPolicy {
  sourceKind: RefreshSourceKind;
  cadence: RefreshCadence;
  expectedEveryHours: number;
  graceHours: number;
  /** A last success older than this is operationally overdue. */
  overdueAfterHours: number;
  /** Where the cadence came from. INVALID_SETTING means a row existed but was unreadable. */
  origin: 'SETTING' | 'DEFAULT' | 'INVALID_SETTING';
  /** Changes whenever the effective policy or its setting row changes. Opaque; for invalidation. */
  version: string;
}

export interface RefreshPolicyRequest {
  sourceKind: RefreshSourceKind;
  /** Reserved for a future subscription-tier override. No tier changes policy today. */
  tier?: never;
}

/** The raw setting row, as read. Null when no row exists. */
export interface RefreshCadenceSettingRow {
  value: string;
  updatedAt: Date;
}

export const cadenceHours = (c: RefreshCadence): number => Number.parseInt(c, 10);

export function parseRefreshCadence(raw: unknown): RefreshCadence | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return (REFRESH_CADENCES as readonly string[]).includes(v) ? (v as RefreshCadence) : null;
}

export function graceHoursFor(expectedEveryHours: number): number {
  return Math.max(GRACE_FLOOR_HOURS, expectedEveryHours * GRACE_SHARE);
}

/** Pure: the effective policy from the setting row (or its absence). */
export function resolveRefreshPolicy(
  request: RefreshPolicyRequest,
  row: RefreshCadenceSettingRow | null,
): RefreshPolicy {
  const { sourceKind } = request;
  const parsed = row ? parseRefreshCadence(row.value) : null;
  // An unreadable row falls back to the default, like every other enum setting
  // (getRegistrationMode, getProductStatus) — but says so in `origin`.
  const origin: RefreshPolicy['origin'] = !row ? 'DEFAULT' : parsed ? 'SETTING' : 'INVALID_SETTING';
  const cadence = parsed ?? DEFAULT_REFRESH_CADENCE[sourceKind];
  const expectedEveryHours = cadenceHours(cadence);
  const graceHours = graceHoursFor(expectedEveryHours);
  return {
    sourceKind, cadence, expectedEveryHours, graceHours,
    overdueAfterHours: expectedEveryHours + graceHours,
    origin,
    version: `${sourceKind}:${cadence}:${row ? row.updatedAt.toISOString() : 'default'}`,
  };
}

// ── Scheduler honourability ───────────────────────────────────────────────────

export interface CadenceAssessment {
  cadence: RefreshCadence;
  /** True when the deployed attempt schedule can deliver exactly this cadence. */
  honourable: boolean;
  /** Why not, in the operator's words. Null when honourable. */
  reason: string | null;
  /** The interval the schedule would actually deliver for this cadence, in hours. */
  effectiveHours: number | null;
}

/**
 * Can an attempt period of `attemptPeriodHours` deliver `cadence`? The ONE rule:
 * the cadence must be a whole multiple of the period. Pure; the period comes from
 * the registry (lib/platform/scheduler-capability.ts), never from a constant here.
 */
export function assessCadence(
  cadence: RefreshCadence,
  attemptPeriodHours: number | null,
  sourceNoun = 'source',
): CadenceAssessment {
  const hours = cadenceHours(cadence);
  if (attemptPeriodHours === null) {
    return { cadence, honourable: false, effectiveHours: null,
      reason: `No scheduled job refreshes this ${sourceNoun}; no cadence can be honoured.` };
  }
  if (hours < attemptPeriodHours) {
    return { cadence, honourable: false, effectiveHours: attemptPeriodHours,
      reason: `Not supported by the current scheduler; ${sourceNoun} attempts occur every ${attemptPeriodHours} hours.` };
  }
  if (hours % attemptPeriodHours !== 0) {
    const effective = Math.ceil(hours / attemptPeriodHours) * attemptPeriodHours;
    return { cadence, honourable: false, effectiveHours: effective,
      reason: `Cannot be represented by the current ${attemptPeriodHours}-hour attempt schedule; effective execution would be ${effective} hours.` };
  }
  return { cadence, honourable: true, reason: null, effectiveHours: hours };
}

/** Is this cadence one the deployed attempt period can deliver exactly? */
export function schedulerCanHonour(cadence: RefreshCadence, attemptPeriodHours: number | null): boolean {
  return assessCadence(cadence, attemptPeriodHours).honourable;
}

/** Every cadence in the menu the given attempt period can honour, in menu order. */
export function honourableCadences(attemptPeriodHours: number | null): RefreshCadence[] {
  return REFRESH_CADENCES.filter((c) => schedulerCanHonour(c, attemptPeriodHours));
}

/** The product defaults, resolved — for callers with no settings client. */
export function defaultRefreshPolicies(): Readonly<Record<RefreshSourceKind, RefreshPolicy>> {
  return {
    BANK:   resolveRefreshPolicy({ sourceKind: 'BANK' }, null),
    WALLET: resolveRefreshPolicy({ sourceKind: 'WALLET' }, null),
  };
}

const HOUR_MS = 3_600_000;

/** Operationally overdue: a success clock older than cadence + grace. No clock is not "overdue" (NEVER_UPDATED says that). */
export function isOverdue(lastSuccess: Date | null, policy: Pick<RefreshPolicy, 'overdueAfterHours'>, now: Date): boolean {
  return !!lastSuccess && now.getTime() - lastSuccess.getTime() > policy.overdueAfterHours * HOUR_MS;
}

/**
 * For the scheduler: a source is due for a scheduled attempt once it is within
 * one grace window of its expected refresh. At a 6h cadence that is 4h — so
 * every 6-hourly slot attempts it, and a :30 continuation slot skips what the
 * :00 slot just refreshed; at 12h it is attempted every other slot.
 */
export function isDueForScheduledRefresh(lastSuccess: Date | null, policy: RefreshPolicy, now: Date): boolean {
  if (!lastSuccess) return true;
  const dueAfterHours = Math.max(1, policy.expectedEveryHours - policy.graceHours);
  return now.getTime() - lastSuccess.getTime() >= dueAfterHours * HOUR_MS;
}
