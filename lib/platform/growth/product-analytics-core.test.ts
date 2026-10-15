/**
 * lib/platform/growth/product-analytics-core.test.ts  (BETA A1–A8)
 *
 * The pure projection, pinned on a five-user fixture without a database:
 *
 *   1. ENGAGEMENT EXCLUSIONS — cron/operator/LOGIN/SESSION_ACTIVE_DAY rows,
 *      harness invocations and null-user invocations never count as engagement.
 *   2. PRESENT vs ENGAGED — distinct (user, day); a double row counts once;
 *      sign-ins are their own stat.
 *   3. RETENTION — D1 / D7-window / D7-strict per weekly first-visit cohort,
 *      "not yet measurable" (undefined) for a young cohort, null for an empty one.
 *   4. FUNNEL — strict, monotone, abandonment at the horizon.
 *   5. ADOPTION + FREQUENCY — adoption ÷ registered, frequency ÷ engaged MAU.
 *   6. COST — AI chat + brief RETURNED rows + current Plaid cycle, over engaged
 *      MAU; an unpriced model yields null and a note, never zero.
 *   7. PRIVACY — rows carrying email / name / address never reach the response.
 *   8. The reader and route by source: fm_system, allow-listed selects, the gate.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/growth/product-analytics-core.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { AuditAction } from "@/lib/audit-actions";
import {
  ABANDONMENT_HORIZON_DAYS, ENGAGEMENT_AI_SURFACES, ENGAGEMENT_AUDIT_ACTIONS, PRESENCE_ACTIONS, PRODUCT_ANALYTICS_LOOKBACK_DAYS,
  RETENTION_COHORT_WEEKS, addDays, analysisSince, buildProductAnalytics, engagementDays, furthestStage, isoMonday, lastNDays,
  stageReachedAt, type AuditEventFact, type AiInvocationFact, type ProductAnalyticsFacts,
} from "./product-analytics-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const close = (a: number | null | undefined, b: number) => typeof a === "number" && Math.abs(a - b) < 1e-9;
const T = (s: string) => new Date(s);
const NOW = T("2026-10-15T12:00:00Z");

const ev = (userId: string | null, action: string, at: string, day?: string): AuditEventFact => ({ userId, action, at: T(at), ...(day ? { day } : {}) });
const ai = (over: Partial<AiInvocationFact> & { userId: string | null; surface: string; occurredAt: string }): AiInvocationFact => ({
  provider: "OPENAI", model: "gpt-5-mini", promptTokens: 1000, cachedPromptTokens: 0, completionTokens: 200, reasoningTokens: 0,
  latencyMs: 500, toolCallCount: 0, environment: "production", correlationId: null, turnIndex: null, outcome: "RETURNED",
  ...over, occurredAt: T(over.occurredAt),
});

const user = (id: string, createdAt: string, verified: boolean, deactivatedAt: string | null = null) => ({
  id, createdAt: T(createdAt), emailVerifiedAt: verified ? T(createdAt) : null, acceptedTermsAt: T(createdAt), deactivatedAt: deactivatedAt ? T(deactivatedAt) : null,
  // forbidden material a careless reader might pass through
  ...({ email: `${id}@example.test`, name: `Person ${id.toUpperCase()}` } as object),
});

function fixture(): ProductAnalyticsFacts {
  return {
    users: [
      user("u_a", "2026-09-01T09:00:00Z", true),
      user("u_b", "2026-10-06T10:00:00Z", true),
      user("u_c", "2026-10-08T10:00:00Z", true),
      user("u_d", "2026-10-14T08:00:00Z", true),
      user("u_e", "2026-10-13T08:00:00Z", false, "2026-10-14T00:00:00Z"),
    ],
    firstSessions: [
      { userId: "u_a", at: T("2026-09-01T09:05:00Z") }, { userId: "u_b", at: T("2026-10-06T10:05:00Z") },
      { userId: "u_c", at: T("2026-10-08T10:05:00Z") }, { userId: "u_d", at: T("2026-10-14T08:05:00Z") },
    ],
    sessionStarts: [
      { userId: "u_a", at: T("2026-09-01T09:05:00Z") }, { userId: "u_a", at: T("2026-10-15T08:00:00Z") },
      { userId: "u_b", at: T("2026-10-06T10:05:00Z") }, { userId: "u_c", at: T("2026-10-08T10:05:00Z") },
      { userId: "u_d", at: T("2026-10-14T08:05:00Z") },
    ],
    logins: [
      { userId: "u_a", at: T("2026-09-01T09:05:00Z") }, { userId: "u_a", at: T("2026-10-15T08:00:00Z") },
      { userId: "u_b", at: T("2026-10-06T10:05:00Z") }, { userId: "u_c", at: T("2026-10-08T10:05:00Z") },
      { userId: "u_d", at: T("2026-10-14T08:05:00Z") },
    ],
    auditEvents: [
      // presence
      ev("u_a", AuditAction.SESSION_ACTIVE_DAY, "2026-09-02T09:10:00Z", "2026-09-02"),
      ev("u_a", AuditAction.SESSION_ACTIVE_DAY, "2026-09-05T09:10:00Z", "2026-09-05"),
      ev("u_a", AuditAction.SESSION_ACTIVE_DAY, "2026-10-15T08:02:00Z", "2026-10-15"),
      ev("u_b", AuditAction.SESSION_ACTIVE_DAY, "2026-10-07T10:00:00Z", "2026-10-07"),
      ev("u_b", AuditAction.SESSION_ACTIVE_DAY, "2026-10-13T10:00:00Z", "2026-10-13"),
      ev("u_c", AuditAction.SESSION_ACTIVE_DAY, "2026-10-08T10:06:00Z", "2026-10-08"),
      ev("u_c", AuditAction.SESSION_ACTIVE_DAY, "2026-10-08T10:06:00Z", "2026-10-08"),   // raced double row
      ev("u_d", AuditAction.SESSION_ACTIVE_DAY, "2026-10-14T08:07:00Z", "2026-10-14"),
      ev("u_d", AuditAction.SESSION_ACTIVE_DAY, "2026-10-15T07:00:00Z", "2026-10-15"),
      ev(null, AuditAction.SESSION_ACTIVE_DAY, "2026-10-15T07:00:00Z", "2026-10-15"),    // deleted account
      // engagement
      ev("u_a", AuditAction.SPACE_VIEWED, "2026-09-02T09:11:00Z", "2026-09-02"),
      ev("u_a", AuditAction.SPACE_VIEWED, "2026-09-05T09:11:00Z", "2026-09-05"),
      ev("u_a", AuditAction.SPACE_VIEWED, "2026-10-15T08:03:00Z", "2026-10-15"),
      ev("u_b", AuditAction.SPACE_VIEWED, "2026-10-07T10:01:00Z", "2026-10-07"),
      ev("u_b", AuditAction.SPACE_VIEWED, "2026-10-13T10:01:00Z", "2026-10-13"),
      ev("u_b", AuditAction.SPACE_VIEWED, "2026-10-13T10:01:00Z", "2026-10-13"),         // raced double row
      ev("u_a", AuditAction.BRIEF_VIEWED, "2026-09-05T09:12:00Z"),
      ev("u_a", AuditAction.BRIEF_VIEWED, "2026-10-10T09:12:00Z"),
      ev("u_d", AuditAction.TRANSACTIONS_VIEWED, "2026-10-14T08:08:00Z", "2026-10-14"),
      ev("u_a", AuditAction.ACCOUNT_ADD, "2026-09-03T09:00:00Z"),
      ev("u_b", AuditAction.MANUAL_ASSET_ADD, "2026-10-07T12:00:00Z"),
      // adoption only, never engagement
      ev("u_a", AuditAction.DATA_EXPORTED, "2026-10-12T09:00:00Z"),
      ev("u_c", AuditAction.DATA_EXPORTED, "2026-10-10T09:00:00Z"),
      // never engagement, even if a reader handed them over
      ev("u_c", AuditAction.OPERATOR_REFRESH_ALL, "2026-10-15T09:00:00Z"),
      ev("u_c", AuditAction.LOGIN, "2026-10-15T09:00:00Z"),
      ev("u_c", AuditAction.PLAID_ITEM_STATUS_CHANGED, "2026-10-15T09:00:00Z"),
    ],
    aiInvocations: [
      ai({ userId: "u_a", surface: "chat", occurredAt: "2026-09-02T10:00:00Z", correlationId: "c1", turnIndex: 0 }),
      ai({ userId: "u_a", surface: "chat", occurredAt: "2026-10-15T09:00:00Z", correlationId: "c2", turnIndex: 0 }),
      ai({ userId: "u_a", surface: "chat", occurredAt: "2026-10-15T09:00:05Z", correlationId: "c2", turnIndex: 0 }), // tool loop: same turn
      ai({ userId: "u_d", surface: "chat", occurredAt: "2026-10-15T10:00:00Z", correlationId: "c3", turnIndex: 0 }),
      ai({ userId: null, surface: "brief", occurredAt: "2026-10-15T05:00:00Z", promptTokens: 2000, completionTokens: 500 }),
      ai({ userId: "u_c", surface: "harness", occurredAt: "2026-10-15T06:00:00Z" }),
      ai({ userId: null, surface: "chat", occurredAt: "2026-10-15T06:30:00Z", outcome: "FAILED", promptTokens: 0, completionTokens: 0 }),
    ],
    firstAiTurns: [{ userId: "u_a", at: T("2026-09-02T10:00:00Z") }, { userId: "u_d", at: T("2026-10-15T10:00:00Z") }],
    firstBriefViews: [{ userId: "u_a", at: T("2026-09-05T09:12:00Z") }],
    lastEngagements: [
      { userId: "u_a", at: T("2026-10-15T09:00:05Z") }, { userId: "u_a", at: T("2026-10-15T08:03:00Z") },
      { userId: "u_b", at: T("2026-10-13T10:01:00Z") }, { userId: "u_d", at: T("2026-10-15T10:00:00Z") },
    ],
    plaidItems: [
      { id: "pi1", userId: "u_a", externalItemId: "item-real-1", createdAt: T("2026-09-03T09:00:00Z"), status: "ACTIVE", investmentsConsent: null, environment: "production",
        ...({ encryptedToken: "SECRET-TOKEN", institutionName: "Chase" } as object) },
      { id: "pi9", userId: "u_a", externalItemId: "demo_item_9", createdAt: T("2026-09-03T09:00:00Z"), status: "ACTIVE", investmentsConsent: null, environment: null },
    ],
    walletConnections: [{ userId: "u_c", createdAt: T("2026-10-08T11:00:00Z"), status: "REVOKED", ...({ walletAddress: "bc1qSECRET" } as object) }],
    manualAssets: [{ userId: "u_b", createdAt: T("2026-10-07T12:00:00Z") }],
    plaidTransitions: [],
  };
}

console.log("0. day arithmetic");
{
  check("isoMonday of a Thursday is that week's Monday", isoMonday("2026-10-15") === "2026-10-12");
  check("isoMonday of a Sunday is six days back", isoMonday("2026-10-18") === "2026-10-12");
  check("isoMonday of a Monday is itself", isoMonday("2026-10-12") === "2026-10-12");
  check("addDays crosses a month", addDays("2026-09-30", 1) === "2026-10-01" && addDays("2026-10-01", -1) === "2026-09-30");
  check("lastNDays ends today, inclusive", JSON.stringify(lastNDays("2026-10-15", 3)) === '["2026-10-13","2026-10-14","2026-10-15"]');
  check("the lookback covers the oldest cohort and its horizon", PRODUCT_ANALYTICS_LOOKBACK_DAYS >= RETENTION_COHORT_WEEKS * 7 + 7
    && analysisSince(NOW).toISOString() === `${addDays("2026-10-15", -(PRODUCT_ANALYTICS_LOOKBACK_DAYS - 1))}T00:00:00.000Z`);
}

console.log("1. the engagement predicate — exactly the frozen one");
{
  check("audit half: the four product events + the three connection adds, nothing else",
    [...ENGAGEMENT_AUDIT_ACTIONS].sort().join() === ["SPACE_VIEWED", "BRIEF_VIEWED", "TRANSACTIONS_VIEWED", "MANUAL_ASSET_VALUE_UPDATED", "ACCOUNT_ADD", "WALLET_ADD", "MANUAL_ASSET_ADD"].sort().join());
  check("SESSION_ACTIVE_DAY is presence, not engagement", PRESENCE_ACTIONS.includes(AuditAction.SESSION_ACTIVE_DAY) && !ENGAGEMENT_AUDIT_ACTIONS.includes(AuditAction.SESSION_ACTIVE_DAY));
  check("AI half: chat and brief only", [...ENGAGEMENT_AI_SURFACES].sort().join() === "brief,chat");
  const noise = engagementDays({
    auditEvents: [
      ev("u_x", AuditAction.SESSION_ACTIVE_DAY, "2026-10-15T01:00:00Z", "2026-10-15"), ev("u_x", AuditAction.LOGIN, "2026-10-15T01:00:00Z"),
      ev("u_x", AuditAction.OPERATOR_REFRESH_ALL, "2026-10-15T01:00:00Z"), ev("u_x", AuditAction.CONNECTION_RESYNC_TRIGGERED, "2026-10-15T01:00:00Z"),
      ev("u_x", AuditAction.PLAID_ITEM_STATUS_CHANGED, "2026-10-15T01:00:00Z"), ev("u_x", AuditAction.DATA_EXPORTED, "2026-10-15T01:00:00Z"),
      ev(null, AuditAction.SPACE_VIEWED, "2026-10-15T01:00:00Z", "2026-10-15"),
    ],
    aiInvocations: [
      ai({ userId: "u_x", surface: "harness", occurredAt: "2026-10-15T01:00:00Z" }),
      ai({ userId: null, surface: "chat", occurredAt: "2026-10-15T01:00:00Z" }),
      ai({ userId: "u_x", surface: null as unknown as string, occurredAt: "2026-10-15T01:00:00Z" }),
    ],
  });
  check("presence rows, LOGIN, operator actions, status transitions, exports, harness, null-user and surfaceless invocations: zero engaged users", noise.size === 0,
    JSON.stringify([...noise.keys()]));
  const failedAsk = engagementDays({ auditEvents: [], aiInvocations: [ai({ userId: "u_y", surface: "chat", occurredAt: "2026-10-15T01:00:00Z", outcome: "FAILED" })] });
  check("a failed chat turn is still the person asking (engagement), though it is never priced", failedAsk.get("u_y")?.has("2026-10-15") === true);
}

const out = buildProductAnalytics(fixture(), NOW);

console.log("2. registrations");
{
  const r = out.registrations;
  check("total / deactivated", r.total === 5 && r.deactivated === 1);
  check("last 7 d counts registrations on the 7 calendar days ending today", r.last7d === 2, String(r.last7d));
  check("last 30 d", r.last30d === 4, String(r.last30d));
  check("perDay is the 30-day grid, zero-filled, ending today",
    r.perDay.length === 30 && r.perDay[29].day === "2026-10-15" && r.perDay[29].count === 0 && r.perDay.find((d) => d.day === "2026-10-14")?.count === 1
    && r.perDay.find((d) => d.day === "2026-09-16")?.count === 0);
  check("windowDays and checkedAt", out.windowDays === 30 && out.checkedAt === NOW.toISOString());
}

console.log("3. present vs engaged, sign-ins beside them");
{
  const a = out.active;
  check("daily: present 2 (A, D), engaged 2 (A Space view + chat, D chat), sign-ins 1 (A)",
    a.daily.present === 2 && a.daily.engaged === 2 && a.daily.signIns === 1, JSON.stringify(a.daily));
  check("weekly: present 3, engaged 3, sign-ins 2", a.weekly.present === 3 && a.weekly.engaged === 3 && a.weekly.signIns === 2, JSON.stringify(a.weekly));
  check("monthly: present 4 (C is present, never engaged), engaged 3, sign-ins 4",
    a.monthly.present === 4 && a.monthly.engaged === 3 && a.monthly.signIns === 4, JSON.stringify(a.monthly));
  check("a raced double row counts once (C's day, B's Space view)",
    a.perDay.find((d) => d.day === "2026-10-08")?.present === 1 && a.perDay.find((d) => d.day === "2026-10-13")?.engaged === 1);
  check("perDay: 30 rows ending today; today present 2 engaged 2", a.perDay.length === 30 && a.perDay[29].day === "2026-10-15" && a.perDay[29].present === 2 && a.perDay[29].engaged === 2);
  check("a null-user presence row is not attributable", a.perDay[29].present === 2);
  check("the sign-in day alone makes a user present (B on 10-06 has no SESSION_ACTIVE_DAY row), never engaged",
    a.perDay.find((d) => d.day === "2026-10-06")?.present === 1 && a.perDay.find((d) => d.day === "2026-10-06")?.engaged === 0);
}

console.log("4. retention");
{
  const r = out.retention;
  check("returning ever: engaged on a day after first visit — A, B, D of 5", r.returningEver.count === 3 && close(r.returningEver.rate, 0.6));
  check("abandonment horizon is the frozen 7", r.abandonmentHorizonDays === ABANDONMENT_HORIZON_DAYS && r.abandonmentHorizonDays === 7);
  check(`${RETENTION_COHORT_WEEKS} weekly cohorts, Mondays, oldest first, newest is this week`,
    r.cohorts.length === RETENTION_COHORT_WEEKS && r.cohorts[0].weekStart === "2026-08-24" && r.cohorts[7].weekStart === "2026-10-12"
    && r.cohorts.every((c) => isoMonday(c.weekStart) === c.weekStart));
  const c0 = r.cohorts.find((c) => c.weekStart === "2026-08-24")!;
  check("an empty cohort: size 0, rates null (no denominator)", c0.cohortSize === 0 && c0.d1 === null && c0.d7Window === null && c0.d7Strict === null);
  const cA = r.cohorts.find((c) => c.weekStart === "2026-08-31")!;
  check("A's cohort: D1 yes (09-02), D7 window yes (09-05), D7 strict no (09-08)", cA.cohortSize === 1 && close(cA.d1, 1) && close(cA.d7Window, 1) && close(cA.d7Strict, 0), JSON.stringify(cA));
  const cBC = r.cohorts.find((c) => c.weekStart === "2026-10-05")!;
  check("B+C cohort: D1 = 1/2; D7 measured over B alone (C's day 7 is today, incomplete) = 1/1 both forms",
    cBC.cohortSize === 2 && close(cBC.d1, 0.5) && close(cBC.d7Window, 1) && close(cBC.d7Strict, 1), JSON.stringify(cBC));
  const cDE = r.cohorts.find((c) => c.weekStart === "2026-10-12")!;
  check("this week's cohort: D1 measured over E alone (D's day 1 is today) = 0/1; D7 not yet measurable (undefined, never 0)",
    cDE.cohortSize === 2 && close(cDE.d1, 0) && cDE.d7Window === undefined && cDE.d7Strict === undefined && !("d7Window" in cDE && cDE.d7Window === null), JSON.stringify(cDE));
}

console.log("5. the onboarding funnel — strict and monotone");
{
  const f = out.funnel;
  const by = Object.fromEntries(f.map((s) => [s.key, s]));
  check("seven stages in the frozen order", f.map((s) => s.key).join() === "registered,verified,firstSession,firstConnection,firstAiTurn,firstBriefViewed,returned");
  check("counts: 5 → 4 → 4 → 3 → 1 → 1 → 1", f.map((s) => s.count).join() === "5,4,4,3,1,1,1", f.map((s) => s.count).join());
  check("counts never rise along the funnel", f.every((s, i) => i === 0 || s.count <= f[i - 1].count));
  check("first stage has no rate; the rest are conversion from the previous stage",
    !("rate" in by.registered) && close(by.verified.rate, 0.8) && close(by.firstSession.rate, 1) && close(by.firstConnection.rate, 0.75) && close(by.firstAiTurn.rate, 1 / 3));
  check("abandoned: B and C connected over 7 days ago and never asked; D connected nothing but is within the horizon; E is unverified but young",
    by.firstConnection.abandoned === 2 && by.firstSession.abandoned === 0 && by.registered.abandoned === 0, JSON.stringify(f.map((s) => [s.key, s.abandoned])));
  check("the last stage carries no abandonment", !("abandoned" in by.returned));
  check("labels are the catalogue's", by.firstBriefViewed.label === "First Brief viewed" && by.firstAiTurn.label === "First AI turn");
  check("manual assets count as a first connection (B) and a revoked wallet still was one (C)", by.firstConnection.count === 3);
  const reached = stageReachedAt(fixture().users[1], { firstSession: T("2026-10-06T10:05:00Z"), firstConnection: T("2026-10-07T12:00:00Z"), lastEngagement: T("2026-10-13T10:01:00Z") });
  check("furthestStage is the last CONTIGUOUS stage: B returned but never asked, so the stage is firstConnection",
    furthestStage(reached) === "firstConnection" && reached.returned !== undefined);
  check("a user with nothing is at 'registered'", furthestStage(stageReachedAt(fixture().users[4], {})) === "registered");
}

console.log("6. feature adoption and frequency");
{
  const by = Object.fromEntries(out.features.map((s) => [s.key, s]));
  const weeks = 30 / 7;
  check("seven features in the frozen order", out.features.map((s) => s.key).join() === "aiChat,dailyBrief,personalSpaces,transactions,connections,manualAssets,exports");
  check("AI chat: adopters A and D; a tool loop is ONE turn ⇒ 2 uses; adoption ÷ registered = 0.4; frequency ÷ engaged MAU ÷ weeks",
    by.aiChat.adopters === 2 && close(by.aiChat.adoption, 0.4) && close(by.aiChat.frequencyPerEngagedUserPerWeek, 2 / 3 / weeks), JSON.stringify(by.aiChat));
  check("Daily Brief: A once in the window (09-05 is outside)", by.dailyBrief.adopters === 1 && close(by.dailyBrief.frequencyPerEngagedUserPerWeek, 1 / 3 / weeks));
  check("Spaces: adopters 2, uses 3 user-days (the double row counts once)", by.personalSpaces.adopters === 2 && close(by.personalSpaces.frequencyPerEngagedUserPerWeek, 3 / 3 / weeks));
  check("Transactions: D once", by.transactions.adopters === 1);
  check("Connections: holders are current state (A's Item, B's manual asset; C's REVOKED wallet is not), uses are adds in the window (B's manual add)",
    by.connections.adopters === 2 && close(by.connections.adoption, 0.4) && close(by.connections.frequencyPerEngagedUserPerWeek, 1 / 3 / weeks), JSON.stringify(by.connections));
  check("Manual assets: B", by.manualAssets.adopters === 1);
  check("Exports: A and C adopted, yet C is NOT engaged (exports are adoption only)", by.exports.adopters === 2 && out.active.monthly.engaged === 3);
  check("every feature names its basis", out.features.every((f) => f.basis.length > 10));
}

console.log("7. cost per engaged user");
{
  const c = out.cost;
  // gpt-5-mini: $0.25/M in, $2.00/M out. A: 2 × (1000·0.25 + 200·2)/1e6; D: one; brief: (2000·0.25 + 500·2)/1e6.
  const aiExpected = 2 * 650 / 1e6 + 650 / 1e6 + 1500 / 1e6;
  check("AI = chat + brief RETURNED rows in the window, priced per day (harness, the failed row and the 09-02 row excluded)", close(c.aiUsd, aiExpected), String(c.aiUsd));
  check("Plaid = the current cycle's Item-months × rate; the seeded demo Item is not billed", close(c.plaidUsd, 0.30), String(c.plaidUsd));
  check("denominator is engaged MAU (3) and the per-user figure divides the sum", c.engagedUsers === 3 && close(c.perEngagedUserUsd, (aiExpected + 0.30) / 3));
  check("tier ESTIMATED with notes naming both sides and the denominator", c.tier === "ESTIMATED" && c.notes.length >= 3 && c.notes.some((n) => /rate card/.test(n)) && c.notes.some((n) => /Item-month/.test(n)) && c.notes.some((n) => /engaged/.test(n)));

  const unpriced = fixture();
  unpriced.aiInvocations = [...unpriced.aiInvocations, ai({ userId: "u_a", surface: "chat", occurredAt: "2026-10-15T11:00:00Z", model: "gpt-unknown-99" })];
  const u = buildProductAnalytics(unpriced, NOW).cost;
  check("an unpriced model ⇒ aiUsd null, per-user null, a note that names the gap — never zero", u.aiUsd === null && u.perEngagedUserUsd === null && u.plaidUsd === 0.30 && u.notes.some((n) => /unavailable/.test(n) && /1 of 5/.test(n)), JSON.stringify(u.notes));

  const quiet = fixture();
  quiet.aiInvocations = []; quiet.plaidItems = [];
  const q = buildProductAnalytics(quiet, NOW).cost;
  check("nothing used ⇒ both sides are a real 0 (not null) and the per-user figure is 0", q.aiUsd === 0 && q.plaidUsd === 0 && q.perEngagedUserUsd === 0);
  const nobody = fixture();
  nobody.auditEvents = nobody.auditEvents.filter((e) => e.action === AuditAction.SESSION_ACTIVE_DAY); nobody.aiInvocations = [];
  const n = buildProductAnalytics(nobody, NOW).cost;
  check("no engaged user ⇒ no per-user figure (null), with the reason", n.engagedUsers === 0 && n.perEngagedUserUsd === null && n.notes.some((x) => /no engaged user/.test(x)));
}

console.log("8. privacy and the footnote");
{
  const json = JSON.stringify(out);
  check("no user id, email, name, token, institution or address reaches the response",
    !/u_[a-e]|@example|Person |SECRET|Chase|bc1q|item-real|demo_item/.test(json));
  check("exclusions name jobs/webhooks/operators, harness, prefetch, the presence basis and identity",
    out.exclusions.some((e) => /webhook/.test(e) && /operator/.test(e)) && out.exclusions.some((e) => /harness/.test(e))
    && out.exclusions.some((e) => /prefetch/.test(e)) && out.exclusions.some((e) => /SESSION_ACTIVE_DAY/.test(e)) && out.exclusions.some((e) => /Customer Success/.test(e)));
}

console.log("9. the reader and the route, by source");
{
  const strip = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const reader = strip("lib/platform/growth/product-analytics.ts");
  check("reader is server-only and reads through fm_system, never the migration principal",
    /import "server-only"/.test(reader) && /systemDb/.test(reader) && !/import \{[^}]*\bdb\b[^}]*\} from "@\/lib\/db"/.test(reader));
  check("reader selects no email, name, username, Space name, token, balance or prompt",
    !/\b(email|name|username|encryptedToken|credential|cursor|balance|amount|walletAddress|institutionName|content|prompt)\s*:\s*true/.test(reader));
  check("reader writes nothing", !/\.(create|update|updateMany|delete|deleteMany|upsert)\(/.test(reader));
  check("reader fetches exactly the analytics audit actions and the customer AI surfaces from the core's constants",
    /ANALYTICS_AUDIT_ACTIONS/.test(reader) && /ENGAGEMENT_AI_SURFACES/.test(reader) && /ENGAGEMENT_AUDIT_ACTIONS/.test(reader));
  check("reader includes MANUAL assets in first connection (syncStatus 'manual', not deleted)", /syncStatus:\s*"manual",\s*deletedAt:\s*null/.test(reader));
  check("reader excludes deleted-account rows at the source (userId not null) for the day-grain audit reads", /userId:\s*\{\s*not:\s*null\s*\}/.test(reader));
  const route = strip("app/api/platform/growth-revenue/product-analytics/route.ts");
  check("route: requirePlatformAccess(GROWTH_REVENUE, READ) first, error returned before any read",
    /requirePlatformAccess\(\s*"GROWTH_REVENUE",\s*"READ"\s*\)/.test(route) && route.indexOf("requirePlatformAccess(") < route.indexOf("getProductAnalytics(") && /if \(err\) return err/.test(route));
  check("route: no-store, no WRITE/CONTROL, no mutating verb, no db import",
    /"Cache-Control":\s*"no-store"/.test(route) && !/"WRITE"|"CONTROL"/.test(route) && !/export async function (POST|PUT|PATCH|DELETE)/.test(route) && !/@\/lib\/db/.test(route));
  check("route returns the frozen DTO by type", /satisfies ProductAnalyticsResponse/.test(route));
  const core = strip("lib/platform/growth/product-analytics-core.ts");
  check("core imports no database and no server-only module", !/@\/lib\/db/.test(core) && !/server-only/.test(core));
}

if (failures > 0) { console.error(`\nproduct-analytics-core.test: ${failures} failure(s).`); process.exit(1); }
console.log("\nproduct-analytics-core.test: all passed.");
