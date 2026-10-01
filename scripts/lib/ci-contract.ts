/**
 * scripts/lib/ci-contract.ts — THE CI CONTRACT, AS DATA.
 *
 * What GitHub CI runs, in the order it runs it, stated once. `npm run ci`
 * (scripts/ci-local.ts) executes these lists; scripts/ci-local.test.ts fails if
 * .github/workflows/ci.yml's `run:` steps, runtime source or Postgres service
 * drift from them. Pure — no I/O — so the test can import it without running
 * anything.
 */

/** ci.yml `test` job, step for step. */
export const TEST_JOB = [
  "npm ci",
  "npx prisma generate",
  "npm run test:unit",
  "npm run typecheck",
  "npm run lint",
] as const;

/** ci.yml `architecture` job, step for step. */
export const ARCHITECTURE_JOB = [
  "npm ci",
  "npx prisma generate",
  "npx prisma migrate deploy",
  "npx prisma db seed",
  "npm run audit:ci",
  // RLS-3 — the tenant-isolation gate. Runs as fm_app (NOBYPASSRLS, non-owner)
  // against the job's own throwaway database, so CI exercises the POLICIES and
  // not merely the application's where-clauses. Before this step existed, CI
  // ran everything as a superuser and could not have detected a policy that
  // did nothing.
  "RLS_TARGET_URL=$DATABASE_URL npm run rls:accept",
  // RLS-8 — the APPLICATION-level proof. The SQL suite above would stay green
  // if the application never used fm_app at all; this one goes red the moment
  // a service reaches the database through any authority but its own. It
  // builds its own throwaway database because it must control the role URLs
  // before lib/db.ts binds them at module load.
  "npm run rls:accept:app",
] as const;

/** ci.yml's `postgres` service: image and credentials of the throwaway database. */
export const CI_POSTGRES = {
  image: "postgres:16",
  user: "fintracker",
  password: "fintracker",
  database: "fintracker_ci",
} as const;

/** Throwaway, as in ci.yml: prisma/seed.ts encrypts a fake Plaid token with it. */
export const CI_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";

/** Every variable a Prisma client or CLI could take a database from. */
export const DB_URL_VARS = ["DATABASE_URL", "DIRECT_URL", "SHADOW_DATABASE_URL"] as const;

/** The major a `.nvmrc` names ("24", "v24", "24.21.0" ⇒ 24), or null. */
export function nvmrcMajor(text: string): number | null {
  const m = /^\s*v?(\d+)(?:\.\d+){0,2}\s*$/.exec(text);
  return m ? Number(m[1]) : null;
}

/** The major an `engines.node` range of the form "24.x" / "24" names, or null. */
export function enginesMajor(range: string | undefined): number | null {
  const m = /^\s*(\d+)(?:\.x)?\s*$/.exec(range ?? "");
  return m ? Number(m[1]) : null;
}

/** The inherited environment with every database URL removed. */
export function withoutDatabaseUrls(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of DB_URL_VARS) delete out[k];
  return out;
}
