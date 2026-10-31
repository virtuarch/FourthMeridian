/**
 * lib/platform/growth/acquisition-core.ts  (Platform Spaces 2.0 — Growth)
 *
 * PURE folds behind GET /api/platform/growth-revenue/acquisition. The reader
 * (./acquisition.ts) fetches row sets; this file turns them into the
 * identity-free AcquisitionResponse. No I/O, no clock — `now` is an argument.
 *
 * Authorities (docs/plans/PLATFORM-SPACES-2.0-VISUAL-ARCHITECTURE-2026-10-31.md §4):
 *   requests       BetaAccessRequestEvent.receivedAt — one row per form submission,
 *                  folded to DISTINCT requester per UTC day (the requester key is a
 *                  digest the reader computes in SQL — no address reaches this file)
 *   registrations  User.createdAt (the same user set the product analytics use)
 *   waitlist       BetaAccessRequest.status / inviteExpiresAt — current state
 *   sources        the requester's FIRST in-window submission's allowlisted source
 *   time of week   AuditLog LOGIN instants; AiInvocation chat turns (distinct turn)
 *   cohorts        registration week × engagement (the frozen predicate,
 *                  product-analytics-core `activitySets`) / × strict funnel stage
 *                  (`stageReachedAt` + `furthestStage`, the ONE funnel)
 *
 * Coverage is declared, never inferred from the data: a day before a source
 * began (or past its retention edge) is `null`, a cohort period before
 * engagement facts began is `noData`, and an unfinished period is `immature`.
 */

import type { AcquisitionSource } from "@/lib/marketing/acquisition";
import {
  FUNNEL_STAGE_LABELS, FUNNEL_STAGE_ORDER, activitySets, addDays, dayOf, firstConnections, furthestStage, isoMonday,
  lastNDays, stageReachedAt, type ActivityFactSet, type ProductAnalyticsFacts, type UserInstant,
} from "./product-analytics-core";
import type {
  AcquisitionDay, AcquisitionResponse, CohortCell, CohortRow, OnboardingStageKey,
} from "./acquisition-types";

/** BetaAccessRequestEvent arrived with migration 20261007100000 — no submission is recorded before it. */
export const REQUEST_EVENTS_SINCE = "2026-10-07";
/** jobs/data-retention.ts — BetaAccessRequestEvent rows are deleted after 180 days. */
export const REQUEST_EVENT_RETENTION_DAYS = 180;
/** Product events (the engagement audit actions) began 2026-10-15 (lib/analytics/product-events.ts). */
export const ENGAGEMENT_EVENTS_SINCE = "2026-10-15";
/** jobs/product-event-retention.ts — product events are kept 13 months. */
export const ENGAGEMENT_RETENTION_DAYS = 395;
/** jobs/data-retention.ts — AiInvocation rows are deleted after 90 days. */
export const CHAT_RETENTION_DAYS = 90;

export const COHORT_WEEKS = 8;
export const RETENTION_OFFSETS = 8;
export const TOP_SOURCES = 6;

export const ONBOARDING_STAGES: readonly OnboardingStageKey[] = [
  "verified", "firstSession", "firstConnection", "firstAiTurn", "firstBriefViewed",
];

export interface RequestEventFact { requesterKey: string; receivedAt: Date; source: AcquisitionSource | null }
export interface WaitlistFact { status: string; inviteExpiresAt: Date | null; invitedAt: Date | null }
export interface ChatTurnFact { key: string; at: Date }

export type CohortFunnelFacts = Pick<ProductAnalyticsFacts,
  "users" | "firstSessions" | "firstAiTurns" | "firstBriefViews" | "lastEngagements" | "plaidItems" | "walletConnections" | "manualAssets">;

export interface AcquisitionFacts {
  /** Submissions inside the window (receivedAt ≥ window start). */
  requestEvents: readonly RequestEventFact[];
  waitlist: readonly WaitlistFact[];
  /** LOGIN instants inside the window. */
  logins: readonly Date[];
  /** Chat AI invocations inside the window, keyed by turn (several rows per turn fold to one). */
  chatTurns: readonly ChatTurnFact[];
  /** Ever-facts for the cohorts (the funnel's own loader). */
  funnel: CohortFunnelFacts;
  /** Day-grain activity since the oldest cohort week began. */
  activity: ActivityFactSet;
}

const later = (a: string, b: string): string => (a > b ? a : b);

/** Weekday with Monday = 0, in UTC. */
export const weekdayUTC = (d: Date): number => (d.getUTCDay() + 6) % 7;

function grid(): number[][] {
  return Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
}

function perDay(days: readonly string[], coveredFrom: string | null, dayKeys: Iterable<string>): AcquisitionDay[] {
  const counts = new Map<string, number>();
  for (const d of dayKeys) counts.set(d, (counts.get(d) ?? 0) + 1);
  return days.map((day) => ({ day, count: coveredFrom !== null && day >= coveredFrom ? counts.get(day) ?? 0 : null }));
}

const observedTotal = (rows: readonly AcquisitionDay[]): number => rows.reduce((a, r) => a + (r.count ?? 0), 0);

function sourceLabel(s: AcquisitionSource | null): string | null {
  if (!s) return null;
  return s.utmSource?.trim() || s.referrerHost?.trim() || null;
}

/** The cohort weeks, oldest first: the current ISO week and the seven before it. */
export function cohortWeeks(today: string): string[] {
  const newest = isoMonday(today);
  return Array.from({ length: COHORT_WEEKS }, (_, i) => addDays(newest, -7 * (COHORT_WEEKS - 1 - i)));
}

export function buildAcquisition(facts: AcquisitionFacts, now: Date, windowDays: 30 | 90): AcquisitionResponse {
  const today = dayOf(now);
  const days = lastNDays(today, windowDays);
  const from = days[0];

  // ── Coverage (declared) ────────────────────────────────────────────────────
  const requestsFrom = later(REQUEST_EVENTS_SINCE, addDays(today, -(REQUEST_EVENT_RETENTION_DAYS - 1)));
  const engagementFrom = later(ENGAGEMENT_EVENTS_SINCE, addDays(today, -(ENGAGEMENT_RETENTION_DAYS - 1)));
  const chatFrom = addDays(today, -(CHAT_RETENTION_DAYS - 1));
  const coverage = {
    requestsFrom: requestsFrom <= today ? requestsFrom : null,
    engagementFrom: engagementFrom <= today ? engagementFrom : null,
    chatFrom,
  };

  // ── Requests: distinct requester per UTC day; first in-window submission's source ──
  const requesterDays = new Set<string>();
  const firstByRequester = new Map<string, RequestEventFact>();
  for (const e of facts.requestEvents) {
    const day = dayOf(e.receivedAt);
    if (day < from || day > today) continue;
    requesterDays.add(`${day}|${e.requesterKey}`);
    const prior = firstByRequester.get(e.requesterKey);
    if (!prior || e.receivedAt < prior.receivedAt) firstByRequester.set(e.requesterKey, e);
  }
  const requestDays = perDay(days, coverage.requestsFrom, [...requesterDays].map((k) => k.slice(0, 10)));

  const sourceCounts = new Map<string, number>();
  let sourcesUnrecorded = 0;
  for (const e of firstByRequester.values()) {
    const label = sourceLabel(e.source);
    if (label === null) { sourcesUnrecorded++; continue; }
    sourceCounts.set(label, (sourceCounts.get(label) ?? 0) + 1);
  }
  const ranked = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const sources = ranked.slice(0, TOP_SOURCES).map(([label, count]) => ({ label, count }));
  const rest = ranked.slice(TOP_SOURCES).reduce((a, [, c]) => a + c, 0);
  if (rest > 0) sources.push({ label: "Other sources", count: rest });

  // ── Registrations ──────────────────────────────────────────────────────────
  const registrationDays = perDay(days, from, facts.funnel.users.map((u) => dayOf(u.createdAt)));

  // ── Waitlist (current state) ───────────────────────────────────────────────
  const waitlist = { pending: 0, invited: 0, invitedExpired: 0, redeemed: 0, declined: 0, revoked: 0 };
  for (const w of facts.waitlist) {
    if (w.status === "PENDING") waitlist.pending++;
    else if (w.status === "APPROVED") {
      if (w.inviteExpiresAt && w.inviteExpiresAt.getTime() < now.getTime()) waitlist.invitedExpired++;
      else waitlist.invited++;
    } else if (w.status === "REDEEMED") waitlist.redeemed++;
    // A revoked invitation is stored as DENIED with its invitedAt kept (growth.ts lifecycle).
    else if (w.status === "DENIED") { if (w.invitedAt) waitlist.revoked++; else waitlist.declined++; }
  }

  // ── Time of week (UTC) ─────────────────────────────────────────────────────
  const signIns = grid();
  let signInTotal = 0;
  for (const at of facts.logins) {
    const day = dayOf(at);
    if (day < from || day > today) continue;
    signIns[weekdayUTC(at)][at.getUTCHours()]++;
    signInTotal++;
  }
  const chatTurns = grid();
  const firstOfTurn = new Map<string, Date>();
  for (const t of facts.chatTurns) {
    const prior = firstOfTurn.get(t.key);
    if (!prior || t.at < prior) firstOfTurn.set(t.key, t.at);
  }
  let chatTotal = 0;
  for (const at of firstOfTurn.values()) {
    const day = dayOf(at);
    if (day < from || day > today) continue;
    chatTurns[weekdayUTC(at)][at.getUTCHours()]++;
    chatTotal++;
  }

  // ── Cohorts ────────────────────────────────────────────────────────────────
  const weeks = cohortWeeks(today);
  const members = new Map<string, string[]>(weeks.map((w) => [w, []]));
  for (const u of facts.funnel.users) {
    const w = isoMonday(dayOf(u.createdAt));
    members.get(w)?.push(u.id);
  }
  const engagement = activitySets(facts.activity).engagement;

  const retentionRows: CohortRow[] = weeks.map((weekStart) => {
    const ids = members.get(weekStart) ?? [];
    const cells: CohortCell[] = Array.from({ length: RETENTION_OFFSETS }, (_, k) => {
      const start = addDays(weekStart, 7 * k);
      const end = addDays(start, 6);
      if (end >= today) return { state: "immature" };
      if (coverage.engagementFrom === null || start < coverage.engagementFrom) return { state: "noData" };
      let num = 0;
      for (const id of ids) {
        const active = engagement.get(id);
        if (!active) continue;
        for (let d = 0; d < 7; d++) if (active.has(addDays(start, d))) { num++; break; }
      }
      return { state: "value", num, den: ids.length };
    });
    return { weekStart, size: ids.length, cells };
  });

  const onboarding = buildOnboardingCohorts(facts.funnel, today);

  const notes: string[] = [
    "UTC days and hours.",
    `Beta requests are recorded from ${REQUEST_EVENTS_SINCE} and kept ${REQUEST_EVENT_RETENTION_DAYS} days; earlier days read "no data".`,
    "Waitlist counts are the current state — a decision overwrites the request's status.",
    `Retention counts engagement (product events, chat and Brief), recorded from ${ENGAGEMENT_EVENTS_SINCE}; earlier weeks read "no data".`,
    "Onboarding is the strict funnel as of today; recent cohorts are still onboarding.",
    `AI chat turns are kept ${CHAT_RETENTION_DAYS} days.`,
  ];

  return {
    checkedAt: now.toISOString(),
    windowDays, from, to: today,
    coverage,
    requests: { perDay: requestDays, total: firstByRequester.size },
    registrations: { perDay: registrationDays, total: observedTotal(registrationDays) },
    waitlist,
    sources,
    sourcesUnrecorded,
    timeOfWeek: { signIns, signInTotal, chatTurns, chatTotal },
    retention: { offsets: RETENTION_OFFSETS, rows: retentionRows },
    onboarding,
    notes,
  };
}

/**
 * Per account: the index (in FUNNEL_STAGE_ORDER) of the furthest stage reached
 * THROUGH — the strict funnel, the one `stageReachedAt` + `furthestStage`.
 * Shared by the Growth cohorts and the Customer Success stage distribution.
 */
export function funnelThrough(funnel: CohortFunnelFacts): Map<string, number> {
  const first = (rows: readonly UserInstant[]) => {
    const m = new Map<string, Date>();
    for (const r of rows) { const p = m.get(r.userId); if (!p || r.at < p) m.set(r.userId, r.at); }
    return m;
  };
  const last = (rows: readonly UserInstant[]) => {
    const m = new Map<string, Date>();
    for (const r of rows) { const p = m.get(r.userId); if (!p || r.at > p) m.set(r.userId, r.at); }
    return m;
  };
  const fs = first(funnel.firstSessions);
  const fa = first(funnel.firstAiTurns);
  const fb = first(funnel.firstBriefViews);
  const le = last(funnel.lastEngagements);
  const fc = firstConnections(funnel);
  const through = new Map<string, number>();
  for (const u of funnel.users) {
    const reached = stageReachedAt(u, {
      firstSession: fs.get(u.id), firstConnection: fc.get(u.id), firstAiTurn: fa.get(u.id),
      firstBriefView: fb.get(u.id), lastEngagement: le.get(u.id),
    });
    through.set(u.id, FUNNEL_STAGE_ORDER.indexOf(furthestStage(reached)));
  }
  return through;
}

/** Registration-week cohorts × onboarding stage: got through the stage ÷ cohort size (as of today). */
export function buildOnboardingCohorts(funnel: CohortFunnelFacts, today: string): AcquisitionResponse["onboarding"] {
  const through = funnelThrough(funnel);
  const weeks = cohortWeeks(today);
  const members = new Map<string, string[]>(weeks.map((w) => [w, []]));
  for (const u of funnel.users) members.get(isoMonday(dayOf(u.createdAt)))?.push(u.id);
  const rows: CohortRow[] = weeks.map((weekStart) => {
    const ids = members.get(weekStart) ?? [];
    const cells: CohortCell[] = ONBOARDING_STAGES.map((stage) => {
      const idx = FUNNEL_STAGE_ORDER.indexOf(stage);
      const num = ids.filter((id) => (through.get(id) ?? 0) >= idx).length;
      return { state: "value", num, den: ids.length };
    });
    return { weekStart, size: ids.length, cells };
  });
  return { stages: ONBOARDING_STAGES.map((key) => ({ key, label: FUNNEL_STAGE_LABELS[key] })), rows };
}
