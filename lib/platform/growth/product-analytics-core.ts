/**
 * lib/platform/growth/product-analytics-core.ts  (BETA A1–A8 — THE PURE PROJECTION)
 *
 * Takes ALREADY-FETCHED row sets (lib/platform/growth/product-analytics.ts reads
 * them on fm_system) and returns the frozen `ProductAnalyticsResponse`
 * (product-analytics-types.ts, the W3→W4 contract). No I/O, no clock of its own
 * (`now` is an argument), no store. Every figure is a fold over ledgers that
 * already exist; nothing here is written back.
 *
 * THREE STRATA, NEVER MIXED (design §1):
 *   registration — a User row exists
 *   presence     — SESSION_ACTIVE_DAY (lib/auth/session-activity.ts) ∪ the UTC
 *                  day a session was CREATED (a visit shorter than one activity
 *                  granularity writes no day row of its own; the sign-in is still
 *                  an authenticated session touching the day)
 *   engagement   — THE FROZEN PREDICATE (coordination contract):
 *                    product event (SPACE_VIEWED · BRIEF_VIEWED ·
 *                    TRANSACTIONS_VIEWED · MANUAL_ASSET_VALUE_UPDATED)
 *                  ∪ AiInvocation surface chat|brief WITH a userId
 *                  ∪ ACCOUNT_ADD | WALLET_ADD | MANUAL_ASSET_ADD
 *                  Never cron / webhook / resume / operator executions, never
 *                  surface `harness`, never operator actions. SESSION_ACTIVE_DAY
 *                  is presence, NOT engagement — otherwise engaged ≡ present and
 *                  the pair says nothing.
 *
 * COUNTING RULE (contract rule 3): the writers dedupe per (user, action, day) but
 * hold no unique index, so every count here is over DISTINCT (user, UTC day) —
 * a double row can never double a figure.
 *
 * IDENTITY. The facts carry user ids because the folds join on them; the
 * response carries none — no id, name, email or Space name. The privacy scan
 * (lib/platform/observability-privacy.test.ts) pins the reader's selects and the
 * test here feeds rows with forbidden fields and asserts they never surface.
 *
 * TIME. UTC calendar days throughout (lib/time/clock's `toISODateUTC`). "The last
 * n days" is the n calendar days ending TODAY (today included, partial). A
 * retention horizon k is measurable for a user only when first-visit + k is a
 * COMPLETE day (≤ yesterday), so a young cohort reads "not yet measurable"
 * (`undefined`), never 0 %.
 */

import { AuditAction, type AuditActionType } from "@/lib/audit-actions";
import { toISODateUTC } from "@/lib/time/clock";
import { rollUp, type InvocationFact } from "@/lib/platform/ai/invocation-economics";
import { monthCycle, priceCycle, type PlaidItemFact, type PlaidItemTransition } from "@/lib/platform/plaid/item-months";
import type {
  ActiveUsers, CostPerEngagedUser, FeatureAdoption, FunnelStage, ProductAnalyticsResponse, RatedCount, RetentionCohort,
} from "./product-analytics-types";

// ── Constants ────────────────────────────────────────────────────────────────

export const PRODUCT_ANALYTICS_WINDOW_DAYS = 30 as const;
export const ABANDONMENT_HORIZON_DAYS = 7 as const;
/** Weekly first-visit cohorts reported: this many ISO weeks ending with the current one. */
export const RETENTION_COHORT_WEEKS = 8;
export const RETENTION_HORIZON_DAYS = 7;
/**
 * How far back the reader fetches day-grain facts: the oldest cohort's Monday
 * (7 weeks + 6 days ago at most) plus its retention horizon, with a week of
 * slack. Everything "ever" (first visit, first connection, last engagement)
 * arrives as per-user min/max rows instead and is not bounded by this.
 */
export const PRODUCT_ANALYTICS_LOOKBACK_DAYS = RETENTION_COHORT_WEEKS * 7 + RETENTION_HORIZON_DAYS + 7;

/** Presence: the one product event that says "a live session touched this day". */
export const PRESENCE_ACTIONS: readonly AuditActionType[] = [AuditAction.SESSION_ACTIVE_DAY];
/** The connection-lifecycle actions the engagement predicate admits. */
export const CONNECTION_ADD_ACTIONS: readonly AuditActionType[] = [
  AuditAction.ACCOUNT_ADD, AuditAction.WALLET_ADD, AuditAction.MANUAL_ASSET_ADD,
];
/** Engagement from the audit ledger — the frozen predicate's AuditLog half. */
export const ENGAGEMENT_AUDIT_ACTIONS: readonly AuditActionType[] = [
  AuditAction.SPACE_VIEWED, AuditAction.BRIEF_VIEWED, AuditAction.TRANSACTIONS_VIEWED, AuditAction.MANUAL_ASSET_VALUE_UPDATED,
  ...CONNECTION_ADD_ACTIONS,
];
/** Engagement from the AI ledger — customer surfaces only; `harness` never. */
export const ENGAGEMENT_AI_SURFACES: readonly string[] = ["chat", "brief"];
/** Adoption only (never engagement): the export action. */
export const EXPORT_ACTIONS: readonly AuditActionType[] = [AuditAction.DATA_EXPORTED];
/** Every audit action the reader fetches at day grain. */
export const ANALYTICS_AUDIT_ACTIONS: readonly AuditActionType[] = [
  ...PRESENCE_ACTIONS, ...ENGAGEMENT_AUDIT_ACTIONS, ...EXPORT_ACTIONS,
];

export const FUNNEL_STAGE_ORDER: readonly FunnelStage["key"][] = [
  "registered", "verified", "firstSession", "firstConnection", "firstAiTurn", "firstBriefViewed", "returned",
];
export const FUNNEL_STAGE_LABELS: Readonly<Record<FunnelStage["key"], string>> = {
  registered: "Registered", verified: "Verified", firstSession: "First session", firstConnection: "First connection",
  firstAiTurn: "First AI turn", firstBriefViewed: "First Brief viewed", returned: "Returned",
};

// ── Inputs (already fetched; ids are joins, never output) ────────────────────

export interface UserFact {
  id: string; createdAt: Date; emailVerifiedAt: Date | null; acceptedTermsAt: Date | null; deactivatedAt: Date | null;
}
export interface UserInstant { userId: string; at: Date }
/** One AuditLog row of an ANALYTICS_AUDIT_ACTIONS action; `day` is metadata.day when the row carries one. */
export interface AuditEventFact { userId: string | null; action: string; at: Date; day?: string | null }
/** One AiInvocation row of a customer surface, with its attribution. */
export interface AiInvocationFact extends InvocationFact { userId: string | null; outcome: string }
export interface ConnectionFact { userId: string | null; createdAt: Date; status: string }

export interface ProductAnalyticsFacts {
  users: readonly UserFact[];
  /** min(UserSession.createdAt) per user — the first visit. */
  firstSessions: readonly UserInstant[];
  /** UserSession.createdAt rows inside the lookback — the sign-in day joins presence. */
  sessionStarts: readonly UserInstant[];
  /** ANALYTICS_AUDIT_ACTIONS rows inside the lookback. */
  auditEvents: readonly AuditEventFact[];
  /** LOGIN rows inside the lookback (sign-ins; a credential fact, not activity). */
  logins: readonly UserInstant[];
  /** AiInvocation rows with surface ∈ ENGAGEMENT_AI_SURFACES inside the lookback. */
  aiInvocations: readonly AiInvocationFact[];
  /** min(occurredAt) per user over surface chat — ever. */
  firstAiTurns: readonly UserInstant[];
  /** min(createdAt) per user over BRIEF_VIEWED — ever. */
  firstBriefViews: readonly UserInstant[];
  /** max(engagement instant) per user — ever; several rows per user are folded by max. */
  lastEngagements: readonly UserInstant[];
  /** Every PlaidItem with its owner (owner is a join key; the census never sees it). */
  plaidItems: readonly (PlaidItemFact & { userId: string })[];
  /** Live-provider wallet Connections (provider ∉ PLAID/MANUAL/CSV). */
  walletConnections: readonly ConnectionFact[];
  /** Manual FinancialAccounts (syncStatus 'manual', not deleted). */
  manualAssets: readonly { userId: string | null; createdAt: Date }[];
  /** CH-2 PLAID_ITEM_STATUS_CHANGED transitions (decoded). */
  plaidTransitions: readonly PlaidItemTransition[];
}

// ── Day arithmetic (UTC) ─────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
export const dayOf = (d: Date | string): string => (typeof d === "string" ? d.slice(0, 10) : toISODateUTC(d));
export function addDays(day: string, n: number): string {
  return toISODateUTC(new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS));
}
/** ISO Monday of the week containing `day`. */
export function isoMonday(day: string): string {
  const dow = new Date(`${day}T00:00:00.000Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}
/** The n calendar days ending with `today` (inclusive). */
export function lastNDays(today: string, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(today, -i));
  return out;
}
/** The instant the reader's lookback starts: 00:00Z of the oldest day the day-grain facts must cover. */
export function analysisSince(now: Date): Date {
  return new Date(`${addDays(toISODateUTC(now), -(PRODUCT_ANALYTICS_LOOKBACK_DAYS - 1))}T00:00:00.000Z`);
}

// ── Day-grain fact sets ──────────────────────────────────────────────────────

/** `userId → Set<day>` — the DISTINCT (user, day) fold every count rests on. */
export type UserDays = Map<string, Set<string>>;

function add(map: UserDays, userId: string | null, day: string): void {
  if (!userId) return;                      // null user (deleted account) — not attributable
  const set = map.get(userId) ?? new Set<string>();
  set.add(day);
  map.set(userId, set);
}
const eventDay = (e: AuditEventFact): string => (typeof e.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.day) ? e.day : dayOf(e.at));

/** Presence days per user: SESSION_ACTIVE_DAY rows ∪ session-creation days. */
export function presenceDays(facts: Pick<ProductAnalyticsFacts, "auditEvents" | "sessionStarts">): UserDays {
  const out: UserDays = new Map();
  for (const e of facts.auditEvents) if (PRESENCE_ACTIONS.includes(e.action as AuditActionType)) add(out, e.userId, eventDay(e));
  for (const s of facts.sessionStarts) add(out, s.userId, dayOf(s.at));
  return out;
}

/** Engagement days per user — THE FROZEN PREDICATE, and nothing else. */
export function engagementDays(facts: Pick<ProductAnalyticsFacts, "auditEvents" | "aiInvocations">): UserDays {
  const out: UserDays = new Map();
  for (const e of facts.auditEvents) if (ENGAGEMENT_AUDIT_ACTIONS.includes(e.action as AuditActionType)) add(out, e.userId, eventDay(e));
  for (const i of facts.aiInvocations) {
    if (i.userId && i.surface && ENGAGEMENT_AI_SURFACES.includes(i.surface)) add(out, i.userId, dayOf(i.occurredAt));
  }
  return out;
}

function signInDays(logins: readonly UserInstant[]): UserDays {
  const out: UserDays = new Map();
  for (const l of logins) add(out, l.userId, dayOf(l.at));
  return out;
}

/** The day-grain facts a reader loads for presence / engagement / sign-ins. */
export type ActivityFactSet = Pick<ProductAnalyticsFacts, "auditEvents" | "sessionStarts" | "aiInvocations" | "logins">;
export interface ActivitySets { presence: UserDays; engagement: UserDays; signIns: UserDays }

/** The three (user → days) folds every active-user figure is counted from. Shared with lib/platform/activity. */
export function activitySets(facts: ActivityFactSet): ActivitySets {
  return { presence: presenceDays(facts), engagement: engagementDays(facts), signIns: signInDays(facts.logins) };
}

/** Distinct users with at least one day inside `days`. */
export function usersActiveOn(map: UserDays, days: ReadonlySet<string>): number {
  let n = 0;
  for (const set of map.values()) { for (const d of set) { if (days.has(d)) { n++; break; } } }
  return n;
}

/** Present / engaged / sign-ins over the last `n` days ending `today`. */
export function activeUsers(sets: ActivitySets, today: string, n: number): ActiveUsers {
  const days = new Set(lastNDays(today, n));
  return {
    present: usersActiveOn(sets.presence, days),
    engaged: usersActiveOn(sets.engagement, days),
    signIns: usersActiveOn(sets.signIns, days),
  };
}

// ── Per-user "ever" facts ────────────────────────────────────────────────────

function minBy(rows: readonly UserInstant[]): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const r of rows) { const cur = out.get(r.userId); if (!cur || r.at < cur) out.set(r.userId, r.at); }
  return out;
}
function maxBy(rows: readonly UserInstant[]): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const r of rows) { const cur = out.get(r.userId); if (!cur || r.at > cur) out.set(r.userId, r.at); }
  return out;
}

/** First visit = first session, falling back to registration (design §4). */
export function firstVisitDays(users: readonly UserFact[], firstSessions: readonly UserInstant[]): Map<string, string> {
  const first = minBy(firstSessions);
  const out = new Map<string, string>();
  for (const u of users) out.set(u.id, dayOf(first.get(u.id) ?? u.createdAt));
  return out;
}

/** Earliest connection per user across Plaid Items, wallet Connections and MANUAL assets (design §6: manual included). */
export function firstConnections(facts: Pick<ProductAnalyticsFacts, "plaidItems" | "walletConnections" | "manualAssets">): Map<string, Date> {
  const rows: UserInstant[] = [];
  for (const p of facts.plaidItems) rows.push({ userId: p.userId, at: typeof p.createdAt === "string" ? new Date(p.createdAt) : p.createdAt });
  for (const w of facts.walletConnections) if (w.userId) rows.push({ userId: w.userId, at: w.createdAt });
  for (const m of facts.manualAssets) if (m.userId) rows.push({ userId: m.userId, at: m.createdAt });
  return minBy(rows);
}

// ── Registrations ────────────────────────────────────────────────────────────

export function buildRegistrations(users: readonly UserFact[], today: string): ProductAnalyticsResponse["registrations"] {
  const days = lastNDays(today, PRODUCT_ANALYTICS_WINDOW_DAYS);
  const last7 = new Set(lastNDays(today, 7));
  const perDay = new Map<string, number>(days.map((d) => [d, 0]));
  let deactivated = 0, last7d = 0, last30d = 0;
  for (const u of users) {
    if (u.deactivatedAt) deactivated++;
    const d = dayOf(u.createdAt);
    if (perDay.has(d)) { perDay.set(d, (perDay.get(d) ?? 0) + 1); last30d++; }
    if (last7.has(d)) last7d++;
  }
  return { total: users.length, deactivated, last7d, last30d, perDay: days.map((day) => ({ day, count: perDay.get(day) ?? 0 })) };
}

// ── Retention ────────────────────────────────────────────────────────────────

const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

/**
 * Weekly first-visit cohorts × D1 / D7-window / D7-strict.
 *
 * A horizon k is MEASURABLE for a member when firstVisit + k ≤ yesterday (a
 * complete UTC day). The rate is engaged_k ÷ measurable_k over the measurable
 * members; a cohort with no measurable member for k reads `undefined` ("not yet
 * measurable"); an empty cohort reads `null` (no denominator).
 */
export function buildCohorts(
  firstVisit: ReadonlyMap<string, string>, engagement: UserDays, today: string,
): RetentionCohort[] {
  const yesterday = addDays(today, -1);
  const newest = isoMonday(today);
  const weeks: string[] = [];
  for (let w = RETENTION_COHORT_WEEKS - 1; w >= 0; w--) weeks.push(addDays(newest, -7 * w));

  return weeks.map((weekStart) => {
    const weekEnd = addDays(weekStart, 6);
    const members = [...firstVisit.entries()].filter(([, day]) => day >= weekStart && day <= weekEnd);
    if (members.length === 0) return { weekStart, cohortSize: 0, d1: null, d7Window: null, d7Strict: null };

    const rate = (hit: (userId: string, first: string) => boolean, k: number): number | null | undefined => {
      let measurable = 0, engaged = 0;
      for (const [userId, first] of members) {
        if (addDays(first, k) > yesterday) continue;
        measurable++;
        if (hit(userId, first)) engaged++;
      }
      return measurable === 0 ? undefined : engaged / measurable;
    };
    const on = (userId: string, day: string) => engagement.get(userId)?.has(day) ?? false;
    const d1 = rate((u, f) => on(u, addDays(f, 1)), 1);
    const d7Window = rate((u, f) => { for (let k = 1; k <= 7; k++) if (on(u, addDays(f, k))) return true; return false; }, 7);
    const d7Strict = rate((u, f) => on(u, addDays(f, 7)), 7);
    return { weekStart, cohortSize: members.length, d1, d7Window, d7Strict };
  });
}

/** Returning = engaged on any UTC day strictly after the first-visit day (ever). */
export function buildReturningEver(
  firstVisit: ReadonlyMap<string, string>, lastEngagements: readonly UserInstant[], total: number,
): RatedCount {
  const last = maxBy(lastEngagements);
  let count = 0;
  for (const [userId, first] of firstVisit) { const l = last.get(userId); if (l && dayOf(l) > first) count++; }
  return { count, rate: ratio(count, total) };
}

// ── Funnel ───────────────────────────────────────────────────────────────────

export interface FunnelInputs {
  users: readonly UserFact[];
  firstSessions: readonly UserInstant[];
  firstConnections: ReadonlyMap<string, Date>;
  firstAiTurns: readonly UserInstant[];
  firstBriefViews: readonly UserInstant[];
  lastEngagements: readonly UserInstant[];
}

/** Per user: the instant each stage was reached, or undefined. Pure; shared with the Customer Success roll-up. */
export function stageReachedAt(u: UserFact, inputs: {
  firstSession?: Date; firstConnection?: Date; firstAiTurn?: Date; firstBriefView?: Date; lastEngagement?: Date;
}): Partial<Record<FunnelStage["key"], Date>> {
  const firstVisitDay = dayOf(inputs.firstSession ?? u.createdAt);
  const out: Partial<Record<FunnelStage["key"], Date>> = { registered: u.createdAt };
  if (u.emailVerifiedAt) out.verified = u.emailVerifiedAt;
  if (inputs.firstSession) out.firstSession = inputs.firstSession;
  if (inputs.firstConnection) out.firstConnection = inputs.firstConnection;
  if (inputs.firstAiTurn) out.firstAiTurn = inputs.firstAiTurn;
  if (inputs.firstBriefView) out.firstBriefViewed = inputs.firstBriefView;
  if (inputs.lastEngagement && dayOf(inputs.lastEngagement) > firstVisitDay) out.returned = inputs.lastEngagement;
  return out;
}

/**
 * The furthest stage a user has reached THROUGH the funnel: the last stage such
 * that it and every stage before it were reached. A strict funnel, so a count
 * never rises along the sequence and a rate never exceeds 1 (the FunnelStages
 * renderer draws bars as a fraction of the first stage and assumes exactly
 * that). Shared with the Customer Success roll-up (`funnelStage`).
 */
export function furthestStage(reached: Partial<Record<FunnelStage["key"], Date>>): FunnelStage["key"] {
  let best: FunnelStage["key"] = "registered";
  for (const k of FUNNEL_STAGE_ORDER) { if (!reached[k]) break; best = k; }
  return best;
}

/**
 * The onboarding funnel (design §6), strict: a user is "at" stage i when they
 * reached stages 1…i. `count` is how many users got THROUGH stage i, `rate` is
 * count ÷ the previous stage's count (undefined on the first stage, null when
 * the previous stage is empty), and `abandoned` is the users who got through
 * stage i, not through stage i+1, and reached stage i more than
 * ABANDONMENT_HORIZON_DAYS ago — "signed in, nothing connected", "connected,
 * never asked", "never read a Brief", "did not return".
 */
export function buildFunnel(inputs: FunnelInputs, now: Date): FunnelStage[] {
  const firstSession = minBy(inputs.firstSessions);
  const firstAi = minBy(inputs.firstAiTurns);
  const firstBrief = minBy(inputs.firstBriefViews);
  const lastEng = maxBy(inputs.lastEngagements);
  const horizon = now.getTime() - ABANDONMENT_HORIZON_DAYS * DAY_MS;

  // Per user: the index of the furthest stage reached through, and when each stage was reached.
  const perUser = inputs.users.map((u) => {
    const reached = stageReachedAt(u, {
      firstSession: firstSession.get(u.id), firstConnection: inputs.firstConnections.get(u.id),
      firstAiTurn: firstAi.get(u.id), firstBriefView: firstBrief.get(u.id), lastEngagement: lastEng.get(u.id),
    });
    return { reached, through: FUNNEL_STAGE_ORDER.indexOf(furthestStage(reached)) };
  });

  return FUNNEL_STAGE_ORDER.map((key, i) => {
    const last = i === FUNNEL_STAGE_ORDER.length - 1;
    let count = 0, prevCount = 0, abandoned = 0;
    for (const { reached, through } of perUser) {
      if (through >= i - 1) prevCount++;
      if (through < i) continue;
      count++;
      const at = reached[key];
      if (!last && through === i && at && at.getTime() <= horizon) abandoned++;
    }
    return {
      key, label: FUNNEL_STAGE_LABELS[key], count,
      ...(i === 0 ? {} : { rate: ratio(count, prevCount) }),
      ...(last ? {} : { abandoned }),
    };
  });
}

// ── Feature adoption ─────────────────────────────────────────────────────────

const turnKey = (i: AiInvocationFact): string =>
  i.correlationId && i.turnIndex !== null ? `${i.correlationId}#${i.turnIndex}` : `${i.userId}|${dayOf(i.occurredAt)}|${new Date(i.occurredAt).toISOString()}`;

export function buildFeatures(facts: ProductAnalyticsFacts, today: string, engagedMonthly: number): FeatureAdoption[] {
  const window = new Set(lastNDays(today, PRODUCT_ANALYTICS_WINDOW_DAYS));
  const registered = facts.users.length;
  const weeks = PRODUCT_ANALYTICS_WINDOW_DAYS / 7;
  const inWindow = (e: AuditEventFact) => e.userId !== null && window.has(eventDay(e));

  // `grain` — the view events are deduped per (user, Space, day) by their writer
  // and counted here as DISTINCT (user, day) (contract rule 3: a raced double
  // row never doubles a figure); adds and value updates are per-occurrence facts.
  const audit = (actions: readonly AuditActionType[], grain: "userDay" | "occurrence") => {
    const rows = facts.auditEvents.filter((e) => actions.includes(e.action as AuditActionType) && inWindow(e));
    const uses = grain === "userDay" ? new Set(rows.map((e) => `${e.userId}|${eventDay(e)}`)).size : rows.length;
    return { adopters: new Set(rows.map((e) => e.userId as string)).size, uses };
  };
  const chat = facts.aiInvocations.filter((i) => i.userId && i.surface === "chat" && window.has(dayOf(i.occurredAt)));
  const connectionHolders = new Set<string>();
  for (const p of facts.plaidItems) if (p.status !== "REVOKED") connectionHolders.add(p.userId);
  for (const w of facts.walletConnections) if (w.userId && w.status !== "REVOKED") connectionHolders.add(w.userId);
  for (const m of facts.manualAssets) if (m.userId) connectionHolders.add(m.userId);

  const row = (key: FeatureAdoption["key"], label: string, adopters: number, uses: number, basis: string): FeatureAdoption => ({
    key, label, adopters,
    adoption: ratio(adopters, registered),
    frequencyPerEngagedUserPerWeek: engagedMonthly > 0 ? uses / engagedMonthly / weeks : null,
    basis,
  });
  const brief = audit([AuditAction.BRIEF_VIEWED], "userDay");
  const spaces = audit([AuditAction.SPACE_VIEWED], "userDay");
  const tx = audit([AuditAction.TRANSACTIONS_VIEWED], "userDay");
  const adds = audit(CONNECTION_ADD_ACTIONS, "occurrence");
  const manual = audit([AuditAction.MANUAL_ASSET_ADD, AuditAction.MANUAL_ASSET_VALUE_UPDATED], "occurrence");
  const exports = audit(EXPORT_ACTIONS, "occurrence");

  return [
    row("aiChat", "AI Chat", new Set(chat.map((i) => i.userId as string)).size, new Set(chat.map(turnKey)).size,
      "AiInvocation surface=chat with a userId; a use is one turn (correlationId#turnIndex)"),
    row("dailyBrief", "Daily Brief", brief.adopters, brief.uses, "AuditLog BRIEF_VIEWED; a use is one (user, day)"),
    row("personalSpaces", "Spaces", spaces.adopters, spaces.uses, "AuditLog SPACE_VIEWED; a use is one (user, day) with at least one Space viewed"),
    row("transactions", "Transactions", tx.adopters, tx.uses, "AuditLog TRANSACTIONS_VIEWED (first page); a use is one (user, day)"),
    row("connections", "Connections", connectionHolders.size, adds.uses,
      "adopters: users holding a non-REVOKED Plaid Item, a live wallet Connection or a manual asset (current state); uses: ACCOUNT_ADD + WALLET_ADD + MANUAL_ASSET_ADD in the window"),
    row("manualAssets", "Manual assets", manual.adopters, manual.uses, "AuditLog MANUAL_ASSET_ADD + MANUAL_ASSET_VALUE_UPDATED"),
    row("exports", "Exports", exports.adopters, exports.uses, "AuditLog DATA_EXPORTED"),
  ];
}

// ── Cost per engaged user (A8) ───────────────────────────────────────────────

export function buildCost(facts: ProductAnalyticsFacts, today: string, engagedUsers: number): CostPerEngagedUser {
  const window = new Set(lastNDays(today, PRODUCT_ANALYTICS_WINDOW_DAYS));
  const notes: string[] = [];

  // AI — customer surfaces, RETURNED rows (failures carry zero tokens), each priced on its own day's rate.
  const returned = facts.aiInvocations.filter((i) => i.outcome === "RETURNED" && i.surface && ENGAGEMENT_AI_SURFACES.includes(i.surface) && window.has(dayOf(i.occurredAt)));
  const ai = rollUp(returned);
  let aiUsd: number | null;
  if (ai.invocations === 0) { aiUsd = 0; notes.push("AI: no chat or brief invocation in the window."); }
  else if (ai.unpricedInvocations > 0 || ai.usd === null) {
    aiUsd = null;
    notes.push(`AI: unavailable — ${ai.unpricedInvocations} of ${ai.invocations} invocation(s) carry a model with no rate in force on their day; an unpriced call is never counted as zero.`);
  } else {
    aiUsd = ai.usd;
    notes.push(`AI: ${ai.invocations} chat + brief invocation(s) over ${PRODUCT_ANALYTICS_WINDOW_DAYS} days, priced on the code-owned rate card (estimate, not the provider invoice); harness traffic excluded.`);
  }

  // Plaid — the current calendar-month cycle, "present during cycle" reading, seeded fixtures excluded by the census.
  const cycle = monthCycle(today.slice(0, 7));
  const plaid = priceCycle(facts.plaidItems, facts.plaidTransitions, cycle, "presentDuringCycle", { today });
  const itemMonths = plaid.itemMonths.transactions + plaid.itemMonths.investments;
  let plaidUsd: number | null;
  if (itemMonths === 0) { plaidUsd = 0; notes.push("Plaid: no billable Item-month in the current cycle."); }
  else if (plaid.unpricedItemMonths > 0 || plaid.usd === null) {
    plaidUsd = null;
    notes.push(`Plaid: unavailable — ${plaid.unpricedItemMonths} of ${itemMonths} Item-month(s) have no rate evidenced for the cycle.`);
  } else {
    plaidUsd = plaid.usd;
    notes.push(`Plaid: ${itemMonths} Item-month(s) in the ${cycle.start}…${cycle.end} cycle under the "present during cycle" reading × PLAID_RATES (estimate).`);
  }

  const perEngagedUserUsd = aiUsd !== null && plaidUsd !== null && engagedUsers > 0 ? (aiUsd + plaidUsd) / engagedUsers : null;
  if (engagedUsers === 0) notes.push("Denominator: no engaged user in the window, so no per-user figure.");
  else notes.push(`Denominator: ${engagedUsers} engaged user(s) over ${PRODUCT_ANALYTICS_WINDOW_DAYS} days (engaged MAU — owner decision A8).`);

  return { aiUsd, plaidUsd, engagedUsers, perEngagedUserUsd, tier: "ESTIMATED", notes };
}

// ── The response ─────────────────────────────────────────────────────────────

export const PRODUCT_ANALYTICS_EXCLUSIONS: readonly string[] = [
  "Scheduled jobs, webhook deliveries, cron / resume / operator refresh executions and operator actions are never presence or engagement.",
  "AiInvocation rows with surface 'harness', or without a userId, are never engagement and never customer cost.",
  "Platform Spaces write no SPACE_VIEWED; router prefetches, Brief polls that return no Brief and cursor continuations are not views.",
  "Present = SESSION_ACTIVE_DAY rows ∪ the UTC day a session was created; engaged excludes presence by construction.",
  `Retention cohorts cover the last ${RETENTION_COHORT_WEEKS} first-visit weeks; a horizon is measured only over members whose day is complete, so a young cohort reads 'not yet measurable', never 0 %.`,
  "Rows whose user was deleted (AuditLog.userId set null) are not attributable and are not counted.",
  "No user id, name, email or Space name leaves this projection; per-user figures live in Customer Success.",
];

export function buildProductAnalytics(facts: ProductAnalyticsFacts, now: Date): ProductAnalyticsResponse {
  const today = toISODateUTC(now);
  const sets = activitySets(facts);
  const daily = activeUsers(sets, today, 1);
  const weekly = activeUsers(sets, today, 7);
  const monthly = activeUsers(sets, today, PRODUCT_ANALYTICS_WINDOW_DAYS);
  const perDay = lastNDays(today, PRODUCT_ANALYTICS_WINDOW_DAYS).map((day) => {
    const one = new Set([day]);
    return { day, present: usersActiveOn(sets.presence, one), engaged: usersActiveOn(sets.engagement, one) };
  });

  const firstVisit = firstVisitDays(facts.users, facts.firstSessions);

  return {
    checkedAt: now.toISOString(),
    windowDays: PRODUCT_ANALYTICS_WINDOW_DAYS,
    registrations: buildRegistrations(facts.users, today),
    active: { daily, weekly, monthly, perDay },
    retention: {
      returningEver: buildReturningEver(firstVisit, facts.lastEngagements, facts.users.length),
      cohorts: buildCohorts(firstVisit, sets.engagement, today),
      abandonmentHorizonDays: ABANDONMENT_HORIZON_DAYS,
    },
    funnel: buildFunnel({
      users: facts.users, firstSessions: facts.firstSessions, firstConnections: firstConnections(facts),
      firstAiTurns: facts.firstAiTurns, firstBriefViews: facts.firstBriefViews, lastEngagements: facts.lastEngagements,
    }, now),
    features: buildFeatures(facts, today, monthly.engaged),
    cost: buildCost(facts, today, monthly.engaged),
    exclusions: [...PRODUCT_ANALYTICS_EXCLUSIONS],
  };
}
