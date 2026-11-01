/**
 * components/platform/comms/comms-model.ts  (Customer Success — Communications Center, pure)
 *
 * Words and shapes for the four Communications views (Library · Automations ·
 * Delivery & History · Preferences). No React, no fetch, no clock.
 *
 * Honesty rules this module owns (contract §3.1 C1–C3):
 *   • a `null` count is NOT OBSERVED — it is never drawn, summed or shown as 0;
 *   • a `withheld` PEOPLE count (§4.12 preferences) is OBSERVED but a small
 *     cell (1–4 people) — worded distinctly from "not observed", never as a
 *     number. DELIVERY counts (§4.11, the catalog's `recent`) are never
 *     withheld, so the day series carry no withheld state at all;
 *   • a list says when it was checked, and when its totals are a floor or capped.
 */

import {
  CATALOG_CATEGORIES, COMMS_CHANNELS, CONSENT_CLASSES, AUDIENCES, DEFINITION_STATUS_ORDER, EMAIL_STORM_LIMIT,
  type CatalogItem, type CommsChannel, type ConsentClass, type DaySeries, type DefinitionStatus, type PreviewChannel, type Severity,
} from "@/lib/notifications/catalog/types";
import type { StatusTone } from "../platform-surface";
import {
  DELIVERY_STATUSES, SUPPRESSION_REASONS,
  type Aggregate, type AutomationState, type DeliveryStatus, type StatusCounts, type SuppressionReason,
} from "@/lib/platform/comms-center/contract-v1-section-4";

const n = (v: number) => v.toLocaleString("en-US");

// ── Owner-approved decisions, as UI copy (one place) ────────────────────────────

/**
 * The server's EMAIL_STORM_LIMIT.maxPerRecipient, imported from the client-safe
 * vocabulary (lib/notifications/catalog/types.ts, Comms B1) — no local copy.
 */
export const STORM_MAX_PER_HOUR: number = EMAIL_STORM_LIMIT.maxPerRecipient;

/** The consent classes the server's storm limit never applies to (storm.ts: SECURITY_CRITICAL, CEREMONY, OPERATOR). */
const STORM_EXEMPT: ReadonlySet<ConsentClass> = new Set(["SECURITY_CRITICAL", "CEREMONY", "OPERATOR"]);

export const COMMS_POLICY = {
  elevated: "Activating a customer-facing automation requires elevated operator permission.",
  protectedAlerts: "Security alerts can’t be muted, paused or re-routed.",
  /** A protected CEREMONY / OPERATOR email or in-app message (e.g. the staff security-anomaly bell). */
  protectedUnmutable: "This message can’t be muted, paused or re-routed.",
  /** A protected definition whose only legs are read-only banners (dismissal is the banner's own, never a preference). */
  protectedBanner: "Banner — not editable here; customers may dismiss it where the banner allows.",
  /** A protected definition with no channels at all. */
  protectedNoChannels: "No message is sent (by design).",
  /** Protected but user-suppressible (no such definition today): operators can't touch it, customers can. */
  protectedGeneric: "Operators can’t disable, pause or re-route this message.",
  noTracking: "No open or click tracking, ever — no tracking pixels and no link rewriting.",
  /** The server's policy (lib/notifications/delivery/storm.ts): limited = SERVICE / AWARENESS / MARKETING. */
  storm: `At most ${STORM_MAX_PER_HOUR} emails per person per hour (service, awareness and marketing); over the limit an email is not sent. Security, ceremony and operator messages are exempt.`,
  noPii: "No recipient addresses or message bodies are shown here. Previews use synthetic data only.",
  previewBanner: "[PREVIEW] synthetic — fictional data, never sent",
} as const;

/** Owner decision: delivery rows are kept 90 days, then counts only. */
export const DELIVERY_RETENTION_POLICY_DAYS = 90;

/**
 * THE one retention wording (Library detail and Delivery). `serverDays` is what
 * the server reports (CatalogDetail.retention.deliveryDays), or null where no
 * server figure is available; the caveat drops itself once the server says 90.
 */
export function retentionText(serverDays: number | null): string {
  const base = `Owner policy: ${DELIVERY_RETENTION_POLICY_DAYS} days, then counts only.`;
  return serverDays !== null && serverDays !== DELIVERY_RETENTION_POLICY_DAYS
    ? `${base} Server currently reports ${n(serverDays)} days (pending alignment).`
    : base;
}

/**
 * The protected note for a definition, by what it actually sends:
 *   no channels               ⇒ nothing is sent (by design);
 *   only read-only banners    ⇒ not editable here (a banner's dismissal is its own, not a mute);
 *   user-suppressible         ⇒ operator-only note (no such protected definition today);
 *   SECURITY_CRITICAL         ⇒ security alerts can't be muted;
 *   otherwise (CEREMONY / OPERATOR email or in-app, e.g. SECURITY_ANOMALY_DETECTED) ⇒ can't be muted.
 */
export function protectedNote(d: Pick<CatalogItem, "consentClass" | "userSuppressible" | "channels">): string {
  if (d.channels.length === 0) return COMMS_POLICY.protectedNoChannels;
  if (d.channels.every((c) => c.channel === "BANNER" || c.path === "READ_ONLY_SURFACE")) return COMMS_POLICY.protectedBanner;
  if (d.userSuppressible) return COMMS_POLICY.protectedGeneric;
  return d.consentClass === "SECURITY_CRITICAL" ? COMMS_POLICY.protectedAlerts : COMMS_POLICY.protectedUnmutable;
}

/** A server-supplied href is followed only when it is an internal app path ("/x", never "//host" or a scheme). */
export function isInternalPath(href: string | null | undefined): href is string {
  return typeof href === "string" && href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/\\");
}

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
  return STORM_EXEMPT.has(d.consentClass)
    ? `Exempt from the ${STORM_MAX_PER_HOUR}-emails-per-hour limit (security, ceremony and operator messages always send).`
    : COMMS_POLICY.storm;
}

// ── Day series (C1 + C2) ────────────────────────────────────────────────────────

/** Delivery counts are never withheld (§4.11): a day is observed (a number, 0 allowed) or not observed (null). */
export type DayState = "observed" | "not-observed";
export interface DayCell { day: string; state: DayState; count: number | null }

export function dayCells(series: DaySeries): DayCell[] {
  return series.days.map((d): DayCell => (d.count === null ? { day: d.day, state: "not-observed", count: null } : { day: d.day, state: "observed", count: d.count }));
}

export interface DaySummary {
  days: number;
  observed: number;
  notObserved: number;
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
    total: obs.length ? obs.reduce((a, c) => a + (c.count ?? 0), 0) : null,
    max: obs.reduce((m, c) => Math.max(m, c.count ?? 0), 0),
  };
}

export function daySummaryText(s: DaySummary, noun = "send"): string {
  if (s.observed === 0) return `Not observed yet · ${s.days} UTC days without ledger coverage`;
  const parts = [s.total === null ? "no observed total" : `${n(s.total)} ${noun}${s.total === 1 ? "" : "s"} on observed days`];
  if (s.notObserved) parts.push(`${s.notObserved} day${s.notObserved === 1 ? "" : "s"} not observed`);
  return parts.join(" · ");
}

// ── Small-cell counts (C1) ──────────────────────────────────────────────────────

export type CountState = "value" | "withheld" | "not-observed";
export interface CountCell { state: CountState; text: string; value: number | null }

/**
 * One count that may be withheld (observed small cell) or not observed.
 * "<5" ONLY when the count is null AND withheld is true; a null count with
 * withheld false is "not observed"; a number is always shown as itself.
 *
 * NOTE for Session 1 (contract §4.12): a PreferenceCell carries ONE `withheld`
 * flag for TWO counts (optedOut, optedIn). If a cell has withheld: true and
 * both counts null, the UI cannot tell whether both were small cells or one
 * was simply not observed — it renders both as "<5". A per-count flag (or the
 * C1 `Aggregate` shape per count) would remove the ambiguity.
 */
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
/**
 * Operator words for every server SuppressionReason. Exhaustive by type: a
 * reason the server adds without a label here is a compile error, not a
 * silently humanized enum.
 */
export const SUPPRESSION_LABEL = {
  PREFERENCE_OFF: "Customer turned it off",
  NO_RECIPIENT: "No recipient",
  OBSOLETE: "No longer relevant",
  DEDUPE_OPEN: "Duplicate of an open message",
  FREQUENCY_CAP: "Frequency cap reached",
  ELIGIBILITY_FAILED: "Not eligible",
  ADMISSION_REFUSED: "Admission refused",
  ACCOUNT_RESTRICTED: "Account restricted",
  BETA_LIFECYCLE: "Beta lifecycle",
  ENTITLEMENT: "Not entitled",
  PROVIDER_FREEZE: "Provider frozen",
  ENVIRONMENT_GUARD: "Environment guard (not production)",
  AUTOMATION_PAUSED: "Automation paused",
  STORM_BREAKER: "Storm breaker",
  // The server SUPPRESSES these (storm.ts): never sent later, so never "held".
  RATE_LIMITED: `Not sent: ${STORM_MAX_PER_HOUR} emails/hour limit`,
  RATE_LIMIT_UNVERIFIED: "Not sent: limit couldn’t be verified",
} as const satisfies Record<SuppressionReason, string>;

/** The in-app leg suppressed by the customer's own preference is named as such. */
export const IN_APP_PREFERENCE_OFF_LABEL = "Customer turned off in-app";

/** One suppressed row's words: `channel` is the row's (or the filter's) channel, null when mixed. */
export function suppressionLabel(reason: SuppressionReason, channel: CommsChannel | null): string {
  return reason === "PREFERENCE_OFF" && channel === "IN_APP" ? IN_APP_PREFERENCE_OFF_LABEL : SUPPRESSION_LABEL[reason];
}

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

/**
 * Non-zero suppression reasons, largest first. Null in ⇒ null out (not observed).
 * `channel` = the view's channel filter: the rows are in-app rows only when it is IN_APP.
 */
export function suppressionRows(r: Record<SuppressionReason, number> | null, channel: CommsChannel | null = null): Array<{ reason: SuppressionReason; label: string; count: number }> | null {
  if (!r) return null;
  return SUPPRESSION_REASONS.map((k) => ({ reason: k, label: suppressionLabel(k, channel), count: r[k] ?? 0 })).filter((x) => x.count > 0).sort((a, b) => b.count - a.count);
}

// ── Automations (§4.6) ──────────────────────────────────────────────────────────

export const AUTOMATION_STATE_TONE: Record<AutomationState, StatusTone> = { DRAFT: "muted", ACTIVE: "ok", PAUSED: "warn", DISABLED: "muted" };

export function utcStamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "—" : `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
