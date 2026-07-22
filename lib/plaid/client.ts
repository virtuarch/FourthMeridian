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

// ── LAZY init (PO-5A) ────────────────────────────────────────────────────────
// The real client is built on FIRST USE, not at module import. This is the P0
// beta fix: importing this module must never throw, so a route that imports
// plaidClient can guard with `env.isPlaidEnabled` and return a clean 503 when
// Plaid is unconfigured — instead of the whole route crashing at module load.
// A misconfigured deploy now fails at the first ACTUAL Plaid call (guarded away),
// never at import.
let _realClient: PlaidApi | null = null;

function realPlaidClient(): PlaidApi {
  if (_realClient) return _realClient;
  const plaidEnv = validatePlaidEnv(); // throws only here, on first real use
  const config = new Configuration({
    basePath: PlaidEnvironments[plaidEnv],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID!,
        "PLAID-SECRET":    process.env.PLAID_SECRET!,
      },
    },
  });
  _realClient = new PlaidApi(config);
  return _realClient;
}

/**
 * Wave 2 S7 — usage-recording proxy over the real PlaidApi, now also LAZY: the
 * real client is resolved on first property access (realPlaidClient()), so this
 * module has no import-time side effects. Same type + `plaidClient` export name,
 * so the ~16 call sites are unchanged. Each method invocation fire-and-forgets
 * one `calls` counter, then delegates. recordApiUsage is non-throwing.
 */
export const plaidClient: PlaidApi = new Proxy({} as PlaidApi, {
  get(_target, prop, receiver) {
    const client = realPlaidClient();
    const value = Reflect.get(client, prop, receiver);
    if (typeof value !== "function") return value;
    const method = typeof prop === "string" ? prop : String(prop);
    return function (...args: unknown[]) {
      void recordApiUsage("PLAID", method, "calls", 1);
      return (value as (...a: unknown[]) => unknown).apply(client, args);
    };
  },
});

/**
 * The configured Plaid environment label (for routes that log/echo it). Read
 * RAW at import (no validation/throw) so importing this module is side-effect
 * free; the real client still validates on first use. Meaningful only when Plaid
 * is configured — guard real usage with env.isPlaidEnabled.
 */
export const PLAID_ENV = (process.env.PLAID_ENV ?? "sandbox") as PlaidEnv;
