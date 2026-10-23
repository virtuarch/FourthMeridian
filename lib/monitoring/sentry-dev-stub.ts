/**
 * lib/monitoring/sentry-dev-stub.ts  (PERF-4)
 *
 * What `@sentry/nextjs` resolves to under `next dev` when NO DSN is configured
 * — and nowhere else (the alias is in next.config.ts; production builds and
 * `next dev` with a DSN resolve the real SDK, untouched).
 *
 * Without a DSN the SDK was already `enabled: false`: it sent nothing, but the
 * dev server still compiled all of it — the Node SDK with OpenTelemetry into
 * the instrumentation layer, the browser SDK into every page. A runtime
 * `if (!dsn)` cannot avoid that; only resolution can. So the init surfaces
 * (instrumentation.ts, instrumentation-client.ts) are unchanged and, here,
 * read these instead:
 *
 *   init                           no initialisation occurs
 *   captureRequestError            undefined ⇒ Next registers no onRequestError
 *   captureRouterTransitionStart   undefined ⇒ Next registers no transition hook
 *
 * It must export every binding the init surfaces read from `Sentry.` and import
 * nothing (lib/monitoring/sentry-dev-gate.test.ts derives and pins both).
 */

/** No DSN ⇒ no initialisation. */
export function init(_options?: unknown): undefined {
  return undefined;
}

export const captureRequestError = undefined;
export const captureRouterTransitionStart = undefined;
