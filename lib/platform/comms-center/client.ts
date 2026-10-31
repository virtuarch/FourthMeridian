/**
 * lib/platform/comms-center/client.ts  (Comms Center UI — Session 2)
 *
 * Typed client helpers for the Customer Success Communications Center reads
 * (contract docs/plans/COMMS-CENTER-API-CONTRACT-v1-2026-10-31.md §4).
 *
 *   • URL builders — one per endpoint, query strings in a STABLE order with
 *     empty filters omitted, so a filter change is exactly one URL change.
 *   • classifyCommsResponse — THE probe rule, pure and tested. Routes that are
 *     not merged yet (automations, delivery, preferences) answer 404 (no route)
 *     or 501; the UI shows "coming soon" for those and lights up on the first
 *     200 without a code change. A 404 that carries the contract's own
 *     `{ code: "NOT_FOUND" }` is a real "no such object", not a missing route.
 *     503 UNAVAILABLE is an honest outage state, never an empty list (§3.4).
 *   • commsRead — same-origin GET through the classifier (fetch injectable).
 *
 * Client-safe: imports types and closed value lists only.
 */

import type {
  CatalogDetail, CatalogResponse, CommsChannel, PreviewChannel, PreviewResponse, TriggersResponse,
} from "@/lib/notifications/catalog/types";
import type {
  AutomationDetail, AutomationState, AutomationsResponse, DeliveryAnalytics, DeliveryStatus, DeliveryWindow,
  PreferenceAggregate, RunsResponse,
} from "./contract-v1-section-4";

export const COMMS_BASE = "/api/platform/customer-success/notifications";

// ── Result of a read ────────────────────────────────────────────────────────────

export type CommsReadResult<T> =
  | { kind: "ok"; data: T }
  /** The endpoint is not deployed yet (404 without a contract body, or 501). */
  | { kind: "coming-soon"; status: number }
  /** The contract's 404 NOT_FOUND (an unknown key / id). */
  | { kind: "not-found"; error: string }
  /** 503 UNAVAILABLE — the source could not be read. Never rendered as empty. */
  | { kind: "unavailable"; error: string }
  /** 401 / 403 (incl. OPERATOR_TOTP_REQUIRED). */
  | { kind: "denied"; status: number; code: string | null; error: string }
  /** 429 RATE_LIMITED. */
  | { kind: "rate-limited"; error: string }
  /** 400 / 409 / any other failure, or a network error (status 0). */
  | { kind: "error"; status: number; code: string | null; error: string };

type ContractBody = { error?: unknown; code?: unknown } | null;

function contractFields(body: unknown): { error: string | null; code: string | null } {
  const b = (body && typeof body === "object" ? body : null) as ContractBody;
  const error = typeof b?.error === "string" ? b.error.slice(0, 200) : null;
  const code = typeof b?.code === "string" && /^[A-Z_]{1,40}$/.test(b.code) ? b.code : null;
  return { error, code };
}

/**
 * Classify a response by status and its (already parsed, possibly null) JSON
 * body. Pure. The body is only consulted for the contract's `{ error, code }`.
 */
export function classifyCommsResponse<T>(status: number, body: unknown): CommsReadResult<T> {
  if (status >= 200 && status < 300) return { kind: "ok", data: body as T };
  const { error, code } = contractFields(body);
  if (status === 501) return { kind: "coming-soon", status };
  if (status === 404) {
    return code === "NOT_FOUND" ? { kind: "not-found", error: error ?? "Not found." } : { kind: "coming-soon", status };
  }
  if (status === 503) return { kind: "unavailable", error: error ?? "Service unavailable." };
  if (status === 401 || status === 403) {
    return { kind: "denied", status, code, error: code === "OPERATOR_TOTP_REQUIRED" ? "Two-factor verification is required for operator access." : error ?? "Not authorized." };
  }
  if (status === 429) return { kind: "rate-limited", error: error ?? "Too many requests. Try again shortly." };
  return { kind: "error", status, code, error: error ?? `Request failed (${status}).` };
}

export type FetchLike = (url: string, init?: { credentials?: "same-origin"; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Same-origin GET through the classifier. Never throws. */
export async function commsRead<T>(url: string, opts: { signal?: AbortSignal; fetchImpl?: FetchLike } = {}): Promise<CommsReadResult<T>> {
  const f: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  try {
    const r = await f(url, { credentials: "same-origin", signal: opts.signal });
    let body: unknown = null;
    try { body = await r.json(); } catch { body = null; } // a missing route answers HTML
    return classifyCommsResponse<T>(r.status, body);
  } catch {
    return { kind: "error", status: 0, code: null, error: "Network error — the request did not complete." };
  }
}

// ── Query strings ───────────────────────────────────────────────────────────────

/** Build `?a=1&b=2` from ordered pairs, skipping null / empty values. "" when nothing remains. */
export function queryString(pairs: ReadonlyArray<readonly [string, string | number | null | undefined]>): string {
  const p = new URLSearchParams();
  for (const [k, v] of pairs) if (v !== null && v !== undefined && String(v) !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** §4.2 filters. An empty string / null means "any". */
export interface CatalogFilters {
  status: string | null;
  category: string | null;
  audience: string | null;
  channel: string | null;
  consentClass: string | null;
  q: string;
}
export const EMPTY_CATALOG_FILTERS: CatalogFilters = { status: null, category: null, audience: null, channel: null, consentClass: null, q: "" };

/** limit=100 returns the whole v1 catalog in one page (§4.2). */
export const CATALOG_PAGE = 100;

export function catalogUrl(f: CatalogFilters, cursor: string | null = null): string {
  return `${COMMS_BASE}/catalog${queryString([
    ["status", f.status], ["category", f.category], ["audience", f.audience], ["channel", f.channel], ["consentClass", f.consentClass],
    ["q", f.q.trim()], ["limit", CATALOG_PAGE], ["cursor", cursor],
  ])}`;
}

export function catalogDetailUrl(key: string): string {
  return `${COMMS_BASE}/catalog/${encodeURIComponent(key)}`;
}

export function previewUrl(key: string, channel: PreviewChannel, variant: string | null): string {
  return `${COMMS_BASE}/catalog/${encodeURIComponent(key)}/preview${queryString([["channel", channel], ["variant", variant]])}`;
}

export function triggersUrl(): string {
  return `${COMMS_BASE}/triggers${queryString([["limit", 100]])}`;
}

export function automationsUrl(state: AutomationState | null = null, cursor: string | null = null): string {
  return `${COMMS_BASE}/automations${queryString([["state", state], ["limit", 50], ["cursor", cursor]])}`;
}

export function automationUrl(id: string): string {
  return `${COMMS_BASE}/automations/${encodeURIComponent(id)}`;
}

export function automationRunsUrl(id: string): string {
  return `${COMMS_BASE}/automations/${encodeURIComponent(id)}/runs${queryString([["limit", 20]])}`;
}

export interface DeliveryFilters {
  window: DeliveryWindow;
  channel: CommsChannel | null;
  status: DeliveryStatus | null;
  template: string | null;
}
export const DEFAULT_DELIVERY_FILTERS: DeliveryFilters = { window: "7d", channel: null, status: null, template: null };

export function deliveryUrl(f: DeliveryFilters): string {
  return `${COMMS_BASE}/delivery${queryString([["window", f.window], ["channel", f.channel], ["status", f.status], ["template", f.template]])}`;
}

export function preferencesUrl(): string {
  return `${COMMS_BASE}/preferences`;
}

// ── Typed readers (one per endpoint) ────────────────────────────────────────────

export const readCatalog = (f: CatalogFilters, cursor: string | null = null) => commsRead<CatalogResponse>(catalogUrl(f, cursor));
export const readCatalogDetail = (key: string) => commsRead<CatalogDetail>(catalogDetailUrl(key));
export const readPreview = (key: string, channel: PreviewChannel, variant: string | null) => commsRead<PreviewResponse>(previewUrl(key, channel, variant));
export const readTriggers = () => commsRead<TriggersResponse>(triggersUrl());
export const readAutomations = (state: AutomationState | null = null) => commsRead<AutomationsResponse>(automationsUrl(state));
export const readAutomation = (id: string) => commsRead<AutomationDetail>(automationUrl(id));
export const readAutomationRuns = (id: string) => commsRead<RunsResponse>(automationRunsUrl(id));
export const readDelivery = (f: DeliveryFilters) => commsRead<DeliveryAnalytics>(deliveryUrl(f));
export const readPreferences = () => commsRead<PreferenceAggregate>(preferencesUrl());

// ── Mutation seams (Phase B — NOT wired in this PR) ─────────────────────────────

/**
 * The automation actions the contract defines (§4.7–§4.10). No route exists
 * yet, so nothing here sends a request: the UI renders each as an explained,
 * unavailable action. When Session 1 merges the routes, a writer posts a
 * `MutationRequest` (contract-v1-section-4.ts) to `path(id)` and these flags
 * decide the copy and the permission note.
 *
 * `elevated` = the action increases reach (owner decision O-1): it needs the
 * area's highest operator permission, a fresh sign-in check and a reason.
 */
export interface AutomationActionSeam {
  action: "activate" | "pause" | "disable" | "dry-run" | "test-send";
  label: string;
  path: (id: string) => string;
  elevated: boolean;
  /** One line the UI shows while the route is not available. */
  note: string;
}

export const AUTOMATION_ACTION_SEAMS: readonly AutomationActionSeam[] = [
  { action: "activate", label: "Activate", path: (id) => `${automationUrl(id)}/activate`, elevated: true,
    note: "Activating a customer-facing automation increases reach, so it requires elevated operator permission and a reason." },
  { action: "pause", label: "Pause", path: (id) => `${automationUrl(id)}/pause`, elevated: false,
    note: "Pausing reduces sending and cancels anything already scheduled by this automation." },
  { action: "disable", label: "Disable", path: (id) => `${automationUrl(id)}/disable`, elevated: false,
    note: "Disabling is final; a disabled automation is cloned to revive it." },
  { action: "dry-run", label: "Dry run", path: (id) => `${automationUrl(id)}/dry-run`, elevated: false,
    note: "A dry run replays recorded events and sends nothing." },
  { action: "test-send", label: "Test send", path: () => `${COMMS_BASE}/test-send`, elevated: false,
    note: "A test send goes only to your own verified address, with synthetic content." },
];
