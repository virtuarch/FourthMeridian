/**
 * lib/plaid/client.ts
 *
 * Singleton Plaid API client. Reads credentials from environment variables —
 * never hardcoded. Used only in server-side API routes, never in client components.
 */

import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { recordApiUsage } from "@/lib/usage/record";

// ── Validate required env vars at module load time ───────────────────────────
const VALID_ENVS = ["sandbox", "development", "production"] as const;
type PlaidEnv = typeof VALID_ENVS[number];

function validatePlaidEnv(): PlaidEnv {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret   = process.env.PLAID_SECRET;
  const env      = process.env.PLAID_ENV;

  if (!clientId) throw new Error("Missing env var: PLAID_CLIENT_ID");
  if (!secret)   throw new Error("Missing env var: PLAID_SECRET");
  if (!env)      throw new Error("Missing env var: PLAID_ENV");

  if (!VALID_ENVS.includes(env as PlaidEnv)) {
    throw new Error(
      `Invalid PLAID_ENV="${env}". Must be one of: ${VALID_ENVS.join(", ")}`
    );
  }

  // Log environment on first load — never log the secret itself
  console.log(`[plaid] client initialised → environment: ${env}`);

  return env as PlaidEnv;
}

const plaidEnv = validatePlaidEnv();

const config = new Configuration({
  basePath: PlaidEnvironments[plaidEnv],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID!,
      "PLAID-SECRET":    process.env.PLAID_SECRET!,
    },
  },
});

// The real Plaid SDK client. Kept internal; every consumer imports the
// recording proxy below (same name, same type) instead.
const basePlaidClient = new PlaidApi(config);

/**
 * Wave 2 S7 — usage-recording proxy over the real PlaidApi. Transparent: it has
 * the same type and the same `plaidClient` export name, so the ~16 existing call
 * sites keep their imports/usage unchanged (this is purely additive — no call
 * site is edited). On each method invocation it fire-and-forgets one `calls`
 * counter keyed on the method name (the metric), then delegates to the real
 * client with the real instance as `this`. recordApiUsage is non-throwing, so
 * instrumentation can never affect a Plaid call's behavior or result.
 */
export const plaidClient: PlaidApi = new Proxy(basePlaidClient, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== "function") return value;
    const method = typeof prop === "string" ? prop : String(prop);
    return function (...args: unknown[]) {
      void recordApiUsage("PLAID", method, "calls", 1);
      return (value as (...a: unknown[]) => unknown).apply(target, args);
    };
  },
});

/** The resolved Plaid environment (for use in routes that need to log it). */
export const PLAID_ENV = plaidEnv;
