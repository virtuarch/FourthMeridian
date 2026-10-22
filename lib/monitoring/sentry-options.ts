/**
 * lib/monitoring/sentry-options.ts  (V25-FINAL-2 — Area A)
 *
 * THE single, centralized error-monitoring configuration, shared by all three
 * Sentry init points (server + edge in instrumentation.ts, browser in
 * instrumentation-client.ts). Keeping the options in one place is what the ops
 * gate requires ("configuration is centralized"); the three runtimes differ only
 * in which `Sentry.init` they call, never in policy.
 *
 * CLIENT-SAFE BY CONSTRUCTION: this module reads ONLY `NEXT_PUBLIC_*` /
 * build-inlined env and imports nothing server-only (no lib/env, no lib/db). It
 * is bundled into the browser, so it must never touch a secret. The Sentry DSN is
 * a PUBLISHABLE identifier (not a secret), hence `NEXT_PUBLIC_SENTRY_DSN`.
 *
 * DISABLED WITHOUT A DSN: `enabled: !!DSN` means dev/test/preview (no DSN) send
 * NOTHING — the SDK makes no network calls and stays silent. Production is gated
 * separately at boot (lib/env.ts PROD_REQUIRED_KEYS), so a prod deploy cannot run
 * with monitoring silently off.
 *
 * ERRORS ONLY, NO TRACING: `tracesSampleRate: 0` — this is error capture, not an
 * APM/tracing platform (explicit ops-gate non-goal). No dashboards, no metric
 * pipelines; just "serious production failures are visible".
 *
 * FINANCIAL DATA MUST NEVER RIDE AN ERROR PAYLOAD (the instrumentation.ts
 * doctrine): `sendDefaultPii: false` keeps cookies/headers/bodies off by default,
 * and `scrubEvent` additionally strips any request body/cookies/query that a
 * future config change might reintroduce. Financial values live in request
 * bodies and DB rows — neither is ever attached.
 */

import type { Breadcrumb, BreadcrumbHint, ErrorEvent, EventHint } from "@sentry/nextjs";
import { currentDeploymentSha } from "@/lib/monitoring/deployment";

/** The publishable DSN. Empty string ⇒ monitoring disabled (dev/test/preview). */
export const SENTRY_DSN: string = process.env.NEXT_PUBLIC_SENTRY_DSN ?? "";

/** True when a DSN is configured (⇒ the SDK will actually report). */
export const SENTRY_ENABLED: boolean = SENTRY_DSN.length > 0;

/**
 * Deployment environment label. Prefers Vercel's env, falls back to NODE_ENV.
 * Read from NEXT_PUBLIC_/build-inlined vars only so it is identical client + server.
 */
const ENVIRONMENT: string =
  process.env.NEXT_PUBLIC_VERCEL_ENV ??
  process.env.VERCEL_ENV ??
  process.env.NODE_ENV ??
  "development";

/**
 * Release identifier for grouping — the deploy's git SHA when Vercel provides it.
 *
 * OPS-2B′: resolved through the ONE canonical deployment authority, which is the
 * same value stamped onto immutable operational facts (`JobRun.deploymentSha`,
 * `RefreshExecution.deploymentSha`). That shared identifier is what lets a Sentry
 * incident be correlated to the job or refresh that produced it; two independent
 * reads would have been free to drift.
 */
const RELEASE: string | undefined = currentDeploymentSha() ?? undefined;

/**
 * Final defense against financial data / PII leaving in an error payload. Runs on
 * every event just before send. Drops the request body, cookies, and query string
 * — the places a monetary amount, token, or identifier could ride — regardless of
 * any other SDK setting. Pure; returns the scrubbed event (or null to drop).
 */
export function scrubEvent(event: ErrorEvent, _hint?: EventHint): ErrorEvent | null {
  if (event.request) {
    delete event.request.data;        // request body — financial payloads live here
    delete event.request.cookies;     // session / auth cookies
    delete (event.request as { query_string?: unknown }).query_string;
  }
  // Never ship the raw user object beyond an opaque id (no email/ip/financial state).
  if (event.user) {
    event.user = event.user.id ? { id: event.user.id } : {};
  }
  return event;
}

/**
 * PRIV-015 — breadcrumbs are the trail the SDK attaches to every event, and
 * scrubEvent never touched them: a `console` breadcrumb carries the full
 * console.log/console.error arguments (route handlers log identifiers, Plaid
 * error payloads, user ids), and an `http`/`fetch`/`navigation` breadcrumb
 * carries the full URL including its query string (`?asof=…&account=…`,
 * `?q=<username>`, tokens in reset links). Runs on every breadcrumb before it is
 * recorded. Pure; returns the scrubbed breadcrumb, or null to drop it.
 *
 *   - `console` breadcrumbs are DROPPED outright (the exception itself is
 *     captured separately; the log line adds only payload).
 *   - any breadcrumb's `data.url` / `data.to` / `data.from` loses its query
 *     string and fragment; `message` loses any `?query` it embeds.
 *   - `data.body`, `data.request`/`response` payloads and `data.arguments` are
 *     removed.
 */
const URL_KEYS = ["url", "to", "from"] as const;
const PAYLOAD_KEYS = ["body", "arguments", "request", "response", "input", "query_string", "params"] as const;

function stripQuery(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb, _hint?: BreadcrumbHint): Breadcrumb | null {
  if (!breadcrumb || typeof breadcrumb !== "object") return null;
  if (breadcrumb.category === "console") return null;
  if (breadcrumb.data && typeof breadcrumb.data === "object") {
    const data = { ...breadcrumb.data };
    for (const k of URL_KEYS) if (k in data) data[k] = stripQuery(data[k]);
    for (const k of PAYLOAD_KEYS) delete data[k];
    breadcrumb = { ...breadcrumb, data };
  }
  if (typeof breadcrumb.message === "string" && /[?#]/.test(breadcrumb.message)) {
    breadcrumb = { ...breadcrumb, message: breadcrumb.message.replace(/[?#][^\s"']*/g, "") };
  }
  return breadcrumb;
}

/**
 * The shared init options every runtime passes to `Sentry.init`. A plain object
 * (not a typed Sentry Options import) so it is trivially usable by the node, edge,
 * and browser SDKs alike.
 */
export function sharedSentryOptions() {
  return {
    dsn:              SENTRY_DSN || undefined,
    enabled:          SENTRY_ENABLED,
    environment:      ENVIRONMENT,
    release:          RELEASE,
    tracesSampleRate: 0,          // error monitoring only — NOT tracing/APM
    sendDefaultPii:   false,      // no cookies/headers/ip by default
    beforeSend:       scrubEvent, // strip any residual financial data / PII
    beforeBreadcrumb: scrubBreadcrumb, // PRIV-015 — no console lines, no query strings
  };
}
