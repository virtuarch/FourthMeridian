/**
 * lib/env.ts
 *
 * Centralised environment variable access and startup validation.
 *
 * USAGE
 * -----
 * Import `env` wherever you need an environment variable:
 *
 *   import { env } from "@/lib/env";
 *   const url = env.DATABASE_URL;           // throws if not set
 *   if (env.isPlaidEnabled) { ... }         // feature flag
 *
 * Call `validateEnv()` early in server startup (e.g. instrumentation.ts)
 * to surface ALL missing required variables at once instead of discovering
 * them one by one at runtime:
 *
 *   import { validateEnv } from "@/lib/env";
 *   validateEnv();  // throws with a full list of missing vars if any are absent
 *
 * DESIGN
 * ------
 * - Required variables are accessed via getters that throw at call-site if missing.
 *   This fails fast and gives a clear error rather than a cryptic downstream failure.
 * - Optional integrations expose the raw value (undefined if not set) and
 *   boolean feature flags (isPlaidEnabled, etc.) for guard clauses.
 * - `validateEnv()` can be called to validate everything eagerly at startup.
 *
 * FLAG PATTERN (v2.6 REVIEW-3, deliberate)
 * ----------------------------------------
 * Feature-flag and kill-switch TRUTH lives at each flag's OWN gate function,
 * which reads `process.env.X` directly at CALL TIME (e.g.
 * lib/investments/position-capture.ts `investmentObservationsEnabled()`).
 * That is load-bearing, not sloppiness:
 *   - the test suite toggles process.env at runtime and re-invokes the gates
 *     (this module snapshots once at load, so a mirror here can NEVER be the
 *     gate);
 *   - operational scripts run the gated modules under plain `tsx`, where this
 *     module's `server-only` import cannot be resolved without a preload.
 * This module therefore carries NO duplicate boolean accessor for those flags
 * — a second, documented-but-dead copy of a flag authority is exactly the
 * drift REVIEW-3 removed. The snapshot entries below exist ONLY for startup
 * validation and the value-free env report. `.env.example` is the single
 * documentation surface for every variable and its default.
 */

import "server-only";

// ── Internal snapshot (read once at module load) ──────────────────────────────

const _e = {
  DATABASE_URL:         process.env.DATABASE_URL,
  NEXTAUTH_SECRET:      process.env.NEXTAUTH_SECRET,
  NEXTAUTH_URL:         process.env.NEXTAUTH_URL,
  NEXT_PUBLIC_APP_URL:  process.env.NEXT_PUBLIC_APP_URL,
  ENCRYPTION_KEY:       process.env.ENCRYPTION_KEY,

  PLAID_CLIENT_ID:      process.env.PLAID_CLIENT_ID,
  PLAID_SECRET:         process.env.PLAID_SECRET,
  PLAID_ENV:            process.env.PLAID_ENV,

  OPENAI_API_KEY:       process.env.OPENAI_API_KEY,
  ETHERSCAN_API_KEY:    process.env.ETHERSCAN_API_KEY,
  HELIUS_API_KEY:       process.env.HELIUS_API_KEY,

  RESEND_API_KEY:       process.env.RESEND_API_KEY,
  EMAIL_FROM_DEFAULT:   process.env.EMAIL_FROM_DEFAULT,

  // Security Ops alerts inbox (Wave 3 ⑧). Optional — the anomaly detector sends
  // its direct security-alert email here; defaults to security@fourthmeridian.com
  // when unset (still env-gated by RESEND_API_KEY like all mail).
  SECURITY_ALERTS_EMAIL: process.env.SECURITY_ALERTS_EMAIL,

  // Platform Ops alert destination (OPS-5 S5). Optional — the alert evaluator
  // emails the operator here on any breach. When UNSET there is no destination:
  // alerts are still evaluated and recorded, but no mail is sent (an honest
  // "skipped", surfaced in the Alerts widget) rather than sent to a guessed
  // mailbox that might bounce. Still env-gated by RESEND_API_KEY like all mail.
  PLATFORM_ALERTS_EMAIL: process.env.PLATFORM_ALERTS_EMAIL,

  // PO-3B — beta-request intake notification destination. Same honest-skip
  // pattern as PLATFORM_ALERTS_EMAIL: null when unset ⇒ no operator notification
  // is sent (the request is still recorded + reviewable in the queue). Never a
  // hardcoded personal address.
  BETA_REQUESTS_EMAIL: process.env.BETA_REQUESTS_EMAIL,

  // CAPTCHA (Cloudflare Turnstile, Wave 2 ⑥). Both optional — absent means
  // CAPTCHA is DISABLED (verifyCaptchaToken skips → true; widgets don't
  // render). The secret gates server-side verification (lib/captcha.ts reads
  // process.env.TURNSTILE_SECRET_KEY directly — the single verify site); the
  // NEXT_PUBLIC site key is inlined into client bundles by Next, so client
  // widgets read process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY directly (they
  // can't import this server-only module) — mirrored here for server-side
  // "is it configured?" checks and env reporting.
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
  TURNSTILE_SECRET_KEY:           process.env.TURNSTILE_SECRET_KEY,

  CRON_SECRET:          process.env.CRON_SECRET,
  RATE_LIMIT_ENABLED:   process.env.RATE_LIMIT_ENABLED,
  RATE_LIMIT_SHADOW:    process.env.RATE_LIMIT_SHADOW,

  DISABLE_SYSTEM_ADMIN: process.env.DISABLE_SYSTEM_ADMIN,
  NODE_ENV:             process.env.NODE_ENV,

  // V26-ENV-1 — deployment-environment identity. `VERCEL` is "1" on every Vercel
  // build/runtime; `VERCEL_ENV` is "production" | "preview" | "development".
  // These are the ONLY authority on which deployment this is — NODE_ENV is not
  // (see deploymentEnvironment() below for why that distinction is load-bearing).
  VERCEL:               process.env.VERCEL,
  VERCEL_ENV:           process.env.VERCEL_ENV,

  // V25-FINAL-2 (Area A) — error-monitoring (Sentry) DSN. PUBLISHABLE, not a
  // secret: it identifies the ingest project, not an auth credential, hence the
  // NEXT_PUBLIC_ prefix (inlined into client bundles so instrumentation-client.ts
  // can read it). Mirrored here for server-side "is monitoring configured?"
  // checks, getEnvReport, and the PRODUCTION gate (PROD_REQUIRED_KEYS) — the
  // instrumentation init points read the shared client-safe config directly.
  // Absent ⇒ SDK disabled (dev/test/preview stay silent, no network calls).
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // MI2 S2 — the designated Merchant Operations Space id. Optional: absent means
  // the merge-review surface fails CLOSED (no one is a member of "no space"), so
  // access is a deliberate SYSTEM_ADMIN act of creating the Space, setting this,
  // and granting membership. Config, not schema, per the ratified refinement.
  MERCHANT_OPS_SPACE_ID: process.env.MERCHANT_OPS_SPACE_ID,

  // ── Price / FX vendor keys (A-track investment history + MC1 FX archive) ─────
  // Declared here for documentation + value-free env reporting. Each SDK/adapter
  // call site still reads process.env directly (registry pattern) so it fails at
  // its own boundary; these snapshot entries exist for "is it configured?" checks
  // and getEnvReport, NOT to feed the adapters. All OPTIONAL — absent degrades
  // the integration gracefully (see the accessors below), never a boot failure.
  TIINGO_API_KEY:    process.env.TIINGO_API_KEY,    // securities price vendor (lib/prices/registry.ts)
  COINGECKO_API_KEY: process.env.COINGECKO_API_KEY, // BTC/USD daily close backfill (lib/crypto/btc-price.ts)
  // V26-PRICE-4C — days of history the CONFIGURED CoinGecko tier serves. Absent
  // ⇒ the Demo default (365). Possession of a key does NOT imply a paid plan, so
  // a paid deployment must set this to match its tier; leaving it unset makes the
  // adapter advertise less capability than it has, never more.
  COINGECKO_HISTORY_DAYS: process.env.COINGECKO_HISTORY_DAYS,
  OXR_APP_ID:        process.env.OXR_APP_ID,        // primary FX provider (lib/fx/registry.ts)

  // ── Investment-history pipeline kill switches (A1/A3/A4/A9 + price capture) ──
  // Each is strict `=== "true"` at its own reader; absent/anything-else = OFF.
  // Mirrored here for documentation + feature-flag checks only (the pipeline
  // readers still consult process.env directly at their call sites).
  INVESTMENT_OBSERVATIONS_ENABLED:   process.env.INVESTMENT_OBSERVATIONS_ENABLED,
  INVESTMENT_EVENTS_ENABLED:         process.env.INVESTMENT_EVENTS_ENABLED,
  INVESTMENT_RECONSTRUCTION_ENABLED: process.env.INVESTMENT_RECONSTRUCTION_ENABLED,
  WEALTH_REGENERATION_ENABLED:       process.env.WEALTH_REGENERATION_ENABLED,
  SECURITY_PRICES_ENABLED:           process.env.SECURITY_PRICES_ENABLED,
  INVESTMENT_IMPORTS_ENABLED:        process.env.INVESTMENT_IMPORTS_ENABLED,

  // ⚠️ QUANTITY_AUTHORITY_MODE — A MONEY SWITCH, not an ordinary feature flag
  // (V26-QUANTITY-1G; declared here by REVIEW-3 — it was previously undeclared).
  // Read at call time by lib/investments/quantity-authority.ts
  // `quantityAuthorityMode()`, which IS wired into historical valuation
  // (lib/investments/valuation.ts). Values:
  //   unset / "off" / anything unrecognised → off (byte-identical valuation;
  //     a typo must never silently enable an experimental money path)
  //   "compare" → both quantity replays computed, LEGACY used, deltas ledgered
  //   "adopt"   → the quantity-timeline authority's quantity is USED wherever
  //     sufficiently supported — this REPOINTS historical quantity replay, i.e.
  //     it changes money values. Never set in production without the
  //     compare-mode ledger having been reviewed first.
  // validateEnv() warns loudly on any non-off value; see .env.example.
  QUANTITY_AUTHORITY_MODE: process.env.QUANTITY_AUTHORITY_MODE,

  // ── AI output enforcement / diagnostics ─────────────────────────────────────
  // AI_OUTPUT_VALIDATION_MODE: shadow | annotate | block; unset/unrecognized ⇒
  // 'annotate' (the live KD-2 default) at app/api/ai/chat/route.ts. FLOWTYPE_SHADOW
  // toggles an optional non-PII flow-distribution log line only (no data-path
  // effect); unset ⇒ "off". Both read directly at their sites — mirrored for docs.
  AI_OUTPUT_VALIDATION_MODE: process.env.AI_OUTPUT_VALIDATION_MODE,
  FLOWTYPE_SHADOW:           process.env.FLOWTYPE_SHADOW,
} as const;

// ── Deployment-environment classification (V26-ENV-1) ─────────────────────────

/** The deployment environments this app recognises. */
export type DeploymentEnvironment = "production" | "preview" | "development";

/**
 * THE TRAP THIS EXISTS TO CLOSE: **Vercel builds Preview deployments with
 * `NODE_ENV=production`.** Every production-only guard in this file used to key
 * on `NODE_ENV === "production"`, so a Preview deployment was classified as
 * Production and had to satisfy every production requirement. Two consequences,
 * both observed in the wild:
 *
 *   - `PROD_REQUIRED_KEYS` were enforced on Preview — which is why Preview was
 *     made to carry a production-only NEXT_PUBLIC_SENTRY_DSN just to boot.
 *   - The Plaid production guard fired on Preview, where `PLAID_ENV="sandbox"`
 *     is the CORRECT setting. It throws from `validateEnv()`, which runs inside
 *     the instrumentation `register()` hook — so the Preview server never
 *     booted and EVERY route (not just Plaid) failed with "An error occurred
 *     while loading instrumentation hook". Preview was down completely.
 *
 * `VERCEL_ENV` is the authority on Vercel. `NODE_ENV` is a BUILD-MODE signal
 * ("is this an optimised build?"), NOT a deployment environment, and must never
 * be used as one on Vercel.
 *
 * Outside Vercel (local dev, CI, tests) there is no `VERCEL_ENV`, so the
 * original `NODE_ENV` behaviour is preserved exactly.
 *
 * NOTE on the `VERCEL=1` + `VERCEL_ENV` unset edge: this classifies as
 * "development" (non-production), matching the specified contract. Vercel always
 * sets `VERCEL_ENV` on a real deployment, so this state is not reachable there.
 */
export function deploymentEnvironment(): DeploymentEnvironment {
  if (_e.VERCEL === "1") {
    if (_e.VERCEL_ENV === "production") return "production";
    if (_e.VERCEL_ENV === "preview")    return "preview";
    return "development";
  }
  return _e.NODE_ENV === "production" ? "production" : "development";
}

/**
 * The single classifier every production-only guard in this file consults.
 * Equivalent to:
 *
 *   VERCEL === "1" ? VERCEL_ENV === "production" : NODE_ENV === "production"
 *
 * Expressed via `deploymentEnvironment()` so the boolean and the three-way
 * classification can never disagree.
 */
export function isProductionDeployment(): boolean {
  return deploymentEnvironment() === "production";
}

// ── Required variable getter ──────────────────────────────────────────────────

function req(key: keyof typeof _e): string {
  const val = _e[key];
  if (!val) {
    throw new Error(
      `[env] Required environment variable "${key}" is not set.\n` +
      `      Check your .env.local file or deployment secrets.`
    );
  }
  return val as string;
}

// ── Startup validator ─────────────────────────────────────────────────────────

const REQUIRED_KEYS: (keyof typeof _e)[] = [
  "DATABASE_URL",
  "NEXTAUTH_SECRET",
  "ENCRYPTION_KEY",
];

// OPS-1 S6 — required in a PRODUCTION DEPLOYMENT only (isProductionDeployment(),
// i.e. VERCEL_ENV="production" on Vercel — NOT merely NODE_ENV="production", which
// is also true on Preview). Dev/test/preview keep working without them:
//   - NEXTAUTH_URL / NEXT_PUBLIC_APP_URL: auto-detected / localhost in dev,
//     but production email links and auth redirects must never guess.
//   - RESEND_API_KEY: without it lib/email/send.ts silently captures instead
//     of sending — acceptable in dev, a broken password-reset flow in prod.
//   - CRON_SECRET: vercel.json schedules the single dispatcher cron (OPS-4
//     S2, /api/jobs/dispatch); unset means every cron request 401s
//     (jobs enabled ⇒ secret required).
const PROD_REQUIRED_KEYS: (keyof typeof _e)[] = [
  "NEXTAUTH_URL",
  "NEXT_PUBLIC_APP_URL",
  "RESEND_API_KEY",
  "CRON_SECRET",
  // V25-FINAL-2 (Area A) — production error monitoring is a pre-beta requirement
  // (docs/operations/production-readiness.md). Without a DSN a prod deploy would
  // run BLIND to serious failures, so boot fails fast rather than start silently
  // unmonitored.
  //
  // V26-ENV-1: dev/test/preview genuinely do not require it now (the SDK simply
  // stays disabled). Before the deployment-aware classifier this comment was
  // FALSE — Preview matched NODE_ENV="production" and so was forced to carry a
  // production-only DSN just to pass boot validation.
  "NEXT_PUBLIC_SENTRY_DSN",
];

// ── Structured report (PO1.2 — additive; names only, never values) ─────────────

/** Per-key verdict in the env report. */
export type EnvKeyStatus = "pass" | "warn" | "fail";

/** One checked key's verdict. Carries the key NAME and a static note only —
 *  never the value, matching the codebase's PII-avoidance doctrine. */
export interface EnvKeyReport {
  /** The environment variable name (never its value). */
  key:    string;
  status: EnvKeyStatus;
  /** When the key is required: always, only in production, or optional. */
  scope:  "always" | "production" | "optional";
  /** Short static reason (no values). */
  note?:  string;
}

/** The structured, value-free environment report surfaced by the ops_env_status
 *  widget. `ok` is true iff nothing is a hard `fail`. */
export interface EnvReport {
  nodeEnv: string;
  ok:      boolean;
  counts:  { pass: number; warn: number; fail: number };
  keys:    EnvKeyReport[];
}

/**
 * Non-throwing classification of every key `validateEnv()` checks, as a
 * structured report. Pure over the module snapshot `_e`; safe to call from a
 * request handler (unlike validateEnv, which throws on a hard failure). Reports
 * NAMES + status only — never values. Kept in lock-step with validateEnv's own
 * required/prod-required/RATE_LIMIT conditions below.
 */
export function getEnvReport(): EnvReport {
  // V26-ENV-1 — deployment-aware, NOT NODE_ENV. On a Preview deployment the
  // prod-only keys are a "warn" (unset is fine), never a "fail".
  const isProd = isProductionDeployment();
  const keys: EnvKeyReport[] = [];

  for (const k of REQUIRED_KEYS) {
    keys.push(
      _e[k]
        ? { key: k, status: "pass", scope: "always" }
        : { key: k, status: "fail", scope: "always", note: "required — not set" },
    );
  }

  for (const k of PROD_REQUIRED_KEYS) {
    if (_e[k]) keys.push({ key: k, status: "pass", scope: "production" });
    else if (isProd) keys.push({ key: k, status: "fail", scope: "production", note: "required in production — not set" });
    else keys.push({ key: k, status: "warn", scope: "production", note: "unset — required in production" });
  }

  // RATE_LIMIT_ENABLED — never fatal; mirrors validateEnv's two warn conditions.
  const rl = _e.RATE_LIMIT_ENABLED;
  if (isProd && rl === "false") {
    keys.push({ key: "RATE_LIMIT_ENABLED", status: "warn", scope: "optional", note: "disabled in production" });
  } else if (rl !== undefined && rl !== "" && rl !== "true" && rl !== "false") {
    keys.push({ key: "RATE_LIMIT_ENABLED", status: "warn", scope: "optional", note: "unexpected value" });
  } else {
    keys.push({ key: "RATE_LIMIT_ENABLED", status: "pass", scope: "optional" });
  }

  // QUANTITY_AUTHORITY_MODE — a money switch (see the snapshot comment). Never
  // fatal, but any non-off value is surfaced as a warn so an experimental
  // quantity replay can never be silently live.
  const qam = _e.QUANTITY_AUTHORITY_MODE;
  if (qam === undefined || qam === "" || qam === "off") {
    keys.push({ key: "QUANTITY_AUTHORITY_MODE", status: "pass", scope: "optional" });
  } else if (qam === "compare" || qam === "adopt") {
    keys.push({ key: "QUANTITY_AUTHORITY_MODE", status: "warn", scope: "optional", note: `quantity authority is "${qam}" — experimental quantity replay is active` });
  } else {
    keys.push({ key: "QUANTITY_AUTHORITY_MODE", status: "warn", scope: "optional", note: "unrecognised value — treated as off" });
  }

  // Optional price/FX vendor keys — never fatal. Represented in the report so the
  // ops surface shows whether each external integration is configured. Absent is a
  // warn ("integration disabled / graceful degrade"), never a fail. Names only.
  for (const k of ["TIINGO_API_KEY", "OXR_APP_ID", "COINGECKO_API_KEY"] as const) {
    keys.push(
      _e[k]
        ? { key: k, status: "pass", scope: "optional" }
        : { key: k, status: "warn", scope: "optional", note: "optional vendor key — integration disabled" },
    );
  }

  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const k of keys) counts[k.status]++;

  return { nodeEnv: _e.NODE_ENV ?? "development", ok: counts.fail === 0, counts, keys };
}

/**
 * Validates all required environment variables in one pass.
 * Runs at server boot via instrumentation.ts (OPS-1 S6).
 * Throws with a complete list of missing variables.
 *
 * PO1.2 (additive, backward-compatible): now ALSO returns the structured
 * `EnvReport` on success. The throw-at-boot behavior is unchanged — callers
 * that ignore the return (instrumentation.ts) are unaffected; a caller that
 * needs the report without risking a throw uses `getEnvReport()` instead.
 */
export function validateEnv(): EnvReport {
  // V26-ENV-1 — every production-only guard below keys on the DEPLOYMENT
  // environment, not NODE_ENV (which Vercel also sets to "production" on
  // Preview). See deploymentEnvironment() for the failure this prevents.
  const isProd  = isProductionDeployment();
  const missing = [
    ...REQUIRED_KEYS.filter((k) => !_e[k]),
    ...(isProd ? PROD_REQUIRED_KEYS.filter((k) => !_e[k]) : []),
  ];

  if (missing.length > 0) {
    throw new Error(
      `[env] Missing required environment variable${missing.length > 1 ? "s" : ""}:\n` +
      missing.map((k) => `  • ${k}`).join("\n") +
      `\n\nSee .env.example for setup instructions.`
    );
  }

  // V25-FINAL-2 — a production deployment must not silently run against Plaid
  // SANDBOX. Plaid is an OPTIONAL integration (a prod deploy with NO credentials
  // runs with Plaid disabled — env.isPlaidEnabled false, routes return 503), and
  // that supported mode is untouched. But when Plaid IS configured in production
  // (both credentials present ⇒ real ingestion is expected), PLAID_ENV must be an
  // explicit "production": otherwise the app talks to sandbox with real users
  // (PLAID_ENV unset defaults to "sandbox" at the accessor), or hits an unguarded
  // 500 on first call. Fail fast at boot instead.
  //
  // V26-ENV-1: dev/preview/test genuinely never reach this branch now, because
  // the gate is isProductionDeployment(). The previous comment claimed the same
  // thing while the gate was NODE_ENV-based — and it was FALSE: Vercel Preview
  // builds set NODE_ENV="production", so Preview (correctly running
  // PLAID_ENV="sandbox") threw here at boot and took the ENTIRE deployment down,
  // every route, not just Plaid. Preview keeps using sandbox freely.
  if (isProd && _e.PLAID_CLIENT_ID && _e.PLAID_SECRET && _e.PLAID_ENV !== "production") {
    const shown = _e.PLAID_ENV ? `"${_e.PLAID_ENV}"` : "unset (defaults to sandbox)";
    throw new Error(
      `[env] Plaid is configured in production (PLAID_CLIENT_ID + PLAID_SECRET present) but ` +
      `PLAID_ENV is ${shown}. A production deployment must set PLAID_ENV="production" — ` +
      `refusing to start against Plaid sandbox with real users.\n\n` +
      `Fix: set PLAID_ENV="production", or unset PLAID_CLIENT_ID/PLAID_SECRET to run with ` +
      `Plaid disabled.`
    );
  }

  // RATE_LIMIT_ENABLED (OPS-1 S4 polarity): production is limited by default;
  // "false" is an explicit emergency opt-out. Never fatal — but loud.
  if (isProd && _e.RATE_LIMIT_ENABLED === "false") {
    console.warn(
      "[env] RATE_LIMIT_ENABLED=false in production — rate limiting is DISABLED. " +
      "This should be a temporary emergency measure only."
    );
  }
  const rl = _e.RATE_LIMIT_ENABLED;
  if (rl !== undefined && rl !== "" && rl !== "true" && rl !== "false") {
    console.warn(
      `[env] RATE_LIMIT_ENABLED has unexpected value ${JSON.stringify(rl)} — expected "true" or "false".`
    );
  }

  // QUANTITY_AUTHORITY_MODE (REVIEW-3) — a MONEY switch: "adopt" repoints
  // historical quantity replay inside valuation (lib/investments/
  // quantity-authority.ts). Never fatal (the reader treats any unrecognised
  // value as off), but a non-off value must never be silently live.
  const qam = _e.QUANTITY_AUTHORITY_MODE;
  if (qam === "compare" || qam === "adopt") {
    console.warn(
      `[env] QUANTITY_AUTHORITY_MODE="${qam}" — the experimental quantity-timeline ` +
      `authority is ${qam === "adopt" ? "ADOPTED into historical valuation (money values can change)" : "computed in compare mode (legacy values still used)"}.` +
      (isProd ? " This is a PRODUCTION deployment — confirm this is deliberate." : "")
    );
  } else if (qam !== undefined && qam !== "" && qam !== "off") {
    console.warn(
      `[env] QUANTITY_AUTHORITY_MODE has unrecognised value ${JSON.stringify(qam)} — ` +
      `treated as "off" (expected "off" | "compare" | "adopt").`
    );
  }

  // Additive: return the structured report on the success path (no throw).
  return getEnvReport();
}

// ── Public env object ─────────────────────────────────────────────────────────

export const env = {
  // ── Required ──────────────────────────────────────────────────────────────
  get DATABASE_URL()    { return req("DATABASE_URL"); },
  get NEXTAUTH_SECRET() { return req("NEXTAUTH_SECRET"); },
  get ENCRYPTION_KEY()  { return req("ENCRYPTION_KEY"); },

  // NEXTAUTH_URL is optional in dev (auto-detected from Host header) but
  // should be set in production.
  get NEXTAUTH_URL()    { return _e.NEXTAUTH_URL; },

  // Trusted public base URL for absolute links in outbound email (e.g. password
  // reset). Read from env — NEVER from a request Host header — so a poisoned
  // Host cannot redirect a reset link to an attacker domain. Falls back to
  // localhost in dev (mirrors app/layout.tsx metadataBase).
  get NEXT_PUBLIC_APP_URL() { return _e.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"; },

  // ── Plaid ─────────────────────────────────────────────────────────────────
  get PLAID_CLIENT_ID() { return _e.PLAID_CLIENT_ID; },
  get PLAID_SECRET()    { return _e.PLAID_SECRET; },
  get PLAID_ENV()       { return (_e.PLAID_ENV ?? "sandbox") as "sandbox" | "development" | "production"; },

  // ── AI ────────────────────────────────────────────────────────────────────
  // NOTE: lib/ai/provider.ts (the only OpenAI SDK import site) reads
  // process.env.OPENAI_API_KEY directly so it can fail loudly at call time;
  // this accessor exists for feature-flag checks, not for the SDK client.
  get OPENAI_API_KEY()  { return _e.OPENAI_API_KEY; },

  // ── Crypto ────────────────────────────────────────────────────────────────
  get ETHERSCAN_API_KEY()  { return _e.ETHERSCAN_API_KEY; },
  get HELIUS_API_KEY()     { return _e.HELIUS_API_KEY; },

  // ── Email ─────────────────────────────────────────────────────────────────
  // NOTE: lib/email/providers/resend.ts (the only Resend SDK import site) reads
  // process.env.RESEND_API_KEY directly so it can fail loudly at call time;
  // this accessor exists for feature-flag checks, not for the SDK client.
  get RESEND_API_KEY()     { return _e.RESEND_API_KEY; },
  /** Optional default From identity; falls back to the per-purpose sender map. */
  get EMAIL_FROM_DEFAULT() { return _e.EMAIL_FROM_DEFAULT; },

  // ── Security Ops (Wave 3 ⑧) ─────────────────────────────────────────────────
  /** Inbox for direct security-anomaly alert emails. Defaults to
   *  security@fourthmeridian.com when unset. */
  get SECURITY_ALERTS_EMAIL() { return _e.SECURITY_ALERTS_EMAIL ?? "security@fourthmeridian.com"; },
  /** Platform Ops alert destination (OPS-5 S5). null when unset — no destination,
   *  no send (honest skip); the operator sets this to activate email alerting. */
  get PLATFORM_ALERTS_EMAIL(): string | null { return _e.PLATFORM_ALERTS_EMAIL ?? null; },
  /** Beta-request intake notification destination (PO-3B). null when unset — no
   *  notification is sent (honest skip); the operator sets this to be alerted of
   *  new beta requests. Never a hardcoded personal address. */
  get BETA_REQUESTS_EMAIL(): string | null { return _e.BETA_REQUESTS_EMAIL ?? null; },

  // ── CAPTCHA (Cloudflare Turnstile, Wave 2 ⑥) ────────────────────────────────
  // NOTE: lib/captcha.ts (the single server-side verify site) reads
  // process.env.TURNSTILE_SECRET_KEY directly; these accessors exist for
  // feature-flag checks, not for the verify call.
  get TURNSTILE_SECRET_KEY()   { return _e.TURNSTILE_SECRET_KEY; },
  /** Public Turnstile site key. Client widgets read the inlined NEXT_PUBLIC_
   *  var directly (this server-only module can't be imported client-side); this
   *  accessor is for server components / server-side "configured?" checks. */
  get TURNSTILE_SITE_KEY()     { return _e.NEXT_PUBLIC_TURNSTILE_SITE_KEY; },

  // ── Admin ─────────────────────────────────────────────────────────────────
  /** When true, all SYSTEM_ADMIN logins are blocked. */
  get isSystemAdminDisabled() { return _e.DISABLE_SYSTEM_ADMIN === "true"; },

  // ── Merchant Operations (MI2 S2) ────────────────────────────────────────────
  /** The designated Merchant Operations Space id, or null when unset (gate fails closed). */
  get merchantOpsSpaceId() { return _e.MERCHANT_OPS_SPACE_ID ?? null; },

  // ── Price / FX vendor keys ──────────────────────────────────────────────────
  // NOTE: the price/FX registries read process.env directly at their call sites;
  // these accessors are for feature-flag checks and env reporting, not the SDKs.
  get TIINGO_API_KEY()    { return _e.TIINGO_API_KEY; },
  get COINGECKO_API_KEY() { return _e.COINGECKO_API_KEY; },
  get COINGECKO_HISTORY_DAYS() { return _e.COINGECKO_HISTORY_DAYS; },
  get OXR_APP_ID()        { return _e.OXR_APP_ID; },

  // ── Feature flags ─────────────────────────────────────────────────────────
  // REVIEW-3 flag hygiene: the accessors below are the ONLY flag accessors this
  // module carries, because they are the only ones with consumers. Every other
  // flag's truth lives at its own gate function, which reads process.env at
  // call time (see the FLAG PATTERN note in the module header) and is
  // documented in .env.example. Deleted here (all were consumer-less duplicate
  // authorities): isAiEnabled, isEthEnabled, isSolanaEnabled, isCryptoEnabled,
  // isEmailEnabled, isCaptchaEnabled, aiOutputValidationMode,
  // isInvestment{Observations,Events,Reconstruction,Imports}Enabled,
  // isWealthRegenerationEnabled, isSecurityPriceCaptureEnabled,
  // isSecurityPriceVendorEnabled, isCryptoPriceVendorEnabled, isFxPrimaryEnabled.
  /** Plaid integration is available when both credentials are set. */
  get isPlaidEnabled()    { return !!_e.PLAID_CLIENT_ID && !!_e.PLAID_SECRET; },
  /** V25-FINAL-2 — error monitoring (Sentry) is active when the DSN is set. Production
   *  requires it (PROD_REQUIRED_KEYS); the SDK stays disabled without it elsewhere.
   *  Kept (despite no runtime consumer) as the discoverability contract pinned by
   *  lib/monitoring/sentry-options.test.ts. */
  get isErrorMonitoringConfigured() { return !!_e.NEXT_PUBLIC_SENTRY_DSN; },

  // ── Runtime ───────────────────────────────────────────────────────────────
  /** Next.js BUILD mode — "am I running `next dev`?". Deliberately still a
   *  NODE_ENV question: it asks about the build, not the deployment. */
  get isDev()    { return _e.NODE_ENV === "development"; },
  /** V26-ENV-1 — "is this a PRODUCTION DEPLOYMENT?". Deployment-aware: on Vercel
   *  this is VERCEL_ENV="production", so a Preview deployment reports false even
   *  though Vercel builds it with NODE_ENV="production". */
  get isProd()   { return isProductionDeployment(); },
  /** Raw NODE_ENV (build mode). For "which deployment is this?" use
   *  `deploymentEnv` — on Preview, nodeEnv is "production". */
  get nodeEnv()  { return _e.NODE_ENV ?? "development"; },
  /** "production" | "preview" | "development" — the deployment environment. */
  get deploymentEnv(): DeploymentEnvironment { return deploymentEnvironment(); },
} as const;
