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
 *   • commsWrite — same-origin JSON POST through the SAME classifier (contract
 *     v1.1 §3: the B1 content writes). Never throws. A 409 CONFLICT carries the
 *     server's `current` token; a 400 CONTENT_INVALID / 422 SUGGESTION_REJECTED
 *     carries the typed `issues`; a 503 AI_UNAVAILABLE carries its `ai` reason.
 *
 * Client-safe: imports types and closed value lists only.
 */

import type {
  CatalogDetail, CatalogResponse, CommsChannel, PreviewChannel, PreviewResponse, TriggersResponse,
} from "@/lib/notifications/catalog/types";
import type {
  AiSuggestRequest, AiSuggestResult, AiUnavailableReason, ContentIssue, ContentPreviewResponse, EditableChannel, PublishRequest, PublishResult,
  RenderRequest, RollbackRequest, RollbackResult, SaveDraftRequest, TemplateVersionDTO, VersionsResponse,
} from "@/lib/notifications/content/types";
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
  /**
   * 503 UNAVAILABLE — the source could not be read. Never rendered as empty.
   * `ai` is set for the ai-suggest 503 AI_UNAVAILABLE (contract v1.1 §4.5).
   */
  | { kind: "unavailable"; error: string; code?: string | null; ai?: { reason: AiUnavailableReason; detail: string | null; retryAfterSeconds: number | null } }
  /** 401 / 403 (incl. OPERATOR_TOTP_REQUIRED). */
  | { kind: "denied"; status: number; code: string | null; error: string }
  /** 429 RATE_LIMITED. */
  | { kind: "rate-limited"; error: string }
  /**
   * 400 / 409 / 422 / any other failure, or a network error (status 0).
   * `current` = the 409 CONFLICT's server token (v1.1 §0.3); `issues` = the typed
   * issues of a 400 CONTENT_INVALID, 409 WARNINGS_UNACKNOWLEDGED or 422
   * SUGGESTION_REJECTED (v1.1 §2.5, §4.3). Both are omitted when absent.
   */
  | { kind: "error"; status: number; code: string | null; error: string; current?: number; issues?: ContentIssue[] };

type ContractBody = { error?: unknown; code?: unknown } | null;

function contractFields(body: unknown): { error: string | null; code: string | null } {
  const b = (body && typeof body === "object" ? body : null) as ContractBody;
  const error = typeof b?.error === "string" ? b.error.slice(0, 200) : null;
  const code = typeof b?.code === "string" && /^[A-Z_]{1,40}$/.test(b.code) ? b.code : null;
  return { error, code };
}

const AI_REASONS: readonly string[] = ["KILL_SWITCH", "COST_FREEZE", "ALLOWANCE", "PROVIDER"] satisfies readonly AiUnavailableReason[];
const SHORT_CODE = /^[A-Z_]{1,40}$/;

/** The typed issues of a refusal body: kept only when each is an object with a code, severity and message. */
function issuesOf(body: unknown): ContentIssue[] | undefined {
  const raw = (body && typeof body === "object" ? (body as { issues?: unknown }).issues : undefined);
  if (!Array.isArray(raw)) return undefined;
  const ok = raw.filter((i): i is ContentIssue => !!i && typeof i === "object"
    && typeof (i as ContentIssue).code === "string" && ((i as ContentIssue).severity === "error" || (i as ContentIssue).severity === "warning")
    && typeof (i as ContentIssue).message === "string");
  return ok.slice(0, 200);
}

function aiOf(body: unknown): { reason: AiUnavailableReason; detail: string | null; retryAfterSeconds: number | null } | undefined {
  const b = (body && typeof body === "object" ? body : null) as { code?: unknown; reason?: unknown; detail?: unknown; retryAfterSeconds?: unknown } | null;
  if (!b || b.code !== "AI_UNAVAILABLE" || typeof b.reason !== "string" || !AI_REASONS.includes(b.reason)) return undefined;
  return {
    reason: b.reason as AiUnavailableReason,
    detail: typeof b.detail === "string" && SHORT_CODE.test(b.detail) ? b.detail : null,
    retryAfterSeconds: typeof b.retryAfterSeconds === "number" && Number.isFinite(b.retryAfterSeconds) && b.retryAfterSeconds > 0 ? Math.round(b.retryAfterSeconds) : null,
  };
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
  if (status === 503) {
    const ai = aiOf(body);
    return { kind: "unavailable", error: error ?? "Service unavailable.", ...(code ? { code } : {}), ...(ai ? { ai } : {}) };
  }
  if (status === 401 || status === 403) {
    return { kind: "denied", status, code, error: code === "OPERATOR_TOTP_REQUIRED" ? "Two-factor verification is required for operator access." : error ?? "Not authorized." };
  }
  if (status === 429) return { kind: "rate-limited", error: error ?? "Too many requests. Try again shortly." };
  const current = status === 409 && code === "CONFLICT" ? (body as { current?: unknown }).current : undefined;
  const issues = status === 400 || status === 409 || status === 422 ? issuesOf(body) : undefined;
  return {
    kind: "error", status, code, error: error ?? `Request failed (${status}).`,
    ...(typeof current === "number" && Number.isInteger(current) && current >= 0 ? { current } : {}),
    ...(issues ? { issues } : {}),
  };
}

export type FetchLike = (url: string, init?: {
  credentials?: "same-origin";
  signal?: AbortSignal;
  method?: "POST";
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; json(): Promise<unknown> }>;

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

/**
 * Same-origin JSON POST through the classifier (contract v1.1 §3). Never throws.
 * The body is the contract's request shape, serialised as-is. A 404 here is
 * always classified by the classifier's rule (NOT_FOUND ⇒ not-found).
 */
export async function commsWrite<T>(url: string, body: unknown, opts: { signal?: AbortSignal; fetchImpl?: FetchLike } = {}): Promise<CommsReadResult<T>> {
  const f: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  let payload: string;
  try { payload = JSON.stringify(body ?? {}); } catch { return { kind: "error", status: 0, code: null, error: "The request could not be prepared." }; }
  try {
    const r = await f(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: payload, signal: opts.signal });
    let parsed: unknown = null;
    try { parsed = await r.json(); } catch { parsed = null; }
    return classifyCommsResponse<T>(r.status, parsed);
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

/**
 * The status-chip totals: the same filters WITHOUT status, one row only. The
 * server computes `totals` over the filtered set BEFORE pagination (and AFTER
 * the status filter), so this is the cheap way to count every status at once.
 */
export function catalogTotalsUrl(f: CatalogFilters): string {
  return `${COMMS_BASE}/catalog${queryString([
    ["category", f.category], ["audience", f.audience], ["channel", f.channel], ["consentClass", f.consentClass],
    ["q", f.q.trim()], ["limit", 1],
  ])}`;
}

export function catalogDetailUrl(key: string): string {
  return `${COMMS_BASE}/catalog/${encodeURIComponent(key)}`;
}

/** `versionId` (v1.1 §3.7) previews any saved version of this key; absent ⇒ the live content. */
export function previewUrl(key: string, channel: PreviewChannel, variant: string | null, versionId: string | null = null): string {
  return `${COMMS_BASE}/catalog/${encodeURIComponent(key)}/preview${queryString([["channel", channel], ["variant", variant], ["versionId", versionId]])}`;
}

// ── Content (contract v1.1 §3, Phase B1) ────────────────────────────────────────

/** The reserved rollback target that makes the code default live again (v1.1 §3.5). */
export const CODE_DEFAULT_VERSION_ID = "code-default";
/** One versions page: the stream's history, newest first (v1.1 §3.2). */
export const VERSIONS_PAGE = 50;

const contentBase = (key: string) => `${COMMS_BASE}/catalog/${encodeURIComponent(key)}`;

/** `channel` null ⇒ omitted (the server picks the only editable leg, or reports the lock). */
export function versionsUrl(key: string, channel: EditableChannel | null, variant: string | null, cursor: string | null = null): string {
  return `${contentBase(key)}/versions${queryString([["channel", channel], ["variant", variant], ["limit", VERSIONS_PAGE], ["cursor", cursor]])}`;
}
/** GET one version (v1.1 §3.3). A draft save POSTs to `saveDraftUrl` (no query). */
export function versionUrl(key: string, id: string): string { return `${contentBase(key)}/versions/${encodeURIComponent(id)}`; }
export function saveDraftUrl(key: string): string { return `${contentBase(key)}/versions`; }
export function publishUrl(key: string, id: string): string { return `${versionUrl(key, id)}/publish`; }
export function rollbackUrl(key: string, id: string): string { return `${versionUrl(key, id)}/rollback`; }
export function aiSuggestUrl(key: string, id: string): string { return `${versionUrl(key, id)}/ai-suggest`; }
export function renderUrl(key: string): string { return `${contentBase(key)}/render`; }

/** The B1 write envelope (MutationResult): `auditLogId` is absent on rollback. */
export interface MutationEnvelope<T> { success: true; result: T; auditLogId?: string | null }

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
export const readVersions = (key: string, channel: EditableChannel | null, variant: string | null, cursor: string | null = null) =>
  commsRead<VersionsResponse>(versionsUrl(key, channel, variant, cursor));
export const readVersion = (key: string, id: string) => commsRead<TemplateVersionDTO>(versionUrl(key, id));
export const readVersionPreview = (key: string, channel: PreviewChannel, versionId: string) => commsRead<ContentPreviewResponse>(previewUrl(key, channel, null, versionId));

// ── Content writers (v1.1 §3.3–§3.8; request shapes are content/types.ts's) ─────

export const postRender = (key: string, req: RenderRequest, signal?: AbortSignal) => commsWrite<ContentPreviewResponse>(renderUrl(key), req, { signal });
export const postSaveDraft = (key: string, req: SaveDraftRequest) =>
  commsWrite<MutationEnvelope<TemplateVersionDTO>>(saveDraftUrl(key), req);
export const postPublish = (key: string, id: string, req: PublishRequest) =>
  commsWrite<MutationEnvelope<PublishResult>>(publishUrl(key, id), req);
export const postRollback = (key: string, id: string, req: RollbackRequest) =>
  commsWrite<MutationEnvelope<RollbackResult>>(rollbackUrl(key, id), req);
/** 200 is the bare AiSuggestResult (not an envelope, v1.1 §4.3). */
export const postAiSuggest = (key: string, id: string, req: AiSuggestRequest) =>
  commsWrite<AiSuggestResult>(aiSuggestUrl(key, id), req);

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
