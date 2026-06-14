/**
 * lib/plaid/client.ts
 *
 * Singleton Plaid API client. Reads credentials from environment variables —
 * never hardcoded. Used only in server-side API routes, never in client components.
 */

import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

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

export const plaidClient = new PlaidApi(config);

/** The resolved Plaid environment (for use in routes that need to log it). */
export const PLAID_ENV = plaidEnv;
