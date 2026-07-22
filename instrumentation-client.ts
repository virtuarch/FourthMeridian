/**
 * instrumentation-client.ts  (V25-FINAL-2 — Area A)
 *
 * Next.js browser-instrumentation hook (loaded automatically on the client, the
 * counterpart to instrumentation.ts on the server). Initializes Sentry for the
 * BROWSER runtime from the SAME shared, client-safe config the server uses
 * (lib/monitoring/sentry-options.ts) — one policy, one scrubber, one DSN source.
 *
 * With no DSN (dev/test/preview) the SDK is `enabled: false` and sends nothing.
 * Fatal client/runtime errors surface through this init + app/global-error.tsx.
 */

import * as Sentry from "@sentry/nextjs";
import { sharedSentryOptions } from "@/lib/monitoring/sentry-options";

Sentry.init(sharedSentryOptions());

/**
 * Instruments Next.js App Router client navigations so an error during a
 * client-side transition is attributed correctly. No-op when the SDK is disabled.
 */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
