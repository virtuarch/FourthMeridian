/**
 * components/platform/platform-overview.test.ts  (Platform Operations 2.0 — R1, plan §4.1 + §2)
 *
 * Successor of platform-area-pulse.test.ts (git mv): the per-card pulse became
 * the Overview command center, so every pulse rule is restated for it —
 *   · one existing route per area, under the area's own grant, no cross-area route;
 *   · an honest first frame (status, no figure); MERCHANT_OPS stays a doorway;
 *   · a refusal/failure is "unavailable", never a zero; gaps stay gaps;
 * plus the R1 rules: probes mount only for granted areas, the verdict exists
 * only where an authority issues one, the merged attention queue, KPI tile
 * provenance, and the Platform AI page (guarded, no controls, not an area).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/platform-overview.test.ts
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlatformOverviewView, PROBED_AREAS, initialSignals } from "./overview/PlatformOverview";
import {
  TREND_DAYS,
  attentionQueue,
  overviewStatus,
  spaceTiles,
  sumObserved,
  trailingPoints,
  calendarPoints,
  type OverviewSignals,
} from "./overview/overview-model";
import { PlatformAiPlaceholder, PLATFORM_AI_COPY } from "./PlatformAiPlaceholder";
import { isPlatformAreaValue, platformAreaFromPath, PLATFORM_AI_HREF } from "@/lib/platform/nav";
import { isPlatformSpaceRoute } from "@/components/ui/ContextualNavbar";
import { ALL_PLATFORM_AREAS } from "@/lib/platform/policy";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const code = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const SRC = code("components/platform/overview/PlatformOverview.tsx");
const MODEL = code("components/platform/overview/overview-model.ts");

const SPACES = [
  { id: "s0", name: "ROW::PLATFORM_OPS", area: "PLATFORM_OPS" },
  { id: "s1", name: "ROW::SECURITY_OPS", area: "SECURITY_OPS" },
  { id: "s2", name: "ROW::GROWTH_REVENUE", area: "GROWTH_REVENUE" },
  { id: "s3", name: "ROW::CUSTOMER_SUCCESS", area: "CUSTOMER_SUCCESS" },
  { id: "s4", name: "ROW::MERCHANT_OPS", area: "MERCHANT_OPS" },
];
const NOW = new Date("2026-10-30T12:00:00.000Z");
const ok = <T,>(data: T) => ({ status: "ok" as const, data, fetchedAt: NOW.toISOString() });
const days = <T extends object>(n: number, f: (i: number) => T): (T & { day: string })[] =>
  Array.from({ length: n }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, "0")}`, ...f(i) }));

const FULL: OverviewSignals = {
  PLATFORM_OPS: {
    overview: ok({ checkedAt: NOW.toISOString(), worst: "FAILED" as const, domains: [{ key: "jobs", title: "Jobs", state: "FAILED" as const }, { key: "ai", title: "AI", state: "HEALTHY" as const }] }),
    attention: ok({ checkedAt: NOW.toISOString(), counts: { error: 1, info: 1 }, items: [
      { id: "a2", severity: "error" as const, entity: { label: "Nightly job" }, problem: "failed twice", since: "2026-10-30T11:00:00.000Z", evidence: { workspace: "platform-jobs" } },
      { id: "a1", severity: "info" as const, entity: { label: "FX rates" }, problem: "stale", since: "2026-10-30T10:00:00.000Z", evidence: { workspace: "platform-providers" } },
    ] }),
    refreshDaily: ok({ envelope: { checkedAt: NOW.toISOString() }, days: days(20, (i) => ({ byStatus: { FAILED: i % 3 } })) }),
    aiTrend: ok({ checkedAt: NOW.toISOString(), pricingConfigured: true, unpricedDays: ["2026-10-19"], days: days(30, (i) => ({ calls: 10, estimatedSpendUsd: i === 18 ? null : 0.5 })) }),
  },
  CUSTOMER_SUCCESS: {
    syncIssues: ok({ activeTotal: 7, truncated: true, severityCounts: { critical: 1 }, items: [
      { id: "c1", title: "Chase", operationLabel: "Balance refresh", description: "Item login required", severity: "critical" as const, lastOccurredAt: "2026-10-30T09:00:00.000Z" },
    ] }),
    incidentsDaily: ok({ checkedAt: NOW.toISOString(), floor: false, days: days(14, () => ({ opened: 1, resolved: 0 })) }),
  },
  GROWTH_REVENUE: { analytics: ok({ checkedAt: NOW.toISOString(), registrations: { last7d: 4, last30d: 9, perDay: days(30, () => ({ count: 1 })) } }) },
  SECURITY_OPS: {
    anomalies: ok({ summary: { failedLoginsWindow: 3, windowMinutes: 15, tripsLast24h: 1 }, trips: [
      { id: "t1", type: "failed_login_identifier", count: 12, windowMinutes: 15, at: "2026-10-30T08:00:00.000Z" },
      { id: "t0", type: "failed_login_identifier", count: 12, windowMinutes: 15, at: "2026-10-27T08:00:00.000Z" },
    ] }),
    daily: ok({ checkedAt: NOW.toISOString(), floor: true, days: days(14, () => ({ failedSignIns: 2 })) }),
  },
};

console.log("pure series helpers (pulse rules, restated)");
{
  const d = days(20, (i) => ({ n: i }));
  const pts = trailingPoints(d, (x) => x.n as number, "bad");
  check(`trend = the trailing ${TREND_DAYS} UTC days, ascending, value + tone carried`,
    pts.length === TREND_DAYS && pts[0].key === "2026-10-07" && pts[TREND_DAYS - 1].key === "2026-10-20" && pts.every((p) => p.tone === "bad") && pts[0].value === 6);
  check("a short series stays short; no series ⇒ no points", trailingPoints(d.slice(0, 3), () => 1).length === 3 && trailingPoints(undefined, () => 0).length === 0);
  check("a null value stays a GAP, never zero", trailingPoints([{ day: "2026-10-01" }], () => null)[0].value === null);
  check("a sum over gaps only is null (unobserved), not zero", sumObserved([{ key: "a", value: null }]) === null && sumObserved([{ key: "a", value: 2 }, { key: "b", value: null }]) === 2);
}

console.log("one existing route per area, under the area's own grant; no cross-area route");
{
  const urls = [...SRC.matchAll(/useWidgetFetch<[\s\S]*?>\("([^"]+)"\)/g)].map((m) => m[1]);
  const expected: Record<string, string> = {
    "/api/platform/platform-ops/overview": "platform-ops",
    "/api/platform/platform-ops/attention": "platform-ops",
    "/api/platform/platform-ops/refresh/daily": "platform-ops",
    "/api/platform/platform-ops/ai-usage-trend": "platform-ops",
    "/api/platform/customer-success/sync-issues": "customer-success",
    "/api/platform/customer-success/incidents-daily": "customer-success",
    "/api/platform/growth-revenue/product-analytics": "growth-revenue",
    "/api/platform/security-ops/anomalies": "security-ops",
    "/api/platform/security-ops/daily": "security-ops",
  };
  check("exactly nine static reads, each a declared existing route, none twice",
    urls.length === 9 && (SRC.match(/useWidgetFetch</g) ?? []).length === 9 && urls.every((u) => u in expected) && new Set(urls).size === 9, urls.join(","));
  const probes: Record<string, string> = { OpsProbe: "platform-ops", CustomersProbe: "customer-success", SignupsProbe: "growth-revenue", SecurityProbe: "security-ops" };
  for (const [fn, area] of Object.entries(probes)) {
    const start = SRC.indexOf(`function ${fn}(`);
    const end = SRC.indexOf("\nfunction ", start + 1);
    const reads = [...SRC.slice(start, end > 0 ? end : undefined).matchAll(/useWidgetFetch<[\s\S]*?>\("([^"]+)"\)/g)].map((m) => m[1]);
    check(`${fn} reads only /api/platform/${area}/*`, reads.length > 0 && reads.every((u) => u.startsWith(`/api/platform/${area}/`)), reads.join(","));
  }
  check("each declared route exists", Object.keys(expected).every((u) => existsSync(path.join(ROOT, "app", u, "route.ts"))));
  check("no CROSS-area route was introduced", !existsSync(path.join(ROOT, "app/api/platform/overview")) && !existsSync(path.join(ROOT, "app/api/platform/pulse")) && !existsSync(path.join(ROOT, "app/api/platform/attention")));
  check("no other fetch in the Overview (only the probes' useWidgetFetch)", !/\bfetch\(/.test(SRC) && !/\bfetch\(/.test(MODEL));
  check("probed areas are the four with summary routes", PROBED_AREAS.join(",") === "PLATFORM_OPS,CUSTOMER_SUCCESS,GROWTH_REVENUE,SECURITY_OPS");
  check("a probe MOUNTS only for a granted area (an ungranted area is never asked — no refusal provoked)",
    ["PLATFORM_OPS:OpsProbe", "CUSTOMER_SUCCESS:CustomersProbe", "GROWTH_REVENUE:SignupsProbe", "SECURITY_OPS:SecurityProbe"]
      .every((p) => { const [a, c] = p.split(":"); return new RegExp(`\\{has\\("${a}"\\) && <${c} report=\\{report\\} \\/>\\}`).test(SRC); }));
  check("the granted set is the server-loaded rows prop, nothing else", /const has = \(a: string\) => spaces\.some\(\(s\) => s\.area === a\);/.test(SRC));
}

console.log("honest first frame");
{
  for (const space of SPACES) {
    const one = [space];
    const html = renderToStaticMarkup(createElement(PlatformOverviewView, { spaces: one, signals: initialSignals(one) }));
    const body = text(html).replace("1 Platform Space", "").replace(/· 7 d|· 14 d/g, "");
    check(`${space.area}: no figure before an answer`, !/\d/.test(body), body);
  }
  check("initial signals cover exactly the granted probed areas (MERCHANT_OPS has none)",
    Object.keys(initialSignals(SPACES)).sort().join() === [...PROBED_AREAS].sort().join() && Object.keys(initialSignals([SPACES[4]])).length === 0);
  const merchant = renderToStaticMarkup(createElement(PlatformOverviewView, { spaces: [SPACES[4]], signals: {} }));
  check("MERCHANT_OPS stays a doorway with an honest line (no figure)", text(merchant).includes("No summary metrics for this Space yet") && merchant.includes('href="/dashboard/platform/MERCHANT_OPS"'));
  check("loading is 'Checking'/'reading…', never a verdict", overviewStatus(initialSignals(SPACES)).verdict.word === "Checking");
}

console.log("status header: a verdict only where an authority issues one");
{
  const s = overviewStatus(FULL);
  check("PLATFORM_OPS granted ⇒ the overview's worst state, word + tone", s.verdict.word === "Failed" && s.verdict.tone === "bad" && s.authoritative && s.checkedAt === NOW.toISOString());
  check("facts: domains not healthy, then per-area facts", s.facts[0].label === "Domains not healthy" && s.facts[0].value === "1 of 2" && s.facts.some((f) => f.label === "Open incidents" && f.value === "≥7"));
  const noOps: OverviewSignals = { ...FULL, PLATFORM_OPS: undefined };
  const n = overviewStatus(noOps);
  check("without PLATFORM_OPS ⇒ 'Unknown', muted, NOT authoritative — facts only", n.verdict.word === "Unknown" && n.verdict.tone === "muted" && !n.authoritative && n.facts.length > 0);
  const err = overviewStatus({ PLATFORM_OPS: { ...FULL.PLATFORM_OPS!, overview: { status: "error", error: "Not authorized" } } });
  check("a failed overview read ⇒ 'Unknown' with the reason, never 'Healthy'", err.verdict.word === "Unknown" && err.title.includes("Not authorized"));
  check("the verdict words are the overview authority's STATE words only (no score)", !/\bscore\b/i.test(MODEL) && /HEALTHY: "Healthy"/.test(MODEL));
}

console.log("attention queue: merged, prioritised, each item from its own area");
{
  const q = attentionQueue(FULL, SPACES, NOW);
  check("merged by severity across areas", q.items.map((i) => i.key).join() === "cs:c1,ops:a2,sec:t1,ops:a1", q.items.map((i) => i.key).join());
  // Each area's own order is its authority's (incidents: sortIncidentsForOperator) —
  // the merge never re-sorts within a list (incidents/preview-core.test.ts pins one sorter).
  const unordered = attentionQueue({ CUSTOMER_SUCCESS: { ...FULL.CUSTOMER_SUCCESS!, syncIssues: ok({ activeTotal: 2, truncated: false, severityCounts: {}, items: [
    { id: "x", title: "X", operationLabel: null, description: "d", severity: "warning" as const, lastOccurredAt: "2026-10-30T11:00:00.000Z" },
    { id: "y", title: "Y", operationLabel: null, description: "d", severity: "warning" as const, lastOccurredAt: "2026-10-30T11:30:00.000Z" },
  ] }) } }, SPACES, NOW);
  check("within an area, the authority's order is kept (no second ordering authority)", unordered.items.map((i) => i.key).join() === "cs:x,cs:y");
  check("the model contains no .sort( at all", !/\.sort\(/.test(MODEL));
  check("a security trip older than 24 h is not 'needs attention'", !q.items.some((i) => i.key === "sec:t0"));
  check("each item links into ITS OWN area", q.items.every((i) => i.href.startsWith(`/dashboard/platform/${i.area}`)));
  check("ops items deep-link the authority's workspace (aliases resolve on the page)", q.items.find((i) => i.key === "ops:a2")!.href === "/dashboard/platform/PLATFORM_OPS?workspace=platform-jobs");
  check("words + tones: Critical/bad, Error/bad, Warning/warn, Info/muted",
    q.items.map((i) => `${i.severityWord}/${i.tone}`).join() === "Critical/bad,Error/bad,Warning/warn,Info/muted");
  check("meta names the Space + a relative age from the answer instant", q.items[0].meta === "ROW::CUSTOMER_SUCCESS · 3 h ago", q.items[0].meta);
  check("'View all' per area with its total (a floor is worded ≥)", q.totals.map((t) => `${t.area}:${t.count}`).join() === "PLATFORM_OPS:2,CUSTOMER_SUCCESS:≥7,SECURITY_OPS:1");
  check("at most five", attentionQueue({ ...FULL, PLATFORM_OPS: { ...FULL.PLATFORM_OPS!, attention: ok({ checkedAt: "", counts: { info: 9 }, items: Array.from({ length: 9 }, (_, i) => ({ id: `x${i}`, severity: "info" as const, entity: { label: "x" }, problem: "p", since: null, evidence: { workspace: "platform-overview" } })) }) } }, SPACES, NOW).items.length === 5);
  const failed = attentionQueue({ CUSTOMER_SUCCESS: { ...FULL.CUSTOMER_SUCCESS!, syncIssues: { status: "error", error: "Not authorized" } } }, SPACES, NOW);
  check("a failed source is a NOTE, and the queue never claims 'all clear'", failed.notes.length === 1 && failed.notes[0].includes("unavailable") && !failed.allClear);
  const loading = attentionQueue(initialSignals(SPACES), SPACES, NOW);
  check("loading sources ⇒ loading, not all clear", loading.loading && !loading.allClear && loading.items.length === 0);
  const clear = attentionQueue({ SECURITY_OPS: { ...FULL.SECURITY_OPS!, anomalies: ok({ summary: { failedLoginsWindow: 0, windowMinutes: 15, tripsLast24h: 0 }, trips: [] }) } }, SPACES, NOW);
  check("all clear ONLY when every source answered with nothing", clear.allClear && clear.items.length === 0);
}

console.log("KPI tiles: persisted series, provenance, honest gaps");
{
  const t = spaceTiles(FULL, SPACES);
  const ops = t.find((s) => s.area === "PLATFORM_OPS")!.tiles;
  check("Platform Ops: refresh failures · AI calls · AI spend", ops.map((x) => x.key).join() === "ops-refresh-failures,ops-ai-calls,ops-ai-spend");
  check(`series are the trailing ${TREND_DAYS} days`, ops.every((x) => x.points.length === TREND_DAYS));
  const spend = ops[2];
  check("AI spend is ESTIMATED (tokens × rate card), partial days named", spend.provenance === "ESTIMATED" && spend.value === "$6.50" && /1 day\(s\) unpriced/.test(spend.note ?? ""), `${spend.value} ${spend.note}`);
  check("an unpriced day is a GAP in the spend series", spend.points.some((p) => p.value === null));
  const unpriced = spaceTiles({ PLATFORM_OPS: { ...FULL.PLATFORM_OPS!, aiTrend: ok({ checkedAt: "", pricingConfigured: false, days: days(14, () => ({ calls: 1, estimatedSpendUsd: null })) }) } }, SPACES)[0].tiles[2];
  check("no rate card ⇒ spend UNKNOWN, no number, no chart", unpriced.provenance === "UNKNOWN" && unpriced.value === null && unpriced.points.length === 0);
  check("counts are MEASURED with 'as of' from the route", ops[0].provenance === "MEASURED" && ops[0].asOf === NOW.toISOString());
  const cs = t.find((s) => s.area === "CUSTOMER_SUCCESS")!.tiles;
  check("Customer Success: open incidents (floor worded) + opened per day", cs[0].value === "≥7" && cs[0].note === "floor, not a total" && cs[1].points.length === TREND_DAYS);
  const sec = t.find((s) => s.area === "SECURITY_OPS")!.tiles[0];
  check("Security: failed sign-ins with the floor note", sec.value === "28" && /floor/.test(sec.note ?? ""));
  check("Growth: sign-ups 7 d", t.find((s) => s.area === "GROWTH_REVENUE")!.tiles[0].value === "4");
  const errTile = spaceTiles({ GROWTH_REVENUE: { analytics: { status: "error", error: "Request failed (500)" } } }, SPACES).find((s) => s.area === "GROWTH_REVENUE")!.tiles[0];
  check("a failed read ⇒ no value, UNKNOWN provenance, the reason carried (never a zero)", errTile.value === null && errTile.provenance === "UNKNOWN" && errTile.reason === "Request failed (500)");
  check("tiles link into their own Space", t.every((s) => s.tiles.every((x) => x.href.startsWith(`/dashboard/platform/${s.area}`))));
  check("an ungranted area produces no tiles even with signals present", spaceTiles(FULL, [SPACES[2]]).length === 1 && spaceTiles(FULL, [SPACES[2]])[0].area === "GROWTH_REVENUE");

  const html = renderToStaticMarkup(createElement(PlatformOverviewView, { spaces: SPACES, signals: FULL, now: NOW }));
  check("rendered: attention items beyond the third hide below sm (mobile shows 3)", (html.match(/<li class="max-sm:hidden"/g) ?? []).length === 1);
  check("rendered: provenance chips carry words (Measured / Estimated)", /data-provenance="ESTIMATED"[^>]*>Estimated · as of 12:00 UTC/.test(html) && /data-provenance="MEASURED"/.test(html));
  check("rendered: two columns from lg, one below; tiles two-up", /lg:grid-cols-\[minmax\(0,5fr\)_minmax\(0,6fr\)\]/.test(html) && /grid grid-cols-2/.test(html));
}

console.log("Platform AI page: guarded like the Overview, honest, no controls, not an area");
{
  const page = code("app/(shell)/dashboard/platform/ai/page.tsx");
  const iSession = page.indexOf("if (!session?.user?.id) return redirectToLogin();");
  const iGrants = page.indexOf('if (spaces.length === 0) redirect("/dashboard/spaces");');
  const iTotp = page.indexOf("if (env.isOperatorTotpEnforced && !(await operatorHasTotp(session.user.id))) redirect(OPERATOR_TOTP_ENROLMENT_PATH);");
  check("gate order = the Overview's: session → ≥1 ACTIVE grant (tenant read) → operator 2FA", iSession > -1 && iGrants > iSession && iTotp > iGrants && /loadPlatformDirectory\(session\.user\.id\)/.test(page));
  check("it reads no Platform data and renders only the placeholder", /return <PlatformAiPlaceholder \/>;/.test(page) && !/\/api\/platform|systemDb|@\/lib\/db"/.test(page));
  const html = renderToStaticMarkup(createElement(PlatformAiPlaceholder));
  check("titled 'Platform AI', in the AI visual language (AiMark)", /<h1[^>]*>Platform AI<\/h1>/.test(html) && /box-shadow:0 0 10px 1px var\(--accent-info\)/.test(html));
  check("NO input, textarea, form, button, link or contenteditable — nothing that pretends to work",
    !/<(input|textarea|form|button|select|a)\b/.test(html) && !/contenteditable/i.test(html));
  check("the copy: planned read-only intelligence, explicit authorisation for actions, not available yet",
    /read-only/.test(PLATFORM_AI_COPY) && /explicit authorisation/.test(PLATFORM_AI_COPY) && /not available yet/.test(PLATFORM_AI_COPY) && text(html).includes("Not available yet"));
  check("no fake messages", !/(You|Assistant|Fourth Meridian AI):/.test(text(html)));
  check("'ai' is never an area: areas are UPPER_CASE enums and 'ai' is not one", !isPlatformAreaValue("ai") && ALL_PLATFORM_AREAS.every((a) => a === a.toUpperCase()));
  check("the AI path is not a Space route and stands in no area", !isPlatformSpaceRoute(PLATFORM_AI_HREF) && platformAreaFromPath(PLATFORM_AI_HREF) === null);
  check("it is a STATIC sibling of [area] (static segments win; [area] is untouched)",
    existsSync(path.join(ROOT, "app/(shell)/dashboard/platform/ai/page.tsx")) && existsSync(path.join(ROOT, "app/(shell)/dashboard/platform/[area]/page.tsx")));
}

console.log("R1 review fixes");
{
  // An incident carried by BOTH Ops attention (incident:<id>) and CS incidents appears once.
  const both = attentionQueue({ ...FULL, PLATFORM_OPS: { ...FULL.PLATFORM_OPS!, attention: ok({ checkedAt: NOW.toISOString(), counts: { critical: 1 }, items: [
    { id: "incident:c1", severity: "critical" as const, entity: { label: "Chase" }, problem: "Item login required", since: "2026-10-30T09:00:00.000Z", evidence: { workspace: "platform-overview" } },
  ] }) } }, SPACES, NOW);
  const chase = both.items.filter((x) => /Chase/.test(x.title));
  check("a sync incident held by both Ops attention and CS appears exactly once", chase.length === 1, both.items.map((x) => x.title).join(" | "));
  // Sparse AI series: exactly TREND_DAYS calendar days ending on checkedAt, missing days are gaps.
  const sparse = [{ day: "2026-10-01", calls: 5 }, { day: "2026-10-29", calls: 3 }, { day: "2026-10-30", calls: 2 }];
  const pts = calendarPoints(sparse, (x) => x.calls, "2026-10-30T12:00:00.000Z");
  check("calendar window is exactly TREND_DAYS long", pts.length === TREND_DAYS);
  check("…ends on checkedAt's day and starts TREND_DAYS-1 days earlier", pts.at(-1)!.key === "2026-10-30" && pts[0].key === "2026-10-17");
  check("…days outside the window never leak in (Oct 1 excluded)", sumObserved(pts) === 5);
  check("…missing days are gaps (null), not zero", pts.filter((x) => x.value === null).length === TREND_DAYS - 2);
}

if (failures > 0) {
  console.error(`\nplatform-overview: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nplatform-overview: all checks passed.");
