/**
 * components/platform/widgets/provider-view.ts  (UX-P1 · Agent 3)
 *
 * THE PURE VIEW-MODEL behind the provider table. One row per provider
 * AUTHORITY, and the authorities are never merged:
 *
 *   Plaid, Open Exchange Rates   lib/platform/provider-health.ts (trust vocabulary
 *                                OPERATIONAL | DEGRADED | STALE | FAILING | UNKNOWN),
 *                                over /platform-ops/provider-health
 *   Resend                       NotificationDelivery counts over
 *                                /platform-ops/email-health — a DELIVERY authority
 *                                that emits counts and no verdict, so its Status
 *                                cell says exactly that
 *   OpenAI                       NO provider authority is exposed by any
 *                                PLATFORM_OPS route (lib/platform/ai/failures.ts is
 *                                read only by the alert engine), so the row is
 *                                Unavailable with that reason — never a guess
 *
 * No React, no fetch, no clock. Every cell is a word the authority said or an
 * `Unavailable` with the reason it could not say one.
 */

import type { ProviderHealth, ProviderTrust } from "@/lib/platform/provider-health";
import type { ProviderHealthResponse } from "@/app/api/platform/platform-ops/provider-health/route";
import type { EmailHealthResponse } from "@/app/api/platform/platform-ops/email-health/route";
import { NO_AUTHORITY, type StatusTone } from "../platform-surface";

// ── Trust vocabulary → tone ──────────────────────────────────────────────────

export const TRUST_WORD: Record<ProviderTrust, string> = {
  OPERATIONAL: "Operational",
  DEGRADED:    "Degraded",
  STALE:       "Stale data",
  FAILING:     "Failing",
  UNKNOWN:     "Unknown",
};

export const TRUST_TONE: Record<ProviderTrust, StatusTone> = {
  OPERATIONAL: "ok",
  DEGRADED:    "warn",
  STALE:       "warn",
  FAILING:     "bad",
  UNKNOWN:     "muted",
};

export function trustBadge(trust: ProviderTrust): { word: string; tone: StatusTone } {
  return { word: TRUST_WORD[trust] ?? trust, tone: TRUST_TONE[trust] ?? "muted" };
}

// ── Cells ────────────────────────────────────────────────────────────────────

/** A cell either says something (value + optional qualifier) or says why it cannot. */
export type Cell = { value: string; qualifier?: string } | { unavailable: string };

export const isUnavailable = (c: Cell): c is { unavailable: string } => "unavailable" in c;

export interface ProviderRowView {
  key: string;
  label: string;
  /** The system of record this row's words come from — rendered as Provenance. */
  authority: string;
  /** The authority's own kind word (BANKING, FX, …) or null. */
  kind: string | null;
  status: { word: string; tone: StatusTone } | { unavailable: string };
  freshness: Cell;
  /** ISO instant, or the reason there is none. */
  lastSuccess: { iso: string } | { unavailable: string };
  threshold: Cell;
  affected: Cell;
  action: { workspaceId: string } | { unavailable: string };
  /** The provider-health record, when the row came from that authority (drives the drawer). */
  detail: ProviderHealth | null;
}

/** A fetched resource as the widget holds it — the same triple every house hook returns. */
export interface Fetched<T> { data: T | null; loading: boolean; error: string | null }

// ── Provider-health rows (Plaid, OXR) ────────────────────────────────────────

export const PROVIDER_HEALTH_AUTHORITY = "provider-health";
export const THRESHOLD_NOT_EMITTED = "not emitted by the provider authority";
export const AFFECTED_NOT_LISTED = "not listed";
const NO_RUN_IN_WINDOW = "no successful run in the window";

/** The doorway for a provider: where the evidence behind its execution lives. */
export const PROVIDER_WORKSPACE: Record<string, string> = {
  PLAID:                "platform-refresh",
  OPEN_EXCHANGE_RATES:  "platform-jobs",
};

const FRESHNESS_WORD: Record<ProviderHealth["freshness"]["state"], string> = {
  fresh: "Fresh", stale: "Stale", empty: "Empty", idle: "Idle", unknown: "Unknown",
};

export function providerHealthRow(p: ProviderHealth): ProviderRowView {
  const workspaceId = PROVIDER_WORKSPACE[p.key];
  return {
    key: p.key,
    label: p.label,
    authority: PROVIDER_HEALTH_AUTHORITY,
    kind: p.kind,
    status: trustBadge(p.trust),
    freshness: { value: FRESHNESS_WORD[p.freshness.state] ?? p.freshness.state, qualifier: p.freshness.detail },
    lastSuccess: p.lastSuccessAt ? { iso: p.lastSuccessAt } : { unavailable: NO_RUN_IN_WINDOW },
    threshold: { unavailable: THRESHOLD_NOT_EMITTED },
    // The payload carries freshness PROSE about connections, never a count
    // field; parsing prose into a number would be an invented figure.
    affected: { unavailable: AFFECTED_NOT_LISTED },
    action: workspaceId ? { workspaceId } : { unavailable: "no workspace holds this provider's evidence" },
    detail: p,
  };
}

/** When the provider-health read did not return, the registry's two providers still get a row that says so. */
const PROVIDER_HEALTH_REGISTRY: readonly { key: string; label: string; kind: string }[] = [
  { key: "PLAID", label: "Plaid", kind: "BANKING" },
  { key: "OPEN_EXCHANGE_RATES", label: "Open Exchange Rates", kind: "FX" },
];

function providerHealthUnreadRow(spec: { key: string; label: string; kind: string }, reason: string): ProviderRowView {
  const workspaceId = PROVIDER_WORKSPACE[spec.key];
  return {
    key: spec.key, label: spec.label, authority: PROVIDER_HEALTH_AUTHORITY, kind: spec.kind,
    status: { unavailable: reason }, freshness: { unavailable: reason }, lastSuccess: { unavailable: reason },
    threshold: { unavailable: THRESHOLD_NOT_EMITTED }, affected: { unavailable: AFFECTED_NOT_LISTED },
    action: workspaceId ? { workspaceId } : { unavailable: reason }, detail: null,
  };
}

// ── Resend (delivery authority) ──────────────────────────────────────────────

export const RESEND_KEY = "RESEND";
export const RESEND_AUTHORITY = "NotificationDelivery";
export const RESEND_NO_VERDICT = "delivery authority emits counts, no verdict";

export function resendRow(email: Fetched<EmailHealthResponse>): ProviderRowView {
  const base = { key: RESEND_KEY, label: "Resend", authority: RESEND_AUTHORITY, kind: "EMAIL", detail: null as ProviderHealth | null };
  const unread = email.loading ? "email-health read pending" : email.error ? `email-health read failed — ${email.error}` : null;
  if (unread || !email.data) {
    const reason = unread ?? "email-health returned nothing";
    return {
      ...base,
      status: { unavailable: reason }, freshness: { unavailable: reason }, lastSuccess: { unavailable: reason },
      threshold: { unavailable: "none declared" }, affected: { unavailable: "deliveries, not connections" },
      action: { unavailable: "no operator route; Email delivery is composed on this workspace" },
    };
  }
  const c = email.data.counts;
  return {
    ...base,
    status: { unavailable: RESEND_NO_VERDICT },
    freshness: {
      value: `${c.error} error${c.error === 1 ? "" : "s"} · ${c.captured} captured · ${c.sent} sent`,
      qualifier: `${c.total} deliveries in ${email.data.windowDays} d · ${c.skipped} skipped (no recipient)`,
    },
    lastSuccess: { unavailable: "not in the delivery payload" },
    threshold: { unavailable: "none declared" },
    affected: { unavailable: "deliveries, not connections" },
    action: { unavailable: "no operator route; Email delivery is composed on this workspace" },
  };
}

// ── OpenAI (no authority) ────────────────────────────────────────────────────

export const OPENAI_KEY = "OPENAI";
export const OPENAI_NO_AUTHORITY = "no PLATFORM_OPS route exposes an AI provider authority";

export function openAiRow(): ProviderRowView {
  return {
    key: OPENAI_KEY, label: "OpenAI", authority: NO_AUTHORITY, kind: "AI",
    status: { unavailable: OPENAI_NO_AUTHORITY },
    freshness: { unavailable: OPENAI_NO_AUTHORITY },
    lastSuccess: { unavailable: OPENAI_NO_AUTHORITY },
    threshold: { unavailable: OPENAI_NO_AUTHORITY },
    affected: { unavailable: OPENAI_NO_AUTHORITY },
    // The AI workspace shows invocation OUTCOMES (a ledger, not a verdict) —
    // the honest place to look until a provider authority exists.
    action: { workspaceId: "platform-ai" },
    detail: null,
  };
}

// ── Assembly ─────────────────────────────────────────────────────────────────

export function providerRows(providers: Fetched<ProviderHealthResponse>, email: Fetched<EmailHealthResponse>): ProviderRowView[] {
  const healthRows: ProviderRowView[] = providers.data
    ? providers.data.providers.map(providerHealthRow)
    : PROVIDER_HEALTH_REGISTRY.map((s) =>
        providerHealthUnreadRow(s, providers.loading ? "provider-health read pending" : `provider-health read failed — ${providers.error ?? "no data"}`));
  return [...healthRows, resendRow(email), openAiRow()];
}

/** The trust composition over the provider-health authority's own counts (its rows only). */
export function trustSegments(counts: Record<ProviderTrust, number>): { word: string; count: number; tone: StatusTone }[] {
  return (["OPERATIONAL", "DEGRADED", "STALE", "FAILING", "UNKNOWN"] as const).map((t) => ({ word: TRUST_WORD[t], count: counts[t] ?? 0, tone: TRUST_TONE[t] }));
}

export const PROVIDER_FOOTNOTE =
  "One row per authority, never merged: Plaid and Open Exchange Rates are the provider-health synthesis (trust = content or execution, worst wins); " +
  "Resend is the NotificationDelivery ledger, which counts and does not judge; OpenAI has no provider authority on a Platform Operations route today, so its row says so. " +
  "Thresholds and per-connection lists are not in the provider payload and are not inferred from its prose.";
