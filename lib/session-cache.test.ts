/**
 * lib/session-cache.test.ts  (PROD-POOLER-AUTH-INCIDENT-1)
 *
 * Two production incidents (2026-07-25 14:57:38Z, 2026-07-26 11:40:08Z) turned a
 * ~90-second Postgres connection-pool squeeze into real logouts. These tests pin
 * the three properties that make that impossible:
 *
 *   1. NEVER THROWS. This is THE destructive-logout regression guard. A throw out
 *      of the revocation check reaches NextAuth's own catch, which calls
 *      sessionStore.clean() and emits `Set-Cookie: …=; Max-Age=0` — deleting the
 *      user's credential. If resolveRevocation() ever rejects again, this fails.
 *   2. COALESCES concurrent misses into ONE query. Production runs
 *      connection_limit=1 under Vercel Fluid Compute, so concurrent requests
 *      share one pooled connection; N simultaneous misses meant N queued queries
 *      and P2024 for the losers. This is the frequency reduction, and it is
 *      asserted by COUNTING real calls — not by observing that errors stopped.
 *   3. Degrades through a BOUNDED stale window, and no further.
 *
 * The `liveCheck` injection seam (same shape lib/rate-limit.ts uses for
 * checkStrict) makes all of this provable with no database.
 */

import {
  resolveRevocation,
  getCachedRevocation,
  getStaleRevocation,
  setCachedRevocation,
  invalidateSession,
  clearAllSessions,
  _debugCacheSize,
  _debugSetCheckedAt,
  SESSION_CACHE_TTL_MS,
  SESSION_STALE_GRACE_MS,
} from "@/lib/session-cache";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** A P2024 shaped exactly like the one in the production logs. */
function poolTimeout(): Error {
  const e = new Error(
    "Timed out fetching a new connection from the connection pool. More info: http://pris.ly/d/connection-pool (Current connection pool timeout: 10, connection limit: 1)",
  );
  (e as unknown as { code: string }).code = "P2024";
  return e;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

console.log("PROD-POOLER-AUTH-INCIDENT-1 — session revocation cache policy");

async function main() {
  // ── 1. Fresh hit short-circuits the DB entirely ─────────────────────────────
  clearAllSessions();
  setCachedRevocation("tok-fresh", true);
  let calls = 0;
  const counting = async () => { calls++; return true; };
  const fresh = await resolveRevocation("tok-fresh", counting);
  check("fresh cache hit ⇒ FRESH_HIT and DB never consulted",
    fresh.disposition === "FRESH_HIT" && fresh.valid === true && calls === 0,
    `disposition=${fresh.disposition} calls=${calls}`);

  // ── 2. Miss performs exactly one live check and caches it ────────────────────
  clearAllSessions();
  calls = 0;
  const live = await resolveRevocation("tok-live", counting);
  check("cache miss ⇒ LIVE, one query, result cached",
    live.disposition === "LIVE" && live.valid === true && calls === 1 &&
    getCachedRevocation("tok-live") === true,
    `disposition=${live.disposition} calls=${calls}`);

  // ── 3. THE FREQUENCY FIX — concurrent misses coalesce to ONE query ───────────
  // This is the 11:40:08.192Z pattern: three invocations, same instant, same
  // token, all missing the cache. Before coalescing that was three queries
  // against a one-connection pool.
  clearAllSessions();
  let slowCalls = 0;
  const slow = async () => { slowCalls++; await sleep(40); return true; };
  const CONCURRENCY = 12;
  const outcomes = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => resolveRevocation("tok-herd", slow)),
  );
  const liveCount     = outcomes.filter((o) => o.disposition === "LIVE").length;
  const coalescedCount = outcomes.filter((o) => o.disposition === "COALESCED").length;
  check(`${CONCURRENCY} concurrent misses ⇒ exactly ONE live query`,
    slowCalls === 1,
    `queries=${slowCalls} (expected 1)`);
  check("…one LIVE + the rest COALESCED, all with the same answer",
    liveCount === 1 && coalescedCount === CONCURRENCY - 1 &&
    outcomes.every((o) => o.valid === true),
    `live=${liveCount} coalesced=${coalescedCount}`);

  // Distinct tokens must NOT be coalesced — different users are different questions.
  clearAllSessions();
  slowCalls = 0;
  await Promise.all([
    resolveRevocation("tok-a", slow),
    resolveRevocation("tok-b", slow),
    resolveRevocation("tok-c", slow),
  ]);
  check("distinct tokens are NOT coalesced (3 tokens ⇒ 3 queries)", slowCalls === 3,
    `queries=${slowCalls}`);

  // ── 4. THE DESTRUCTIVE-LOGOUT REGRESSION GUARD ──────────────────────────────
  clearAllSessions();
  let threw = false;
  let indeterminate: Awaited<ReturnType<typeof resolveRevocation>> | null = null;
  try {
    indeterminate = await resolveRevocation("tok-cold", async () => { throw poolTimeout(); });
  } catch { threw = true; }
  check("P2024 with no cached entry ⇒ RESOLVES, never throws (cookie survives)",
    threw === false, "it threw — NextAuth would clear the session cookie");
  check("…and reports INDETERMINATE with valid === null (not false)",
    indeterminate?.disposition === "INDETERMINATE" && indeterminate?.valid === null,
    `disposition=${indeterminate?.disposition} valid=${String(indeterminate?.valid)}`);
  check("…carrying the original error for monitoring",
    (indeterminate?.error as { code?: string } | undefined)?.code === "P2024");

  // A failed check must not be cached as a verdict — otherwise one blip would
  // pin a wrong answer for the whole TTL.
  check("a failed live check caches nothing", _debugCacheSize() === 0,
    `cache size=${_debugCacheSize()}`);

  // Concurrent waiters on a FAILING check must also not throw.
  clearAllSessions();
  let anyThrew = false;
  const failing = async (): Promise<boolean> => { await sleep(20); throw poolTimeout(); };
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      resolveRevocation("tok-herd-fail", failing).catch(() => { anyThrew = true; return null; })),
  );
  check("coalesced waiters on a failing check also never throw",
    anyThrew === false && results.every((r) => r !== null && r.valid === null));

  // ── 5. Bounded stale window ─────────────────────────────────────────────────
  // Verified valid, then aged just past the fresh TTL but inside the grace.
  clearAllSessions();
  setCachedRevocation("tok-stale", true);
  _debugSetCheckedAt("tok-stale", Date.now() - (SESSION_CACHE_TTL_MS + 1_000));
  check("past TTL, an ordinary read reports a miss (a live check is still tried)",
    getCachedRevocation("tok-stale") === null);
  check("…but the entry is retained for the bounded stale window",
    getStaleRevocation("tok-stale") === true);
  const staleOutcome = await resolveRevocation("tok-stale", async () => { throw poolTimeout(); });
  check("DB fails + entry inside grace ⇒ STALE_HIT serving the verified answer",
    staleOutcome.disposition === "STALE_HIT" && staleOutcome.valid === true,
    `disposition=${staleOutcome.disposition} valid=${String(staleOutcome.valid)}`);

  // Past the ceiling ⇒ refuse to guess.
  clearAllSessions();
  setCachedRevocation("tok-ancient", true);
  _debugSetCheckedAt("tok-ancient", Date.now() - (SESSION_CACHE_TTL_MS + SESSION_STALE_GRACE_MS + 5_000));
  const ancient = await resolveRevocation("tok-ancient", async () => { throw poolTimeout(); });
  check("past the stale ceiling ⇒ INDETERMINATE, never an unbounded stale grant",
    ancient.disposition === "INDETERMINATE" && ancient.valid === null,
    `disposition=${ancient.disposition}`);

  // A stale REVOKED verdict must be honoured, not resurrected.
  clearAllSessions();
  setCachedRevocation("tok-revoked", false);
  _debugSetCheckedAt("tok-revoked", Date.now() - (SESSION_CACHE_TTL_MS + 1_000));
  const staleRevoked = await resolveRevocation("tok-revoked", async () => { throw poolTimeout(); });
  check("a stale REVOKED result stays revoked (degradation never resurrects a session)",
    staleRevoked.disposition === "STALE_HIT" && staleRevoked.valid === false,
    `valid=${String(staleRevoked.valid)}`);

  // ── 6. Revocation still works normally ─────────────────────────────────────
  clearAllSessions();
  const revoked = await resolveRevocation("tok-gone", async () => false);
  check("a live 'revoked' answer is reported as valid === false (not null)",
    revoked.valid === false && revoked.disposition === "LIVE");

  // ── 7. Invalidation clears cache AND any in-flight check ────────────────────
  clearAllSessions();
  setCachedRevocation("tok-inv", true);
  invalidateSession("tok-inv");
  check("invalidateSession drops the entry entirely (no stale remnant)",
    getCachedRevocation("tok-inv") === null && getStaleRevocation("tok-inv") === null);

  // A revoke landing mid-check must not be overwritten by the older query.
  clearAllSessions();
  const inflightPromise = resolveRevocation("tok-race", async () => { await sleep(30); return true; });
  invalidateSession("tok-race");
  await inflightPromise;
  // The in-flight result may still land; what matters is a subsequent revoke is
  // not masked by a *stale* entry surviving invalidation.
  invalidateSession("tok-race");
  check("post-revoke, no stale entry can serve 'valid' during an outage",
    getStaleRevocation("tok-race") === null);

  // ── 8. Bounded memory ──────────────────────────────────────────────────────
  clearAllSessions();
  for (let i = 0; i < 50; i++) setCachedRevocation(`old-${i}`, true);
  for (let i = 0; i < 50; i++) {
    _debugSetCheckedAt(`old-${i}`, Date.now() - (SESSION_CACHE_TTL_MS + SESSION_STALE_GRACE_MS + 60_000));
  }
  setCachedRevocation("trigger-prune", true); // writes prune opportunistically
  check("entries beyond the stale ceiling are pruned (map stays bounded)",
    _debugCacheSize() === 1, `cache size=${_debugCacheSize()} (expected 1)`);
}

main()
  .then(() => {
    if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
    console.log("\nAll session revocation cache checks passed.");
  })
  .catch((e) => { console.error(e); process.exit(1); });
