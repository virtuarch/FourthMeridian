/**
 * components/platform/overview/overview-model.ts  (Platform Operations 2.0 — R1, plan §4.1)
 *
 * The PURE half of the Platform Overview command center: from what each granted
 * area's OWN routes answered, derive the status header, the merged attention
 * queue and the per-Space KPI tiles. No React, no fetch, no clock — every input
 * is handed in, so it is testable with plain values.
 *
 * HONESTY RULES (enforced here, pinned by platform-overview.test.ts):
 *   · a source that has not answered is LOADING, one that failed is UNAVAILABLE —
 *     neither is ever folded into a zero or into "nothing needs attention";
 *   · the overall verdict exists only where an authority issues one: Platform
 *     Operations' overview (`worst` over its domains). Without that grant there
 *     is no verdict word beyond "Unknown" — areas without a verdict authority
 *     contribute FACTS, not health;
 *   · a series is the route's persisted day buckets, trailing TREND_DAYS; a
 *     missing value is a gap; AI spend is ESTIMATED (tokens × rate card) and
 *     UNKNOWN when no rate covered it — never "billed".
 *
 * The response shapes below are the minimal STRUCTURAL subsets this surface
 * reads (no server module is imported into the client bundle).
 */

import type { MiniBarPoint, StatusTone } from "@/components/platform/platform-surface";
import type { ProvenanceKind } from "@/components/platform/ui/ProvenanceChip";
import { platformAreaHref } from "@/lib/platform/directory";
import { platformWorkspaceHref } from "@/lib/space/use-platform-workspace-navigation";

/** How many trailing UTC days a tile's trend shows. */
export const TREND_DAYS = 14;
/** How many attention items the queue shows (desktop); the primitive shows 3 below sm. */
export const ATTENTION_LIMIT = 5;

export type Severity = "critical" | "error" | "warning" | "info";
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, error: 1, warning: 2, info: 3 };
const SEVERITY_TONE: Record<Severity, StatusTone> = { critical: "bad", error: "bad", warning: "warn", info: "muted" };
const SEVERITY_WORD: Record<Severity, string> = { critical: "Critical", error: "Error", warning: "Warning", info: "Info" };

// ── Source state ─────────────────────────────────────────────────────────────

export type Source<T> =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ok"; data: T; fetchedAt: string | null };

export const LOADING = { status: "loading" } as const;

/** Fold a useWidgetFetch result into a Source. */
export function toSource<T>(r: { data: T | null; loading: boolean; error: string | null; fetchedAt: string | null }): Source<T> {
  if (r.data !== null) return { status: "ok", data: r.data, fetchedAt: r.fetchedAt };
  if (r.loading) return { status: "loading" };
  return { status: "error", error: r.error ?? "Failed to load" };
}

// ── Structural response subsets (each from its own area's route) ─────────────

type DomainState = "HEALTHY" | "DEGRADED" | "FAILED" | "STALE" | "UNKNOWN";

/** /api/platform/platform-ops/overview */
export interface OpsOverviewData {
  checkedAt: string;
  worst: DomainState;
  domains: readonly { key: string; title: string; state: DomainState }[];
}
/** /api/platform/platform-ops/attention */
export interface OpsAttentionData {
  checkedAt: string;
  items: readonly {
    id: string;
    severity: Severity;
    entity: { label: string };
    problem: string;
    since: string | null;
    evidence: { workspace: string };
  }[];
  counts: Partial<Record<Severity, number>>;
  authoritiesFailed?: readonly string[];
}
/** /api/platform/platform-ops/refresh/daily */
export interface OpsRefreshDailyData {
  envelope?: { checkedAt?: string };
  days: readonly { day: string; byStatus: Readonly<Record<string, number>> }[];
  floor?: boolean;
}
/** /api/platform/platform-ops/ai-usage-trend */
export interface OpsAiTrendData {
  checkedAt: string;
  pricingConfigured: boolean;
  days: readonly { day: string; calls: number; estimatedSpendUsd: number | null }[];
  unpricedDays?: readonly string[];
}
/** /api/platform/customer-success/sync-issues */
export interface CsSyncIssuesData {
  items: readonly { id: string; title: string; operationLabel: string | null; description: string; severity: Severity; lastOccurredAt: string }[];
  activeTotal: number;
  truncated: boolean;
  severityCounts: Partial<Record<Severity, number>>;
}
/** /api/platform/customer-success/incidents-daily */
export interface CsIncidentsDailyData {
  checkedAt: string;
  floor: boolean;
  days: readonly { day: string; opened: number; resolved: number }[];
}
/** /api/platform/growth-revenue/product-analytics */
export interface SignupAnalyticsData {
  checkedAt: string;
  registrations: { last7d: number; last30d: number; perDay: readonly { day: string; count: number }[] };
}
/** /api/platform/security-ops/anomalies */
export interface SecurityAnomaliesData {
  trips: readonly { id: string; type: string; count: number; windowMinutes: number; at: string }[];
  summary: { failedLoginsWindow: number; windowMinutes: number; tripsLast24h: number };
}
/** /api/platform/security-ops/daily */
export interface SecurityDailyData {
  checkedAt: string;
  floor: boolean;
  days: readonly { day: string; failedSignIns: number }[];
}

/** Everything the Overview read, per area. An area absent here is NOT granted. */
export interface OverviewSignals {
  PLATFORM_OPS?: { overview: Source<OpsOverviewData>; attention: Source<OpsAttentionData>; refreshDaily: Source<OpsRefreshDailyData>; aiTrend: Source<OpsAiTrendData> };
  CUSTOMER_SUCCESS?: { syncIssues: Source<CsSyncIssuesData>; incidentsDaily: Source<CsIncidentsDailyData> };
  GROWTH_REVENUE?: { analytics: Source<SignupAnalyticsData> };
  SECURITY_OPS?: { anomalies: Source<SecurityAnomaliesData>; daily: Source<SecurityDailyData> };
}

/** A granted Space as the Overview sees it (server-authorized rows). */
export interface OverviewSpace {
  id: string;
  name: string;
  area: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const count = (n: number) => n.toLocaleString("en-US");
const usd = (n: number) => (n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString("en-US")}`);

/** The trailing `TREND_DAYS` of a day series as bar points (a null value stays a gap). */
export function trailingPoints<T extends { day: string }>(days: readonly T[] | null | undefined, value: (d: T) => number | null, tone?: StatusTone): MiniBarPoint[] {
  return (days ?? []).slice(-TREND_DAYS).map((d) => ({ key: d.day, value: value(d), ...(tone ? { tone } : {}) }));
}

/** Sum of the observed values (gaps excluded); null when nothing was observed. */
export function sumObserved(points: readonly MiniBarPoint[]): number | null {
  const observed = points.filter((p) => p.value != null);
  return observed.length === 0 ? null : observed.reduce((n, p) => n + (p.value ?? 0), 0);
}

function nameOf(spaces: readonly OverviewSpace[], area: string): string {
  return spaces.find((s) => s.area === area)?.name ?? area;
}

/** The newest instant any source answered (the "as of" for relative ages), or null. */
export function latestAnswerAt(signals: OverviewSignals): Date | null {
  let best: number | null = null;
  for (const area of Object.values(signals)) {
    for (const src of Object.values(area ?? {}) as Source<unknown>[]) {
      if (src.status !== "ok" || !src.fetchedAt) continue;
      const t = Date.parse(src.fetchedAt);
      if (!Number.isNaN(t) && (best === null || t > best)) best = t;
    }
  }
  return best === null ? null : new Date(best);
}

// ── Status header ────────────────────────────────────────────────────────────

const STATE_WORD: Record<DomainState, string> = { HEALTHY: "Healthy", DEGRADED: "Degraded", FAILED: "Failed", STALE: "Stale", UNKNOWN: "Unknown" };
const STATE_TONE: Record<DomainState, StatusTone> = { HEALTHY: "ok", DEGRADED: "warn", FAILED: "bad", STALE: "warn", UNKNOWN: "muted" };
const STATE_TITLE: Record<DomainState, string> = {
  HEALTHY: "Fourth Meridian is operating normally",
  STALE: "Something is overdue",
  DEGRADED: "Something is degraded",
  FAILED: "Something has failed",
  UNKNOWN: "Health cannot be established",
};

export interface OverviewStatus {
  verdict: { word: string; tone: StatusTone };
  title: string;
  checkedAt: string | null;
  facts: { label: string; value: string; tone?: StatusTone }[];
  /** True when the verdict comes from an authority (Platform Operations overview). */
  authoritative: boolean;
}

export function overviewStatus(signals: OverviewSignals): OverviewStatus {
  const facts: OverviewStatus["facts"] = [];
  const ops = signals.PLATFORM_OPS;
  if (ops?.attention.status === "ok") {
    const n = Object.values(ops.attention.data.counts).reduce<number>((a, b) => a + (b ?? 0), 0);
    facts.push({ label: "Ops attention", value: count(n), tone: n > 0 ? "warn" : undefined });
  }
  const cs = signals.CUSTOMER_SUCCESS;
  if (cs?.syncIssues.status === "ok") {
    const d = cs.syncIssues.data;
    facts.push({ label: "Open incidents", value: d.truncated ? `≥${count(d.activeTotal)}` : count(d.activeTotal), tone: d.activeTotal > 0 ? "warn" : undefined });
  }
  const sec = signals.SECURITY_OPS;
  if (sec?.anomalies.status === "ok") {
    const t = sec.anomalies.data.summary.tripsLast24h;
    facts.push({ label: "Anomaly trips · 24 h", value: count(t), tone: t > 0 ? "warn" : undefined });
  }
  const growth = signals.GROWTH_REVENUE;
  if (growth?.analytics.status === "ok") {
    facts.push({ label: "Sign-ups · 7 d", value: count(growth.analytics.data.registrations.last7d) });
  }

  if (ops) {
    const o = ops.overview;
    if (o.status === "loading") return { verdict: { word: "Checking", tone: "muted" }, title: "Reading Platform health…", checkedAt: null, facts, authoritative: true };
    if (o.status === "error") return { verdict: { word: "Unknown", tone: "muted" }, title: `Platform health could not be read — ${o.error}`, checkedAt: null, facts, authoritative: true };
    const worst = o.data.worst;
    const notHealthy = o.data.domains.filter((d) => d.state !== "HEALTHY" && d.state !== "UNKNOWN").length;
    return {
      verdict: { word: STATE_WORD[worst], tone: STATE_TONE[worst] },
      title: STATE_TITLE[worst],
      checkedAt: o.data.checkedAt,
      facts: [{ label: "Domains not healthy", value: `${notHealthy} of ${o.data.domains.length}`, tone: notHealthy > 0 ? "warn" : undefined }, ...facts],
      authoritative: true,
    };
  }
  // No area the viewer holds issues a platform verdict: facts only, no health word.
  return { verdict: { word: "Unknown", tone: "muted" }, title: "No overall verdict for the Spaces you hold", checkedAt: null, facts, authoritative: false };
}

// ── Attention queue ──────────────────────────────────────────────────────────

export interface QueueItem {
  key: string;
  area: string;
  severity: Severity;
  severityWord: string;
  tone: StatusTone;
  title: string;
  why: string;
  since: string | null;
  meta: string;
  href: string;
  actionLabel: string;
}

export interface QueueTotal {
  area: string;
  label: string;
  href: string;
  count: string;
}

export interface OverviewQueue {
  items: QueueItem[];
  totals: QueueTotal[];
  loading: boolean;
  /** Areas whose attention source could not be read, worded. */
  notes: string[];
  /** True only when every attention source answered and none had an item. */
  allClear: boolean;
}

function ago(iso: string | null, now: Date | null): string | null {
  if (!iso || !now) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const m = Math.max(0, Math.round((now.getTime() - t) / 60_000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function item(area: string, spaces: readonly OverviewSpace[], now: Date | null, p: Omit<QueueItem, "area" | "severityWord" | "tone" | "meta">): QueueItem {
  const when = ago(p.since, now);
  return { ...p, area, severityWord: SEVERITY_WORD[p.severity], tone: SEVERITY_TONE[p.severity], meta: [nameOf(spaces, area), when].filter(Boolean).join(" · ") };
}

/** Stable k-way merge of already-ordered lists by severity rank (heads only). */
function mergeBySeverity(lists: readonly QueueItem[][]): QueueItem[] {
  const idx = lists.map(() => 0);
  const out: QueueItem[] = [];
  for (;;) {
    let pick = -1;
    for (let i = 0; i < lists.length; i++) {
      const head = lists[i][idx[i]];
      if (!head) continue;
      if (pick === -1 || SEVERITY_RANK[head.severity] < SEVERITY_RANK[lists[pick][idx[pick]].severity]) pick = i;
    }
    if (pick === -1) return out;
    out.push(lists[pick][idx[pick]++]);
  }
}

export function attentionQueue(signals: OverviewSignals, spaces: readonly OverviewSpace[], now: Date | null, limit = ATTENTION_LIMIT): OverviewQueue {
  const lists: QueueItem[][] = [];
  const totals: QueueTotal[] = [];
  const notes: string[] = [];
  let loading = false;
  let answered = 0;
  let sources = 0;

  const ops = signals.PLATFORM_OPS;
  if (ops) {
    sources++;
    const a = ops.attention;
    if (a.status === "loading") loading = true;
    else if (a.status === "error") notes.push(`${nameOf(spaces, "PLATFORM_OPS")}: attention unavailable — ${a.error}`);
    else {
      answered++;
      const list: QueueItem[] = [];
      lists.push(list);
      for (const it of a.data.items) {
        list.push(item("PLATFORM_OPS", spaces, now, {
          key: `ops:${it.id}`, severity: it.severity, title: it.entity.label, why: it.problem, since: it.since,
          href: platformWorkspaceHref("PLATFORM_OPS", it.evidence.workspace), actionLabel: "Inspect",
        }));
      }
      const n = Object.values(a.data.counts).reduce<number>((x, y) => x + (y ?? 0), 0);
      if (n > 0) totals.push({ area: "PLATFORM_OPS", label: nameOf(spaces, "PLATFORM_OPS"), href: platformAreaHref("PLATFORM_OPS"), count: count(n) });
      if ((a.data.authoritiesFailed ?? []).length > 0) notes.push(`${nameOf(spaces, "PLATFORM_OPS")}: ${a.data.authoritiesFailed!.length} attention source(s) could not be read`);
    }
  }

  const cs = signals.CUSTOMER_SUCCESS;
  if (cs) {
    sources++;
    const s = cs.syncIssues;
    if (s.status === "loading") loading = true;
    else if (s.status === "error") notes.push(`${nameOf(spaces, "CUSTOMER_SUCCESS")}: incidents unavailable — ${s.error}`);
    else {
      answered++;
      const href = platformWorkspaceHref("CUSTOMER_SUCCESS", "platform-incidents");
      const list: QueueItem[] = [];
      lists.push(list);
      for (const it of s.data.items) {
        list.push(item("CUSTOMER_SUCCESS", spaces, now, {
          key: `cs:${it.id}`, severity: it.severity, title: it.operationLabel ? `${it.title} · ${it.operationLabel}` : it.title,
          why: it.description, since: it.lastOccurredAt, href, actionLabel: "Open incident",
        }));
      }
      if (s.data.activeTotal > 0) totals.push({ area: "CUSTOMER_SUCCESS", label: nameOf(spaces, "CUSTOMER_SUCCESS"), href, count: s.data.truncated ? `≥${count(s.data.activeTotal)}` : count(s.data.activeTotal) });
    }
  }

  const sec = signals.SECURITY_OPS;
  if (sec) {
    sources++;
    const s = sec.anomalies;
    if (s.status === "loading") loading = true;
    else if (s.status === "error") notes.push(`${nameOf(spaces, "SECURITY_OPS")}: anomalies unavailable — ${s.error}`);
    else {
      answered++;
      const href = platformAreaHref("SECURITY_OPS");
      // "Last 24 h" is measured from the instant the route answered.
      const ref = now ?? (s.fetchedAt ? new Date(s.fetchedAt) : null);
      const dayAgo = ref ? ref.getTime() - 24 * 60 * 60_000 : null;
      const list: QueueItem[] = [];
      lists.push(list);
      for (const t of s.data.trips) {
        const at = Date.parse(t.at);
        if (Number.isNaN(at) || dayAgo === null || at < dayAgo) continue;
        list.push(item("SECURITY_OPS", spaces, now, {
          key: `sec:${t.id}`, severity: "warning", title: "Security anomaly",
          why: `${t.type.replace(/_/g, " ")}: ${count(t.count)} in ${t.windowMinutes} min`, since: t.at, href, actionLabel: "Review",
        }));
      }
      if (s.data.summary.tripsLast24h > 0) totals.push({ area: "SECURITY_OPS", label: nameOf(spaces, "SECURITY_OPS"), href, count: count(s.data.summary.tripsLast24h) });
    }
  }

  // MERGE, never re-sort: each area's list arrives already ordered by its own
  // authority (incidents by lib/platform/incidents sortIncidentsForOperator,
  // attention by its core). The merge takes, at each step, the head with the
  // most severe word, ties going to the earlier area — so no second ordering
  // authority is introduced (pinned by incidents/preview-core.test.ts).
  const merged = mergeBySeverity(lists);
  return {
    items: merged.slice(0, limit),
    totals,
    loading,
    notes,
    allClear: sources > 0 && answered === sources && merged.length === 0,
  };
}

// ── KPI tiles ────────────────────────────────────────────────────────────────

export interface TileModel {
  key: string;
  area: string;
  spaceName: string;
  label: string;
  /** null while loading or unavailable (see `state`). */
  value: string | null;
  state: "loading" | "error" | "ok";
  reason?: string;
  points: MiniBarPoint[];
  format: "count" | "usd";
  caption?: string;
  provenance: ProvenanceKind;
  asOf: string | null;
  note?: string;
  href: string;
}

export interface SpaceTiles {
  area: string;
  name: string;
  href: string;
  tiles: TileModel[];
}

function tileFrom<T>(
  base: Pick<TileModel, "key" | "area" | "spaceName" | "label" | "href" | "format"> & { provenance: ProvenanceKind },
  src: Source<T>,
  ok: (d: T) => Pick<TileModel, "value" | "points"> & Partial<Pick<TileModel, "caption" | "note" | "asOf" | "provenance">>,
): TileModel {
  if (src.status === "loading") return { ...base, value: null, state: "loading", reason: "reading…", points: [], asOf: null };
  if (src.status === "error") return { ...base, value: null, state: "error", reason: src.error, points: [], provenance: "UNKNOWN", asOf: null };
  const r = ok(src.data);
  return { ...base, state: "ok", caption: r.caption, note: r.note, asOf: r.asOf ?? src.fetchedAt, value: r.value, points: r.points, provenance: r.provenance ?? base.provenance };
}

export function spaceTiles(signals: OverviewSignals, spaces: readonly OverviewSpace[]): SpaceTiles[] {
  return spaces.map((space) => {
    const href = platformAreaHref(space.area);
    const base = (key: string, label: string, format: TileModel["format"], provenance: ProvenanceKind, tileHref = href) =>
      ({ key, area: space.area, spaceName: space.name, label, href: tileHref, format, provenance });
    const tiles: TileModel[] = [];

    if (space.area === "PLATFORM_OPS" && signals.PLATFORM_OPS) {
      const ops = signals.PLATFORM_OPS;
      tiles.push(tileFrom(base("ops-refresh-failures", `Refresh failures · ${TREND_DAYS} d`, "count", "MEASURED", platformWorkspaceHref("PLATFORM_OPS", "platform-overview", "pipeline")), ops.refreshDaily, (d) => {
        const points = trailingPoints(d.days, (x) => x.byStatus.FAILED ?? 0, "bad");
        const total = sumObserved(points);
        return { value: total === null ? null : count(total), points, caption: `UTC days · last ${points.length} · refresh ledger`, note: d.floor ? "floor — older days not loaded" : undefined, asOf: d.envelope?.checkedAt ?? null };
      }));
      tiles.push(tileFrom(base("ops-ai-calls", `AI calls · ${TREND_DAYS} d`, "count", "MEASURED", platformWorkspaceHref("PLATFORM_OPS", "platform-ai")), ops.aiTrend, (d) => {
        const points = trailingPoints(d.days, (x) => x.calls);
        const total = sumObserved(points);
        return { value: total === null ? null : count(total), points, caption: `UTC days · last ${points.length} · usage counters`, asOf: d.checkedAt };
      }));
      tiles.push(tileFrom(base("ops-ai-spend", `AI spend · ${TREND_DAYS} d`, "usd", "ESTIMATED", platformWorkspaceHref("PLATFORM_OPS", "platform-ai", "costs")), ops.aiTrend, (d) => {
        const points = trailingPoints(d.days, (x) => x.estimatedSpendUsd);
        const total = d.pricingConfigured ? sumObserved(points) : null;
        const inWindow = new Set(points.map((p) => p.key));
        const unpriced = (d.unpricedDays ?? []).filter((x) => inWindow.has(x)).length;
        return {
          value: total === null ? null : usd(total),
          points: d.pricingConfigured ? points : [],
          caption: `UTC days · last ${points.length} · tokens × rate card`,
          note: !d.pricingConfigured ? "no rate card configured" : unpriced > 0 ? `partial — ${unpriced} day(s) unpriced` : undefined,
          provenance: total === null ? "UNKNOWN" : "ESTIMATED",
          asOf: d.checkedAt,
        };
      }));
    }

    if (space.area === "CUSTOMER_SUCCESS" && signals.CUSTOMER_SUCCESS) {
      const cs = signals.CUSTOMER_SUCCESS;
      const incidentsHref = platformWorkspaceHref("CUSTOMER_SUCCESS", "platform-incidents");
      tiles.push(tileFrom(base("cs-open-incidents", "Open sync incidents", "count", "MEASURED", incidentsHref), cs.syncIssues, (d) => ({
        value: d.truncated ? `≥${count(d.activeTotal)}` : count(d.activeTotal), points: [], note: d.truncated ? "floor, not a total" : undefined,
      })));
      tiles.push(tileFrom(base("cs-incidents-opened", `Incidents opened · ${TREND_DAYS} d`, "count", "MEASURED", incidentsHref), cs.incidentsDaily, (d) => {
        const points = trailingPoints(d.days, (x) => x.opened, "warn");
        const total = sumObserved(points);
        return { value: total === null ? null : count(total), points, caption: `UTC days · last ${points.length}`, note: d.floor ? "floor — the read hit its cap" : undefined, asOf: d.checkedAt };
      }));
    }

    if (space.area === "GROWTH_REVENUE" && signals.GROWTH_REVENUE) {
      tiles.push(tileFrom(base("growth-signups", "Sign-ups · 7 d", "count", "MEASURED"), signals.GROWTH_REVENUE.analytics, (d) => {
        const points = trailingPoints(d.registrations.perDay, (x) => x.count);
        return { value: count(d.registrations.last7d), points, caption: `UTC days · last ${points.length} · ${count(d.registrations.last30d)} in 30 d`, asOf: d.checkedAt };
      }));
    }

    if (space.area === "SECURITY_OPS" && signals.SECURITY_OPS) {
      tiles.push(tileFrom(base("sec-failed-signins", `Failed sign-ins · ${TREND_DAYS} d`, "count", "MEASURED"), signals.SECURITY_OPS.daily, (d) => {
        const points = trailingPoints(d.days, (x) => x.failedSignIns);
        const total = sumObserved(points);
        return { value: total === null ? null : count(total), points, caption: `UTC days · last ${points.length} · audit log`, note: d.floor ? "floor — the read hit its cap" : undefined, asOf: d.checkedAt };
      }));
    }

    return { area: space.area, name: space.name, href, tiles };
  });
}

/** The formatter a tile's series uses (shared with the renderer). */
export function tileFormatter(format: TileModel["format"]): (n: number) => string {
  return format === "usd" ? usd : count;
}
