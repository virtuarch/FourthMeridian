/**
 * lib/notifications/delivery/analytics.test.ts  (Comms Center Phase A-2a)
 *
 * GET /api/platform/customer-success/notifications/delivery (contract §4.11,
 * C1–C4) and the per-key `recent` series of GET /catalog/[key], through the
 * same handlers the routes call, with an injected gate and read source:
 *
 *   1. the dense DaySeries: 7/30/90 days, ascending, one per UTC day, with its
 *      own {window, from, to}; the six series keys always present;
 *   2. the two nulls: null before ledgerSince (not observed), 0 on an observed
 *      day with no sends, small counts (1–4) returned AS NUMBERS — `withheld`
 *      is never set on delivery counts (they count messages, not people);
 *   3. totals / suppressedByReason / byKey carry EVERY key, over the observed
 *      range only, and are null as a whole when ledgerSince is null;
 *   4. filters reach the source and are validated (400 on anything unknown);
 *   5. 503 UNAVAILABLE when the ledger read fails — never zeros or an empty list;
 *   6. gating: 401 / 403 / 429 before any read; the route file is wired to
 *      CUSTOMER_SUCCESS READ + the cs-comms-read bucket, GET only;
 *   7. no PII in any response;
 *   8. GET /catalog/[key] `recent` reads the ledger (and 503s with it).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/notifications/delivery/analytics.test.ts
 */

import { readFileSync } from "node:fs";
import { limitByUser } from "@/lib/rate-limit";
import { catalogDetail, runRead, CS_COMMS_READ_LIMIT, type ReadDeps } from "@/lib/notifications/catalog/http";
import {
  SERIES_KEYS,
  deliveryAnalytics,
  recentSeriesForKey,
  type DeliveryCountQuery,
  type DeliveryCountRow,
  type DeliveryReadSource,
} from "@/lib/notifications/delivery/analytics";
import { DELIVERY_STATUSES, SUPPRESSION_REASONS } from "@/lib/notifications/delivery/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
  }
}

const NOW = new Date("2026-10-31T12:00:00.000Z");
const ENV = { VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "production" };
const u = (q: string) => new URL(`https://app.example.invalid/api/platform/customer-success/notifications/delivery${q}`);
const seen: string[] = [];
async function call(r: Response | Promise<Response>): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const res = await r;
  const text = await res.text();
  seen.push(text);
  return { status: res.status, json: JSON.parse(text) as Record<string, unknown>, headers: res.headers };
}

/** An in-memory source that applies the query like the SQL does and records every query. */
function source(since: string | null, rows: DeliveryCountRow[], opts: { fail?: "since" | "counts" } = {}) {
  const queries: DeliveryCountQuery[] = [];
  const s: DeliveryReadSource = {
    async ledgerSince() { if (opts.fail === "since") throw new Error("relation \"CommsDelivery\" does not exist"); return since; },
    async counts(q) {
      queries.push(q);
      if (opts.fail === "counts") throw new Error("connection reset: user@example.invalid");
      return rows.filter((r) => r.day >= q.from && r.day <= q.to && (!q.channel || r.channel === q.channel) && (!q.status || r.status === q.status) && (!q.key || r.definitionKey === q.key));
    },
  };
  return { s, queries };
}
const cell = (day: string, definitionKey: string, status: string, count: number, channel = "EMAIL", reason: string | null = null): DeliveryCountRow =>
  ({ day, definitionKey, channel, status, reason, count });

type Series = { window: string; from: string; to: string; days: Array<{ day: string; count: number | null; withheld?: true }>; floor: boolean };

async function dense(): Promise<void> {
  console.log("1. dense, self-describing day series");
  for (const [w, n, from] of [["7d", 7, "2026-10-25"], ["30d", 30, "2026-10-02"], ["90d", 90, "2026-08-03"]] as const) {
    const { s } = source("2026-01-01", []);
    const r = await call(deliveryAnalytics(u(`?window=${w}`), NOW, s, ENV));
    const series = r.json.series as Record<string, Series>;
    const ok = SERIES_KEYS.every((k) => {
      const x = series[k];
      const days = x.days.map((d) => d.day);
      const ascending = days.every((d, i) => i === 0 || d > days[i - 1]);
      const consecutive = days.every((d, i) => i === 0 || Date.parse(d) - Date.parse(days[i - 1]) === 86_400_000);
      return x.window === w && x.days.length === n && x.from === from && x.to === "2026-10-31" && days[0] === from && ascending && consecutive && x.floor === false;
    });
    check(`${w}: all six series dense — ${n} UTC days ${from}..2026-10-31, ascending, gap-free, with {window, from, to}`, r.status === 200 && ok);
    check(`${w}: envelope from/to match the series`, r.json.window === w && r.json.from === from && r.json.to === "2026-10-31");
  }
  const { s } = source(null, []);
  const r = await call(deliveryAnalytics(u(""), NOW, s, ENV));
  check("default window is 7d", r.json.window === "7d" && (r.json.series as Record<string, Series>).accepted.days.length === 7);
  check("the six series keys, exactly: accepted, failed, dead, suppressed, captured, cancelled",
    Object.keys(r.json.series as object).sort().join() === "accepted,cancelled,captured,dead,failed,suppressed");
}

async function nulls(): Promise<void> {
  console.log("2. not observed (null) vs zero vs small counts; never withheld");
  {
    const { s, queries } = source(null, [cell("2026-10-30", "PASSWORD_CHANGED", "ACCEPTED", 3)]);
    const r = await call(deliveryAnalytics(u("?window=30d"), NOW, s, ENV));
    const series = r.json.series as Record<string, Series>;
    check("ledgerSince null → every day of every series is null (not observed), never 0",
      SERIES_KEYS.every((k) => series[k].days.every((d) => d.count === null)));
    check("ledgerSince null → totals, suppressedByReason and byKey are null AS A WHOLE",
      r.json.totals === null && r.json.suppressedByReason === null && r.json.byKey === null);
    check("…and no count query is even issued", queries.length === 0);
    check("coverage reports ledgerSince null", (r.json.coverage as { ledgerSince: unknown }).ledgerSince === null);
  }
  {
    const { s, queries } = source("2026-10-28", [
      cell("2026-10-20", "PASSWORD_CHANGED", "ACCEPTED", 50), // before ledgerSince: impossible in reality, must not count
      cell("2026-10-28", "PASSWORD_CHANGED", "ACCEPTED", 2),
      cell("2026-10-30", "PASSWORD_CHANGED", "ACCEPTED", 1),
      cell("2026-10-30", "SYNC_FAILED", "CAPTURED", 4),
    ]);
    const r = await call(deliveryAnalytics(u("?window=7d"), NOW, s, ENV));
    const acc = (r.json.series as Record<string, Series>).accepted.days;
    check("days before ledgerSince → null; the ledgerSince day and after → counts",
      acc.map((d) => d.count).join() === ",,,2,0,1,0", acc.map((d) => d.count));
    check("an observed day with no sends is 0, not null", acc[4].count === 0 && acc[6].count === 0);
    check("small counts (1–4) are returned as numbers; `withheld` is never set on delivery counts",
      acc[5].count === 1 && (r.json.series as Record<string, Series>).captured.days[5].count === 4
      && !seen[seen.length - 1].includes("withheld"));
    check("the source is asked for the OBSERVED range only (from = max(window start, ledgerSince))",
      queries.length === 1 && queries[0].from === "2026-10-28" && queries[0].to === "2026-10-31");
    check("totals count the observed range only (3 accepted, 4 captured)",
      (r.json.totals as Record<string, number>).ACCEPTED === 3 && (r.json.totals as Record<string, number>).CAPTURED === 4);
  }
}

async function totals(): Promise<void> {
  console.log("3. totals, reasons and byKey carry every key");
  const { s } = source("2026-09-01", [
    cell("2026-10-30", "PASSWORD_CHANGED", "ACCEPTED", 7),
    cell("2026-10-30", "PASSWORD_CHANGED", "FAILED", 1),
    cell("2026-10-29", "SYNC_FAILED", "SUPPRESSED", 2, "IN_APP", "PREFERENCE_OFF"),
    cell("2026-10-29", "SYNC_FAILED", "SUPPRESSED", 1, "EMAIL", "DEDUPE_OPEN"),
    cell("2026-10-29", "SYNC_FAILED", "DEAD", 1),
    cell("2026-10-29", "PLATFORM_ALERT", "CAPTURED", 5, "OPERATOR_EMAIL", "ENVIRONMENT_GUARD"),
  ]);
  const r = await call(deliveryAnalytics(u("?window=7d"), NOW, s, ENV));
  const t = r.json.totals as Record<string, number>;
  check("totals: EVERY DeliveryStatus key present (incl. QUEUED, SCHEDULED, CANCELLED, DELIVERED, BOUNCED, COMPLAINED), numbers",
    Object.keys(t).sort().join() === [...DELIVERY_STATUSES].sort().join() && Object.values(t).every((v) => typeof v === "number"), t);
  check("totals values", t.ACCEPTED === 7 && t.FAILED === 1 && t.SUPPRESSED === 3 && t.DEAD === 1 && t.CAPTURED === 5 && t.DELIVERED === 0 && t.CANCELLED === 0);
  const reasons = r.json.suppressedByReason as Record<string, number>;
  check("suppressedByReason: every SuppressionReason key; SUPPRESSED rows only (a CAPTURED guard reason is not a suppression)",
    Object.keys(reasons).sort().join() === [...SUPPRESSION_REASONS].sort().join() && reasons.PREFERENCE_OFF === 2 && reasons.DEDUPE_OPEN === 1 && reasons.ENVIRONMENT_GUARD === 0, reasons);
  const byKey = r.json.byKey as Array<{ key: string; counts: Record<string, number> }>;
  check("byKey: one entry per observed key, sorted, each with the FULL status vector",
    byKey.map((b) => b.key).join() === "PASSWORD_CHANGED,PLATFORM_ALERT,SYNC_FAILED"
    && byKey.every((b) => Object.keys(b.counts).length === DELIVERY_STATUSES.length)
    && byKey[2].counts.SUPPRESSED === 3 && byKey[2].counts.DEAD === 1, byKey);
  const series = r.json.series as Record<string, Series>;
  check("series.dead / suppressed / captured / failed pick their own status",
    series.dead.days[4].count === 1 && series.suppressed.days[4].count === 3 && series.captured.days[4].count === 5 && series.failed.days[5].count === 1);
  check("measured: delivered, opens and clicks are all false (never claimed)",
    JSON.stringify(r.json.measured) === JSON.stringify({ delivered: false, opens: false, clicks: false }));
  check("coverage + providerHealth link + floor/capped/checkedAt",
    JSON.stringify(r.json.coverage) === JSON.stringify({ ledgerSince: "2026-09-01", directSendsCovered: true, environment: "preview" })
    && (r.json.providerHealth as { href: string }).href === "/dashboard/platform/PLATFORM_OPS?workspace=platform-providers"
    && r.json.floor === false && r.json.capped === false && r.json.checkedAt === NOW.toISOString());
  check("Cache-Control: no-store", r.headers.get("Cache-Control") === "no-store");
}

async function filters(): Promise<void> {
  console.log("4. filters");
  const { s, queries } = source("2026-01-01", [cell("2026-10-30", "PASSWORD_CHANGED", "ACCEPTED", 2), cell("2026-10-30", "SYNC_FAILED", "ACCEPTED", 9, "IN_APP")]);
  const r = await call(deliveryAnalytics(u("?window=30d&channel=EMAIL&status=ACCEPTED&template=PASSWORD_CHANGED"), NOW, s, ENV));
  check("channel / status / template reach the source and the echo",
    queries[0].channel === "EMAIL" && queries[0].status === "ACCEPTED" && queries[0].key === "PASSWORD_CHANGED"
    && JSON.stringify(r.json.filters) === JSON.stringify({ channel: "EMAIL", status: "ACCEPTED", template: "PASSWORD_CHANGED" }));
  check("…and only matching cells count", (r.json.totals as Record<string, number>).ACCEPTED === 2);
  for (const [q, why] of [["?window=1y", "window"], ["?channel=SMS", "channel"], ["?status=OPENED", "status"], ["?template=NOT_A_KEY", "template"], ["?template=__proto__", "template"], ["?userId=u1", "unknown param"]] as const) {
    const bad = await call(deliveryAnalytics(u(q), NOW, s, ENV));
    check(`400 VALIDATION on a bad ${why} (${q})`, bad.status === 400 && bad.json.code === "VALIDATION");
  }
}

const allow: ReadDeps["guard"] = async () => [{ user: { id: "operator-1" } }, null];
const noLimit: ReadDeps["rateLimit"] = async () => null;

async function failure(): Promise<void> {
  console.log("5. 503 on a ledger read failure");
  for (const fail of ["since", "counts"] as const) {
    const { s } = source("2026-10-01", [], { fail });
    const r = await call(runRead({ guard: allow, rateLimit: noLimit, now: () => NOW }, (now) => deliveryAnalytics(u("?window=7d"), now, s, ENV)));
    check(`${fail} read throws → 503 { code: UNAVAILABLE } with a fixed message — no totals, no series, no zeros`,
      r.status === 503 && r.json.code === "UNAVAILABLE" && !("totals" in r.json) && !("series" in r.json) && !("byKey" in r.json)
      && !String(r.json.error).includes("CommsDelivery") && !String(r.json.error).includes("@"), r.json);
  }
}

async function gating(): Promise<void> {
  console.log("6. gating + rate limit");
  let reads = 0;
  const { s } = source("2026-10-01", []);
  const counted: DeliveryReadSource = { ledgerSince: async () => { reads++; return s.ledgerSince(); }, counts: s.counts };
  const deny = (status: number): ReadDeps["guard"] => async () => [null, new Response(JSON.stringify({ error: "no" }), { status })];
  const work = (now: Date) => deliveryAnalytics(u(""), now, counted, ENV);
  const r401 = await call(runRead({ guard: deny(401), rateLimit: noLimit }, work));
  const r403 = await call(runRead({ guard: deny(403), rateLimit: noLimit }, work));
  check("401 UNAUTHENTICATED / 403 FORBIDDEN before any ledger read",
    r401.status === 401 && r401.json.code === "UNAUTHENTICATED" && r403.status === 403 && r403.json.code === "FORBIDDEN" && reads === 0);
  // The real limiter, the real bucket: the 121st read in a minute is refused.
  process.env.RATE_LIMIT_ENABLED = "true"; // the in-memory backend outside production
  const bucket = (id: string) => limitByUser(id, "cs-comms-read-test", CS_COMMS_READ_LIMIT);
  let last: { status: number; json: Record<string, unknown>; headers: Headers } | null = null;
  for (let i = 0; i < CS_COMMS_READ_LIMIT.limit + 1; i++) last = await call(runRead({ guard: allow, rateLimit: bucket, now: () => NOW }, work));
  check(`the ${CS_COMMS_READ_LIMIT.limit + 1}st read in a minute → 429 RATE_LIMITED with Retry-After`,
    CS_COMMS_READ_LIMIT.limit === 120 && CS_COMMS_READ_LIMIT.windowSec === 60 && last!.status === 429 && last!.json.code === "RATE_LIMITED" && last!.headers.get("Retry-After") !== null);
  check("…and the limited read did no work", reads === CS_COMMS_READ_LIMIT.limit);
  const src = readFileSync("app/api/platform/customer-success/notifications/delivery/route.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("route: GET only, requirePlatformAccess(\"CUSTOMER_SUCCESS\", \"READ\") written in the route file, the cs-comms-read bucket, through runRead",
    /export async function GET\(/.test(src) && !/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(src)
    && /runRead\(\{ guard: \(\) => requirePlatformAccess\("CUSTOMER_SUCCESS", "READ"\), rateLimit: csCommsReadLimit \},/.test(src)
    && !/requireFreshPlatformAccess|"WRITE"|"CONTROL"/.test(src));
  const store = readFileSync("lib/notifications/delivery/read-store.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  check("read source: the system principal, and it never selects a recipient column",
    /import \{ systemDb \} from "@\/lib\/db"/.test(store) && !/recipientUserId|recipientHash|notificationId|providerMessageId/.test(store));
}

async function recent(): Promise<void> {
  console.log("8. GET /catalog/[key] recent from the ledger");
  const { s, queries } = source("2026-10-20", [cell("2026-10-30", "SYNC_FAILED", "ACCEPTED", 2, "IN_APP"), cell("2026-10-30", "SYNC_FAILED", "SUPPRESSED", 1, "EMAIL", "PREFERENCE_OFF")]);
  const r = await call(catalogDetail("SYNC_FAILED", NOW, (key, at) => recentSeriesForKey(s, key, at)));
  const days = (r.json.recent as Series).days;
  check("recent: dense 30 days; null before ledgerSince; every outcome of the key per day after",
    r.status === 200 && days.length === 30 && days[0].day === "2026-10-02" && days.findIndex((d) => d.count !== null) === 18
    && days.find((d) => d.day === "2026-10-30")?.count === 3 && days.find((d) => d.day === "2026-10-31")?.count === 0, days.slice(15));
  check("…queried for that key only", queries.every((q) => q.key === "SYNC_FAILED"));
  check("retention.deliveryDays is 90 (owner decision)", (r.json.retention as { deliveryDays: number }).deliveryDays === 90);
  const { s: broken } = source("2026-10-01", [], { fail: "counts" });
  const r503 = await call(runRead({ guard: allow, rateLimit: noLimit, now: () => NOW }, (now) => catalogDetail("SYNC_FAILED", now, (key, at) => recentSeriesForKey(broken, key, at))));
  check("a failed ledger read → 503 UNAVAILABLE, never a fabricated all-null series", r503.status === 503 && r503.json.code === "UNAVAILABLE");
  const routeSrc = readFileSync("app/api/platform/customer-success/notifications/catalog/[key]/route.ts", "utf8");
  check("the detail route passes the ledger reader", /recentSeriesForKey\(deliveryReadSource, key, at\)/.test(routeSrc));
}

async function pii(): Promise<void> {
  console.log("7. no PII in any response");
  const all = seen.join("\n");
  check("no address, userId field, recipient field, title, body or link in any response",
    !/@example|recipient|userId|"title"|"body"|https?:\/\/(?!app\.example)/.test(all.replace(/"\/dashboard[^"]*"/g, "")));
}

async function main(): Promise<void> {
  await dense();
  await nulls();
  await totals();
  await filters();
  await failure();
  await gating();
  await recent();
  await pii();
  if (failures > 0) { console.error(`\n${failures} delivery API check(s) failed`); process.exit(1); }
  console.log("\nAll delivery API checks passed.");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
