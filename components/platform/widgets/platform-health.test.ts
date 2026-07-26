/**
 * components/platform/widgets/platform-health.test.ts  (PM-1)
 *
 * RENDER-PATH proof for the consolidated Platform Health surface
 * (house pattern: standalone tsx + renderToStaticMarkup, DB-free):
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/platform-health.test.ts
 *
 * Two components are rendered, and the split matters:
 *   · `OpsPlatformHealthWidget` — the REAL self-fetching widget. Server
 *     rendering never runs an effect, so what it renders is exactly the first
 *     frame an operator sees. That is the only way to prove the loading state
 *     is genuinely the loading state and not a hopeful empty one.
 *   · `PlatformHealthSurface` — the prop-driven surface, which is how failure,
 *     empty registries and populated data become reachable without a network.
 *
 * Fixtures use the REAL authorities wherever the authority is pure:
 * `getEnvReport()` is called for a genuine environment report, and the alert
 * views are pushed through the real `deriveAlertRuleViews` / `collectAlertHistory`
 * over the real `ALERT_RULES`. Provider and freshness reports are typed literals
 * (their authorities need a database), so drift in those shapes fails the
 * typecheck rather than passing silently.
 *
 * ── WHAT IS PINNED HERE ──────────────────────────────────────────────────────
 * Every one of these is a way this surface could quietly start lying:
 *   1. loading is not the empty state
 *   2. a failed fetch is not zero, not nominal, not "nothing to report"
 *   3. one source failing does not take down — or falsely reassure — the others
 *   4. an empty registry says the registry is empty, and is not nominal
 *   5. all four groups render, always
 *   6. Configuration represents BOTH rate limits and env-status, which are
 *      composed nowhere else and would otherwise become unreachable
 *   7. urgency is never colour alone, and never the inaccessible coral
 *   8. no authority is re-derived in the presentation layer
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ALERT_RULES } from "@/lib/alerts/rules";
import { collectAlertHistory, deriveAlertRuleViews, type AlertRunSummary } from "@/lib/alerts/evaluate";
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
import { GROUP_DOORWAY, GROUP_LABEL, SURFACE_FOOTNOTE } from "./platform-health-view";
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
function alerts(runs: AlertRunSummary[], destination: string | null = "ops@example.test"): PlatformAlertsResponse {
  return {
    destination,
    lastEvaluatedAt: runs[0]?.evaluatedAtISO ?? null,
    rules: deriveAlertRuleViews(ALERT_RULES, () => true, runs),
    history: collectAlertHistory(runs),
  };
}

function run(over: Partial<AlertRunSummary> & { evaluatedAtISO: string }): AlertRunSummary {
  return {
    destination: "ops@example.test",
    deliveryStatus: "sent",
    counts: { evaluated: 5, live: 4, enabled: 4, firing: 0, delivered: 0, suppressed: 0 },
    rules: [],
    fired: [],
    ...over,
  };
}

const QUIET_RUN = run({ evaluatedAtISO: AGO(30) });
const FIRING_RUN = run({
  evaluatedAtISO: AGO(30),
  deliveryStatus: "sent",
  fired: [
    {
      ruleId: "job-failing",
      kind: "job-failing",
      dedupeKey: "job-failing:fetch-fx-rates",
      severity: "critical",
      summary: 'Job "fetch-fx-rates" has failed its last 3 run(s).',
      deliveredAtISO: AGO(120),
    },
  ],
});

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

const EMPTY_RATE_LIMITS: PlatformRateLimitsResponse = {
  windowSince: AGO(60),
  totalRows: 0,
  totalHits: 0,
  topBuckets: [],
};

/** The REAL environment report for this process — a genuine authority answer. */
const ENV: PlatformEnvStatusResponse = getEnvReport();

/** A deterministic all-pass report, for the assertions that must not depend on
 *  which variables happen to be set in the process running the test. */
const ENV_CLEAN: PlatformEnvStatusResponse = {
  nodeEnv: "test",
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

/**
 * The surface's honesty footnote DEFINES the word "Nominal", so it necessarily
 * contains it. Assertions about what the surface CLAIMS therefore read the body
 * with the footnote removed — otherwise the explanation of a word would count as
 * a use of it.
 */
const body = (text: string) => text.replace(SURFACE_FOOTNOTE, "").trim();

/**
 * Every verdict the surface rendered, extracted structurally from the markup
 * `StatusWord` emits. This is stronger than searching the text: it can prove
 * that ZERO verdicts were rendered, which is exactly what loading and failure
 * must look like.
 */
const verdicts = (html: string) =>
  [...html.matchAll(/<span class="text-sm font-medium" style="color:[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]);

function main() {
  // ── 1. The real widget's FIRST FRAME is loading, and only loading ──────────
  console.log("1. the self-fetching widget renders a loading state, never an empty one");
  {
    const html = renderToStaticMarkup(createElement(OpsPlatformHealthWidget, { section: SECTION }));
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    check("shows a loading line", /Loading/.test(text), text.slice(0, 200));
    check("one loading state per source (five)", (html.match(/role="status"/g) ?? []).length === 5,
      `${(html.match(/role="status"/g) ?? []).length}`);

    // The four ways this frame could lie about a request that has not returned.
    check("renders NO verdict at all", verdicts(html).length === 0, verdicts(html).join(","));
    check("does not claim anything is nominal", !body(text).includes("Nominal"), body(text));
    check("does not claim an empty registry", !/No (providers|alert rules|refreshable)/.test(text), text);
    check("does not report a count", !/\d/.test(body(text)), body(text));
    check("does not read as reassuring", !REASSURING.test(text), text);

    // All four groups are labelled from the very first frame — the operator can
    // see what is being fetched, not a surface that grows sections as it loads.
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

    // The specific dishonesty this surface exists to prevent.
    check("renders NO verdict at all", verdicts(html).length === 0, verdicts(html).join(","));
    check("does not claim anything is nominal", !body(text).includes("Nominal"), body(text));
    check("renders no number at all", !/\d/.test(body(text)), body(text));
    check("does not read as reassuring", !REASSURING.test(text), text);
    check("does not say 0 providers or 0 alerts", !/\b0\b/.test(body(text)), body(text));

    // Failure is still a status, and the four groups stay on the page.
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
    // The two Configuration sources are independent: env can answer while rate
    // limits fail, and neither substitutes for the other.
    const cfg = renderSurface({ rateLimits: failed() });
    check("env renders while rate limits fail",
      cfg.text.includes("Rate-limit pressure unavailable") && cfg.text.includes("Environment"), cfg.text);
    const cfg2 = renderSurface({ env: failed() });
    check("rate limits render while env fails",
      cfg2.text.includes("Environment status unavailable") && cfg2.text.includes("ip:pre-login"), cfg2.text);

    // A source still in flight while its neighbours have answered stays LOADING;
    // it does not borrow their result and it does not render as empty.
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
      alerts: ok({ destination: null, lastEvaluatedAt: null, rules: [], history: [] }),
      rateLimits: ok(EMPTY_RATE_LIMITS),
      env: ok(ENV_CLEAN),
    });

    check("no providers registered", text.includes("No providers registered"), text);
    check("no refreshable resources registered", text.includes("No refreshable resources registered"), text);
    check("no alert rules registered", text.includes("No alert rules registered"), text);
    check("no rate-limit activity in the window", text.includes("No rate-limit activity in the window"), text);

    // "0 of 0 operational" is the reading that turns an empty registry into a
    // perfect score. It must not appear.
    check("does not render 0 of 0", !/0 of 0/.test(text), text);
    // Structural: three empty registries produce three Unknowns. Only the
    // environment report — which genuinely answered — may read Nominal. An
    // empty registry scoring "1 of 1 operational" is the failure mode here.
    check("empty registries render Unknown, never Nominal",
      verdicts(html).join(",") === "Unknown,Unknown,Unknown,Nominal", verdicts(html).join(","));
    check("does not read as reassuring", !REASSURING.test(text), text);
  }

  // ── 6. Never evaluated is unknown, not "no firings" ───────────────────────
  console.log("6. an evaluator that never ran is unknown, not quiet");
  {
    const { text } = renderSurface({ alerts: ok(alerts([], null)) });
    check("states the destination is not configured",
      text.includes("Not configured — deliveries have nowhere to go"), text);
  }
  {
    // Rules exist, evaluator has never run.
    const neverRun: PlatformAlertsResponse = {
      destination: "ops@example.test",
      lastEvaluatedAt: null,
      rules: deriveAlertRuleViews(ALERT_RULES, () => true, []),
      history: [],
    };
    const { text } = renderSurface({ alerts: ok(neverRun) });
    check("headline is Never evaluated", text.includes("Never evaluated"), text);
    check("status is Unknown, not Nominal", /Unknown Never evaluated/.test(text), text);
    check("says no evaluation was recorded", text.includes("Never — no evaluation recorded"), text);
  }

  // ── 7. All four groups render populated, and Configuration is complete ────
  console.log("7. four groups, and Configuration keeps both otherwise-unreachable reads");
  {
    const { text } = renderSurface();
    for (const g of GROUPS) check(`group "${g}" renders`, text.includes(g));

    // ops_rate_limits and ops_env_status are composed ONLY into the Overview
    // workspace. If this surface did not represent them, consolidating would
    // delete two operator reads from the product.
    check("rate-limit buckets are represented", text.includes("ip:pre-login") && text.includes("47 hits"), text);
    check("the environment report is represented", text.includes(ENV.nodeEnv), text);
    check("both Configuration captions render",
      text.includes("Environment") && text.includes("Rate limits"), text);

    // The provenance of every source is named — an unattributed number on a
    // four-authority surface cannot be followed up.
    for (const src of ["lib/alerts", "lib/platform/provider-health", "lib/platform/resource-freshness", "lib/env", "RateLimit table"]) {
      check(`provenance names ${src}`, text.includes(src), text);
    }

    // The surface never promotes itself to a verdict about the platform.
    check("footnote refuses a platform-wide claim",
      text.includes("it is not a verdict on the platform"), text);
    check("does not read as reassuring", !REASSURING.test(text), text);
  }

  // ── 8. Rate-limit pressure is reported, not judged ────────────────────────
  console.log("8. a source with no threshold authority carries no verdict");
  {
    const { text } = renderSurface();
    check("says so in words", text.includes("No threshold authority exists for rate-limit pressure"), text);
    // It must not borrow a verdict it has no basis for.
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

    // The authority's own word, rendered as text.
    check("a failing provider is named Failing", bad.text.includes("Failing"), bad.text);
    check("an empty archive is named Empty", bad.text.includes("Empty"), bad.text);
    check("a critical alert firing is named", bad.text.includes("critical"), bad.text);
    check("the group verdict is a word", bad.text.includes("Action needed"), bad.text);

    // …and no coloured element is empty of text, which is what "colour only"
    // would look like in the markup.
    check("no coloured span without a word",
      !/style="color:var\(--coral-[0-9]{3}\)"[^>]*>\s*<\/span>/.test(bad.html), bad.html.slice(0, 400));

    // Urgency is SATURATION, not darkness: --coral-600 measured 3.28:1 on the
    // dark surface and fails WCAG AA for small text.
    check("uses the saturated coral for danger", bad.html.includes("var(--coral-400)"));
    check("never uses --coral-600", !bad.html.includes("--coral-600"), bad.html.slice(0, 400));
    check("never uses --coral-500", !bad.html.includes("--coral-500"));
    check("no raw hex reaches the markup", !/#[0-9a-fA-F]{6}\b/.test(bad.html),
      bad.html.match(/#[0-9a-fA-F]{6}\b/)?.[0]);
  }

  // ── 10. A known-blocked empty archive is not painted as a failure ─────────
  console.log("10. a known-blocked pipeline is unknown, not red");
  {
    // lib/alerts/evaluate.ts deliberately does NOT alert on an `empty` resource
    // whose trust level is "unknown" — that is a gated no-op, "honest, not a
    // false alarm". The surface must agree with the alerting, or the two
    // disagree about the same resource.
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

  // ── 11. The presentation layer re-derives no authority ────────────────────
  console.log("11. nothing here computes what an authority already decided");
  {
    const widget = strip("components/platform/widgets/OpsPlatformHealthWidget.tsx");
    const view = strip("components/platform/widgets/platform-health-view.ts");

    // GROWTH-1's guard idiom: a view module that grows a function computing a
    // rate, a severity or a trust has forked the authority.
    const names = [...view.matchAll(/function (\w+)/g)].map((m) => m[1]);
    check("no view function computes a rate/severity/trust",
      !names.some((n) => /(Rate|Severity|Trust|Health)$/.test(n)), names.join(","));

    // The widget renders; the view module shapes. No counting or filtering of a
    // response may live in the component.
    check("the widget does not filter or reduce a response",
      !/\.filter\(|\.reduce\(|\.sort\(/.test(widget), widget);

    // Freshness maths, availability ratios and staleness thresholds all belong
    // to the authorities that already ship them.
    check("no staleness or ratio arithmetic in the view module",
      !/Date\.now\(\)|\* 100|\/ 1000 \/ 60 \/ 60|staleAfterHours\s*[<>]/.test(view), view);

    for (const [name, src] of [["widget", widget], ["view", view]] as const) {
      check(`${name}: no raw hex colour`, !/#[0-9a-fA-F]{3,8}\b/.test(src), src.match(/#[0-9a-fA-F]{3,8}\b/)?.[0]);
      check(`${name}: no tailwind palette class`,
        !/\b(?:bg|text|border)-(?:gray|blue|red|emerald|green|violet|yellow|amber|purple)-\d{2,3}\b/.test(src));
      check(`${name}: never uses --coral-600`, !src.includes("--coral-600"));
    }

    // Consolidation means five reads, not a new aggregate endpoint.
    for (const route of [
      "/api/platform/platform-ops/alerts",
      "/api/platform/platform-ops/provider-health",
      "/api/platform/platform-ops/resource-freshness",
      "/api/platform/platform-ops/rate-limits",
      "/api/platform/platform-ops/env-status",
    ]) {
      check(`reads the existing route ${route}`, widget.includes(`useWidgetFetch<`) && widget.includes(`"${route}"`));
    }
    check("exactly five fetches", (widget.match(/useWidgetFetch</g) ?? []).length === 5,
      `${(widget.match(/useWidgetFetch</g) ?? []).length}`);
    check("every fetch url is a string literal",
      !/useWidgetFetch<[^>]*>\(\s*[^"]/.test(widget), widget);
  }

  // ── 12. Each group is a DOORWAY onto the workspace that owns its detail ───
  console.log("12. every group names the workspace carrying its full read");
  {
    // The prototype's doorways: Alerts → Providers → Providers → Operations.
    // Two groups deliberately share a target — resource freshness lives in the
    // Providers workspace — so the pairs are asserted by TARGET, not by count
    // of distinct labels.
    const wired = renderSurface({ onOpenWorkspace: () => {} });
    const doorways = [
      ...wired.html.matchAll(/<button type="button" aria-label="([^"]*)"[^>]*>([^<]*)<svg/g),
    ].map((m) => ({ aria: m[1], visible: m[2].trim() }));

    check("one doorway per group", doorways.length === 4, JSON.stringify(doorways));
    check("the doorway labels are the prototype's",
      doorways.map((d) => d.visible).join(",") === "Alerts,Providers,Providers,Operations",
      doorways.map((d) => d.visible).join(","));

    // Every target resolves to a REAL rail workspace, and its label is the
    // registry's — a renamed or removed workspace fails here rather than
    // shipping a doorway onto nothing.
    for (const group of ["alerts", "providers", "freshness", "configuration"] as const) {
      const def = getPlatformWorkspace(GROUP_DOORWAY[group]);
      check(`${group} opens a real workspace (${GROUP_DOORWAY[group]})`, def != null);
      check(`${group}'s doorway is labelled from the registry`,
        def != null && doorways.some((d) => d.visible === def.label && d.aria.includes(GROUP_LABEL[group])),
        JSON.stringify(doorways));
    }

    // Every target is one the Overview workspace actually composes as a doorway,
    // so this surface can never point somewhere the rail does not offer.
    const overview = PLATFORM_AREA_WORKSPACES.PLATFORM_OPS.find((w) => w.workspaceId === "platform-overview");
    for (const group of ["alerts", "providers", "freshness", "configuration"] as const) {
      check(`${group}'s target is a composed Overview doorway`,
        (overview?.doorways ?? []).includes(GROUP_DOORWAY[group]), (overview?.doorways ?? []).join(","));
    }

    // WCAG 2.5.3 — the accessible name begins with the visible text, so voice
    // control still matches what the operator can read.
    for (const d of doorways) {
      check(`accessible name starts with the visible label (${d.visible})`, d.aria.startsWith(d.visible), d.aria);
    }

    // The footnote states the relationship the doorways make good on.
    check("the footnote says each group summarises a workspace",
      wired.text.includes("Each group summarises a workspace on the rail. Open one for its full read."),
      wired.text);

    // Doorways survive every fetch state — a failed group still tells the
    // operator where the full read lives.
    const brokenWired = renderSurface({
      onOpenWorkspace: () => {},
      alerts: failed(), providers: failed(), freshness: failed(), rateLimits: failed(), env: failed(),
    });
    check("doorways still render when every source failed",
      (brokenWired.html.match(/<button type="button" aria-label=/g) ?? []).length === 4);

    // UNWIRED HOST — the rail is local state in PlatformSpaceDashboard and its
    // only summary→detail affordance is the `onOpen(workspaceId)` callback it
    // threads to WorkspaceDoorway. Without it there is nothing to open, so the
    // doorway renders NOTHING rather than a button that does nothing.
    const unwired = renderSurface();
    check("no doorway is rendered when the host wired no handler",
      !unwired.html.includes('<button type="button" aria-label='), unwired.html.slice(0, 400));
    check("and no dead button of any kind is left behind",
      !unwired.html.includes("<button"), unwired.html.slice(0, 400));
  }

  if (failures > 0) { console.error(`\nplatform-health.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nplatform-health.test: all passed.");
}

main();
