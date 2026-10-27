/**
 * components/brief/data-freshness.test.ts   (v2.7)
 *
 * The Daily Brief's "Financial data" disclosure speaks THE shared relative format
 * ("Updated 37 min ago", "Updated yesterday", "Updated Oct 24") over each source's
 * last SUCCESSFUL data receipt — never the Brief's generation time, never a failed
 * attempt, never "all updated together" when they were not.
 *
 *   npx tsx components/brief/data-freshness.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatRelativeTime, formatUpdatedAgo, formatUpdatedLabel } from "@/lib/format";
import { deriveSpaceDataHealth, type DataHealthAccountInput } from "@/lib/connections/space-data-health.core";
import { groupFreshnessText, sourceFreshnessText, undatedAccountsNote, updatedRange } from "./data-freshness-copy";

const NOW = Date.parse("2026-10-27T15:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000, HR = 3_600_000, DAY = 86_400_000;

test("the shared tiers: just now, N min ago, N hr ago, yesterday, absolute date", () => {
  assert.equal(formatUpdatedLabel(ago(20_000), NOW), "Updated just now");
  assert.equal(formatUpdatedLabel(ago(37 * MIN), NOW), "Updated 37 min ago");
  assert.equal(formatUpdatedLabel(ago(61 * MIN), NOW), "Updated 1 hr ago");
  assert.equal(formatUpdatedLabel(ago(3 * HR + 5 * MIN), NOW), "Updated 3 hr ago");
  assert.equal(formatUpdatedLabel(ago(30 * HR), NOW), "Updated yesterday");
  assert.equal(formatUpdatedLabel("2026-10-24T12:00:00.000Z", NOW, "UTC"), "Updated Oct 24");
  assert.equal(formatUpdatedLabel("2025-10-24T12:00:00.000Z", NOW, "UTC"), "Updated Oct 24, 2025");
});

test("under a day it IS the dashboard header's formatter (one convention)", () => {
  for (const ms of [0, 5 * MIN, 59 * MIN, 2 * HR, 23 * HR + 59 * MIN]) {
    assert.equal(formatUpdatedAgo(ago(ms), NOW), formatRelativeTime(ago(ms), NOW));
  }
});

test("missing or invalid timestamp ⇒ 'Update time unavailable'", () => {
  assert.equal(formatUpdatedLabel(null, NOW), "Update time unavailable");
  assert.equal(formatUpdatedLabel(undefined, NOW), "Update time unavailable");
  assert.equal(formatUpdatedLabel("not-a-date", NOW), "Update time unavailable");
});

test("clock skew: a timestamp slightly in the future reads 'just now', never negative", () => {
  assert.equal(formatUpdatedLabel(new Date(NOW + 30_000).toISOString(), NOW), "Updated just now");
});

test("elapsed tiers are timezone-independent; only the absolute date uses the viewer's calendar", () => {
  const ts = "2026-10-26T23:30:00.000Z";
  for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
    // 15.5 h before NOW in every zone, even where the local calendar day differs.
    assert.equal(formatUpdatedAgo(ts, NOW, tz), "15 hr ago", tz);
  }
  // An absolute date: the same instant is Oct 23 in Los Angeles and Oct 24 in Tokyo.
  const old = "2026-10-23T23:30:00.000Z";
  assert.equal(formatUpdatedAgo(old, NOW, "America/Los_Angeles"), "Oct 23");
  assert.equal(formatUpdatedAgo(old, NOW, "Asia/Tokyo"), "Oct 24");
});

test("UTC rollover: phrases age as the clock ticks past midnight with no new data", () => {
  const ts = "2026-10-26T22:00:00.000Z";
  assert.equal(formatUpdatedAgo(ts, Date.parse("2026-10-26T23:59:00.000Z")), "1 hr ago");
  assert.equal(formatUpdatedAgo(ts, Date.parse("2026-10-27T00:01:00.000Z")), "2 hr ago");
  assert.equal(formatUpdatedAgo(ts, Date.parse("2026-10-27T22:30:00.000Z")), "yesterday");
  assert.equal(formatUpdatedAgo(ts, Date.parse("2026-10-28T22:30:00.000Z"), "UTC"), "Oct 26");
});

// ── Through the real data-health derivation ──────────────────────────────────

const plaid = (over: Partial<NonNullable<DataHealthAccountInput["plaid"]>> = {}) => ({
  key: "item1", ownerUserId: "u1", institutionName: "Bank A", status: "ACTIVE",
  lastSyncedAt: new Date(NOW - 2 * HR), syncIncompleteAt: null, historyBuildStartedAt: null, ...over,
});
const acct = (name: string, lastUpdated: Date | null, p = plaid()): DataHealthAccountInput => ({
  detailVisible: true, accountName: name, lastUpdated, syncStatus: "synced", plaid: p, wallet: null,
});
const health = (rows: DataHealthAccountInput[]) => deriveSpaceDataHealth(rows, "u1", new Date(NOW));

test("mixed account freshness inside one institution: a range, never 'all updated together'", () => {
  const p = plaid({ lastSyncedAt: new Date(NOW - 2 * HR) });
  const h = health([acct("Checking", new Date(NOW - 2 * HR), p), acct("Savings", new Date(NOW - 30 * HR), p)]);
  const s = h.sources[0];
  assert.equal(s.state, "CURRENT");
  assert.equal(sourceFreshnessText(s, NOW), "Updated 2 hr ago – yesterday");
  assert.equal(groupFreshnessText(h.groups[0], NOW), "updated 2 hr ago – yesterday");
});

test("an account is never shown fresher than its connection's last successful sync", () => {
  const p = plaid({ lastSyncedAt: new Date(NOW - 5 * HR) });
  const h = health([acct("Checking", new Date(NOW - 10 * MIN), p), acct("Savings", new Date(NOW - 5 * HR), p)]);
  assert.equal(sourceFreshnessText(h.sources[0], NOW), "Updated 5 hr ago");
});

test("uniform freshness: a single phrase", () => {
  const p = plaid({ lastSyncedAt: new Date(NOW - 37 * MIN) });
  const h = health([acct("Checking", new Date(NOW - 37 * MIN), p), acct("Savings", new Date(NOW - 37 * MIN), p)]);
  assert.equal(sourceFreshnessText(h.sources[0], NOW), "Updated 37 min ago");
  assert.equal(h.sources[0].newestUpdatedAt, undefined);
});

test("missing timestamps: an undated account is counted, an undated group says unavailable", () => {
  const p = plaid({ lastSyncedAt: new Date(NOW - HR) });
  const h = health([acct("Checking", new Date(NOW - HR), p), acct("Card", null, p)]);
  assert.equal(undatedAccountsNote(h.sources[0]), "1 account has no recorded update time");
  assert.equal(groupFreshnessText({ kind: "MANUAL", sources: 1, attention: 0, oldestUpdatedAt: null }, NOW), "update time unavailable");
  assert.equal(updatedRange(null, null, NOW), null);
});

test("a failed sync attempt is never shown as an update: the last SUCCESSFUL date is named, as a problem", () => {
  // The connection errored after its last successful sync 3 days ago; the attempt has no clock here.
  const p = plaid({ status: "ERROR", lastSyncedAt: new Date(NOW - 3 * DAY) });
  const h = health([acct("Checking", new Date(NOW - 3 * DAY), p)]);
  const text = sourceFreshnessText(h.sources[0], NOW, "UTC");
  assert.equal(h.sources[0].state, "CONNECTION_ERROR");
  assert.match(text, /^Connection error · last updated Oct 24$/);
  assert.ok(!/Updated (just now|\d+ (min|hr) ago)/.test(text));
  assert.equal(groupFreshnessText(h.groups[0], NOW), "needs attention");
});

test("stale source: out of date names the last successful date, never a relative 'Updated'", () => {
  const p = plaid({ lastSyncedAt: new Date(NOW - 9 * DAY) });
  const h = health([acct("Checking", new Date(NOW - 9 * DAY), p)]);
  assert.equal(h.sources[0].state, "OUT_OF_DATE");
  assert.equal(sourceFreshnessText(h.sources[0], NOW, "UTC"), "Hasn’t updated since Oct 18");
});

test("the Brief page renders the shared copy with a ticking clock — no generation time, no request", () => {
  const src = readFileSync(join(process.cwd(), "components/brief/DailyBriefClient.tsx"), "utf8");
  assert.ok(src.includes("useNowTick()"));
  assert.ok(src.includes("groupFreshnessText") && src.includes("sourceFreshnessText"));
  assert.ok(!/relDay/.test(src), "the competing day-only convention is gone");
  const hook = readFileSync(join(process.cwd(), "components/brief/use-now-tick.ts"), "utf8");
  assert.ok(!/fetch\(|XMLHttpRequest/.test(hook), "the clock makes no request");
});
