/**
 * lib/monitoring/sentry-options.test.ts  (V25-FINAL-2 — Area A)
 *
 * Proves the production error-monitoring wiring is REAL, not merely present:
 *   1. scrubEvent — financial data / PII never rides an error payload (executed).
 *   2. sharedSentryOptions — errors-only, DSN-gated, scrubber wired (executed).
 *   3. Registration — instrumentation.ts actually inits Sentry + exports the
 *      server error hook; the browser + global-error surfaces init/capture too.
 *   4. The production gate — NEXT_PUBLIC_SENTRY_DSN is prod-required.
 *   5. Client-safety — the shared options never import a server-only module.
 *
 *     npx tsx lib/monitoring/sentry-options.test.ts
 */

import { readFileSync } from "fs";
import { join } from "path";
import { scrubEvent, sharedSentryOptions, SENTRY_ENABLED } from "./sentry-options";
import type { ErrorEvent } from "@sentry/nextjs";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; } else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
function read(rel: string): string { return readFileSync(join(process.cwd(), rel), "utf8"); }

// ── 1. scrubEvent — financial data / PII is stripped before send ──────────────
{
  const dirty = {
    request: {
      data: { amount: 1234.56, accessToken: "access-sandbox-xyz", accountNumber: "000123" },
      cookies: "session=secret",
      query_string: "amount=999",
      url: "https://app/x", // non-sensitive, kept
    },
    user: { id: "u1", email: "person@example.com", ip_address: "1.2.3.4" },
    exception: { values: [{ type: "Error", value: "boom" }] },
  } as unknown as ErrorEvent;

  const clean = scrubEvent(dirty)!;
  check("scrub: request body (financial payload) removed", clean.request?.data === undefined);
  check("scrub: cookies removed", clean.request?.cookies === undefined);
  check("scrub: query string removed", (clean.request as { query_string?: unknown }).query_string === undefined);
  check("scrub: non-sensitive request url preserved", clean.request?.url === "https://app/x");
  check("scrub: user reduced to opaque id (no email/ip)",
    clean.user?.id === "u1" && (clean.user as { email?: string }).email === undefined && (clean.user as { ip_address?: string }).ip_address === undefined);
  check("scrub: exception payload preserved (the error itself is the point)", clean.exception?.values?.[0]?.value === "boom");

  // A serialized scrubbed event must not contain the financial/secret material.
  const serialized = JSON.stringify(clean);
  for (const leak of ["1234.56", "access-sandbox-xyz", "000123", "person@example.com", "1.2.3.4", "session=secret"]) {
    check(`scrub: "${leak}" absent from the outgoing event`, !serialized.includes(leak));
  }
}

// ── 2. sharedSentryOptions — errors-only, DSN-gated, scrubber wired ───────────
{
  const o = sharedSentryOptions();
  check("options: enabled reflects DSN presence (disabled in this DSN-less test env)", o.enabled === SENTRY_ENABLED && o.enabled === false);
  check("options: tracesSampleRate 0 (error monitoring, NOT tracing/APM)", o.tracesSampleRate === 0);
  check("options: sendDefaultPii false", o.sendDefaultPii === false);
  check("options: beforeSend is the shared scrubber", o.beforeSend === scrubEvent);
  check("options: an environment label is always set", typeof o.environment === "string" && o.environment.length > 0);
  check("options: no DSN ⇒ dsn undefined (SDK makes no network calls)", o.dsn === undefined);
}

// ── 3. Registration — the SDK is actually initialized, not just imported ──────
{
  const instr = read("instrumentation.ts");
  check("instrumentation imports the Sentry SDK", /from ["']@sentry\/nextjs["']/.test(instr));
  check("instrumentation calls Sentry.init with the shared options", /Sentry\.init\(\s*sharedSentryOptions\(\)\s*\)/.test(instr));
  check("instrumentation inits for BOTH nodejs and edge runtimes",
    instr.includes('NEXT_RUNTIME === "nodejs"') && instr.includes('NEXT_RUNTIME === "edge"'));
  check("instrumentation exports onRequestError (server error capture hook)",
    /export const onRequestError\s*=\s*Sentry\.captureRequestError/.test(instr));
  check("instrumentation still validates env (existing behavior preserved)", instr.includes("validateEnv"));

  const client = read("instrumentation-client.ts");
  check("browser instrumentation inits Sentry from the shared options",
    /Sentry\.init\(\s*sharedSentryOptions\(\)\s*\)/.test(client));

  const globalErr = read("app/global-error.tsx");
  check("global-error boundary captures to Sentry", /Sentry\.captureException\(/.test(globalErr));
  check("global-error is a client component", globalErr.includes('"use client"'));
}

// ── 4. Production gate — monitoring DSN is prod-required ──────────────────────
{
  const envSrc = read("lib/env.ts");
  const prodBlock = envSrc.slice(envSrc.indexOf("PROD_REQUIRED_KEYS"), envSrc.indexOf("];", envSrc.indexOf("PROD_REQUIRED_KEYS")));
  check("NEXT_PUBLIC_SENTRY_DSN is in PROD_REQUIRED_KEYS (prod fails fast if unmonitored)",
    prodBlock.includes("NEXT_PUBLIC_SENTRY_DSN"));
  check("env exposes isErrorMonitoringConfigured", envSrc.includes("isErrorMonitoringConfigured"));
}

// ── 5. Client-safety — shared options never pull a server-only module ─────────
{
  const opts = read("lib/monitoring/sentry-options.ts");
  check("shared options do not import lib/env (would drag server env into the client bundle)",
    !/from ["']@\/lib\/env["']/.test(opts));
  check("shared options do not import server-only", !opts.includes('"server-only"'));
  check("shared options read only NEXT_PUBLIC_ / VERCEL_ env (client-inlinable)",
    !/process\.env\.(?!NEXT_PUBLIC_|VERCEL_|NODE_ENV)/.test(opts));
}

console.log(`\nsentry-options: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
