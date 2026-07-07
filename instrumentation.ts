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
 * EXPLICIT NON-GOALS (do not add here without their own decision record)
 * ----------------------------------------------------------------------
 *   - Background-job dispatch stays OUT of this file. The dormant in-process
 *     scheduler was retired in OPS-4 S2 — scheduled work runs through the
 *     cron-driven dispatcher (app/api/jobs/dispatch + lib/jobs/registry.ts)
 *     and must never become a boot side effect of this file.
 *   - Error reporting (Sentry or equivalent) is NOT configured yet. When it
 *     is adopted, this register() is the intended init point for the server
 *     side (with PII/body scrubbing — financial data must never ride an error
 *     payload). Until then, fail-open paths log structured console lines
 *     ("[rate-limit] store error — failing open", etc.).
 *
 * The NEXT_RUNTIME guard keeps the edge bundle (proxy.ts middleware) from
 * pulling in node-only imports.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateEnv } = await import("@/lib/env");
    validateEnv();
    console.log("[instrumentation] validateEnv passed — server starting.");
  }
}
