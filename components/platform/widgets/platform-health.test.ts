/**
 * components/platform/widgets/platform-health.test.ts  (PM-1 · UX-P1 compact posture)
 *
 * RENDER-PATH proof for the consolidated Platform Health surface
 * (house pattern: standalone tsx + renderToStaticMarkup, DB-free):
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/platform-health.test.ts
 *
 * Two components are rendered, and the split matters:
 *   · `OpsPlatformHealthWidget` — the REAL self-fetching widget. Server
 *     rendering never runs an effect, so what it renders is exactly the first
 *     frame an operator sees.
 *   · `PlatformHealthSurface` — the prop-driven surface, which is how failure,
 *     empty registries and populated data become reachable without a network.
 *
 * ── WHAT IS PINNED HERE ──────────────────────────────────────────────────────
 *   1. loading is not the empty state
 *   2. a failed fetch is not zero, not nominal, not "nothing to report"
 *   3. one source failing does not take down — or falsely reassure — the others
 *   4. an empty registry says the registry is empty, and is not nominal
 *   5. all four groups render, always
 *   6. Configuration represents BOTH rate limits and env-status
 *   7. urgency is never colour alone, and never the inaccessible coral
 *   8. a known-blocked empty archive is unknown, not red
 *   9. UX-P1: the Alerts word derives from FIRING NOW — a critical in the
 *      delivery history with nothing firing in the latest run is Nominal, and
 *      the history is listed as historical in the disclosure
 *  10. UX-P1: each group leads with at most two rows; provenance chips, notes
 *      and the remaining rows sit inside a <details> disclosure
 *  11. the presentation layer re-derives no authority
 *  12. every group is a doorway onto a real, composed workspace
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ALERT_RULES } from "@/lib/alerts/rules";
import { collectAlertHistory, deriveAlertRuleViews, type AlertRunSummary } from "@/lib/alerts/evaluate";
import { latestAlertEvaluation } from "@/lib/alerts/latest-evaluation";
import { getEnvReport } from "@/lib/env";
import type { ProviderHealth } from "@/lib/platform/provider-health";
import type { ResourceFreshnessReport } from "@/lib/platform/resource-freshness";
import type { PlatformAlertsResponse } from "@/app/api/platform/platform-ops/alerts/route";
import type { ProviderHealthResponse } from "@/app/api/platform/platform-ops/provider-health/route";
import type { ResourceFreshnessResponse } from "@/app/api/platform/platform-ops/resource-freshness/route";
import type { PlatformRateLimitsResponse } from "@/app/api/platform/platform-ops/rate-limits/route";
import type { PlatformEnvStatusResponse } from "@/app/api/platform/platform-ops/env-status/route";
import {
  OpsPlatformHealthWidget,
  PlatformHealthSurface,
  type FetchedResource,
} from "./OpsPlatformHealthWidget";
import { GROUP_DOORWAY, GROUP_LABEL, LEAD_ROWS, SURFACE_FOOTNOTE, alertsView } from "./platform-health-view";
import { PLATFORM_AREA_WORKSPACES, getPlatformWorkspace } from "@/lib/platform/workspaces";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const strip = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SECTION = { id: "s1", key: "ops_platform_health", label: "Platform Health" };

/** A fixed clock, so every relative age in this file is deterministic. */
const NOW = Date.parse("2026-07-24T12:00:00.000Z");
const AGO = (mins: number) => new Date(NOW - mins * 60_000).toISOString();

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Alert rule views through the REAL derivation over the REAL registry. */
function alerts(runs: AlertRunSummary[], destinationConfigured = true): PlatformAlertsResponse {
  return {
    destinationConfigured,
    lastEvaluatedAt: runs[0]?.evaluatedAtISO ?? null,
    rules: deriveAlertRuleViews(ALERT_RULES, () => true, runs),
    history: collectAlertHistory(runs),
    historyRuns: runs.length,
    latest: latestAlertEvaluation(runs),
  };
}

function run(over: Partial<AlertRunSummary> & { evaluatedAtISO: string }): AlertRunSummary {
  return {
    destination: "ops@example.test",
    deliveryStatus: "sent",
    counts: { evaluated: 5, live: 4, enabled: 4, firing: 0, delivered: 0, suppressed: 0 },
    rules: ALERT_RULES.map((r) => ({ id: r.id, kind: r.kind, enabled: r.live, live: r.live, firing: false, breaches: 0, severity: null })),
    fired: [],
    ...over,
  };
}

const CRITICAL_FIRED = {
  ruleId: "job-failing" as const,
  kind: "job-failing" as const,
  dedupeKey: "job-failing:fetch-fx-rates",
  severity: "critical" as const,
  summary: 'Job "fetch-fx-rates" has failed its last 3 run(s).',
  deliveredAtISO: AGO(120),
};

const QUIET_RUN = run({ evaluatedAtISO: AGO(30) });
/** Firing NOW: the latest run's outcome breaches, and it was delivered. */
const FIRING_RUN = run({
  evaluatedAtISO: AGO(30),
  rules: ALERT_RULES.map((r) => ({ id: r.id, kind: r.kind, enabled: r.live, live: r.live, firing: r.id === "job-failing", breaches: r.id === "job-failing" ? 1 : 0, severity: r.id === "job-failing" ? "critical" as const : null })),
  fired: [CRITICAL_FIRED],
});
/** HISTORY ONLY: a critical was delivered two hours ago, but the latest run breached nothing. */
const HISTORY_ONLY_RUN = run({ evaluatedAtISO: AGO(30), fired: [CRITICAL_FIRED] });

function provider(over: Partial<ProviderHealth> & { key: string; label: string }): ProviderHealth {
  return {
    kind: "BANKING",
    trust: "OPERATIONAL",
    availability: 1,
    lastSuccessAt: AGO(60),
    lastFailureAt: null,
    latencyMs: 900,
    quota: null,
    remainingQuota: null,
    coverage: null,
    coverageUnit: null,
    freshness: { state: "fresh", asOf: AGO(60), ageDays: 0, source: "connection-health", detail: "synced 1h ago" },
    syncFailures: 0,
    errorRate: 0,
    callsToday: null,
    calls30d: null,
    notes: [],
    ...over,
  };
}

function providersResponse(list: ProviderHealth[]): ProviderHealthResponse {
  const counts = { OPERATIONAL: 0, DEGRADED: 0, STALE: 0, FAILING: 0, UNKNOWN: 0 };
  for (const p of list) counts[p.trust]++;
  return { checkedAt: AGO(1), counts, providers: list };
}

function resource(over: Partial<ResourceFreshnessReport> & { resource: string; label: string }): ResourceFreshnessReport {
  return {
    newestObservedDate: "2026-07-24",
    ageHours: 3,
    ageDays: 0,
    expectedCadenceHours: 24,
    cadenceLabel: "daily",
    staleAfterHours: 48,
    healthState: "fresh",
    completeness: { expected: 10, observed: 10, ratio: 1 },
    lastSuccessfulRefresh: AGO(180),
    lastAttemptedRefresh: AGO(180),
    lastAttemptStatus: "succeeded",
    trust: { level: "high", caveats: [] },
    ...over,
  };
}

function freshnessResponse(list: ResourceFreshnessReport[]): ResourceFreshnessResponse {
  const counts = { fresh: 0, stale: 0, empty: 0, idle: 0 };
  for (const r of list) counts[r.healthState]++;
  return { checkedAt: AGO(1), allFresh: counts.stale === 0 && counts.empty === 0, counts, resources: list };
}

const RATE_LIMITS: PlatformRateLimitsResponse = {
  windowSince: AGO(60),
  totalRows: 12,
  totalHits: 47,
  topBuckets: [
    { bucket: "ip:pre-login", hits: 31, keys: 7 },
    { bucket: "user:sync", hits: 16, keys: 5 },
  ],
};

const EMPTY_RATE_LIMITS: PlatformRateLimitsResponse = { windowSince: AGO(60), totalRows: 0, totalHits: 0, topBuckets: [] };

/** The REAL environment report for this process — a genuine authority answer. */
const ENV: PlatformEnvStatusResponse = getEnvReport();

/** A deterministic all-pass report. */
const ENV_CLEAN: PlatformEnvStatusResponse = {
  nodeEnv: "test",
  deploymentEnv: "development",
  ok: true,
  counts: { pass: 2, warn: 0, fail: 0 },
  keys: [
    { key: "DATABASE_URL", status: "pass", scope: "always" },
    { key: "NEXTAUTH_SECRET", status: "pass", scope: "always" },
  ],
};

const ok = <T,>(data: T): FetchedResource<T> => ({ data, loading: false, error: null });
const loadingState = <T,>(): FetchedResource<T> => ({ data: null, loading: true, error: null });
const failed = <T,>(msg = "Request failed (500)"): FetchedResource<T> => ({ data: null, loading: false, error: msg });

function renderSurface(over: Partial<Parameters<typeof PlatformHealthSurface>[0]> = {}) {
  const html = renderToStaticMarkup(
    createElement(PlatformHealthSurface, {
      section: SECTION,
      alerts: ok(alerts([QUIET_RUN])),
      providers: ok(providersResponse([provider({ key: "PLAID", label: "Plaid" })])),
      freshness: ok(freshnessResponse([resource({ resource: "fx-rates", label: "FX rates" })])),
      rateLimits: ok(RATE_LIMITS),
      env: ok(ENV),
      nowMs: NOW,
      ...over,
    }),
  );
  return { html, text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
}

const GROUPS = ["Alerts", "Providers", "Freshness", "Configuration"];
const REASSURING = /healthy|all clear|all good|everything is|no issues|operating normally/i;

/** The body with the footnote removed — it DEFINES "Nominal", so it necessarily contains it. */
const body = (text: string) => text.replace(SURFACE_FOOTNOTE, "").trim();

/** Every verdict the surface rendered, extracted from the markup `ToneBadge` emits. */
const verdicts = (html: string) =>
  [...html.matchAll(/<span class="text-xs font-medium">([^<]*)<\/span>/g)].map((m) => m[1]);

/** The markup OUTSIDE every <details> disclosure — what an operator sees by default. */
const outsideDetails = (html: string) => html.replace(/<details[\s\S]*?<\/details>/g, "");

function main() {
  // ── 1. The real widget's FIRST FRAME is loading, and only loading ──────────
  console.log("1. the self-fetching widget renders a loading state, never an empty one");
  {
    const html = renderToStaticMarkup(createElement(OpsPlatformHealthWidget, { section: SECTION }));
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    check("shows a loading line", /Loading/.test(text), text.slice(0, 200));
    check("one loading state per source (five)", (html.match(/role="status"/g) ?? []).length === 5,
      `${(html.match(/role="status"/g) ?? []).length}`);
    check("renders NO verdict at all", verdicts(html).length === 0, verdicts(html).join(","));
    check("does not claim anything is nominal", !body(text).includes("Nominal"), body(text));
    check("does not claim an empty registry", !/No (providers|alert rules|refreshable)/.test(text), text);
    check("does not report a count", !/\d/.test(body(text)), body(text));
    check("does not read as reassuring", !REASSURING.test(text), text);
    for (const g of GROUPS) check(`group "${g}" is labelled while loading`, text.includes(g));
  }

  // ── 2. A failed fetch is never zero and never fine ─────────────────────────
  console.log("2. every failed fetch renders unavailable, never zero or nominal");
  {
    const { html, text } = renderSurface({
      alerts: failed(), providers: failed(), freshness: failed(), rateLimits: failed(), env: failed(),
    });
    for (const subject of ["Alert status", "Provider health", "Resource freshness", "Environment status", "Rate-limit pressure"]) {
      check(`${subject} states it is unavailable`, text.includes(`${subject} unavailable`), text);
    }
    check("explicitly disclaims a clean reading",
      (text.match(/This is not a report that nothing is wrong/g) ?? []).length === 5, text);
    check("renders NO verdict at all", verdicts(html).length === 0, verdicts(html).join(","));
    check("does not claim anything is nominal", !body(text).includes("Nominal"), body(text));
    check("renders no number at all", !/\d/.test(body(text)), body(text));
    check("does not read as reassuring", !REASSURING.test(text), text);
    check("does not say 0 providers or 0 alerts", !/\b0\b/.test(body(text)), body(text));
    for (const g of GROUPS) check(`group "${g}" still renders`, text.includes(g));
  }

  // ── 3. Data present but the fetch failed → still unavailable ──────────────
  console.log("3. an error wins over data we happen to be holding");
  {
    const stale: FetchedResource<ProviderHealthResponse> = {
      data: providersResponse([provider({ key: "PLAID", label: "Plaid" })]),
      loading: false,
      error: "Request failed (500)",
    };
    const { text } = renderSurface({ providers: stale });
    check("shows the unavailable line", text.includes("Provider health unavailable"), text);
    check("does not render the held provider row", !text.includes("Plaid"), text);
  }

  // ── 4. One source failing does not silence or reassure the others ─────────
  console.log("4. partial failure is partial");
  {
    const { text } = renderSurface({ providers: failed() });
    check("the failed source says so", text.includes("Provider health unavailable"));
    check("the healthy-path sources still render", text.includes("FX rates"), text);
    const cfg = renderSurface({ rateLimits: failed() });
    check("env renders while rate limits fail",
      cfg.text.includes("Rate-limit pressure unavailable") && cfg.text.includes("Environment"), cfg.text);
    const cfg2 = renderSurface({ env: failed() });
    check("rate limits render while env fails",
      cfg2.text.includes("Environment status unavailable") && cfg2.text.includes("ip:pre-login"), cfg2.text);
    const slow = renderSurface({ freshness: loadingState() });
    check("a still-loading source shows loading, not empty",
      slow.text.includes("Loading") && !slow.text.includes("No refreshable resources registered"), slow.text);
    check("a still-loading source renders no verdict",
      verdicts(slow.html).length === verdicts(renderSurface().html).length - 1,
      verdicts(slow.html).join(","));
  }

  // ── 5. An empty registry says so, and is not nominal ──────────────────────
  console.log("5. genuinely empty is an honest empty, not a clean bill of health");
  {
    const { html, text } = renderSurface({
      providers: ok(providersResponse([])),
      freshness: ok(freshnessResponse([])),
      alerts: ok({ destinationConfigured: false, lastEvaluatedAt: null, rules: [], history: [], historyRuns: 0, latest: null }),
      rateLimits: ok(EMPTY_RATE_LIMITS),
      env: ok(ENV_CLEAN),
    });
    check("no providers registered", text.includes("No providers registered"), text);
    check("no refreshable resources registered", text.includes("No refreshable resources registered"), text);
    check("no alert rules registered", text.includes("No alert rules registered"), text);
    check("no rate-limit activity in the window", text.includes("No rate-limit activity in the window"), text);
    check("does not render 0 of 0", !/0 of 0/.test(text), text);
    check("empty registries render Unknown, never Nominal",
      verdicts(html).join(",") === "Unknown,Unknown,Unknown,Nominal", verdicts(html).join(","));
    check("does not read as reassuring", !REASSURING.test(text), text);
  }

  // ── 6. Never evaluated is unknown, not "no firings" ───────────────────────
  console.log("6. an evaluator that never ran is unknown, not quiet");
  {
    const { text } = renderSurface({ alerts: ok(alerts([], false)) });
    check("states the destination is not configured",
      text.includes("Not configured — deliveries have nowhere to go"), text);
  }
  {
    const neverRun: PlatformAlertsResponse = {
      destinationConfigured: true, lastEvaluatedAt: null,
      rules: deriveAlertRuleViews(ALERT_RULES, () => true, []),
      history: [], historyRuns: 0, latest: null,
    };
    const { text } = renderSurface({ alerts: ok(neverRun) });
    check("headline is Never evaluated", text.includes("Never evaluated"), text);
    check("status is Unknown, not Nominal", /Unknown Never evaluated/.test(text), text);
    check("says no evaluation was recorded", text.includes("Never — no evaluation recorded"), text);
  }

  // ── 7. All four groups render populated, and Configuration is complete ────
  console.log("7. four groups, and Configuration keeps both otherwise-unreachable reads");
  {
    const { html, text } = renderSurface();
    for (const g of GROUPS) check(`group "${g}" renders`, text.includes(g));
    check("rate-limit buckets are represented", text.includes("ip:pre-login") && text.includes("47 hits"), text);
    check("the environment report is represented", text.includes(ENV.deploymentEnv), text);
    check("both Configuration captions render", text.includes("Environment") && text.includes("Rate limits"), text);
    // Provenance is still named — inside the disclosure (section 10 pins the placement).
    for (const src of ["lib/alerts", "lib/platform/provider-health", "lib/platform/resource-freshness", "lib/env", "RateLimit table"]) {
      check(`provenance names ${src}`, text.includes(src), text);
    }
    check("footnote refuses a platform-wide claim", text.includes("it is not a verdict on the platform"), text);
    check("does not read as reassuring", !REASSURING.test(text), text);
    check("the nominal verdict carries the ok tone (word + colour, never colour alone)",
      /style="color:var\(--emerald-400\)"><span aria-hidden="true"[^>]*><\/span><span class="text-xs font-medium">Nominal<\/span>/.test(html), html.slice(0, 600));
  }

  // ── 8. Rate-limit pressure is reported, not judged ────────────────────────
  console.log("8. a source with no threshold authority carries no verdict");
  {
    const { text } = renderSurface();
    check("says so in words", text.includes("No threshold authority exists for rate-limit pressure"), text);
    check("no verdict is attached to the rate-limit headline",
      !/(Nominal|Caution|Action needed|Unknown)\s+47 hits/.test(text), text);
  }

  // ── 9. Urgency is a word first, and the accessible coral ──────────────────
  console.log("9. severity is never carried by colour alone");
  {
    const bad = renderSurface({
      alerts: ok(alerts([FIRING_RUN])),
      providers: ok(providersResponse([
        provider({ key: "PLAID", label: "Plaid" }),
        provider({ key: "OXR", label: "Open Exchange Rates", kind: "FX", trust: "FAILING", availability: 0.2,
          freshness: { state: "stale", asOf: AGO(4320), ageDays: 3, source: "resource-freshness", detail: "3 days stale" } }),
      ])),
      freshness: ok(freshnessResponse([
        resource({ resource: "fx-rates", label: "FX rates", healthState: "empty", newestObservedDate: null,
          ageHours: null, ageDays: null, completeness: null,
          trust: { level: "low", caveats: ["archive is empty"] } }),
      ])),
    });
    check("a failing provider is named Failing", bad.text.includes("Failing"), bad.text);
    check("an empty archive is named Empty", bad.text.includes("Empty"), bad.text);
    check("a rule firing now is named with its title and 'firing now'", /Repeated job failures firing now/.test(bad.text), bad.text);
    check("the group verdict is a word", bad.text.includes("Action needed"), bad.text);
    check("no coloured span without a word",
      !/style="color:var\(--coral-[0-9]{3}\)"[^>]*>\s*<\/span>/.test(bad.html), bad.html.slice(0, 400));
    check("uses the saturated coral for danger", bad.html.includes("var(--coral-400)"));
    check("never uses --coral-600", !bad.html.includes("--coral-600"), bad.html.slice(0, 400));
    check("never uses --coral-500", !bad.html.includes("--coral-500"));
    check("no raw hex reaches the markup", !/#[0-9a-fA-F]{6}\b/.test(bad.html), bad.html.match(/#[0-9a-fA-F]{6}\b/)?.[0]);
  }

  // ── 10. A known-blocked empty archive is not painted as a failure ─────────
  console.log("10. a known-blocked pipeline is unknown, not red");
  {
    const { text } = renderSurface({
      freshness: ok(freshnessResponse([
        resource({ resource: "security-prices", label: "Security prices", healthState: "empty",
          newestObservedDate: null, ageHours: null, ageDays: null, completeness: null,
          trust: { level: "unknown", caveats: ["no price vendor configured"] } }),
      ])),
    });
    check("the blocked resource is still named Empty", text.includes("Empty"), text);
    check("its caveat is carried from the authority", text.includes("no price vendor configured"), text);
    check("the group is Unknown, not Action needed",
      text.includes("Unknown") && !/Unknown 1 not fresh[\s\S]{0,40}Action needed/.test(text), text);
  }

  // ── 11. UX-P1 — the Alerts word is FIRING NOW, never the delivery history ──
  console.log("11. a historical critical with nothing firing now is Nominal, and listed as history");
  {
    // ENV_CLEAN so the Configuration group (which reads THIS process's real
    // environment) cannot contribute an "Action needed" of its own.
    const { html, text } = renderSurface({ alerts: ok(alerts([HISTORY_ONLY_RUN])), env: ok(ENV_CLEAN) });
    check("the Alerts verdict is Nominal", verdicts(html)[0] === "Nominal", verdicts(html).join(","));
    check("the headline says no rule is firing", /No rule firing/.test(text), text);
    check("'Action needed' is NOT rendered", !text.includes("Action needed"), text);
    check("the delivered critical is listed, labelled Historical", /Historical · Job &quot;fetch-fx-rates&quot;/.test(text), text);
    check("…inside the disclosure, not as a lead row", !outsideDetails(html).includes("fetch-fx-rates"));
    check("the note names the history window", /Recent firings \(historical, last 1 evaluation\): 1 delivered/.test(text), text);

    const view = alertsView(alerts([HISTORY_ONLY_RUN]), NOW);
    check("the view-model agrees: nominal with the history in details", view.status === "nominal" && view.details.some((l) => l.label.startsWith("Historical")));
    const firing = alertsView(alerts([FIRING_RUN]), NOW);
    check("…and a latest-run breach is critical with the rule as a lead row", firing.status === "critical" && firing.lines[0]?.label === "Repeated job failures");
    const olderFiring = alertsView(alerts([HISTORY_ONLY_RUN, FIRING_RUN]), NOW);
    check("an older firing run does not outrank the newest quiet one", olderFiring.status === "nominal");
  }

  // ── 12. UX-P1 — compact: ≤2 lead rows; provenance and notes in <details> ──
  console.log("12. each group leads with at most two rows; the rest is disclosed");
  {
    const many = renderSurface({
      providers: ok(providersResponse([
        provider({ key: "A", label: "Provider A" }), provider({ key: "B", label: "Provider B" }),
        provider({ key: "C", label: "Provider C" }), provider({ key: "D", label: "Provider D", trust: "DEGRADED" }),
      ])),
    });
    const visible = outsideDetails(many.html);
    check("LEAD_ROWS is two", LEAD_ROWS === 2);
    check("the degraded provider leads", visible.includes("Provider D"));
    check("at most two provider rows outside the disclosure",
      ["Provider A", "Provider B", "Provider C", "Provider D"].filter((p) => visible.includes(p)).length === 2, visible.replace(/<[^>]+>/g, " ").slice(0, 400));
    check("the remaining rows are inside the disclosure", ["Provider A", "Provider B", "Provider C", "Provider D"].every((p) => many.html.includes(p)));
    check("the disclosure summary counts what it holds", /Details \(2 more\)/.test(many.text), many.text);
    for (const src of ["lib/alerts", "lib/platform/provider-health", "lib/platform/resource-freshness", "lib/env", "RateLimit table"]) {
      check(`provenance "${src}" is NOT visible by default`, !visible.includes(src));
    }
    check("notes are not visible by default", !visible.includes("Trust is the provider authority"));
    check("one details disclosure per source (five)", (many.html.match(/<details/g) ?? []).length === 5);
  }

  // ── 13. The presentation layer re-derives no authority ────────────────────
  console.log("13. nothing here computes what an authority already decided");
  {
    const widget = strip("components/platform/widgets/OpsPlatformHealthWidget.tsx");
    const view = strip("components/platform/widgets/platform-health-view.ts");
    const names = [...view.matchAll(/function (\w+)/g)].map((m) => m[1]);
    check("no view function computes a rate/severity/trust", !names.some((n) => /(Rate|Severity|Trust|Health)$/.test(n)), names.join(","));
    check("the widget does not filter or reduce a response", !/\.filter\(|\.reduce\(|\.sort\(/.test(widget), widget);
    check("no staleness or ratio arithmetic in the view module",
      !/Date\.now\(\)|\* 100|\/ 1000 \/ 60 \/ 60|staleAfterHours\s*[<>]/.test(view), view);
    check("the view reads firing from the LATEST outcomes, never from history", /d\.latest\b/.test(view) && !/history\.some\(\s*\(h\)\s*=>\s*h\.severity/.test(view));
    for (const [name, src] of [["widget", widget], ["view", view]] as const) {
      check(`${name}: no raw hex colour`, !/#[0-9a-fA-F]{3,8}\b/.test(src), src.match(/#[0-9a-fA-F]{3,8}\b/)?.[0]);
      check(`${name}: no tailwind palette class`,
        !/\b(?:bg|text|border)-(?:gray|blue|red|emerald|green|violet|yellow|amber|purple)-\d{2,3}\b/.test(src));
      check(`${name}: never uses --coral-600`, !src.includes("--coral-600"));
    }
    for (const route of [
      "/api/platform/platform-ops/alerts",
      "/api/platform/platform-ops/provider-health",
      "/api/platform/platform-ops/resource-freshness",
      "/api/platform/platform-ops/rate-limits",
      "/api/platform/platform-ops/env-status",
    ]) {
      check(`reads the existing route ${route}`, widget.includes(`useWidgetFetch<`) && widget.includes(`"${route}"`));
    }
    check("exactly five fetches", (widget.match(/useWidgetFetch</g) ?? []).length === 5, `${(widget.match(/useWidgetFetch</g) ?? []).length}`);
    check("every fetch url is a string literal", !/useWidgetFetch<[^>]*>\(\s*[^"]/.test(widget), widget);
  }

  // ── 14. Each group is a DOORWAY onto the workspace that owns its detail ───
  console.log("14. every group names the workspace carrying its full read");
  {
    const wired = renderSurface({ onOpenWorkspace: () => {} });
    const doorways = [
      ...wired.html.matchAll(/<button type="button" aria-label="([^"]*)"[^>]*>([^<]*)<svg/g),
    ].map((m) => ({ aria: m[1], visible: m[2].trim() }));

    check("one doorway per group", doorways.length === 4, JSON.stringify(doorways));

    const doorwayClass = (wired.html.match(/<button[^>]*aria-label="[^"]*behind Alerts"[^>]*class="([^"]*)"/) ??
                          wired.html.match(/<button[^>]*class="([^"]*)"[^>]*aria-label="[^"]*behind Alerts"/))?.[1] ?? "";
    check("the doorway carries a 44px overlay hit area", /before:h-11/.test(doorwayClass) && /before:absolute/.test(doorwayClass), doorwayClass);
    check("…at least 44px wide too", /before:min-w-\[44px\]/.test(doorwayClass), doorwayClass);
    check("…positioned relative to the button", /(^|\s)relative(\s|$)/.test(doorwayClass), doorwayClass);
    const layoutClasses = doorwayClass.split(/\s+/).filter((c) => !c.startsWith("before:")).join(" ");
    check("the LAYOUT box is untouched", !/min-h-|\bpy-\d|\bh-\d/.test(layoutClasses), layoutClasses);
    check("no negative margin", !/(^|\s)-m[trbl]?-\d/.test(layoutClasses), layoutClasses);
    check("no breakpoint scoping on the overlay", !/(sm|md|lg|xl):/.test(doorwayClass), doorwayClass);
    check("the doorway labels are the registry's workspace labels",
      doorways.map((d) => d.visible).join(",") === "Policies,Providers,Providers,Policies",
      doorways.map((d) => d.visible).join(","));

    for (const group of ["alerts", "providers", "freshness", "configuration"] as const) {
      const def = getPlatformWorkspace(GROUP_DOORWAY[group]);
      check(`${group} opens a real workspace (${GROUP_DOORWAY[group]})`, def != null);
      check(`${group}'s doorway is labelled from the registry`,
        def != null && doorways.some((d) => d.visible === def.label && d.aria.includes(GROUP_LABEL[group])),
        JSON.stringify(doorways));
    }
    const overview = PLATFORM_AREA_WORKSPACES.PLATFORM_OPS.find((w) => w.workspaceId === "platform-overview");
    for (const group of ["alerts", "providers", "freshness", "configuration"] as const) {
      check(`${group}'s target is a composed Overview doorway`,
        (overview?.doorways ?? []).includes(GROUP_DOORWAY[group]), (overview?.doorways ?? []).join(","));
    }
    for (const d of doorways) {
      check(`accessible name starts with the visible label (${d.visible})`, d.aria.startsWith(d.visible), d.aria);
    }
    check("the footnote says each group summarises a workspace",
      wired.text.includes("Each group summarises a workspace on the rail. Open one for its full read."), wired.text);

    const brokenWired = renderSurface({
      onOpenWorkspace: () => {},
      alerts: failed(), providers: failed(), freshness: failed(), rateLimits: failed(), env: failed(),
    });
    check("doorways still render when every source failed",
      (brokenWired.html.match(/<button type="button" aria-label=/g) ?? []).length === 4);

    const unwired = renderSurface();
    check("no doorway is rendered when the host wired no handler",
      !unwired.html.includes('<button type="button" aria-label='), unwired.html.slice(0, 400));
    check("and no dead button of any kind is left behind", !unwired.html.includes("<button"), unwired.html.slice(0, 400));
  }

  if (failures > 0) { console.error(`\nplatform-health.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nplatform-health.test: all passed.");
}

main();
