/**
 * lib/platform/growth/acquisition-core.test.ts  (Platform Spaces 2.0 — Growth)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/growth/acquisition-core.test.ts
 */

import { buildAcquisition, cohortWeeks, weekdayUTC, type AcquisitionFacts } from "./acquisition-core";
import { AuditAction } from "@/lib/audit-actions";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const NOW = new Date("2026-11-20T15:00:00.000Z"); // a Friday
const at = (iso: string) => new Date(iso);
const user = (id: string, created: string, extra: Partial<{ emailVerifiedAt: Date }> = {}) => ({
  id, createdAt: at(created), emailVerifiedAt: extra.emailVerifiedAt ?? null, acceptedTermsAt: null, deactivatedAt: null,
});

function facts(over: Partial<AcquisitionFacts> = {}): AcquisitionFacts {
  return {
    requestEvents: [],
    waitlist: [],
    logins: [],
    chatTurns: [],
    funnel: { users: [], firstSessions: [], firstAiTurns: [], firstBriefViews: [], lastEngagements: [], plaidItems: [], walletConnections: [], manualAssets: [] },
    activity: { auditEvents: [], sessionStarts: [], aiInvocations: [], logins: [] },
    ...over,
  };
}

console.log("1. window + coverage");
{
  const r = buildAcquisition(facts(), NOW, 90);
  check("90-day window ends today", r.to === "2026-11-20" && r.from === "2026-08-23" && r.requests.perDay.length === 90);
  check("requests before 2026-10-07 are null (no data), not zero",
    r.requests.perDay.find((d) => d.day === "2026-10-06")?.count === null && r.requests.perDay.find((d) => d.day === "2026-10-07")?.count === 0);
  check("registrations are observed across the whole window", r.registrations.perDay.every((d) => d.count === 0));
  check("coverage is declared", r.coverage.requestsFrom === "2026-10-07" && r.coverage.engagementFrom === "2026-10-15" && r.coverage.chatFrom === "2026-08-23");
  const r30 = buildAcquisition(facts(), NOW, 30);
  check("30-day window", r30.requests.perDay.length === 30 && r30.from === "2026-10-22");
}

console.log("2. requests — distinct requester per day; first in-window source");
{
  const r = buildAcquisition(facts({
    requestEvents: [
      { requesterKey: "a", receivedAt: at("2026-11-10T08:00:00Z"), source: { utmSource: "newsletter" } },
      { requesterKey: "a", receivedAt: at("2026-11-10T09:00:00Z"), source: { utmSource: "x" } },
      { requesterKey: "a", receivedAt: at("2026-11-12T09:00:00Z"), source: null },
      { requesterKey: "b", receivedAt: at("2026-11-10T10:00:00Z"), source: { referrerHost: "news.example" } },
      { requesterKey: "c", receivedAt: at("2026-11-11T10:00:00Z"), source: null },
      { requesterKey: "d", receivedAt: at("2026-11-11T11:00:00Z"), source: { utmSource: "newsletter" } },
    ],
  }), NOW, 30);
  const day = (d: string) => r.requests.perDay.find((x) => x.day === d)?.count;
  check("a same-day resubmission counts once", day("2026-11-10") === 2);
  check("a later-day resubmission counts on its day", day("2026-11-12") === 1);
  check("total sums the observed days", r.requests.total === 5);
  check("sources rank by requesters; first submission decides", JSON.stringify(r.sources) === JSON.stringify([{ label: "newsletter", count: 2 }, { label: "news.example", count: 1 }]), r.sources);
  check("a requester with no source is counted as unrecorded", r.sourcesUnrecorded === 1);
}

console.log("3. waitlist — current state, expired invitations split out");
{
  const r = buildAcquisition(facts({
    waitlist: [
      { status: "PENDING", inviteExpiresAt: null },
      { status: "APPROVED", inviteExpiresAt: at("2026-11-25T00:00:00Z") },
      { status: "APPROVED", inviteExpiresAt: at("2026-11-01T00:00:00Z") },
      { status: "REDEEMED", inviteExpiresAt: null },
      { status: "DENIED", inviteExpiresAt: null },
    ],
  }), NOW, 30);
  check("counts by status", JSON.stringify(r.waitlist) === JSON.stringify({ pending: 1, invited: 1, invitedExpired: 1, redeemed: 1, declined: 1 }), r.waitlist);
}

console.log("4. time of week — Monday = row 0, UTC hours, one cell per chat turn");
{
  check("weekdayUTC: Monday 0, Sunday 6", weekdayUTC(at("2026-11-16T00:00:00Z")) === 0 && weekdayUTC(at("2026-11-22T23:00:00Z")) === 6);
  const r = buildAcquisition(facts({
    logins: [at("2026-11-16T09:30:00Z"), at("2026-11-16T09:59:00Z"), at("2026-11-15T23:10:00Z"), at("2026-01-01T09:00:00Z")],
    chatTurns: [
      { key: "t1", at: at("2026-11-17T14:00:00Z") },
      { key: "t1", at: at("2026-11-17T14:00:02Z") },
      { key: "t2", at: at("2026-11-17T14:20:00Z") },
    ],
  }), NOW, 30);
  check("sign-ins land in their weekday × hour", r.timeOfWeek.signIns[0][9] === 2 && r.timeOfWeek.signIns[6][23] === 1);
  check("a sign-in outside the window is not counted", r.timeOfWeek.signInTotal === 3);
  check("several rows of one chat turn count once", r.timeOfWeek.chatTurns[1][14] === 2 && r.timeOfWeek.chatTotal === 2);
}

console.log("5. retention cohorts — value / immature / noData, with denominators");
{
  const weeks = cohortWeeks("2026-11-20");
  check("8 cohort weeks, oldest first, newest = this ISO week", weeks.length === 8 && weeks[7] === "2026-11-16" && weeks[0] === "2026-09-28");
  const r = buildAcquisition(facts({
    funnel: {
      users: [user("u1", "2026-10-20T10:00:00Z"), user("u2", "2026-10-21T10:00:00Z"), user("u3", "2026-11-17T10:00:00Z")],
      firstSessions: [], firstAiTurns: [], firstBriefViews: [], lastEngagements: [], plaidItems: [], walletConnections: [], manualAssets: [],
    },
    activity: {
      auditEvents: [
        { userId: "u1", action: AuditAction.SPACE_VIEWED, at: at("2026-10-28T10:00:00Z"), day: "2026-10-28" },
        { userId: "u1", action: AuditAction.SPACE_VIEWED, at: at("2026-10-29T10:00:00Z"), day: "2026-10-29" },
      ],
      sessionStarts: [], aiInvocations: [], logins: [],
    },
  }), NOW, 30);
  const row = r.retention.rows.find((x) => x.weekStart === "2026-10-19")!;
  check("cohort size is the registration week's accounts", row.size === 2);
  check("week 0 counts engagement in the registration week", JSON.stringify(row.cells[0]) === JSON.stringify({ state: "value", num: 0, den: 2 }), row.cells[0]);
  check("week 1 counts a member once however many days", JSON.stringify(row.cells[1]) === JSON.stringify({ state: "value", num: 1, den: 2 }), row.cells[1]);
  check("a week that has not finished is immature", row.cells[4].state === "immature" && row.cells[7].state === "immature");
  const old = r.retention.rows.find((x) => x.weekStart === "2026-09-28")!;
  check("a week before engagement facts began is noData", old.cells[0].state === "noData" && old.cells[2].state === "noData" && old.cells[3].state === "value", old.cells.slice(0, 4));
  const newest = r.retention.rows[7];
  check("this week's cohort is immature at week 0", newest.size === 1 && newest.cells[0].state === "immature");
}

console.log("6. onboarding by cohort — strict funnel, cohort size as denominator");
{
  const r = buildAcquisition(facts({
    funnel: {
      users: [
        user("u1", "2026-10-20T10:00:00Z", { emailVerifiedAt: at("2026-10-20T11:00:00Z") }),
        user("u2", "2026-10-21T10:00:00Z", { emailVerifiedAt: at("2026-10-21T11:00:00Z") }),
        user("u3", "2026-10-22T10:00:00Z"),
      ],
      firstSessions: [{ userId: "u1", at: at("2026-10-20T12:00:00Z") }, { userId: "u3", at: at("2026-10-22T12:00:00Z") }],
      firstAiTurns: [], firstBriefViews: [], lastEngagements: [],
      plaidItems: [], walletConnections: [{ userId: "u1", createdAt: at("2026-10-23T00:00:00Z"), status: "ACTIVE" }], manualAssets: [],
    },
  }), NOW, 30);
  const row = r.onboarding.rows.find((x) => x.weekStart === "2026-10-19")!;
  const nums = row.cells.map((c) => (c.state === "value" ? `${c.num}/${c.den}` : c.state));
  check("verified → first session → first connection, strict (u3 skipped verification)", JSON.stringify(nums) === JSON.stringify(["2/3", "1/3", "1/3", "0/3", "0/3"]), nums);
  check("stages are labelled from the one funnel vocabulary", r.onboarding.stages.map((s) => s.label).join(",") === "Verified,First session,First connection,First AI turn,First Brief viewed");
}

console.log("7. identity-free body");
{
  const r = buildAcquisition(facts({
    requestEvents: [{ requesterKey: "digest-abc", receivedAt: at("2026-11-10T08:00:00Z"), source: null }],
    funnel: { users: [user("user-secret-id", "2026-11-10T00:00:00Z")], firstSessions: [], firstAiTurns: [], firstBriefViews: [], lastEngagements: [], plaidItems: [], walletConnections: [], manualAssets: [] },
  }), NOW, 30);
  const json = JSON.stringify(r);
  check("no requester digest and no user id in the body", !json.includes("digest-abc") && !json.includes("user-secret-id"));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
