/**
 * lib/auth/session-token-exposure.test.ts — P1b: the sessionToken is
 * authentication material and never leaves the server.
 *
 * Standalone tsx script (house pattern). Source scans only — no DB, no network.
 * Every absence claim names its denominator, and §0 proves each needle fires on
 * a counterexample built on the spot (a pattern that cannot fail is a comment).
 *
 *   §1 HTTP — RAW sessionToken HTTP/API SURFACES = 0, proven four ways over
 *      every route under app/api: no route spreads a UserSession row into its
 *      response; no route hands a row list to a JSON body unprojected; no
 *      `select` on a session read names the token; and no JSON response
 *      argument anywhere under app/api names it at all. The DEFERRED set is
 *      now EMPTY and pinned at empty — the admin surface
 *      (app/api/admin/security/users/[userId]/sessions/route.ts) was the last
 *      entry and was repaired with an explicit safe Prisma `select`.
 *      The matching DYNAMIC proof — a distinctive token's VALUE is absent from
 *      the serialised bytes — is lib/auth/admin-session-projection.test.ts.
 *   §2 the browser-facing NextAuth session (GET /api/auth/session) carries no
 *      sessionToken — the callback never sets it, the type no longer declares it.
 *   §3 logs, capture and audit metadata never name a sessionToken.
 *   §4 the client types no longer declare one.
 *   §5 DEACTIVATION — every write that deactivates a user revokes every session.
 *   §6 ROLE CHANGE — every write that changes User.role revokes the user's sessions.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(path.join(ROOT, dir))) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const rel = path.join(dir, e);
    if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(rel);
  }
  return out;
}

// ── Needles ───────────────────────────────────────────────────────────────────
const READS_SESSION_ROWS = /\buserSession\.find(Many|First|Unique)\s*\(/;
/** A spread of a mapped element or the row list itself into an object literal. */
const SPREADS_ROW = /\.\s*map\s*\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\(\s*\{\s*\.\.\.\s*\1\b/;
/** A session read that names its columns at all — i.e. the row is narrowed in the DB. */
const SELECTS_COLUMNS = /\buserSession\.find(?:Many|First|Unique)\s*\(\s*\{[\s\S]{0,400}?\bselect\s*:\s*\{/;
/** A `select: { … }` on a session read that names the token. */
const SELECTS_TOKEN = /\buserSession\.find(?:Many|First|Unique)\s*\(\s*\{[\s\S]{0,400}?\bselect\s*:\s*\{[^}]*\bsessionToken\b/;
/** The token used ONLY as a server-side equality test — what `isCurrent` is. */
const COMPARES_TOKEN = /\bsessionToken\s*===\s*\w|\w+\s*===\s*\w+\.sessionToken\b/;

/**
 * The argument text of every `NextResponse.json(…)` / `Response.json(…)` /
 * `res.json(…)` call, extracted by balancing parens rather than by regex, so a
 * nested object or call cannot truncate the scan. This is the literal set of
 * bytes a route can put on the wire, which is why §1's strongest check runs
 * over it: it does not depend on having anticipated the leak's SHAPE.
 */
function jsonResponseArgs(src: string): string[] {
  const out: string[] = [];
  const call = /\b(?:NextResponse|Response|res)\s*\.\s*json\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}
const SESSION_TOKEN_IN_LOG = /(console\.(log|warn|error|info|debug)|capture\w*|logger\.\w+)\s*\([^;]*sessionToken/;
const SESSION_TOKEN_IN_METADATA = /metadata\s*:\s*\{[^}]*sessionToken/;
/** A WRITE: inside a `data: { … }` block, deactivatedAt set to anything but null. */
const DEACTIVATES = /\bdata\s*:\s*\{[^{}]*?\bdeactivatedAt\s*:\s*(?!\s)(?!null\b)[^,}\n]+/;
const SETS_ROLE = /\.user\.update(Many)?\s*\(\s*\{[\s\S]{0,200}?data\s*:\s*\{[^}]*\brole\s*:/;
const REVOKES_ALL = /revokeAllUserSessions\s*\(|userSession\.updateMany\s*\(\s*\{[\s\S]{0,160}?revokedAt\s*:\s*new Date\(\)/;

console.log("\n0. every needle fires on a counterexample");
check("SPREADS_ROW fires on `sessions.map((s) => ({ ...s, x })`", SPREADS_ROW.test("sessions.map((s) => ({ ...s, x: 1 }))"));
check("SPREADS_ROW fires without parens", SPREADS_ROW.test("rows.map(r => ({ ...r }))"));
check("SPREADS_ROW does not fire on an explicit projection", !SPREADS_ROW.test("sessions.map((s) => toSessionView(s, t))"));
check("SELECTS_COLUMNS fires on a narrowed read and not on a whole-row read",
  SELECTS_COLUMNS.test("db.userSession.findMany({ where: { userId }, select: { id: true } })") &&
  !SELECTS_COLUMNS.test("db.userSession.findMany({ where: { userId }, take: 50 })"));
check("COMPARES_TOKEN fires on an isCurrent-style test",
  COMPARES_TOKEN.test("s.sessionToken === currentToken") && COMPARES_TOKEN.test("currentToken === target.sessionToken"));
check("COMPARES_TOKEN does not fire on a response key", !COMPARES_TOKEN.test("sessionToken: s.sessionToken,"));
check("SELECTS_TOKEN fires on a select that names the token",
  SELECTS_TOKEN.test("db.userSession.findMany({ where: { userId }, select: { id: true, sessionToken: true } })"));
check("SELECTS_TOKEN does not fire on a safe select",
  !SELECTS_TOKEN.test("db.userSession.findMany({ where: { userId }, select: { id: true, userId: true } })"));
check("jsonResponseArgs balances parens past a nested call",
  JSON.stringify(jsonResponseArgs("return NextResponse.json({ a: f(g(1)), b: 2 });")) === JSON.stringify(["{ a: f(g(1)), b: 2 }"]));
check("jsonResponseArgs finds every call",
  jsonResponseArgs("NextResponse.json({x:1}); Response.json({y:2});").length === 2);
check("SESSION_TOKEN_IN_LOG fires", SESSION_TOKEN_IN_LOG.test("console.log(`x ${user.sessionToken}`)"));
check("SESSION_TOKEN_IN_METADATA fires", SESSION_TOKEN_IN_METADATA.test("metadata: { sessionToken: t }"));
check("DEACTIVATES fires on `deactivatedAt: now,`", DEACTIVATES.test("data: { deactivatedAt: now, }"));
check("DEACTIVATES fires on `deactivatedAt: new Date() }`", DEACTIVATES.test("data:  { deactivatedAt: new Date() }"));
check("DEACTIVATES does not fire on `deactivatedAt: null`", !DEACTIVATES.test("data: { deactivatedAt: null }"));
check("DEACTIVATES does not fire on a type annotation", !DEACTIVATES.test("  deactivatedAt: Date | null;"));
check("DEACTIVATES does not fire on audit metadata", !DEACTIVATES.test("metadata: { deactivatedAt: user.deactivatedAt.toISOString() }"));
check("DEACTIVATES does not fire on metadata nested in an audit row's data",
  !DEACTIVATES.test("data: { userId: u, action: A, metadata: { deactivatedAt: user.deactivatedAt.toISOString() } }"));
check("DEACTIVATES fires on a multi-field pending-deletion write",
  DEACTIVATES.test("data:  {\n deletionRequestedAt: now,\n deactivatedAt:       now,\n }"));
check("SETS_ROLE fires", SETS_ROLE.test("db.user.update({ where: { id }, data: { role: UserRole.SYSTEM_ADMIN } })"));
check("REVOKES_ALL fires on the helper and on an inline updateMany",
  REVOKES_ALL.test("await revokeAllUserSessions(id)") &&
  REVOKES_ALL.test("tx.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } })"));

// ── 1. HTTP surfaces ─────────────────────────────────────────────────────────
console.log("\n1. no route serialises a UserSession row");
/**
 * EMPTY, and pinned at empty. The one entry that ever lived here was
 * app/api/admin/security/users/[userId]/sessions/route.ts — RLS-owned, so its
 * `db` authority could not move, and the leak was deferred behind that. The two
 * were never actually coupled: the repair is an explicit safe Prisma `select`,
 * which leaves the route's authority exactly where the RLS programme left it.
 * A new deferral is now a visible diff against this assertion, not a quiet
 * addition to a tolerated set.
 */
const DEFERRED_SPREAD: Record<string, string> = {};
check("the deferral set is empty", Object.keys(DEFERRED_SPREAD).length === 0,
  `still deferred: ${Object.keys(DEFERRED_SPREAD).join(", ")}`);

const routes = walk("app/api").filter((f) => f.endsWith("route.ts"));
const sessionReaders = routes.filter((f) => READS_SESSION_ROWS.test(strip(read(f))));
check(`routes reading UserSession rows found (${sessionReaders.length})`, sessionReaders.length >= 3, sessionReaders.join(", "));
/**
 * A session read must NARROW IN THE DATABASE, so that the token is not in the
 * process at all and no later edit to a response shape can reach it. The two
 * exceptions below genuinely need the whole row — they compare the token
 * server-side to decide `isCurrent`/`invalidateSession`, which is the one use
 * that cannot be satisfied by a projection. The set may only shrink, and each
 * member's REASON is re-checked rather than trusted: drop the comparison and the
 * exemption stops applying.
 */
const WHOLE_ROW_BY_NECESSITY: Record<string, string> = {
  "app/api/user/sessions/route.ts":
    "compares sessionToken to the caller's own cookie token to mark isCurrent",
  "app/api/user/sessions/[sessionId]/route.ts":
    "compares sessionToken to decide isCurrent, and passes it to invalidateSession()",
};
for (const f of sessionReaders) {
  const src = strip(read(f));
  check(`${f} does not spread a session row into its response`, !SPREADS_ROW.test(src));
  check(`${f}: no select on a session read names the token`, !SELECTS_TOKEN.test(src));
  if (WHOLE_ROW_BY_NECESSITY[f]) {
    check(`${f}: whole-row read still justified — ${WHOLE_ROW_BY_NECESSITY[f]}`, COMPARES_TOKEN.test(src),
      "no server-side token comparison left — narrow the read with an explicit select and delete the exemption");
  } else {
    check(`${f}: narrows the session read with an explicit select`, SELECTS_COLUMNS.test(src),
      "a whole-row read puts the token in the process — add `select:` or justify it in WHOLE_ROW_BY_NECESSITY");
  }
}
check(`whole-row exemptions: exactly the ${Object.keys(WHOLE_ROW_BY_NECESSITY).length} known token-comparing routes`,
  JSON.stringify(Object.keys(WHOLE_ROW_BY_NECESSITY).sort()) === JSON.stringify([
    "app/api/user/sessions/[sessionId]/route.ts",
    "app/api/user/sessions/route.ts",
  ]));
/**
 * The invariant itself, over the whole surface rather than over session readers:
 * nothing any route under app/api puts in a JSON body may so much as NAME the
 * token. This is the check that does not depend on having anticipated the leak's
 * shape — a spread, an explicit key, a nested object or a helper's literal all
 * land in the same extracted bytes.
 */
const jsonArgSurfaces = routes.flatMap((f) => jsonResponseArgs(strip(read(f))).map((a) => ({ f, a })));
const tokenInJson = jsonArgSurfaces.filter(({ a }) => /\bsessionToken\b/.test(a));
check(`no JSON response argument names a sessionToken (${jsonArgSurfaces.length} response bodies across ${routes.length} routes)`,
  tokenInJson.length === 0, tokenInJson.map(({ f }) => f).join(", "));
check("…and the scan is not vacuous: it found response bodies to look at", jsonArgSurfaces.length >= 100);
const userSessions = strip(read("app/api/user/sessions/route.ts"));
const view = userSessions.slice(userSessions.indexOf("function toSessionView("));
check("GET /api/user/sessions returns only toSessionView()", /sessions\.map\(\(s\)\s*=>\s*toSessionView\(s,\s*currentToken\)\)/.test(userSessions));
check("toSessionView's returned object names no sessionToken key",
  view.length > 0 && !/^\s*sessionToken\s*:/m.test(view.slice(view.indexOf("return {"))));

/**
 * The admin surface's response must flow through the projection that
 * lib/auth/admin-session-projection.test.ts actually EXECUTES. Without this the
 * two proofs have a seam: reintroducing the original `...s` leaves the
 * projection intact and passing, while nothing on the wire goes through it.
 * Measured — that mutation went red here and stayed green there.
 */
const adminSessions = strip(read("app/api/admin/security/users/[userId]/sessions/route.ts"));
check("GET /api/admin/security/users/[userId]/sessions maps through toAdminSessionView()",
  /sessions\.map\(\(s\)\s*=>\s*toAdminSessionView\(s\)\)/.test(adminSessions));
const adminView = adminSessions.slice(adminSessions.indexOf("function toAdminSessionView("));
check("toAdminSessionView's returned object names no sessionToken key",
  adminView.length > 0 && !/^\s*sessionToken\s*:/m.test(adminView.slice(adminView.indexOf("return {"))));

// ── 2. NextAuth session (GET /api/auth/session) ──────────────────────────────
console.log("\n2. the browser-facing session carries no sessionToken");
const auth = strip(read("lib/auth.ts"));
const cb = auth.slice(auth.indexOf("async session({"), auth.indexOf("events:"));
check("session callback located", cb.length > 500);
check("the session callback never assigns session.sessionToken", !/session\.sessionToken\s*=/.test(cb));
check("…nor returns a spread of the token", !/\.\.\.\s*token\b/.test(cb));
const types = strip(read("types/next-auth.d.ts"));
const sessionIface = types.slice(types.indexOf("interface Session"), types.indexOf("}", types.indexOf("isRevocationIndeterminate") > 0 ? types.indexOf("interface Session") + 1 : 0));
check("types/next-auth.d.ts: Session declares no sessionToken",
  !/sessionToken\s*\?\s*:/.test(types.slice(types.indexOf("interface Session"), types.indexOf("interface User"))), sessionIface.slice(0, 0));
const sessionTs = strip(read("lib/session.ts"));
check("lib/session.ts obtains the sessionToken from the cookie, bound to the verified id",
  /sessionToken:\s*await sessionTokenFromCookie\(session\.user\.id\)/.test(sessionTs) &&
  /claims\.userId === verifiedUserId/.test(sessionTs));
check("…cookies only, never an Authorization header", /headers:\s*\{\}/.test(sessionTs));

// ── 3. Logs, capture, audit metadata ─────────────────────────────────────────
console.log("\n3. logs and audit metadata never name a sessionToken");
const scanned = [...walk("app"), ...walk("lib"), ...walk("jobs"), ...walk("scripts"), "proxy.ts"];
const logHits = scanned.filter((f) => SESSION_TOKEN_IN_LOG.test(strip(read(f))));
const metaHits = scanned.filter((f) => SESSION_TOKEN_IN_METADATA.test(strip(read(f))));
check(`no log/capture call names a sessionToken (${scanned.length} files)`, logHits.length === 0, logHits.join(", "));
check(`no audit metadata names a sessionToken (${scanned.length} files)`, metaHits.length === 0, metaHits.join(", "));

// ── 4. Client types ──────────────────────────────────────────────────────────
console.log("\n4. client types");
const clientFiles = walk("components");
const clientTokenTypes = clientFiles.filter((f) => /^\s*sessionToken\s*\??\s*:/m.test(strip(read(f))));
check(`no component type declares a sessionToken (${clientFiles.length} files)`, clientTokenTypes.length === 0, clientTokenTypes.join(", "));

// ── 5. Deactivation revokes every session ────────────────────────────────────
console.log("\n5. every deactivation revokes every session");
const deactivators = [...walk("app"), ...walk("lib"), ...walk("jobs")].filter((f) => DEACTIVATES.test(strip(read(f))));
check(`deactivation writes found (${deactivators.length}): exactly the three known paths`,
  JSON.stringify([...deactivators].sort()) === JSON.stringify([
    "app/api/platform/growth-revenue/users/[userId]/route.ts",
    "app/api/user/deactivate/route.ts",
    "app/api/user/delete/route.ts",
  ]), deactivators.join(", "));
for (const f of deactivators) {
  const src = strip(read(f));
  const at = src.search(DEACTIVATES);
  const revokeAt = src.slice(at).search(REVOKES_ALL);
  check(`${f}: the deactivation is followed by revoking every session`, revokeAt > 0);
}

// ── 6. Role change revokes the user's sessions ───────────────────────────────
console.log("\n6. every role change revokes the user's sessions");
const roleWriters = [...walk("app"), ...walk("lib"), ...walk("jobs"), ...walk("scripts")].filter((f) => SETS_ROLE.test(strip(read(f))));
check(`role writes found (${roleWriters.length})`, roleWriters.length >= 1, roleWriters.join(", "));
for (const f of roleWriters) {
  const src = strip(read(f));
  const at = src.search(SETS_ROLE);
  check(`${f}: the role change revokes the user's sessions`, src.slice(at).search(REVOKES_ALL) > 0);
}
check("scripts/admin-promote.ts changes the role and revokes inside ONE transaction",
  /\$transaction\(async \(tx\) => \{[\s\S]*tx\.user\.update[\s\S]*tx\.userSession\.updateMany[\s\S]*tx\.auditLog\.create/.test(strip(read("scripts/admin-promote.ts"))));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll session-token exposure checks passed.");
