/**
 * components/platform/widgets/platform-health-view.ts  (PM-1)
 *
 * The consolidated Platform Health surface's presentation vocabulary. Pure,
 * React-free, clock-injected, and testable without rendering anything.
 *
 * ── WHAT IT MAY DO ───────────────────────────────────────────────────────────
 * Turn a value five EXISTING routes already serve into the exact words and the
 * exact design token used to show it, and ORDER states those routes' own
 * authorities already assigned.
 *
 * ── WHAT IT MUST NOT DO ──────────────────────────────────────────────────────
 * Decide what any value IS. There is no staleness maths here, no availability
 * ratio, no trust computation, no threshold. Provider trust arrives decided by
 * lib/platform/provider-health.ts; resource health arrives decided by
 * lib/platform/resource-freshness.ts; env verdicts arrive decided by lib/env.ts.
 * The moment a function here computes one of those, the authority has been
 * forked and two parts of the product start disagreeing about the platform.
 *
 * The three orderings below (`TRUST_STATUS`, `FRESHNESS_STATUS`, and env's
 * fail/warn/pass) are the one judgement this file makes, and each is a RANKING
 * of an authority's own enum, not a new opinion about a resource:
 *   · provider trust — lib/platform/provider-health.ts documents the roll-up as
 *     "content OR execution, worst-wins"; this ranks the result it produced.
 *   · resource state — lib/alerts/evaluate.ts already ranks these for alerting:
 *     `empty` (a cold archive — the incident shape) is critical, `stale` is a
 *     warning, and an `empty` whose trust is "unknown" is a KNOWN-BLOCKED
 *     pipeline that must not read as a failure ("honest, not a false alarm").
 *     That exact rule is mirrored here so the surface and the alerts agree.
 *   · env — `fail`/`warn`/`pass` is lib/env.ts's own three-way verdict.
 *
 * ── THE FOUR STATES ──────────────────────────────────────────────────────────
 * loading ≠ empty ≠ error ≠ unknown. Loading and error are owned by the caller
 * (they come from the fetch, not from a response), so this file owns the other
 * two: a route that answered with an EMPTY registry returns `unknown` with a
 * headline that says the registry is empty, and a value the platform does not
 * have is worded as absent — never as zero, never as fine.
 */

import type { PlatformAlertsResponse } from "@/app/api/platform/platform-ops/alerts/route";
import type { ProviderHealthResponse } from "@/app/api/platform/platform-ops/provider-health/route";
import type { ResourceFreshnessResponse } from "@/app/api/platform/platform-ops/resource-freshness/route";
import type { PlatformRateLimitsResponse } from "@/app/api/platform/platform-ops/rate-limits/route";
import type { PlatformEnvStatusResponse } from "@/app/api/platform/platform-ops/env-status/route";
import type { ProviderTrust } from "@/lib/platform/provider-health";
import type { FreshnessHealthState } from "@/lib/platform/resource-freshness";

// ── Status vocabulary ─────────────────────────────────────────────────────────

/**
 * How loudly a group asks to be opened.
 *
 * `nominal` is the weakest claim the English language will let this surface
 * make: the named authority found nothing outside ITS OWN thresholds. It is not
 * "healthy" and it is not "all clear" — absence of signal is not proof of
 * health, and the surface footnote says so in as many words.
 */
export type HealthStatus = "nominal" | "caution" | "critical" | "unknown";

/** The WORD. Always rendered; colour is never the only carrier (StatusWord). */
export const STATUS_WORD: Record<HealthStatus, string> = {
  nominal:  "Nominal",
  caution:  "Caution",
  critical: "Action needed",
  unknown:  "Unknown",
};

/**
 * The token. Urgency is SATURATION, not darkness — `--coral-600` measures 3.28:1
 * on the dark surface and fails WCAG AA for small text, so danger is the fully
 * saturated `--coral-400` and caution its lighter tint, matching the ramp
 * components/atlas/tones.ts ships and the map incident-preview-view.ts uses.
 *
 * `nominal` deliberately gets no colour of its own: a green "everything is fine"
 * pill is the single most dishonest mark an operational surface can carry.
 */
export const STATUS_TOKEN: Record<HealthStatus, string> = {
  nominal:  "var(--text-primary)",
  caution:  "var(--coral-300)",
  critical: "var(--coral-400)",
  unknown:  "var(--text-muted)",
};

/** Ordering only. `unknown` outranks `nominal` so not-knowing never reads as fine. */
const RANK: Record<HealthStatus, number> = { nominal: 0, unknown: 1, caution: 2, critical: 3 };

/** Worst-wins over statuses that were already assigned elsewhere. */
export function worstStatus(statuses: readonly HealthStatus[]): HealthStatus {
  let worst: HealthStatus = "nominal";
  for (const s of statuses) if (RANK[s] > RANK[worst]) worst = s;
  return worst;
}

// ── Line / source shapes ──────────────────────────────────────────────────────

/** How a single line reads. `bad` and `unknown` only where an AUTHORITY said so. */
export type LineTone = "normal" | "bad" | "unknown";

export const LINE_TOKEN: Record<LineTone, string> = {
  normal:  "var(--text-muted)",
  bad:     "var(--coral-400)",
  unknown: "var(--text-muted)",
};

export interface HealthLine {
  /** What it is — a provider, a resource, a variable, an endpoint bucket. */
  label: string;
  /** What is true of it. Always contains the state in WORDS, never a bare colour. */
  detail: string;
  tone: LineTone;
}

/**
 * One authority's answer, ready to render.
 *
 * `status: null` means THIS SOURCE CARRIES NO HEALTH VERDICT — the platform has
 * no threshold for it, so it is reported and not judged. That is a third thing,
 * distinct from `nominal` (an authority looked and found nothing wrong) and from
 * `unknown` (an authority exists but has nothing to say yet).
 */
export interface SourceView {
  status: HealthStatus | null;
  /** The one line that decides whether an operator opens the detail workspace. */
  headline: string;
  lines: HealthLine[];
  /** The caveat that keeps the numbers above from being over-read. */
  note?: string;
}

// ── Phrasing for the states the caller owns ───────────────────────────────────

export const LOADING_TEXT = "Loading…";

/**
 * A failed fetch NEVER degrades into zero, into empty, or into fine. The second
 * sentence is not decoration: "0 alerts" produced by an outage is the exact
 * false reassurance this surface exists to prevent.
 */
export function unavailableText(subject: string): string {
  return `${subject} unavailable — the platform could not be asked. This is not a report that nothing is wrong.`;
}

/** The surface's own honesty line. Rendered once, under every group.
 *
 * The closing sentence is the prototype's, and it is what the doorways below
 * make true: this surface SUMMARISES four workspaces, so an operator who needs
 * the full read is told there is one and where it is. */
export const SURFACE_FOOTNOTE =
  "Each group reports only what its named authority observed. Nominal means that authority found nothing " +
  "outside its own thresholds — it is not a verdict on the platform, and anything no authority watches does " +
  "not appear here at all. Each group summarises a workspace on the rail. Open one for its full read.";

// ── Groups and their doorways ─────────────────────────────────────────────────

/**
 * The four groups, by identity rather than by position.
 *
 * A doorway is a promise that a fuller read EXISTS somewhere, so the target is
 * named as a rail workspace id from `lib/platform/workspaces.ts` and its LABEL
 * is resolved from that same registry at render time — never re-typed here.
 * `platform-health.test.ts` asserts every target resolves, so a workspace that
 * is renamed or removed fails the suite instead of shipping a doorway onto
 * nothing.
 *
 * Freshness and Providers deliberately share a target: `ops_resource_freshness`
 * is composed into the Providers workspace, which is where its detail actually
 * lives. Configuration opens Operations, which is the workspace that owns the
 * platform's manual operational surface.
 */
export type HealthGroupId = "alerts" | "providers" | "freshness" | "configuration";

export const GROUP_LABEL: Record<HealthGroupId, string> = {
  alerts:        "Alerts",
  providers:     "Providers",
  freshness:     "Freshness",
  configuration: "Configuration",
};

/** Group → the rail workspace id that owns its detail (PLATFORM_AREA_WORKSPACES). */
export const GROUP_DOORWAY: Record<HealthGroupId, string> = {
  alerts:        "platform-alerts",
  providers:     "platform-providers",
  freshness:     "platform-providers",
  configuration: "platform-operations",
};

/** The accessible name of a doorway. Begins with the visible text (WCAG 2.5.3)
 *  and then disambiguates, because two groups open the same workspace. */
export function doorwayLabel(workspaceLabel: string, group: HealthGroupId): string {
  return `${workspaceLabel} — open the workspace behind ${GROUP_LABEL[group]}`;
}

// ── Relative age (clock injected, so every builder is deterministic) ──────────

/**
 * Compact relative age, e.g. "3m" / "2h" / "5d".
 *
 * A near-twin of widget-kit's `timeAgo`, and deliberately not a call to it: that
 * one reads `Date.now()` internally, which makes every phrase built from it
 * untestable and makes this module import a "use client" React file. Taking the
 * clock as an argument is what lets the tests pin the wording instead of the
 * hour they happened to run.
 */
export function relativeAge(iso: string, nowMs: number): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** An age we could not parse is stated as unknown, never rendered as "now". */
function agePhrase(iso: string | null, nowMs: number): string {
  if (iso == null) return "not recorded";
  const age = relativeAge(iso, nowMs);
  return age == null ? "timestamp unreadable" : `${age} ago`;
}

// ── Alerts ────────────────────────────────────────────────────────────────────

/**
 * Alert posture from /api/platform/platform-ops/alerts.
 *
 * THE THING THIS MUST NOT SAY IS "n open". The prototype's headline was "1 open",
 * and there is no open/closed authority in production — `history` is a DELIVERY
 * log derived from evaluate-alerts JobRun summaries. So the headline counts
 * recent firings and the note names the gap rather than papering over it.
 *
 * When the evaluator has never run, nothing at all is known about alerting, and
 * that is `unknown` — not "0 recent firings", which would read as quiet.
 */
export function alertsView(d: PlatformAlertsResponse, nowMs: number): SourceView {
  if (d.rules.length === 0) {
    return {
      status: "unknown",
      headline: "No alert rules registered",
      lines: [],
      note: "Nothing is being watched, so nothing here can fire.",
    };
  }

  const enabled = d.rules.filter((r) => r.enabled).length;
  const dormant = d.rules.filter((r) => !r.live).length;
  const neverEvaluated = d.lastEvaluatedAt == null;
  const anyCritical = d.history.some((h) => h.severity === "critical");

  const status: HealthStatus = neverEvaluated
    ? "unknown"
    : anyCritical
      ? "critical"
      : d.history.length > 0
        ? "caution"
        : "nominal";

  const headline = neverEvaluated
    ? "Never evaluated"
    : d.history.length > 0
      ? `${d.history.length} recent firing${d.history.length === 1 ? "" : "s"}`
      : `${enabled} of ${d.rules.length} rules enabled`;

  const lines: HealthLine[] = [
    {
      label: "Rules enabled",
      detail: dormant > 0
        ? `${enabled} of ${d.rules.length} · ${dormant} dormant, awaiting an authority`
        : `${enabled} of ${d.rules.length}`,
      tone: "normal",
    },
    {
      label: "Last evaluated",
      detail: neverEvaluated ? "Never — no evaluation recorded" : agePhrase(d.lastEvaluatedAt, nowMs),
      tone: neverEvaluated ? "unknown" : "normal",
    },
    {
      label: "Destination",
      // Not configured is a real operational fact: a firing rule with nowhere to
      // go is silent. It is worded, not blanked.
      detail: d.destination ?? "Not configured — deliveries have nowhere to go",
      tone: d.destination ? "normal" : "unknown",
    },
    ...d.history.slice(0, 2).map((h): HealthLine => ({
      label: h.summary,
      detail: `${h.severity} · delivered ${agePhrase(h.deliveredAtISO, nowMs)}`,
      tone: h.severity === "critical" ? "bad" : "normal",
    })),
  ];

  return {
    status,
    headline,
    lines,
    note: "Delivery history only — whether an alert is still open is not recorded anywhere.",
  };
}

// ── Providers ─────────────────────────────────────────────────────────────────

/** Provider trust → its phrasing. Enum spelling must never reach an operator. */
export const TRUST_WORD: Record<ProviderTrust, string> = {
  OPERATIONAL: "Operational",
  DEGRADED:    "Degraded",
  STALE:       "Stale data",
  FAILING:     "Failing",
  UNKNOWN:     "Unknown",
};

/** Ranking of a verdict lib/platform/provider-health.ts already reached. */
const TRUST_STATUS: Record<ProviderTrust, HealthStatus> = {
  OPERATIONAL: "nominal",
  DEGRADED:    "caution",
  STALE:       "critical",
  FAILING:     "critical",
  UNKNOWN:     "unknown",
};

export function providersView(d: ProviderHealthResponse): SourceView {
  if (d.providers.length === 0) {
    return {
      status: "unknown",
      headline: "No providers registered",
      lines: [],
      note: "The provider registry is empty, so no provider is being observed.",
    };
  }

  const status = worstStatus(d.providers.map((p) => TRUST_STATUS[p.trust]));

  return {
    status,
    headline: `${d.counts.OPERATIONAL} of ${d.providers.length} operational`,
    // Every registered provider is listed. The registry is small and static, so
    // there is no truncation and therefore no provider that a "top N" cut could
    // hide precisely because it was the broken one.
    lines: d.providers.map((p): HealthLine => ({
      label: p.label,
      detail: `${TRUST_WORD[p.trust]} · ${p.freshness.detail}`,
      tone: TRUST_STATUS[p.trust] === "nominal" ? "normal" : TRUST_STATUS[p.trust] === "unknown" ? "unknown" : "bad",
    })),
    note: "Trust is the provider authority's own roll-up of content and execution.",
  };
}

// ── Freshness ─────────────────────────────────────────────────────────────────

/** Resource state → its phrasing. */
export const FRESHNESS_WORD: Record<FreshnessHealthState, string> = {
  fresh: "Fresh",
  stale: "Stale",
  empty: "Empty",
  idle:  "Idle",
};

/**
 * Ranking of a state lib/platform/resource-freshness.ts already assigned, using
 * the SAME weighting lib/alerts/evaluate.ts uses to alert on it. `empty` is
 * conditional and handled in the builder: a cold archive whose pipeline is
 * known-blocked carries trust "unknown", and alerting deliberately skips it, so
 * this surface must not paint it red either.
 */
const FRESHNESS_STATUS: Record<FreshnessHealthState, HealthStatus> = {
  fresh: "nominal",
  idle:  "nominal",
  stale: "caution",
  empty: "critical",
};

export function freshnessView(d: ResourceFreshnessResponse): SourceView {
  if (d.resources.length === 0) {
    return {
      status: "unknown",
      headline: "No refreshable resources registered",
      lines: [],
      note: "Nothing is registered for freshness checking, so nothing here is being watched.",
    };
  }

  const statusOf = (r: ResourceFreshnessResponse["resources"][number]): HealthStatus =>
    r.healthState === "empty" && r.trust.level === "unknown" ? "unknown" : FRESHNESS_STATUS[r.healthState];

  const notFresh = d.counts.stale + d.counts.empty;

  return {
    status: worstStatus(d.resources.map(statusOf)),
    headline: notFresh > 0 ? `${notFresh} not fresh` : "Nothing stale or empty",
    lines: d.resources.map((r): HealthLine => {
      const st = statusOf(r);
      const when = r.newestObservedDate ? `newest ${r.newestObservedDate}` : "no observations";
      const caveat = r.trust.caveats[0];
      return {
        label: r.label,
        detail: `${FRESHNESS_WORD[r.healthState]} · ${when} · trust ${r.trust.level}${caveat ? ` · ${caveat}` : ""}`,
        tone: st === "nominal" ? "normal" : st === "unknown" ? "unknown" : "bad",
      };
    }),
    note: "Freshness is read from the stored data, never from a job's exit status.",
  };
}

// ── Configuration · environment ───────────────────────────────────────────────

export function envView(d: PlatformEnvStatusResponse): SourceView {
  const failing = d.keys.filter((k) => k.status === "fail");
  const warning = d.keys.filter((k) => k.status === "warn");

  const status: HealthStatus =
    d.counts.fail > 0 ? "critical" : d.counts.warn > 0 ? "caution" : "nominal";

  const headline =
    d.counts.fail > 0
      ? `${d.counts.fail} failing`
      : d.counts.warn > 0
        ? `${d.counts.warn} warning`
        : "All checked variables set";

  return {
    status,
    headline,
    lines: [
      { label: "Environment", detail: d.nodeEnv, tone: "normal" },
      ...[...failing, ...warning].map((k): HealthLine => ({
        label: k.key,
        detail: `${k.status} · required ${k.scope}${k.note ? ` · ${k.note}` : ""}`,
        tone: k.status === "fail" ? "bad" : "normal",
      })),
    ],
    // Says what the check covers, so a pass is not read as "the configuration is
    // correct" — only as "the keys lib/env.ts knows about are present".
    note: "Names and verdicts only, for the keys lib/env.ts checks. No value is ever read.",
  };
}

// ── Configuration · rate-limit pressure ───────────────────────────────────────

/**
 * Rate-limit pressure from /api/platform/platform-ops/rate-limits.
 *
 * `status` is null, and that is the honest answer rather than a missing feature:
 * nothing in this codebase defines what a healthy number of rate-limit hits is.
 * Painting this "Nominal" would invent a threshold; painting it "Unknown" would
 * claim we cannot see it, when we can see it perfectly and simply have nothing
 * to compare it against. So it is reported and not judged, and the note says so.
 */
export function rateLimitsView(d: PlatformRateLimitsResponse, nowMs: number): SourceView {
  const TOP = 3;
  const hidden = Math.max(0, d.topBuckets.length - TOP);

  return {
    status: null,
    headline:
      d.totalRows === 0
        ? "No rate-limit activity in the window"
        : `${d.totalHits} hits across ${d.totalRows} keys`,
    lines: [
      { label: "Window opened", detail: agePhrase(d.windowSince, nowMs), tone: "normal" },
      ...d.topBuckets.slice(0, TOP).map((b): HealthLine => ({
        label: b.bucket,
        detail: `${b.hits} hits · ${b.keys} keys`,
        tone: "normal",
      })),
      ...(hidden > 0
        ? [{ label: `${hidden} further endpoint bucket${hidden === 1 ? "" : "s"}`, detail: "not shown", tone: "normal" as LineTone }]
        : []),
    ],
    note: "No threshold authority exists for rate-limit pressure, so this is reported, not judged.",
  };
}
