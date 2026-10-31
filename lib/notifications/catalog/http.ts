/**
 * lib/notifications/catalog/http.ts  (Comms Center Phase A-1)
 *
 * The READ-ONLY catalog API (contract §4.2–§4.5), as pure handlers behind an
 * injected gate. The route files under
 * app/api/platform/customer-success/notifications/ wire the real gate
 * (requirePlatformAccess("CUSTOMER_SUCCESS", "READ")) and the `cs-comms-read`
 * rate bucket (§4.1, 120/min); tests inject fakes and exercise the same code.
 *
 * Order, always: gate (401/403) → rate limit (429) → validate (400) → work.
 * Errors use the house shape `{ error, code? }` (§3.4). A failure to build a
 * response is 503 UNAVAILABLE — never a fabricated empty list or zero.
 *
 * PII (§3.2): every payload is built from code-defined catalog facts. No
 * recipient address, user id, name, title or token value is ever read, so none
 * can be returned. Previews are synthetic (lib/notifications/catalog/preview.ts).
 */

import { NextResponse } from "next/server";
import {
  CATALOG_KEYS,
  COMMS_CATALOG,
  getCatalogDefinition,
} from "@/lib/notifications/catalog/definitions";
import { listTriggers } from "@/lib/notifications/catalog/triggers";
import { renderCatalogPreview } from "@/lib/notifications/catalog/preview";
import {
  AUDIENCES,
  CATALOG_CATEGORIES,
  COMMS_CHANNELS,
  CONSENT_CLASSES,
  DEFINITION_STATUS_ORDER,
  PREVIEW_CHANNELS,
  type CatalogDetail,
  type CatalogItem,
  type CatalogResponse,
  type CommsDefinition,
  type DaySeries,
  type DefinitionStatus,
  type PreviewChannel,
  type PreviewResponse,
  type TriggersResponse,
} from "@/lib/notifications/catalog/types";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

/** §4.1 — the read bucket. */
export const CS_COMMS_READ_BUCKET = "cs-comms-read";
export const CS_COMMS_READ_LIMIT = { limit: 120, windowSec: 60 } as const;

/** §3.1 — default page size 50, max 100. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

/**
 * Owner decision (2026-10-31, O-9): per-delivery records are kept 90 days, then
 * counts only (lib/notifications/delivery/rollup.ts — the single source).
 */
export { DELIVERY_RETENTION_DAYS } from "@/lib/notifications/delivery/rollup";
import { DELIVERY_RETENTION_DAYS } from "@/lib/notifications/delivery/rollup";

export interface ReadDeps {
  /** The platform gate; the route passes () => requirePlatformAccess("CUSTOMER_SUCCESS", "READ"). */
  guard: () => Promise<[{ user: { id: string } }, null] | [null, Response]>;
  /** The rate bucket; null = allowed. */
  rateLimit: (userId: string) => Promise<Response | null>;
  now?: () => Date;
}

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const validation = (error: string) => json({ error, code: "VALIDATION" }, 400);
const notFound = () => json({ error: "No catalog definition has that key.", code: "NOT_FOUND" }, 404);
const unavailable = () => json({ error: "The notification data is unavailable.", code: "UNAVAILABLE" }, 503);

/** v1.0.1 — the codes a refusal from the shared gate or limiter is mapped to (§3.4). */
export const GATE_CODES = { 401: "UNAUTHENTICATED", 403: "FORBIDDEN", 429: "RATE_LIMITED", 503: "UNAVAILABLE" } as const;
/** Headers a wrapped refusal keeps from the upstream response (the TOTP-denial marker, Retry-After). */
const KEPT_HEADERS = ["x-fm-platform-denial", "retry-after"] as const;
const DEFAULT_MESSAGES: Record<number, string> = {
  401: "Authentication required.",
  403: "Forbidden.",
  429: "Too many requests. Please slow down and try again shortly.",
  503: "Service temporarily unavailable. Please try again.",
};

/**
 * Re-shape a refusal from the SHARED gate (lib/platform/authorize.ts) or
 * limiter (lib/rate-limit.ts) into the contract error shape `{ error, code }`
 * with `Cache-Control: no-store`, without changing either shared module.
 * (The session layer can also answer 503 + Retry-After when it cannot tell
 * whether a session is valid; that becomes UNAVAILABLE.)
 * Status is kept. A code the upstream already set (OPERATOR_TOTP_REQUIRED) is
 * kept; otherwise the status names it. The upstream `error` text is kept only
 * when it is a short string (these are fixed messages, never data).
 */
export async function contractRefusal(upstream: Response): Promise<Response> {
  const status = upstream.status;
  type RefusalBody = { error?: unknown; code?: unknown } | null;
  let upstreamBody: RefusalBody;
  try { upstreamBody = (await upstream.clone().json()) as RefusalBody; } catch { upstreamBody = null; }
  const error = typeof upstreamBody?.error === "string" && upstreamBody.error.length <= 200
    ? upstreamBody.error
    : DEFAULT_MESSAGES[status] ?? "Request refused.";
  const code = typeof upstreamBody?.code === "string" && /^[A-Z_]{1,40}$/.test(upstreamBody.code)
    ? upstreamBody.code
    : (GATE_CODES as Record<number, string>)[status] ?? (status >= 500 ? "UNAVAILABLE" : "FORBIDDEN");
  const headers = new Headers(NO_STORE);
  for (const h of KEPT_HEADERS) {
    const v = upstream.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  return NextResponse.json({ error, code }, { status, headers });
}

/**
 * Gate, rate-limit, then run `work`. Every refusal leaves in the contract
 * shape with no-store (contractRefusal). Any throw from `work` is 503
 * UNAVAILABLE with a fixed message (the error is never echoed: it could carry data).
 */
export async function runRead(deps: ReadDeps, work: (now: Date) => Response | Promise<Response>): Promise<Response> {
  const [auth, err] = await deps.guard();
  if (err) return contractRefusal(err);
  const limited = await deps.rateLimit(auth.user.id);
  if (limited) return contractRefusal(limited);
  try {
    return await work((deps.now ?? (() => new Date()))());
  } catch {
    return unavailable();
  }
}

// ── DTO mapping ───────────────────────────────────────────────────────────────

export function toCatalogItem(d: CommsDefinition): CatalogItem {
  return {
    key: d.key,
    definitionVersion: d.definitionVersion,
    displayName: d.displayName,
    description: d.description,
    status: d.status,
    category: d.category,
    audience: d.audience,
    consentClass: d.consentClass,
    severity: d.severity,
    channels: d.channels.map((c) => ({ channel: c.channel, defaultOn: c.defaultOn, templateVersion: c.template?.version ?? null, path: c.path })),
    userSuppressible: d.preference.userSuppressible,
    protected: d.protected,
    editable: d.editable,
    supportedActions: [...d.supportedActions],
    ownerSurface: d.ownerSurface ? { ...d.ownerSurface } : null,
    // No automation exists until Phase B (no table), so every count is a true zero.
    automations: { draft: 0, active: 0, paused: 0 },
  };
}

const DAY_MS = 86_400_000;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** C1 + C2 — a dense series of `null` (not observed): the shape of `recent` before the ledger holds a row. */
export function unobservedSeries(now: Date, window: "7d" | "30d" | "90d" = "30d"): DaySeries {
  const n = window === "7d" ? 7 : window === "30d" ? 30 : 90;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Array.from({ length: n }, (_, i) => ({ day: isoDay(today - (n - 1 - i) * DAY_MS), count: null }));
  return { window, from: days[0].day, to: days[n - 1].day, days, floor: false };
}

export function toCatalogDetail(d: CommsDefinition, now: Date, recent: DaySeries = unobservedSeries(now)): CatalogDetail {
  return {
    ...toCatalogItem(d),
    trigger: { kind: d.trigger.kind, triggerKey: d.trigger.triggerKey, sources: [...d.trigger.sources] },
    payload: d.payload.map((p) => ({ ...p })),
    eligibility: [...d.eligibility],
    dedupe: { ...d.dedupe },
    frequencyCap: d.frequencyCap ? { ...d.frequencyCap } : null,
    retention: { ...d.retention, deliveryDays: DELIVERY_RETENTION_DAYS },
    recent,
  };
}

// ── Sort, filter, paginate ────────────────────────────────────────────────────

const STATUS_RANK = new Map<DefinitionStatus, number>(DEFINITION_STATUS_ORDER.map((s, i) => [s, i]));
/** ASCII case fold (C7c): A–Z → a–z only, so the order never depends on a locale. */
const fold = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** §4.2 (C7c) — status order, then displayName (ASCII case-folded), then key. */
export function compareCatalog(a: CommsDefinition, b: CommsDefinition): number {
  return (STATUS_RANK.get(a.status)! - STATUS_RANK.get(b.status)!) || cmp(fold(a.displayName), fold(b.displayName)) || cmp(a.key, b.key);
}

function encodeCursor(key: string): string {
  return Buffer.from(JSON.stringify({ k: key }), "utf8").toString("base64url");
}
function decodeCursor(cursor: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    const k = (v as { k?: unknown } | null)?.k;
    return typeof k === "string" ? k : null;
  } catch {
    return null;
  }
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseEnum<T extends string>(params: URLSearchParams, name: string, allowed: readonly T[]): Parsed<T | null> {
  const raw = params.get(name);
  if (raw === null) return { ok: true, value: null };
  return (allowed as readonly string[]).includes(raw) ? { ok: true, value: raw as T } : { ok: false, error: `Unknown ${name}.` };
}

export function parseLimit(params: URLSearchParams): Parsed<number> {
  const raw = params.get("limit");
  if (raw === null) return { ok: true, value: DEFAULT_LIMIT };
  if (!/^\d{1,4}$/.test(raw)) return { ok: false, error: "limit must be an integer from 1 to 100." };
  const n = Number(raw);
  return n >= 1 && n <= MAX_LIMIT ? { ok: true, value: n } : { ok: false, error: "limit must be an integer from 1 to 100." };
}

/** Pagination over an already-sorted list (code registry: floor and capped are always false). */
function page<T>(all: readonly T[], keyOf: (t: T) => string, params: URLSearchParams, now: Date):
  { ok: true; envelope: { items: T[]; checkedAt: string; nextCursor: string | null; limit: number; floor: false; capped: false } } | { ok: false; error: string } {
  const limit = parseLimit(params);
  if (!limit.ok) return limit;
  let start = 0;
  const cursor = params.get("cursor");
  if (cursor !== null) {
    const after = decodeCursor(cursor);
    const at = after === null ? -1 : all.findIndex((t) => keyOf(t) === after);
    if (at < 0) return { ok: false, error: "Invalid cursor." };
    start = at + 1;
  }
  const items = all.slice(start, start + limit.value);
  const more = start + limit.value < all.length;
  return {
    ok: true,
    envelope: {
      items,
      checkedAt: now.toISOString(),
      nextCursor: more && items.length > 0 ? encodeCursor(keyOf(items[items.length - 1])) : null,
      limit: limit.value,
      floor: false,
      capped: false,
    },
  };
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

/** GET /catalog (§4.2). */
export function catalogList(url: URL, now: Date): Response {
  const p = url.searchParams;
  const status = parseEnum(p, "status", DEFINITION_STATUS_ORDER);
  const category = parseEnum(p, "category", CATALOG_CATEGORIES);
  const audience = parseEnum(p, "audience", AUDIENCES);
  const channel = parseEnum(p, "channel", COMMS_CHANNELS);
  const consentClass = parseEnum(p, "consentClass", CONSENT_CLASSES);
  if (!status.ok) return validation(status.error);
  if (!category.ok) return validation(category.error);
  if (!audience.ok) return validation(audience.error);
  if (!channel.ok) return validation(channel.error);
  if (!consentClass.ok) return validation(consentClass.error);
  const q = p.get("q");
  if (q !== null && (q.length > 100 || /[\u0000-\u001f]/.test(q))) return validation("q must be at most 100 printable characters.");
  const needle = q === null ? null : fold(q.trim());

  const matching = CATALOG_KEYS.map((k) => COMMS_CATALOG[k])
    .filter((d) =>
      (status.value === null || d.status === status.value) &&
      (category.value === null || d.category === category.value) &&
      (audience.value === null || d.audience === audience.value) &&
      (consentClass.value === null || d.consentClass === consentClass.value) &&
      (channel.value === null || d.channels.some((c) => c.channel === channel.value)) &&
      (needle === null || needle === "" || fold(d.key).includes(needle) || fold(d.displayName).includes(needle)))
    .sort(compareCatalog);

  const paged = page(matching, (d) => d.key, p, now);
  if (!paged.ok) return validation(paged.error);

  // Totals count the FILTERED set (every status key present, 0 allowed), before pagination.
  const totals = Object.fromEntries(DEFINITION_STATUS_ORDER.map((s) => [s, 0])) as Record<DefinitionStatus, number>;
  for (const d of matching) totals[d.status]++;

  const body: CatalogResponse = { ...paged.envelope, items: paged.envelope.items.map(toCatalogItem), totals };
  return json(body);
}

/**
 * GET /catalog/[key] (§4.3). `recentFor` reads the delivery ledger's 30-day
 * series for the key (lib/notifications/delivery/analytics.ts recentSeriesForKey);
 * a throw is 503 via runRead — never a fabricated all-null "not observed".
 * Omitted (pure tests): the not-observed shape.
 */
export async function catalogDetail(key: string, now: Date, recentFor?: (key: string, now: Date) => Promise<DaySeries>): Promise<Response> {
  const def = getCatalogDefinition(key);
  if (!def) return notFound();
  const recent = recentFor ? await recentFor(def.key, now) : unobservedSeries(now);
  return json(toCatalogDetail(def, now, recent) satisfies CatalogDetail);
}

/** GET /catalog/[key]/preview?channel=…&variant=… (§4.4). Renders only; never sends. */
export function catalogPreview(key: string, url: URL, now: Date): Response {
  const def = getCatalogDefinition(key);
  if (!def) return notFound();
  const p = url.searchParams;
  // Only `channel` and `variant` are accepted: no query parameter can supply data.
  for (const name of p.keys()) {
    if (name !== "channel" && name !== "variant") return validation("Only channel and variant are accepted.");
  }
  const channel = p.get("channel");
  if (channel === null || !(PREVIEW_CHANNELS as readonly string[]).includes(channel)) {
    return validation(`channel must be one of ${PREVIEW_CHANNELS.join(", ")}.`);
  }
  const variant = p.get("variant");
  if (variant !== null && !/^[a-z0-9-]{1,80}$/.test(variant)) return validation("Unknown preview variant.");
  const out = renderCatalogPreview(def, channel as PreviewChannel, variant);
  if (!out.ok) return out.code === "INVALID_STATE" ? json({ error: out.error, code: "INVALID_STATE" }, 409) : validation(out.error);
  return json({ ...out.body, checkedAt: now.toISOString() } satisfies PreviewResponse);
}

/** GET /triggers (§4.5). */
export function triggersList(url: URL, now: Date): Response {
  const paged = page(listTriggers(), (t) => t.key, url.searchParams, now);
  if (!paged.ok) return validation(paged.error);
  return json(paged.envelope satisfies TriggersResponse);
}
