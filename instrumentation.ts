/**
 * instrumentation.ts  (OPS-1 S6)
 *
 * Next.js server-boot hook — register() runs once per server process start
 * (build output boot on Vercel, `next dev`/`next start` locally), before any
 * request is served.
 *
 * WHAT RUNS HERE
 * --------------
 *   - validateEnv() (lib/env.ts): fails the boot LOUDLY with the complete list
 *     of missing required variables instead of letting the first request die
 *     on a cryptic downstream error. Production additionally requires the
 *     prod-only set (NEXTAUTH_URL, NEXT_PUBLIC_APP_URL, RESEND_API_KEY,
 *     CRON_SECRET) — see PROD_REQUIRED_KEYS in lib/env.ts.
 *
 * ERROR MONITORING (V25-FINAL-2 — Area A)
 * ----------------------------------------
 *   Sentry is initialized here for the SERVER and EDGE runtimes (the browser is
 *   initialized in instrumentation-client.ts). Options come from the single
 *   shared, client-safe config (lib/monitoring/sentry-options.ts) with financial
 *   data / PII scrubbing (scrubEvent). With NO DSN configured (dev/test/preview)
 *   the SDK is `enabled: false` and makes no network calls — local runs stay
 *   silent. Production requires NEXT_PUBLIC_SENTRY_DSN at boot (lib/env.ts
 *   PROD_REQUIRED_KEYS), so prod can never run with monitoring silently off.
 *
 *   `onRequestError` (exported below) is the Next.js 15+/16 hook that captures
 *   uncaught errors thrown while rendering/serving a request — the server-side
 *   error path. Client render errors are captured by app/global-error.tsx.
 *
 * EXPLICIT NON-GOALS (do not add here without their own decision record)
 * ----------------------------------------------------------------------
 *   - Background-job dispatch stays OUT of this file. The dormant in-process
 *     scheduler was retired in OPS-4 S2 — scheduled work runs through the
 *     cron-driven dispatcher (app/api/jobs/dispatch + lib/jobs/registry.ts)
 *     and must never become a boot side effect of this file.
 *   - No tracing/APM, dashboards, or metric pipelines — error capture only.
 *
 * The NEXT_RUNTIME guard keeps the edge bundle (proxy.ts middleware) from
 * pulling in node-only imports.
 */

import * as Sentry from "@sentry/nextjs";
import { sharedSentryOptions } from "@/lib/monitoring/sentry-options";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Init monitoring FIRST so an env-validation failure is itself captured.
    Sentry.init(sharedSentryOptions());

    const { validateEnv } = await import("@/lib/env");
    validateEnv();
    console.log("[instrumentation] validateEnv passed — server starting.");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    Sentry.init(sharedSentryOptions());
  }
}

/**
 * Next.js server-error capture hook — invoked for uncaught errors during
 * request rendering/serving (App Router, route handlers, RSC). Delegating to
 * the SDK helper keeps capture correct across runtimes; a no-DSN SDK swallows it.
 */
export const onRequestError = Sentry.captureRequestError;
