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
 *   boolean feature flags (isPlaidEnabled, isAiEnabled, etc.) for guard clauses.
 * - `validateEnv()` can be called to validate everything eagerly at startup.
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

  // ── AI output enforcement / diagnostics ─────────────────────────────────────
  // AI_OUTPUT_VALIDATION_MODE: shadow | annotate | block; unset/unrecognized ⇒
  // 'annotate' (the live KD-2 default) at app/api/ai/chat/route.ts. FLOWTYPE_SHADOW
  // toggles an optional non-PII flow-distribution log line only (no data-path
  // effect); unset ⇒ "off". Both read directly at their sites — mirrored for docs.
  AI_OUTPUT_VALIDATION_MODE: process.env.AI_OUTPUT_VALIDATION_MODE,
  FLOWTYPE_SHADOW:           process.env.FLOWTYPE_SHADOW,
} as const;

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

// OPS-1 S6 — required in production only. Dev/test keep working without them:
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
  const isProd = _e.NODE_ENV === "production";
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
  const isProd  = _e.NODE_ENV === "production";
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
  get OXR_APP_ID()        { return _e.OXR_APP_ID; },

  // ── Investment-history pipeline enablement (documentation mirror) ────────────
  // Strict "true" semantics, matching each pipeline reader. These do NOT gate the
  // pipeline (the readers own that) — they answer "is the switch on?" for reports.
  get isInvestmentObservationsEnabled()   { return _e.INVESTMENT_OBSERVATIONS_ENABLED === "true"; },
  get isInvestmentEventsEnabled()         { return _e.INVESTMENT_EVENTS_ENABLED === "true"; },
  get isInvestmentReconstructionEnabled() { return _e.INVESTMENT_RECONSTRUCTION_ENABLED === "true"; },
  get isWealthRegenerationEnabled()       { return _e.WEALTH_REGENERATION_ENABLED === "true"; },
  get isSecurityPriceCaptureEnabled()     { return _e.SECURITY_PRICES_ENABLED === "true"; },
  get isInvestmentImportsEnabled()        { return _e.INVESTMENT_IMPORTS_ENABLED === "true"; },
  /** Securities price vendor (Tiingo) is available when the key is set (see lib/prices/registry.ts). */
  get isSecurityPriceVendorEnabled()      { return !!_e.TIINGO_API_KEY; },
  /** BTC daily-close backfill is available when the CoinGecko key is set. */
  get isCryptoPriceVendorEnabled()        { return !!_e.COINGECKO_API_KEY; },
  /** Primary FX provider (Open Exchange Rates) is available when OXR_APP_ID is set;
   *  absent falls back to the keyless Frankfurter/ECB failover. */
  get isFxPrimaryEnabled()                { return !!_e.OXR_APP_ID; },

  // ── AI output enforcement mode (documentation mirror) ────────────────────────
  /** shadow | annotate | block. Unset/unrecognized ⇒ 'annotate' (live default). */
  get aiOutputValidationMode() {
    const raw = (_e.AI_OUTPUT_VALIDATION_MODE ?? "annotate").toLowerCase();
    return raw === "shadow" || raw === "block" ? raw : "annotate";
  },

  // ── Feature flags ─────────────────────────────────────────────────────────
  /** Plaid integration is available when both credentials are set. */
  get isPlaidEnabled()    { return !!_e.PLAID_CLIENT_ID && !!_e.PLAID_SECRET; },
  /** AI chat/advice is available when the OpenAI key is set (see lib/ai/provider.ts). */
  get isAiEnabled()       { return !!_e.OPENAI_API_KEY; },
  /** Ethereum on-chain data is available when the Etherscan key is set. */
  get isEthEnabled()      { return !!_e.ETHERSCAN_API_KEY; },
  /** Solana on-chain data is available when the Helius key is set. */
  get isSolanaEnabled()   { return !!_e.HELIUS_API_KEY; },
  /** Either crypto network is available. */
  get isCryptoEnabled()   { return !!_e.ETHERSCAN_API_KEY || !!_e.HELIUS_API_KEY; },
  /** Real email delivery is available when the Resend key is set (see lib/email/providers/resend.ts). */
  get isEmailEnabled()    { return !!_e.RESEND_API_KEY; },
  /** CAPTCHA verification is active when the Turnstile secret is set (see lib/captcha.ts).
   *  When false, verifyCaptchaToken skips and returns true (dev/test/unconfigured). */
  get isCaptchaEnabled()  { return !!_e.TURNSTILE_SECRET_KEY; },

  // ── Runtime ───────────────────────────────────────────────────────────────
  get isDev()    { return _e.NODE_ENV === "development"; },
  get isProd()   { return _e.NODE_ENV === "production"; },
  get nodeEnv()  { return _e.NODE_ENV ?? "development"; },
} as const;
