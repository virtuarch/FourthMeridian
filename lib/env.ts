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

  CRON_SECRET:          process.env.CRON_SECRET,
  RATE_LIMIT_ENABLED:   process.env.RATE_LIMIT_ENABLED,
  RATE_LIMIT_SHADOW:    process.env.RATE_LIMIT_SHADOW,

  DISABLE_SYSTEM_ADMIN: process.env.DISABLE_SYSTEM_ADMIN,
  NODE_ENV:             process.env.NODE_ENV,
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

/**
 * Validates all required environment variables in one pass.
 * Runs at server boot via instrumentation.ts (OPS-1 S6).
 * Throws with a complete list of missing variables.
 */
export function validateEnv(): void {
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

  // ── Admin ─────────────────────────────────────────────────────────────────
  /** When true, all SYSTEM_ADMIN logins are blocked. */
  get isSystemAdminDisabled() { return _e.DISABLE_SYSTEM_ADMIN === "true"; },

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

  // ── Runtime ───────────────────────────────────────────────────────────────
  get isDev()    { return _e.NODE_ENV === "development"; },
  get isProd()   { return _e.NODE_ENV === "production"; },
  get nodeEnv()  { return _e.NODE_ENV ?? "development"; },
} as const;
