/**
 * components/platform/widgets/security-posture-view.ts  (BETA V2 · Workstream W4)
 *
 * The Security Ops posture surface's presentation vocabulary — pure, React-free,
 * clock-injected. It turns the five shipped SECURITY_OPS route payloads
 * (anomalies · auth-posture · audit · operator-actions · sessions) into words,
 * readings and rows. It authors no metric: the two ratios it shows (MFA adoption,
 * recovery-code coverage) come from the house `barFraction` + `formatRate` pair
 * over counts the auth-posture route already returns, and every other figure is
 * a count the route sent.
 *
 * THE TWO HONESTY FIXES THIS FILE CARRIES (BETA-OWNER-DECISION-MATRIX V2):
 *   · the anomaly KEY is rendered — as its kind in words plus the opaque digest the
 *     route now projects (lib/platform/security/anomalies-core.ts), never raw;
 *   · the login-failure "pulse" is labelled as what the route counts: LOGIN_FAILED
 *     audit rows platform-wide, every reason, over the detector's identifier window
 *     — not the detector's per-account credential-guess threshold.
 *
 * Truth posture (Platform-Spaces-Visualization-Investigation §15.1 Brief 1): the
 * Notes column carries the ABSENCE block (no score, no threat feed, no remediation,
 * no investigation state); the empty trips state carries the coverage caveat;
 * every feed states its depth as a bounded page, never a total.
 */

import type { StatusTone } from "../platform-surface";
import type { AnomaliesResponse, AnomalyTrip } from "@/app/api/platform/security-ops/anomalies/route";
import type { PlatformAuthPosture } from "@/app/api/platform/security-ops/auth-posture/route";
import type { PlatformAuditEvent } from "@/app/api/platform/security-ops/audit/route";
import type { OperatorActionEvent } from "@/app/api/platform/security-ops/operator-actions/route";
import type { PlatformSessionRow, PlatformSessionsResponse } from "@/app/api/platform/security-ops/sessions/route";
import type { AnomalyKeyKind } from "@/lib/platform/security/anomalies-core";
import { PLATFORM_AREA_WORKSPACES } from "@/lib/platform/workspaces";
import { barFraction, formatRate } from "./growth-funnel-view";
import { relTime } from "./job-health-format";

// ── The surface ──────────────────────────────────────────────────────────────

export const POSTURE_TITLE = "Security posture";

export const POSTURE_FOOTNOTE =
  "Five read routes behind SECURITY_OPS READ, each a count or a bounded page the platform already keeps; nothing here is a new detection, a score or a verdict. " +
  "No email, IP, user-agent or user id reaches this surface — an anomaly key is shown as its kind plus an opaque digest, and actors are usernames.";

export const COLUMN = { detections: "Detections", coverage: "Coverage", notes: "Notes" } as const;

export const COLUMN_HINT = {
  detections: "What the inline login-failure detector has recorded, and the raw failure volume it watches.",
  coverage: "How much of the user population the authentication controls cover, counted now.",
  notes: "What this surface does NOT have an authority for — stated, never drawn as a quiet zero.",
} as const;

/** The shape every group receives: the fetch hook's result, one per route. */
export interface Fetched<T> { data: T | null; loading: boolean; error: string | null }

/**
 * The ONE section key whose adapter hosts the surface: the first key composed into
 * the SECURITY_OPS Overview (lib/platform/workspaces.ts — the coordinator's file).
 * The hosting adapter is pinned to equal this, so reordering the composition
 * without re-hosting fails a test instead of rendering the surface nowhere.
 */
export const SECURITY_POSTURE_HOST_KEY: string = PLATFORM_AREA_WORKSPACES.SECURITY_OPS[0]?.sections[0] ?? "sec_auth_posture";

export function sourceFailedText(source: string, error: string): string {
  return `${source} could not be read (${error}) — this group is absent, not empty.`;
}

// ── Detections (anomalies route) ─────────────────────────────────────────────

export const PULSE_BASIS =
  "COUNT(AuditLog LOGIN_FAILED) platform-wide over the detector's identifier window — every failure reason, every account; " +
  "not the detector's per-account credential-guess threshold, which trips per key.";

export interface Reading {
  label: string;
  /** null ⇒ Unavailable with `reason`. */
  value: string | null;
  reason?: string;
  qualifier?: string;
  derivation: string;
}

export function pulseReading(s: AnomaliesResponse["summary"]): Reading {
  return {
    label: `Login failures · all reasons · platform-wide · ${s.windowMinutes} m`,
    value: String(s.failedLoginsWindow),
    qualifier: "raw volume, not a trip",
    derivation: PULSE_BASIS,
  };
}

export function tripsReading(s: AnomaliesResponse["summary"]): Reading {
  return {
    label: "Detector trips · 24 h",
    value: String(s.tripsLast24h),
    qualifier: "one per open (key, window)",
    derivation: "COUNT(AuditLog SECURITY_ANOMALY_DETECTED) in the last 24 h — the detector writes one row per key per open window",
  };
}

const ANOMALY_TYPE_WORD: Readonly<Record<string, string>> = {
  failed_login_identifier: "Failed-login burst (account)",
  failed_login_ip: "Failed-login burst (IP)",
  recovery_code_streak: "Invalid recovery-code streak",
  system_admin_disabled: "Disabled-admin probe",
};

/** "failed_login_identifier" → "Failed-login burst (account)". Display only; unknown types keep their word. */
export function anomalyTypeWord(type: string): string {
  return ANOMALY_TYPE_WORD[type] ?? type.replace(/_/g, " ");
}

export const KEY_KIND_WORD: Record<AnomalyKeyKind, string> = {
  account: "account",
  ip: "IP",
  recovery: "recovery on account",
  admin: "disabled admin account",
  unknown: "key kind unknown",
};

export const LEGACY_KEY_LABEL = "legacy (digest unavailable)";

/**
 * "account h1a2b3c4d" — the kind in words plus the salted keyHash prefix (the
 * same handle the Security Ops bell carries); never the raw key. A row that
 * predates keyHash (`legacy: true`) has no handle and none is invented; "no key
 * recorded" is only for a row that is neither legacy nor carries a keyRef.
 */
export function anomalyKeyLabel(t: Pick<AnomalyTrip, "keyKind" | "keyRef" | "legacy">): string {
  if (t.keyKind === "admin") return KEY_KIND_WORD.admin;
  if (t.keyRef) return `${KEY_KIND_WORD[t.keyKind]} ${t.keyRef}`;
  if (t.legacy) return t.keyKind === "unknown" ? LEGACY_KEY_LABEL : `${KEY_KIND_WORD[t.keyKind]} · ${LEGACY_KEY_LABEL}`;
  return "no key recorded";
}

/** "7 of ≥5 in 15 m" — count against the threshold that tripped; threshold absent is said, not assumed. */
export function tripMagnitude(t: Pick<AnomalyTrip, "count" | "threshold" | "windowMinutes">): string {
  return t.threshold == null
    ? `${t.count} in ${t.windowMinutes} m · threshold not recorded`
    : `${t.count} of ≥${t.threshold} in ${t.windowMinutes} m`;
}

export interface TripRow { id: string; typeWord: string; keyLabel: string; magnitude: string; when: string; stamp: string }

export const TRIP_HEADINGS = ["Type", "Key", "Magnitude", "When"] as const;

/** Rows in the route's order (newest first) — this never re-sorts. */
export function tripRows(trips: readonly AnomalyTrip[], nowMs: number): TripRow[] {
  return trips.map((t) => ({
    id: t.id,
    typeWord: anomalyTypeWord(t.type),
    keyLabel: anomalyKeyLabel(t),
    magnitude: tripMagnitude(t),
    when: relTime(t.at, nowMs),
    stamp: utcStamp(t.at),
  }));
}

export const DETECTOR_COVERAGE =
  "Four inline detectors over LOGIN_FAILED: failed-login bursts per account (≥5 / 15 m) and per IP (≥10 / 15 m), invalid recovery-code streaks (≥3 / 15 m), and any hit on the disabled SYSTEM_ADMIN account (60 m). " +
  "Nothing else is detected — absence of a trip is not absence of an attack outside those four.";

export function tripsEmptyText(): string {
  return `No detector trip in the route's newest page. ${DETECTOR_COVERAGE}`;
}

// ── Coverage (auth-posture route) ────────────────────────────────────────────

export const COVERAGE_DENOMINATOR_NOTE = "every User row, deactivated accounts included — the denominator is not 'active users'";

export function coverageReadings(p: PlatformAuthPosture): Reading[] {
  const mfa = barFraction(p.totpEnabled, p.totalUsers);
  const recovery = barFraction(p.usersWithRecoveryCodes, p.totalUsers);
  return [
    {
      label: "MFA adoption",
      value: mfa == null ? null : formatRate(mfa),
      reason: "no User rows to measure against",
      qualifier: `${p.totpEnabled} of ${p.totalUsers} users with TOTP enabled`,
      derivation: `totpEnabled ÷ totalUsers — ${COVERAGE_DENOMINATOR_NOTE}`,
    },
    {
      label: "Recovery-code coverage",
      value: recovery == null ? null : formatRate(recovery),
      reason: "no User rows to measure against",
      qualifier: `${p.usersWithRecoveryCodes} of ${p.totalUsers} users hold ≥1 unused code`,
      derivation: `users with an unused RecoveryCode ÷ totalUsers — ${COVERAGE_DENOMINATOR_NOTE}`,
    },
    {
      label: "Forced password resets pending",
      value: String(p.forcedResetPending),
      qualifier: p.forcedResetPending === 0 ? "none pending" : "accounts that must reset at next sign-in",
      derivation: "COUNT(User.forcePasswordReset = true), counted now",
    },
  ];
}

// ── Notes (the absence block) ────────────────────────────────────────────────

export const NOTES_ABSENT: ReadonlyArray<{ label: string; reason: string }> = [
  { label: "Risk score", reason: "no scoring authority — a score would launder four detectors into a verdict" },
  { label: "Threat intelligence", reason: "no feed, no geo, no baseline exists" },
  { label: "Remediation", reason: "none on this surface — session revocation is a SYSTEM_ADMIN capability elsewhere" },
  { label: "Investigation state", reason: "no finding or decision log exists; trips are rows, not cases" },
];

export const NOTES_SOURCES: ReadonlyArray<{ source: string; note: string }> = [
  { source: "AuditLog", note: "LOGIN_FAILED · SECURITY_ANOMALY_DETECTED · the 15-action security filter · operator actions" },
  { source: "User", note: "totpEnabled · forcePasswordReset" },
  { source: "RecoveryCode", note: "usedAt IS NULL" },
  { source: "UserSession", note: "revokedAt IS NULL" },
];

// ── Feeds (audit · operator-actions · sessions) ──────────────────────────────

/** "newest 15 events the route returns — a bounded page, not a total". */
export function feedDepthText(n: number, noun: string): string {
  return n === 0 ? `no ${noun} in the route's newest page` : `newest ${n} ${noun} the route returns — a bounded page, not a total`;
}

/** "TWO_FACTOR_ENABLED" → "Two factor enabled". Display only. */
export function auditActionWord(action: string): string {
  const s = action.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface AuditRow { id: string; actionWord: string; actor: string; when: string; stamp: string }

export function auditRows(events: readonly PlatformAuditEvent[], nowMs: number): AuditRow[] {
  return events.map((e) => ({ id: e.id, actionWord: auditActionWord(e.action), actor: e.actor, when: relTime(e.at, nowMs), stamp: utcStamp(e.at) }));
}

export const OPERATOR_RESULT_WORD: Record<NonNullable<OperatorActionEvent["result"]>, string> = { SUCCESS: "succeeded", FAILURE: "failed", REFUSED: "refused" };
export const OPERATOR_RESULT_TONE: Record<NonNullable<OperatorActionEvent["result"]>, StatusTone> = { SUCCESS: "ok", FAILURE: "bad", REFUSED: "warn" };

/** "chris → alice · support request · run …a1b2c3" — operator, target when distinct, reason CODE, execution handle. Never the note. */
export function operatorLine(e: OperatorActionEvent, reasonWord: (code: string) => string): string {
  const parts: string[] = [e.operator];
  if (e.target && e.target !== e.operator) parts[0] = `${e.operator} → ${e.target}`;
  if (e.reasonCode) parts.push(reasonWord(e.reasonCode));
  if (e.execution?.jobRunId) parts.push(`run …${e.execution.jobRunId.slice(-6)}`);
  else if (e.execution?.refreshExecutionId) parts.push(`refresh …${e.execution.refreshExecutionId.slice(-6)}`);
  return parts.join(" · ");
}

export function sessionsReadings(d: PlatformSessionsResponse): Reading[] {
  return [
    { label: "Active sessions", value: String(d.totalActive), derivation: "COUNT(UserSession.revokedAt IS NULL), counted now" },
    { label: "Distinct users with a session", value: String(d.distinctUsers), derivation: "distinct account count over the same rows — grouped server-side; no identifier is returned" },
  ];
}

/** "Chrome · Desktop · macOS" — parsed user-agent facets only; never the string. */
export function sessionLine(s: PlatformSessionRow): string {
  return `${s.browser} · ${s.device} · ${s.os}`;
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** "14 Oct 09:30 UTC"-grain stamp from an ISO instant; the raw value when unreadable. */
export function utcStamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}
