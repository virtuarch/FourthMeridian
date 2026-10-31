/**
 * lib/notifications/delivery/analytics.ts  (Comms Center Phase A-2a)
 *
 * GET /api/platform/customer-success/notifications/delivery (contract §4.11,
 * with C1–C4) as a pure builder over an injected READ SOURCE, plus the 30-day
 * per-key `recent` series of GET /catalog/[key] (§2.1, §4.3). The real source
 * (lib/notifications/delivery/read-store.ts) sums CommsDelivery (≤ 90 days) and
 * CommsDeliveryDaily (the rollup) — a send is in exactly one of them.
 *
 * THE TWO NULLS (C1). Before `coverage.ledgerSince` nothing was observed, so
 * every series day there is `count: null`; an observed day with no sends is 0.
 * `withheld` is NEVER set on this endpoint: delivery counts count messages, not
 * people, and carry no recipient, so the small-cell rule (§4.12 / §4.14) does
 * not apply (§4.11, "Delivery counts are not small-cell withheld"). A count of
 * 1–4 is returned as that number.
 *
 * TOTALS (C3). `totals`, `suppressedByReason` and every `byKey[].counts` carry
 * EVERY key (0 allowed) over the OBSERVED range only, and are null AS A WHOLE
 * when `ledgerSince` is null.
 *
 * SERIES (C2, C4). Six fixed keys — accepted, failed, dead, suppressed,
 * captured, cancelled — always present, each a dense DaySeries with its own
 * `{window, from, to}`; `days.length` is exactly 7, 30 or 90.
 *
 * PII (§3.2): aggregates only — catalog keys, channels, statuses, reasons,
 * counts and dates. The source never selects a recipient column.
 *
 * FAILURE: a source that throws is 503 UNAVAILABLE (runRead), never zeros, an
 * empty byKey or an all-null series.
 */

import { NextResponse } from "next/server";
import { isCatalogKey } from "@/lib/notifications/catalog/definitions";
import { NO_STORE } from "@/lib/notifications/catalog/http";
import { COMMS_CHANNELS, type CommsChannel, type DaySeries } from "@/lib/notifications/catalog/types";
// The response types live in the pure types module (re-exported for the UI by
// lib/notifications/catalog/types.ts); re-exported here for existing importers.
import type { DeliveryAnalytics, DeliveryWindow, ReasonCounts, SeriesKey, StatusCounts } from "@/lib/notifications/delivery/types";
export type { DeliveryAnalytics, DeliveryWindow, ReasonCounts, SeriesKey, StatusCounts };
import { ledgerEnvironment, type LedgerEnv } from "@/lib/notifications/delivery/record";
import {
  DELIVERY_STATUSES,
  SUPPRESSION_REASONS,
  type DeliveryStatus,
  type SuppressionReason,
} from "@/lib/notifications/delivery/types";

export const DELIVERY_WINDOWS = ["7d", "30d", "90d"] as const satisfies readonly DeliveryWindow[];
const WINDOW_DAYS: Record<DeliveryWindow, number> = { "7d": 7, "30d": 30, "90d": 90 };

/** C4 — the six series and the status each one counts. */
export const SERIES_STATUS = {
  accepted: "ACCEPTED",
  failed: "FAILED",
  dead: "DEAD",
  suppressed: "SUPPRESSED",
  captured: "CAPTURED",
  cancelled: "CANCELLED",
} as const satisfies Record<SeriesKey, DeliveryStatus>;
export const SERIES_KEYS = Object.keys(SERIES_STATUS) as SeriesKey[];

/** One aggregated cell from the source: UTC day × key × channel × status × reason. */
export interface DeliveryCountRow {
  day: string; // YYYY-MM-DD UTC
  definitionKey: string;
  channel: string;
  status: string;
  /** "" or null = no reason. */
  reason: string | null;
  count: number;
}

export interface DeliveryCountQuery {
  /** Inclusive UTC days, YYYY-MM-DD. */
  from: string;
  to: string;
  channel: CommsChannel | null;
  status: DeliveryStatus | null;
  key: string | null;
}

export interface DeliveryReadSource {
  /** The first UTC day the ledger (or its rollup) holds a row for; null = nothing observed yet. */
  ledgerSince(): Promise<string | null>;
  counts(q: DeliveryCountQuery): Promise<DeliveryCountRow[]>;
}

const DAY_MS = 86_400_000;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The inclusive UTC days of a window ending today (UTC), ascending. */
export function windowDays(now: Date, window: DeliveryWindow): string[] {
  const n = WINDOW_DAYS[window];
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: n }, (_, i) => isoDay(today - (n - 1 - i) * DAY_MS));
}

const zeroStatuses = (): StatusCounts => Object.fromEntries(DELIVERY_STATUSES.map((s) => [s, 0])) as StatusCounts;
const zeroReasons = (): ReasonCounts => Object.fromEntries(SUPPRESSION_REASONS.map((r) => [r, 0])) as ReasonCounts;
const isStatus = (s: string): s is DeliveryStatus => (DELIVERY_STATUSES as readonly string[]).includes(s);
const isReason = (r: string): r is SuppressionReason => (SUPPRESSION_REASONS as readonly string[]).includes(r);

/** C1 + C2 — a dense series: null before `since` (or when nothing is observed), else the day's count (0 default). */
export function denseSeries(window: DeliveryWindow, days: readonly string[], since: string | null, byDay: ReadonlyMap<string, number>): DaySeries {
  return {
    window,
    from: days[0],
    to: days[days.length - 1],
    days: days.map((day) => ({ day, count: since === null || day < since ? null : (byDay.get(day) ?? 0) })),
    floor: false,
  };
}

/** Build the §4.11 payload. Pure apart from the injected source. */
export async function buildDeliveryAnalytics(args: {
  source: DeliveryReadSource;
  window: DeliveryWindow;
  filters: DeliveryAnalytics["filters"];
  now: Date;
  env: LedgerEnv;
}): Promise<DeliveryAnalytics> {
  const { source, window, filters, now } = args;
  const days = windowDays(now, window);
  const from = days[0];
  const to = days[days.length - 1];
  const since = await source.ledgerSince();
  const observedFrom = since === null ? null : (since > from ? since : from);

  const rows = observedFrom !== null && observedFrom <= to
    ? await source.counts({ from: observedFrom, to, channel: filters.channel, status: filters.status, key: filters.template })
    : [];

  const perSeries = new Map<DeliveryStatus, Map<string, number>>();
  const totals = zeroStatuses();
  const reasons = zeroReasons();
  const byKey = new Map<string, StatusCounts>();
  for (const r of rows) {
    // Belt and braces: the source is asked for the observed range and the filters; re-check both here.
    if (!isStatus(r.status) || r.day < (observedFrom ?? "") || r.day > to) continue;
    if (filters.channel && r.channel !== filters.channel) continue;
    if (filters.status && r.status !== filters.status) continue;
    if (filters.template && r.definitionKey !== filters.template) continue;
    const n = Number.isFinite(r.count) && r.count > 0 ? Math.floor(r.count) : 0;
    totals[r.status] += n;
    if (r.status === "SUPPRESSED" && r.reason && isReason(r.reason)) reasons[r.reason] += n;
    const k = byKey.get(r.definitionKey) ?? zeroStatuses();
    k[r.status] += n;
    byKey.set(r.definitionKey, k);
    const s = perSeries.get(r.status) ?? new Map<string, number>();
    s.set(r.day, (s.get(r.day) ?? 0) + n);
    perSeries.set(r.status, s);
  }

  const observed = since !== null;
  const series = Object.fromEntries(SERIES_KEYS.map((key) =>
    [key, denseSeries(window, days, since, perSeries.get(SERIES_STATUS[key]) ?? new Map())])) as Record<SeriesKey, DaySeries>;

  return {
    window,
    from,
    to,
    filters,
    totals: observed ? totals : null,
    suppressedByReason: observed ? reasons : null,
    byKey: observed ? [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, counts]) => ({ key, counts })) : null,
    series,
    measured: { delivered: false, opens: false, clicks: false },
    // Every sendEmail call site and createNotification write the ledger (A-2a).
    coverage: { ledgerSince: since, directSendsCovered: true, environment: ledgerEnvironment(args.env) },
    providerHealth: { href: "/dashboard/platform/PLATFORM_OPS?workspace=platform-providers", source: "GET /api/platform/platform-ops/email-health" },
    floor: false,
    capped: false,
    checkedAt: now.toISOString(),
  };
}

/** §2.1 — CatalogDetail.recent: every recorded outcome of one key per UTC day, last 30 days. */
export async function recentSeriesForKey(source: DeliveryReadSource, key: string, now: Date): Promise<DaySeries> {
  const days = windowDays(now, "30d");
  const since = await source.ledgerSince();
  const from = since === null ? null : (since > days[0] ? since : days[0]);
  const byDay = new Map<string, number>();
  if (from !== null && from <= days[days.length - 1]) {
    for (const r of await source.counts({ from, to: days[days.length - 1], channel: null, status: null, key })) {
      if (r.definitionKey !== key || r.day < from) continue;
      byDay.set(r.day, (byDay.get(r.day) ?? 0) + (r.count > 0 ? Math.floor(r.count) : 0));
    }
  }
  return denseSeries("30d", days, since, byDay);
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const validation = (error: string) => json({ error, code: "VALIDATION" }, 400);
const ACCEPTED_PARAMS = new Set(["window", "channel", "status", "template"]);

/** GET /delivery (§4.11). Validates, then builds; a source failure throws (runRead → 503). */
export async function deliveryAnalytics(url: URL, now: Date, source: DeliveryReadSource, env: LedgerEnv): Promise<Response> {
  const p = url.searchParams;
  for (const name of p.keys()) {
    if (!ACCEPTED_PARAMS.has(name)) return validation("Only window, channel, status and template are accepted.");
  }
  const window = p.get("window") ?? "7d";
  if (!(DELIVERY_WINDOWS as readonly string[]).includes(window)) return validation("window must be one of 7d, 30d, 90d.");
  const channel = p.get("channel");
  if (channel !== null && !(COMMS_CHANNELS as readonly string[]).includes(channel)) return validation("Unknown channel.");
  const status = p.get("status");
  if (status !== null && !isStatus(status)) return validation("Unknown status.");
  const template = p.get("template");
  if (template !== null && !isCatalogKey(template)) return validation("template must be a catalog key.");
  const body = await buildDeliveryAnalytics({
    source,
    window: window as DeliveryWindow,
    filters: { channel: channel as CommsChannel | null, status: status as DeliveryStatus | null, template },
    now,
    env,
  });
  return json(body satisfies DeliveryAnalytics);
}
