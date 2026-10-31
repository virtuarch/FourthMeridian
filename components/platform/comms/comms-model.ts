/**
 * components/platform/comms/comms-model.ts  (Customer Success — Communications Center, pure)
 *
 * Words and shapes for the four Communications views (Library · Automations ·
 * Delivery & History · Preferences). No React, no fetch, no clock.
 *
 * Honesty rules this module owns (contract §3.1 C1–C3):
 *   • a `null` count is NOT OBSERVED — it is never drawn, summed or shown as 0;
 *   • a `withheld` count is OBSERVED but a small cell (1–4 people) — drawn and
 *     worded distinctly from "not observed", never as a number;
 *   • a list says when it was checked, and when its totals are a floor or capped.
 */

import {
  CATALOG_CATEGORIES, COMMS_CHANNELS, CONSENT_CLASSES, AUDIENCES, DEFINITION_STATUS_ORDER,
  type CatalogItem, type CommsChannel, type ConsentClass, type DaySeries, type DefinitionStatus, type PreviewChannel, type Severity,
} from "@/lib/notifications/catalog/types";
import type { StatusTone } from "../platform-surface";
import {
  DELIVERY_STATUSES, SUPPRESSION_REASONS,
  type Aggregate, type AutomationState, type DeliveryStatus, type StatusCounts, type SuppressionReason,
} from "@/lib/platform/comms-center/contract-v1-section-4";

const n = (v: number) => v.toLocaleString("en-US");

// ── Owner-approved decisions, as UI copy (one place) ────────────────────────────

export const COMMS_POLICY = {
  elevated: "Activating a customer-facing automation requires elevated operator permission.",
  protectedAlerts: "Security alerts can’t be muted, paused or re-routed.",
  retention: "Delivery records are kept 90 days; after that only daily counts remain.",
  noTracking: "No open or click tracking, ever — no tracking pixels and no link rewriting.",
  storm: "Storm limit: at most 5 emails per person per hour from automations. Security messages are exempt.",
  noPii: "No recipient addresses or message bodies are shown here. Previews use synthetic data only.",
  previewBanner: "[PREVIEW] synthetic — fictional data, never sent",
} as const;

export const STORM_LIMIT = { emails: 5, perHours: 1 } as const;
/** Owner decision: delivery rows are kept 90 days, then counts only (the detail flags a server value that differs). */
export const DELIVERY_RETENTION_POLICY_DAYS = 90;

// ── Labels ──────────────────────────────────────────────────────────────────────

const title = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

export const STATUS_LABEL: Record<DefinitionStatus, string> = {
  ENABLED: "Enabled", BUILD: "Approved, not built", BUILD_OFF: "Built off", PROPOSED: "Proposed",
  VOCABULARY: "Vocabulary", NONE_BY_DESIGN: "None by design", RETIRED: "Retired",
};
export const STATUS_TONE: Record<DefinitionStatus, StatusTone> = {
  ENABLED: "ok", BUILD: "info", BUILD_OFF: "muted", PROPOSED: "muted", VOCABULARY: "muted", NONE_BY_DESIGN: "muted", RETIRED: "muted",
};
export const CONSENT_LABEL: Record<ConsentClass, string> = {
  SECURITY_CRITICAL: "Security", CEREMONY: "Ceremony", SERVICE: "Service", AWARENESS: "Awareness", MARKETING: "Marketing", OPERATOR: "Operator",
};
export const CHANNEL_LABEL: Record<CommsChannel, string> = { IN_APP: "In-app", EMAIL: "Email", OPERATOR_EMAIL: "Operator email", BANNER: "Banner" };
export const SEVERITY_TONE: Record<Severity, StatusTone> = { info: "muted", notice: "info", warning: "warn", critical: "bad" };
export const PREVIEW_LABEL: Record<PreviewChannel, string> = { "email-html": "Email", "email-text": "Email text", "in-app": "In-app", operator: "Operator", banner: "Banner" };

export const FILTER_OPTIONS = {
  status: DEFINITION_STATUS_ORDER.map((v) => ({ value: v, label: STATUS_LABEL[v] })),
  category: CATALOG_CATEGORIES.map((v) => ({ value: v, label: title(v) })),
  audience: AUDIENCES.map((v) => ({ value: v, label: title(v) })),
  channel: COMMS_CHANNELS.map((v) => ({ value: v, label: CHANNEL_LABEL[v] })),
  consentClass: CONSENT_CLASSES.map((v) => ({ value: v, label: CONSENT_LABEL[v] })),
} as const;

export const humanize = title;

// ── Status totals as chips ──────────────────────────────────────────────────────

export interface StatusChip { status: DefinitionStatus; label: string; count: number }

/** Every status, in the contract's sort order, with its count (0 allowed). */
export function statusChips(totals: Record<DefinitionStatus, number>): StatusChip[] {
  return DEFINITION_STATUS_ORDER.map((s) => ({ status: s, label: STATUS_LABEL[s], count: totals[s] ?? 0 }));
}

export function totalOf(totals: Record<DefinitionStatus, number>): number {
  return DEFINITION_STATUS_ORDER.reduce((a, s) => a + (totals[s] ?? 0), 0);
}

// ── Catalog row facts ───────────────────────────────────────────────────────────

export function automationsLine(a: CatalogItem["automations"]): string {
  return `${n(a.active)} active · ${n(a.paused)} paused · ${n(a.draft)} draft`;
}

/** The preview renditions a definition's channels can offer (contract §4.4 channel mapping). */
export function previewChannelsFor(channels: ReadonlyArray<{ channel: CommsChannel }>): PreviewChannel[] {
  const has = (c: CommsChannel) => channels.some((x) => x.channel === c);
  const out: PreviewChannel[] = [];
  if (has("EMAIL")) out.push("email-html", "email-text");
  if (has("IN_APP")) out.push("in-app");
  if (has("OPERATOR_EMAIL")) out.push("operator");
  if (has("BANNER")) out.push("banner");
  return out;
}

/** Whether the owner's storm limit applies to this definition, and how. */
export function stormNote(d: Pick<CatalogItem, "consentClass" | "channels">): string | null {
  if (!d.channels.some((c) => c.channel === "EMAIL")) return null;
  return d.consentClass === "SECURITY_CRITICAL"
    ? "Storm limit: exempt — security messages are never held back by the 5-per-hour email limit."
    : COMMS_POLICY.storm;
}

// ── Day series (C1 + C2) ────────────────────────────────────────────────────────

export type DayState = "observed" | "not-observed" | "withheld";
export interface DayCell { day: string; state: DayState; count: number | null }

export function dayCells(series: DaySeries): DayCell[] {
  return series.days.map((d) => {
    if (d.withheld) return { day: d.day, state: "withheld", count: null };
    if (d.count === null) return { day: d.day, state: "not-observed", count: null };
    return { day: d.day, state: "observed", count: d.count };
  });
}

export interface DaySummary {
  days: number;
  observed: number;
  notObserved: number;
  withheld: number;
  /** Sum over OBSERVED days only; null when no day was observed (never 0 for "unknown"). */
  total: number | null;
  max: number;
}

export function daySummary(series: DaySeries): DaySummary {
  const cells = dayCells(series);
  const obs = cells.filter((c) => c.state === "observed");
  return {
    days: cells.length,
    observed: obs.length,
    notObserved: cells.filter((c) => c.state === "not-observed").length,
    withheld: cells.filter((c) => c.state === "withheld").length,
    total: obs.length ? obs.reduce((a, c) => a + (c.count ?? 0), 0) : null,
    max: obs.reduce((m, c) => Math.max(m, c.count ?? 0), 0),
  };
}

export function daySummaryText(s: DaySummary, noun = "send"): string {
  if (s.observed === 0 && s.withheld === 0) return `Not observed yet · ${s.days} UTC days without ledger coverage`;
  const parts = [s.total === null ? "no observed total" : `${n(s.total)} ${noun}${s.total === 1 ? "" : "s"} on observed days`];
  if (s.notObserved) parts.push(`${s.notObserved} day${s.notObserved === 1 ? "" : "s"} not observed`);
  if (s.withheld) parts.push(`${s.withheld} day${s.withheld === 1 ? "" : "s"} withheld (fewer than 5)`);
  return parts.join(" · ");
}

// ── Small-cell counts (C1) ──────────────────────────────────────────────────────

export type CountState = "value" | "withheld" | "not-observed";
export interface CountCell { state: CountState; text: string; value: number | null }

/** One count that may be withheld (observed small cell) or not observed. */
export function countCell(value: number | null, withheld: boolean): CountCell {
  if (value !== null) return { state: "value", text: n(value), value };
  return withheld ? { state: "withheld", text: "<5", value: null } : { state: "not-observed", text: "—", value: null };
}

export const aggregateCell = (a: Aggregate): CountCell => countCell(a.value, a.withheld);

// ── List envelope notes ─────────────────────────────────────────────────────────

/** The floor / capped words every list carries (empty when neither applies). */
export function envelopeNotes(e: { floor: boolean; capped?: boolean; nextCursor?: string | null }): string[] {
  const out: string[] = [];
  if (e.floor) out.push("Totals are a floor — a scan limit was reached, so the real figures may be higher.");
  if (e.capped) out.push("Capped — this list was truncated at a fixed limit.");
  if (e.nextCursor) out.push("More rows exist beyond this page.");
  return out;
}

// ── Delivery (§4.11) ────────────────────────────────────────────────────────────

export const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> = {
  QUEUED: "Queued", SCHEDULED: "Scheduled", SUPPRESSED: "Suppressed", CANCELLED: "Cancelled", CAPTURED: "Captured",
  ACCEPTED: "Accepted by provider", FAILED: "Failed", DEAD: "Dead", DELIVERED: "Delivered", BOUNCED: "Bounced", COMPLAINED: "Complained",
};
export const SERIES_LABEL = { accepted: "Accepted", failed: "Failed", dead: "Dead", suppressed: "Suppressed", captured: "Captured", cancelled: "Cancelled" } as const;
export const SUPPRESSION_LABEL: Record<SuppressionReason, string> = Object.fromEntries(SUPPRESSION_REASONS.map((r) => [r, title(r)])) as Record<SuppressionReason, string>;

/** Statuses only a Phase C provider webhook can produce — shown as "not measured" while measured.delivered is false. */
export const WEBHOOK_ONLY: ReadonlySet<DeliveryStatus> = new Set(["DELIVERED", "BOUNCED", "COMPLAINED"]);

export interface StatusTile { status: DeliveryStatus; label: string; value: number | null; note: string | null }

/** C3 — every status, in vocabulary order. `totals: null` ⇒ every tile is not observed (never 0). */
export function deliveryTiles(totals: StatusCounts | null, measuredDelivered: boolean): StatusTile[] {
  return DELIVERY_STATUSES.map((s) => {
    if (WEBHOOK_ONLY.has(s) && !measuredDelivered) return { status: s, label: DELIVERY_STATUS_LABEL[s], value: null, note: "not measured" };
    return { status: s, label: DELIVERY_STATUS_LABEL[s], value: totals ? totals[s] ?? 0 : null, note: totals ? null : "not observed" };
  });
}

/** Non-zero suppression reasons, largest first. Null in ⇒ null out (not observed). */
export function suppressionRows(r: Record<SuppressionReason, number> | null): Array<{ reason: SuppressionReason; label: string; count: number }> | null {
  if (!r) return null;
  return SUPPRESSION_REASONS.map((k) => ({ reason: k, label: SUPPRESSION_LABEL[k], count: r[k] ?? 0 })).filter((x) => x.count > 0).sort((a, b) => b.count - a.count);
}

// ── Automations (§4.6) ──────────────────────────────────────────────────────────

export const AUTOMATION_STATE_TONE: Record<AutomationState, StatusTone> = { DRAFT: "muted", ACTIVE: "ok", PAUSED: "warn", DISABLED: "muted" };

export function utcStamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "—" : `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
