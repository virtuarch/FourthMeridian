/**
 * lib/test-support/route-env.ts  (TEST-002 / TEST-004)
 *
 * IMPORT THIS FIRST in a route-handler test. Several modules snapshot
 * `process.env` at load (lib/env.ts, lib/auth.ts `secret`), so the values must
 * be in place before anything under app/ or lib/ is imported. ES imports run in
 * source order, so `import "@/lib/test-support/route-env";` as the first line
 * is enough.
 *
 * Every value here is a test constant. DATABASE_URL points at a port nothing
 * listens on — the Prisma client is replaced by lib/test-support/fake-prisma.ts
 * and must never connect; if something bypassed the fake it would fail fast.
 */

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV            = "test";
env.NEXTAUTH_SECRET     = "route-handler-test-secret-not-a-real-secret-0123456789";
env.NEXTAUTH_URL        = "https://app.test.invalid";
env.NEXT_PUBLIC_APP_URL = "https://app.test.invalid";
env.ENCRYPTION_KEY      = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
env.DATABASE_URL        = "postgresql://none:none@127.0.0.1:9/none";
for (const k of [
  "DATABASE_URL_APP", "DATABASE_URL_AUTH", "DATABASE_URL_SYSTEM", "DIRECT_URL", "FM_RLS_STRICT", "FM_DB_GUARD",
  "RATE_LIMIT_ENABLED", "RATE_LIMIT_SHADOW", "TURNSTILE_SECRET_KEY", "RESEND_API_KEY", "DISABLE_SYSTEM_ADMIN",
  "CLIENT_IP_TRUST_CLOUDFLARE", "SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN", "VERCEL", "VERCEL_ENV",
]) delete env[k];

export {};
