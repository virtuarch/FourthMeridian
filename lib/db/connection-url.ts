/**
 * lib/db/connection-url.ts  (PROD-POOLER-AUTH-INCIDENT-1)
 *
 * Owns ONE fact: how many pooled connections a runtime Prisma client may open.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Production ran with `connection_limit=1`. That was never a capacity decision:
 * it was added while troubleshooting locally (~late May 2026), propagated into
 * `.env.example` and `docs/operations/deployment.md` by the "cloud staging
 * infrastructure prep" commit (113f000, 2026-06-15), and was then retained by
 * accident in the Vercel `DATABASE_URL` for Production AND Preview.
 *
 * A one-connection pool is actively harmful under this runtime, because Vercel
 * Fluid Compute is ENABLED: many concurrent requests share ONE Node process, so
 * they share the ONE module-global PrismaClient (lib/db.ts) and therefore the ONE
 * pooled connection. Concurrent requests did not run concurrently — they queued
 * inside Prisma against a 10s `pool_timeout` and the losers died as P2024. That
 * is the mechanism behind the 2026-07-25 14:57:38Z and 2026-07-26 11:40:08Z
 * incidents, in which a transient queue became a destroyed session cookie.
 *
 * ── WHY THE VALUE IS SET HERE AND NOT IN THE URL ─────────────────────────────
 * Every Vercel env var on this project is marked Sensitive, so `DATABASE_URL` is
 * unreadable even by the owner — the leaked parameter cannot be edited in place.
 * Owning the value in reviewed, version-controlled, tested code is also simply
 * better: pool sizing is a property of the RUNTIME, it applies to every
 * environment at once, and a future copy-paste of the old template cannot
 * silently re-introduce a one-connection pool. This module REPLACES the
 * parameter rather than appending it, so the result never depends on how a
 * duplicate query parameter happens to be parsed.
 *
 * Everything else about the connection string is left EXACTLY as configured:
 * host, port 6543, `pgbouncer=true`, schema, credentials. This does not move
 * traffic to the direct database and does not change the pooling mode.
 *
 * ── WHY 5 ────────────────────────────────────────────────────────────────────
 * Measured production baseline (PS-0 / PS-2, 2026-07-23, read from the Vercel and
 * Supabase dashboards — numbers, not estimates):
 *
 *   Supabase `fourth-meridian-production` (ap-southeast-1, compute Micro)
 *     • Supavisor SERVER pool size ......... 15   (per user+db; Micro did not raise it)
 *     • Supavisor MAX CLIENT connections ... 200  (fixed on this tier)
 *     • Postgres max_connections ............ 60
 *     • DB CPU during the incidents ......... 0-2%, disk IO ~0%
 *   Vercel `fintracker1` (Pro, Fluid Compute on, 1 vCPU, regions ["sin1"])
 *     • Peak Supavisor CLIENT connections ... 19  (observed while limit was 1)
 *
 * The database was never compute-saturated, so the incident was connection
 * AVAILABILITY under overlap — precisely what a 1-connection pool manufactures.
 *
 * Worst-case aggregate = concurrent runtime instances x per-instance limit.
 * Using the pessimistic 19 concurrent processes (pessimistic because a larger
 * per-instance pool lets each process finish its own burst instead of spawning
 * more): 19 x 5 = 95 client connections, under half of the fixed 200 ceiling.
 *
 * Sizing against the observed 7-14 request burst, with the slow ~2.4s
 * revocation query this codebase has measured before:
 *     limit 1 -> 14 x 2.4s serial      = ~34s  >> 10s pool_timeout  -> P2024 (observed)
 *     limit 3 -> 14 x 2.4s / 3         = ~11s  >  10s               -> still exposed
 *     limit 5 -> 14 x 2.4s / 5         = ~6.7s <  10s               -> absorbed
 * 5 is therefore the SMALLEST value that comfortably covers the burst actually
 * observed, which is why it is not 3 and not 10.
 *
 * Deliberately unchanged: `pool_timeout` (still 10s) — one variable at a time.
 * Deliberately NOT raised further: past ~10 the queue would simply migrate from
 * Prisma (P2024) to Supavisor (ECHECKOUTTIMEOUT) without adding throughput,
 * because the 15 server slots are shared by every instance. Transaction mode is
 * designed to multiplex many client connections onto few server connections, so
 * 95 clients over 15 servers is the pooler doing its job — not an overload.
 *
 * Scripts under `scripts/` construct their own PrismaClient and are unaffected;
 * migrations use `DIRECT_URL` (port 5432) and are likewise untouched.
 *
 * ── WHY 3 NOW (RLS-PREVIEW-13b, 2026-10-06) ─────────────────────────────────
 * The derivation above assumed ONE pool per process. Since RLS-2 every process
 * holds FOUR — `db`, and the fm_app / fm_auth / fm_system role clients — and this
 * constant sizes all four (lib/db.ts: runtimeDatasourceUrl() and roleClient()).
 * Two of its premises also moved: the 2.4 s revocation query now runs on fm_auth
 * behind a 30 s per-process cache with coalescing, and Supavisor's 200 is a
 * PROJECT-wide client ceiling shared by every role, not a per-pool one.
 *
 * Measured on Preview (Nano, transaction pooler, pool_size 12 per role) under 200
 * concurrent request loops: Supavisor refused clients with
 * "(EMAXCONN) max client connections reached, limit: 200" while Postgres held
 * only 50 backends. Prisma opens connections on demand, grows each pool to its
 * limit under concurrency, and KEEPS them idle (measured), so a warm instance
 * holds ~2L + 2 clients (db and fm_app saturate; fm_auth and fm_system stay
 * near 1). At L = 5 that is ~12 per instance and ~16 instances to the ceiling;
 * at L = 3, ~8 and ~25.
 *
 * Throughput does not fall with it: each role's SERVER pool (12) is the real
 * concurrency ceiling, so client connections past it only queue in Supavisor.
 * 3 also keeps the original reason not to go lower: the in-process queue for a
 * 14-request burst of ~0.4 s phases is ~1.9 s, far inside the 10 s pool_timeout,
 * and 1 would bring back the serial queue that produced P2024 in July.
 */

/**
 * Pooled connections a single runtime Prisma client may open. See the sizing
 * derivation above before changing this — it is an evidence-backed number, not
 * a preference.
 */
export const RUNTIME_CONNECTION_LIMIT = 3;

/** The parameter this module owns. */
const CONNECTION_LIMIT_PARAM = "connection_limit";

/**
 * Return `raw` with `connection_limit` set to `limit`, preserving every other
 * component of the connection string.
 *
 * Returns the input UNCHANGED when it is absent or cannot be parsed: a
 * malformed-URL guess would break process startup, and Prisma's own error for a
 * bad connection string is far more useful than one from here. Never logs or
 * throws — the value contains credentials.
 */
export function withConnectionLimit(
  raw:   string | undefined,
  limit: number = RUNTIME_CONNECTION_LIMIT,
): string | undefined {
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    // `set` replaces any existing value (and adds it when absent), so the result
    // never contains a duplicate parameter whose precedence would be ambiguous.
    url.searchParams.set(CONNECTION_LIMIT_PARAM, String(limit));
    return url.toString();
  } catch {
    return raw;
  }
}

/**
 * Read the runtime datasource URL with the pool size this module owns applied.
 * `undefined` when DATABASE_URL is unset, so callers can let Prisma perform its
 * own (better) missing-configuration error.
 */
export function runtimeDatasourceUrl(): string | undefined {
  return withConnectionLimit(process.env.DATABASE_URL);
}
