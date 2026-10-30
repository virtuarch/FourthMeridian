/**
 * lib/platform/security/analytics-core.ts  (Platform Spaces 2.0 — Security, pure)
 *
 * Folds the SQL-aggregated counts the reader (./analytics.ts) returns into the
 * SecurityAnalyticsResponse. No I/O, no clock — `now` is an argument. Every
 * input row is already a COUNT keyed by day / code; nothing identifying arrives.
 */

import { CREDENTIAL_GUESS_REASONS } from "@/lib/security/anomalies";
import type { OperatorDay, SecurityAnalyticsResponse, SecurityDay } from "./analytics-types";

const DAY_MS = 86_400_000;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export function windowDays(now: Date, n: number): string[] {
  const today = Date.parse(`${dayKey(now)}T00:00:00.000Z`);
  return Array.from({ length: n }, (_, i) => dayKey(new Date(today - (n - 1 - i) * DAY_MS)));
}

/** One aggregated row: a UTC day (YYYY-MM-DD), a code (reason / type / result / action) and a count. */
export interface DayCount { day: string; key: string | null; count: number }
export interface HourCount { dow: number; hour: number; count: number }

export interface SecurityAnalyticsFacts {
  signIns: readonly DayCount[];
  failures: readonly DayCount[];
  failureHours: readonly HourCount[];
  anomalies: readonly DayCount[];
  refusals: readonly DayCount[];
  operatorByResult: readonly DayCount[];
  operatorByAction: readonly { key: string; count: number }[];
  twoFactor: SecurityAnalyticsResponse["twoFactor"];
  activeSessions: number;
  floor: boolean;
}

export const ACCESS_DENIED_TYPE = "platform_access_denied";

const REASON_LABELS: Record<string, string> = {
  user_not_found: "Unknown account",
  invalid_password: "Wrong password",
  totp_required: "2FA code missing",
  totp_invalid: "Wrong 2FA code",
  recovery_code_invalid: "Wrong recovery code",
  email_unverified: "Email not verified",
  pending_deletion: "Account pending deletion",
  account_deactivated: "Account deactivated",
  system_admin_disabled: "Disabled admin account",
  unspecified: "Reason not recorded",
};

const DETECTOR_LABELS: Record<string, string> = {
  failed_login_identifier: "Repeated failures on one account",
  failed_login_ip: "Repeated failures from one network",
  recovery_code_streak: "Repeated recovery-code failures",
  system_admin_disabled: "Disabled admin account used",
};

/** Words for a code: a known label, else the code with underscores spaced (never a raw identifier). */
export function humanize(code: string, labels: Record<string, string>): string {
  if (labels[code]) return labels[code];
  const s = code.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const UNAVAILABLE_SIGNALS: readonly string[] = [
  "Account lockouts — no lockout is recorded (sign-in is rate limited, not locked)",
  "Rate-limited sign-in attempts — a throttled attempt writes no row",
  "Verified incidents and severity — detector windows are not investigated incidents",
];

export function buildSecurityAnalytics(facts: SecurityAnalyticsFacts, now: Date, windowN: 30 | 90): SecurityAnalyticsResponse {
  const keys = windowDays(now, windowN);
  const index = new Map(keys.map((k, i) => [k, i]));
  const days: SecurityDay[] = keys.map((day) => ({
    day, signIns: 0, failedCredential: 0, failedBlocked: 0, accessDenials: 0, detectorTrips: 0, controlRefusals: 0,
  }));
  const at = (day: string) => { const i = index.get(day); return i === undefined ? null : days[i]; };
  const credential = new Set(CREDENTIAL_GUESS_REASONS);

  for (const r of facts.signIns) { const d = at(r.day); if (d) d.signIns += r.count; }
  const reasons = new Map<string, number>();
  for (const r of facts.failures) {
    const d = at(r.day);
    if (!d) continue;
    const reason = r.key ?? "unspecified";
    if (credential.has(reason)) d.failedCredential += r.count; else d.failedBlocked += r.count;
    reasons.set(reason, (reasons.get(reason) ?? 0) + r.count);
  }
  const detectors = new Map<string, number>();
  for (const r of facts.anomalies) {
    const d = at(r.day);
    if (!d) continue;
    if (r.key === ACCESS_DENIED_TYPE) d.accessDenials += r.count;
    else {
      d.detectorTrips += r.count;
      const type = r.key ?? "unspecified";
      detectors.set(type, (detectors.get(type) ?? 0) + r.count);
    }
  }
  for (const r of facts.refusals) { const d = at(r.day); if (d) d.controlRefusals += r.count; }

  const opDays: OperatorDay[] = keys.map((day) => ({ day, success: 0, failure: 0, refused: 0, unknown: 0 }));
  let opTotal = 0;
  for (const r of facts.operatorByResult) {
    const i = index.get(r.day);
    if (i === undefined) continue;
    // A pre-envelope row carries no result: it is "not recorded", never assumed done (the feeds read it as unknown too).
    if (r.key === "SUCCESS") opDays[i].success += r.count;
    else if (r.key === "FAILURE") opDays[i].failure += r.count;
    else if (r.key === "REFUSED") opDays[i].refused += r.count;
    else opDays[i].unknown += r.count;
    opTotal += r.count;
  }

  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const h of facts.failureHours) if (h.dow >= 0 && h.dow < 7 && h.hour >= 0 && h.hour < 24) grid[h.dow][h.hour] += h.count;

  const byCount = <T extends { count: number }>(a: T, b: T) => b.count - a.count;
  return {
    checkedAt: now.toISOString(),
    windowDays: windowN,
    from: keys[0],
    to: keys[keys.length - 1],
    days,
    failedByHour: grid,
    failureReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, label: humanize(reason, REASON_LABELS), kind: credential.has(reason) ? "credential" as const : "gate" as const, count }))
      .sort(byCount),
    detectorTypes: [...detectors.entries()].map(([type, count]) => ({ type, label: humanize(type, DETECTOR_LABELS), count })).sort(byCount),
    operators: {
      days: opDays,
      topActions: [...facts.operatorByAction].sort(byCount).slice(0, 6).map((a) => ({ action: a.key, label: humanize(a.key, {}), count: a.count })),
      total: opTotal,
    },
    twoFactor: facts.twoFactor,
    sessions: { active: facts.activeSessions },
    unavailable: [...UNAVAILABLE_SIGNALS],
    floor: facts.floor,
    notes: [
      "UTC days and hours. Counts only — no address, identifier or network detail leaves the database.",
      "A failed sign-in is not an incident: credential failures are wrong passwords or codes; account-gate refusals were stopped by the account's state (unverified, deactivated, pending deletion, disabled admin) — not by a wrong password.",
      "Operator activity counts only rows with an acting operator; a customer's own deactivation or reactivation is not operator activity. Rows written before results were recorded read \"result not recorded\".",
      "Access-denial records are written at most once per operator and Space per hour, so they are a floor.",
      "Detector windows are automatic threshold trips (lib/security/anomalies), not investigated incidents.",
    ],
  };
}
