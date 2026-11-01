/**
 * lib/test-support/plaid-test-env.ts  (test-only)
 *
 * Import SECOND (after route-env) in a route test that must reach Plaid-gated
 * code: lib/env.ts snapshots process.env at load, so these must be set before
 * it is imported. Fake credentials — the PlaidApi prototype is trapped by the
 * test itself, so no request can leave the process.
 */
const env = process.env as Record<string, string | undefined>;
env.PLAID_CLIENT_ID = "test-client-id-not-real";
env.PLAID_SECRET    = "test-secret-not-real";
env.PLAID_ENV       = "sandbox";
env.WEALTH_REGENERATION_ENABLED = "true";
export {};
