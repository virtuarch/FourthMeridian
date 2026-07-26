/**
 * lib/session-degradation.test.ts  (PROD-POOLER-AUTH-INCIDENT-1)
 *
 * Covers the three things the cache tests can't reach:
 *
 *   1. MONITORING. The `"session"` AuthInfraStage was declared by PS-4A and never
 *      wired, so when production deleted users' session cookies on 2026-07-25 and
 *      2026-07-26, Sentry received nothing. These tests pin the payload — a
 *      P2024 tagged as a pool timeout, the deployment carried by Sentry's
 *      `release` rather than re-read here, and NO credential.
 *   2. THE UPSTREAM ASSUMPTION. The entire fix rests on one fact about installed
 *      NextAuth: a throw from the `session()` callback makes it DELETE the session
 *      cookie. That is vendored behaviour, so it is pinned here — if a NextAuth
 *      upgrade changes it, this fails loudly instead of the fix quietly becoming
 *      either unnecessary or insufficient.
 *   3. THE 401-vs-503 DISTINCTION. Returning 401 for an undeterminable session is
 *      what sent users to /forgot-password believing their password had broken.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildSessionRevocationCapture,
  classifyDbError,
  isPoolTimeoutCode,
} from "@/lib/monitoring/capture";
import {
  SESSION_INDETERMINATE_FLAG,
  isRevocationIndeterminate,
} from "@/lib/auth/session-outcome";
import { serviceUnavailable, unauthorized } from "@/lib/session";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

function poolTimeout(): Error {
  const e = new Error(
    "Timed out fetching a new connection from the connection pool. More info: http://pris.ly/d/connection-pool (Current connection pool timeout: 10, connection limit: 1)",
  );
  (e as unknown as { code: string }).code = "P2024";
  return e;
}

console.log("PROD-POOLER-AUTH-INCIDENT-1 — degradation contract, monitoring, upstream pin");

async function main() {
  // ── 1. Error classification: capacity vs connectivity ───────────────────────
  check("P2024 is classified from the error code", classifyDbError(poolTimeout()) === "P2024");
  check("P2024 is classified from the message when no code is present",
    classifyDbError(new Error("Timed out fetching a new connection from the connection pool.")) === "P2024");
  check("ECHECKOUTTIMEOUT is recognised",
    classifyDbError(new Error("FATAL: (ECHECKOUTTIMEOUT) unable to check out connection")) === "ECHECKOUTTIMEOUT");

  const p1001 = new Error("Can't reach database server");
  (p1001 as unknown as { code: string }).code = "P1001";
  check("P1001 (unreachable) is NOT collapsed into P2024 — different fix, different fingerprint",
    classifyDbError(p1001) === "P1001" && isPoolTimeoutCode("P1001") === false);
  check("pool-timeout codes are flagged, others are not",
    isPoolTimeoutCode("P2024") && isPoolTimeoutCode("ECHECKOUTTIMEOUT") && !isPoolTimeoutCode("UNKNOWN"));
  check("an unrecognisable failure is UNKNOWN, not silently a pool timeout",
    classifyDbError(null) === "UNKNOWN" && classifyDbError(new Error("boom")) === "UNKNOWN");

  // ── 2. Monitoring payload ───────────────────────────────────────────────────
  const denied = buildSessionRevocationCapture({
    error:       poolTimeout(),
    disposition: "INDETERMINATE",
    route:       "/dashboard/spaces",
  });
  check("INDETERMINATE ⇒ level error, auth_stage session, area auth",
    denied.level === "error" && denied.tags.auth_stage === "session" && denied.tags.area === "auth",
    JSON.stringify(denied.tags));
  check("…tagged as a pool timeout with the P2024 code",
    denied.tags.db_error_code === "P2024" && denied.tags.pool_timeout === "true");
  check("…recording the coarse route and the effect on the session",
    denied.contexts.session_revocation.route === "/dashboard/spaces" &&
    String(denied.contexts.session_revocation.effect).includes("session preserved"));

  // The deployment is carried by Sentry's `release`, set from the ONE sanctioned
  // resolver (OPS-2B′). Re-reading it here would be the drift that authority
  // forbids, so the payload deliberately does not tag it.
  const sentryOptions = read("lib/monitoring/sentry-options.ts");
  check("deployment identity reaches Sentry via `release` from the sole resolver",
    /release:\s*RELEASE/.test(sentryOptions) && sentryOptions.includes("currentDeploymentSha()"));
  check("…and this payload does not duplicate that read",
    !("deployment" in denied.tags));

  const absorbed = buildSessionRevocationCapture({
    error: poolTimeout(), disposition: "STALE_HIT",
  });
  check("STALE_HIT ⇒ level warning (leading indicator, not an outage)",
    absorbed.level === "warning" && absorbed.tags.disposition === "STALE_HIT");
  check("…an absent route is null, never a fabricated value",
    absorbed.contexts.session_revocation.route === null);
  check("STALE_HIT and INDETERMINATE are distinguishable in monitoring",
    absorbed.tags.disposition !== denied.tags.disposition);

  // NEVER LOG TOKENS. The token is never passed in, so it cannot appear.
  const secretToken = "b7f1e2c4-dead-beef-cafe-000000000001";
  const payload = buildSessionRevocationCapture({
    error: poolTimeout(), disposition: "INDETERMINATE", route: "/dashboard",
  });
  const serialised = JSON.stringify(payload);
  check("the capture payload carries no session token",
    !serialised.includes(secretToken) && !/sessionToken/i.test(serialised));
  check("…and no cookie, JWT, or user id field",
    !/cookie|jwt|userId|password/i.test(serialised), serialised);

  // A degraded route must never carry the query string (deep-link state).
  const withQuery = buildSessionRevocationCapture({
    error: poolTimeout(), disposition: "INDETERMINATE", route: "/dashboard/spaces",
  });
  check("route is a bare pathname (no query string in the report)",
    !String(withQuery.contexts.session_revocation.route).includes("?"));

  // ── 3. Indeterminate detection ──────────────────────────────────────────────
  check("the flag is detected on a degraded session",
    isRevocationIndeterminate({ [SESSION_INDETERMINATE_FLAG]: true }));
  check("an ordinary session is not indeterminate",
    !isRevocationIndeterminate({ user: { id: "u1" } }));
  check("null / undefined are not indeterminate",
    !isRevocationIndeterminate(null) && !isRevocationIndeterminate(undefined));
  check("a falsy flag is not indeterminate",
    !isRevocationIndeterminate({ [SESSION_INDETERMINATE_FLAG]: false }));

  // ── 4. 503 vs 401 ───────────────────────────────────────────────────────────
  const unavail = serviceUnavailable();
  check("indeterminate maps to 503, NOT 401 (a 401 reads as 'signed out')",
    unavail.status === 503);
  check("…with Retry-After so the client knows to retry rather than re-authenticate",
    unavail.headers.get("Retry-After") === "5");
  check("401 is still available for genuine anonymity", unauthorized().status === 401);
  check("the two responses are distinct", unavail.status !== unauthorized().status);

  // ── 5. Guard wiring — every session guard must handle indeterminate ─────────
  const sessionSrc = read("lib/session.ts");
  const guards = ["requireUser", "requireFreshUser", "requireSystemAdmin", "requireFreshSystemAdmin", "requireSpaceRole"];
  for (const g of guards) {
    // Slice from the guard's declaration to the next export to scope the search.
    const start = sessionSrc.indexOf(`export async function ${g}(`);
    const rest  = sessionSrc.slice(start + 1);
    const end   = rest.indexOf("\nexport ");
    const body  = start >= 0 ? rest.slice(0, end === -1 ? undefined : end) : "";
    check(`${g}() returns 503 on an indeterminate session`,
      start >= 0 && body.includes("serviceUnavailable()"),
      "guard does not handle the indeterminate case");
  }
  // The fresh guards bypass the cache by design, so they own the raw live query.
  // The invariant is that it is funnelled through ONE guarded helper rather than
  // inlined per guard — an inline `await db.userSession.findFirst()` with no catch
  // is what turned a pool timeout into a 500.
  const recheckStart = sessionSrc.indexOf("async function recheckSessionLive(");
  const recheckBody  = recheckStart >= 0
    ? sessionSrc.slice(recheckStart, sessionSrc.indexOf("\n}", recheckStart))
    : "";
  check("the live re-check is funnelled through one guarded helper",
    recheckStart >= 0 &&
    recheckBody.includes("db.userSession.findFirst") &&
    recheckBody.includes("catch") &&
    recheckBody.includes("captureSessionRevocationFailure"),
    "recheckSessionLive must catch and report, not propagate");
  check("…returning a three-way verdict so 'unavailable' is not 'revoked'",
    recheckBody.includes('"unavailable"') && recheckBody.includes('"revoked"') && recheckBody.includes('"valid"'));
  const findFirstCalls = (sessionSrc.match(/db\.userSession\.findFirst/g) ?? []).length;
  check("…and it is the ONLY userSession.findFirst in the guards (no inline duplicate)",
    findFirstCalls === 1, `found ${findFirstCalls} call sites (expected 1)`);

  // ── 6. The session callback must not let the revocation check throw ─────────
  const authSrc = read("lib/auth.ts");
  check("the session callback routes revocation through resolveRevocation()",
    /callbacks\s*:/.test(authSrc) && authSrc.includes("resolveRevocation("));
  check("…and reports the degraded dispositions to monitoring",
    authSrc.includes('captureSessionRevocationFailure') &&
    authSrc.includes('disposition: "INDETERMINATE"') &&
    authSrc.includes('disposition: "STALE_HIT"'));
  check("…returning the indeterminate flag instead of an epoch-expired session",
    authSrc.includes("[SESSION_INDETERMINATE_FLAG]: true"));

  // ── 7. UPSTREAM PIN — the behaviour this whole fix exists to avoid ──────────
  // If these stop matching, re-read node_modules/next-auth/core/routes/session.js
  // before trusting anything above.
  const naSession = read("node_modules/next-auth/core/routes/session.js");
  const jwtCatch  = naSession.slice(naSession.indexOf('sessionStrategy === "jwt"'));
  const firstCatch = jwtCatch.slice(jwtCatch.indexOf("} catch (error) {"), jwtCatch.indexOf("} else {"));
  check("PINNED: NextAuth's jwt session catch still calls sessionStore.clean()",
    firstCatch.includes("sessionStore.clean()"),
    "upstream changed — the destructive-logout premise needs re-verification");
  check("PINNED: NextAuth still logs JWT_SESSION_ERROR there (the only prior signal)",
    firstCatch.includes("JWT_SESSION_ERROR"));
  const cookieSrc = read("node_modules/next-auth/core/lib/cookie.js");
  check("PINNED: clean() emits maxAge 0 (an actual cookie deletion)",
    /maxAge:\s*0/.test(cookieSrc));
  const nextSrc = read("node_modules/next-auth/next/utils.js");
  check("PINNED: the route handler applies cookies to the real response (toResponse)",
    nextSrc.includes("toResponse") && nextSrc.includes("Set-Cookie"));
}

main()
  .then(() => {
    if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
    console.log("\nAll session degradation / monitoring checks passed.");
  })
  .catch((e) => { console.error(e); process.exit(1); });
