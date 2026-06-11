/**
 * lib/plaid/client.ts
 *
 * Singleton Plaid API client. Reads credentials from environment variables —
 * never hardcoded. Used only in server-side API routes, never in client components.
 */

import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

const env = (process.env.PLAID_ENV ?? "sandbox") as keyof typeof PlaidEnvironments;

const config = new Configuration({
  basePath: PlaidEnvironments[env],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID!,
      "PLAID-SECRET":    process.env.PLAID_SECRET!,
    },
  },
});

export const plaidClient = new PlaidApi(config);
