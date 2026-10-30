/**
 * components/platform/leads/security-model.ts  (Platform Spaces 2.0 — Security, pure)
 *
 * Every word and figure the Security dashboard (SecurityLead.tsx) draws, from
 * ONE read: GET /api/platform/security-ops/analytics?window=30|90. No React, no
 * fetch, no clock. Wording contract: a failed sign-in is not an incident, a
 * denial is not an attack, a detector trip is a "detector window".
 */

import type { SecurityAnalyticsResponse, Coverage2fa } from "@/lib/platform/security/analytics-types";
import type { DayBar, Fetched, Kpi } from "../ops-visual/ops-visual-model";
import type { HeroModel } from "../ops-visual/HealthHero";
import type { ShareBar } from "../charts/ShareBars";
import type { AcquisitionDay } from "@/lib/platform/growth/acquisition-types";
import type { StatusTone } from "../platform-surface";

export type SecurityWindow = "30" | "90";
export type SecurityDrawer = "posture";

/** The drawers, each with the hosted (former) widgets it renders unchanged. */
export const SECURITY_DRAWERS: readonly { key: SecurityDrawer; label: string; keys: readonly string[] }[] = [
  { key: "posture", label: "Posture, sessions & detector feed", keys: ["sec_auth_posture"] },
];

/** The Space's other workspaces — the full record feeds. */
export const SECURITY_FEEDS = [
  { workspaceId: "platform-audit", label: "Audit feed" },
  { workspaceId: "platform-operator-actions", label: "Operator actions" },
] as const;

export const SIGN_IN_PALETTE = { succeeded: "color-mix(in srgb, var(--meridian-400) 75%, transparent)", other: "var(--accent-warning)", failed: "var(--coral-400)" } as const;
export const ACCESS_PALETTE = { succeeded: "var(--brass-300)", other: "var(--accent-warning)", failed: "var(--coral-400)" } as const;
export const OPERATOR_PALETTE = { succeeded: "color-mix(in srgb, var(--meridian-400) 75%, transparent)", other: "var(--accent-warning)", failed: "var(--coral-400)" } as const;

const n = (v: number) => v.toLocaleString("en-US");
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;
const hhmm = (iso: string) => `Checked ${new Date(iso).toISOString().slice(11, 16)} UTC`;
const reason = (f: Fetched<unknown>, what: string) => (f.loading ? `Reading ${what}…` : `${what} unavailable${f.error ? ` — ${f.error}` : ""}`);

export interface Totals { signIns: number; credential: number; blocked: number; denials: number; detector: number; refusals: number }

export function totals(s: SecurityAnalyticsResponse): Totals {
  return s.days.reduce((a, d) => ({
    signIns: a.signIns + d.signIns, credential: a.credential + d.failedCredential, blocked: a.blocked + d.failedBlocked,
    denials: a.denials + d.accessDenials, detector: a.detector + d.detectorTrips, refusals: a.refusals + d.controlRefusals,
  }), { signIns: 0, credential: 0, blocked: 0, denials: 0, detector: 0, refusals: 0 });
}

const coverageText = (c: Coverage2fa) => (c.total === 0 ? "none" : `${n(c.enrolled)} of ${n(c.total)}`);
const coverageTone = (c: Coverage2fa, enforced: boolean): StatusTone =>
  c.total === 0 ? "muted" : c.enrolled === c.total ? "ok" : enforced ? "bad" : "warn";

export function securityKpis(f: Fetched<SecurityAnalyticsResponse>): Kpi[] {
  const s = f.data;
  if (!s) {
    const sub = reason(f, "security figures");
    return ["signIns", "failed", "operators2fa", "customers2fa"].map((key, i) => ({
      key, label: ["Sign-ins", "Failed sign-ins", "Operator 2FA", "Customer 2FA"][i], value: "—", sub,
    }));
  }
  const t = totals(s);
  const tf = s.twoFactor;
  return [
    { key: "signIns", label: "Sign-ins", value: n(t.signIns), sub: `${s.windowDays} d · successful` },
    { key: "failed", label: "Failed sign-ins", value: n(t.credential + t.blocked), sub: `${n(t.credential)} credential · ${n(t.blocked)} blocked`,
      tone: t.credential + t.blocked > 0 ? "warn" : undefined },
    { key: "operators2fa", label: "Operator 2FA", value: coverageText(tf.operators), sub: tf.enforcement.operators ? "enforced" : "not enforced",
      tone: coverageTone(tf.operators, tf.enforcement.operators) },
    { key: "customers2fa", label: "Customer 2FA", value: coverageText(tf.customers), sub: tf.enforcement.allUsers ? "required" : "optional",
      tone: tf.customers.total > 0 && tf.customers.enrolled < tf.customers.total && tf.enforcement.allUsers ? "bad" : undefined },
  ];
}

export function securityHero(f: Fetched<SecurityAnalyticsResponse>): HeroModel {
  const s = f.data;
  const t = s ? totals(s) : null;
  const failed = t ? t.credential + t.blocked : null;
  return {
    title: s ? `Security · ${s.windowDays} d` : "Security",
    dot: false,
    provenance: "MEASURED",
    verdict: { word: failed === null ? "—" : plural(failed, "failed sign-in"), tone: "muted" },
    checked: s ? hhmm(s.checkedAt) : null,
    caption: s && t
      ? `${n(t.signIns)} successful · ${n(t.denials)} access denials · ${plural(t.detector, "detector window")} · ${plural(t.refusals, "refused change")}`
      : reason(f, "security figures"),
    kpis: securityKpis(f),
    kpiLabels: { first: "Sign-in figures", second: "Two-factor coverage", all: "Security figures" },
  };
}

export function signInBars(s: SecurityAnalyticsResponse): DayBar[] {
  return s.days.map((d) => ({ day: d.day, succeeded: d.signIns, other: d.failedBlocked, failed: d.failedCredential, observed: true }));
}

export function controlBars(s: SecurityAnalyticsResponse): DayBar[] {
  return s.days.map((d) => ({ day: d.day, succeeded: d.controlRefusals, other: d.accessDenials, failed: d.detectorTrips, observed: true }));
}

export function operatorBars(s: SecurityAnalyticsResponse): DayBar[] {
  return s.operators.days.map((d) => ({ day: d.day, succeeded: d.success, other: d.refused, failed: d.failure, observed: true }));
}

/** Every security event per day (failed sign-ins + denials + detector windows + refusals) — the calendar's series. */
export function eventDays(s: SecurityAnalyticsResponse): AcquisitionDay[] {
  return s.days.map((d) => ({ day: d.day, count: d.failedCredential + d.failedBlocked + d.accessDenials + d.detectorTrips + d.controlRefusals }));
}

export function eventBreakdown(s: SecurityAnalyticsResponse, day: string | null): string {
  const d = day ? s.days.find((x) => x.day === day) : undefined;
  if (!d) return "";
  const parts = [
    d.failedCredential ? `${n(d.failedCredential)} credential` : null,
    d.failedBlocked ? `${n(d.failedBlocked)} blocked` : null,
    d.accessDenials ? `${n(d.accessDenials)} denied` : null,
    d.detectorTrips ? `${n(d.detectorTrips)} detector` : null,
    d.controlRefusals ? `${n(d.controlRefusals)} refused` : null,
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(" · ")})` : "";
}

export function reasonBars(s: SecurityAnalyticsResponse): ShareBar[] {
  const whole = s.failureReasons.reduce((a, r) => a + r.count, 0);
  return s.failureReasons.map((r) => ({
    key: r.reason, label: `${r.label}${r.kind === "blocked" ? " · blocked" : ""}`, count: r.count, share: whole > 0 ? r.count / whole : null, muted: r.kind === "blocked",
  }));
}

export function actionBars(s: SecurityAnalyticsResponse): ShareBar[] {
  return s.operators.topActions.map((a) => ({ key: a.action, label: a.label, count: a.count, share: s.operators.total > 0 ? a.count / s.operators.total : null }));
}

export interface CoverageRow { key: string; label: string; enrolled: number; total: number; pct: number | null; enforcement: string; tone: StatusTone }

export function coverageRows(s: SecurityAnalyticsResponse): CoverageRow[] {
  const tf = s.twoFactor;
  const row = (key: string, label: string, c: Coverage2fa, enforced: boolean, word: [string, string]): CoverageRow => ({
    key, label, enrolled: c.enrolled, total: c.total, pct: c.total > 0 ? (c.enrolled / c.total) * 100 : null,
    enforcement: enforced ? word[0] : word[1], tone: coverageTone(c, enforced),
  });
  return [
    row("operators", "Operators", tf.operators, tf.enforcement.operators, ["Enforced at sign-in to Platform", "Not enforced"]),
    row("admins", "System admins", tf.admins, tf.enforcement.systemAdmins, ["Always required", "Not required"]),
    row("customers", "Customers", tf.customers, tf.enforcement.allUsers, ["Required for all users", "Optional"]),
  ];
}

/** Few failures make a time-of-week pattern meaningless; below this the card says so. */
export const FAILURE_PATTERN_MIN = 10;
