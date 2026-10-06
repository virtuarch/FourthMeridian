/**
 * lib/auth/session-activity.test.ts  (RLS-PREVIEW-13)
 *
 * The session-activity touch once left a transaction open on a suspended
 * instance, held the UserSession row lock, pinned the fm_auth pool and 503'd
 * every signed-in request on Preview. These checks pin the shape that cannot do
 * that — one awaited, non-blocking, throttled statement — and pin that the
 * fire-and-forget updateMany cannot come back. The same behaviour is proven
 * against a real fm_auth role and real row locks in
 * scripts/rls-foreground-acceptance.ts (cases 43-49).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  touchSessionActivity,
  SESSION_ACTIVITY_GRANULARITY_SECONDS,
  type RawExecutor,
} from "@/lib/auth/session-activity";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
/** Comments discuss the old shape on purpose; a guard must not fire on its own documentation. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

console.log("RLS-PREVIEW-13 — session activity bookkeeping");

async function main() {
  // ── The statement itself, through a recording client ──────────────────────
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const fake: RawExecutor = {
    $executeRaw(query: TemplateStringsArray, ...values: unknown[]) {
      calls.push({ sql: query.join("$?"), values });
      return Promise.resolve(1);
    },
  };
  const n = await touchSessionActivity(fake, "tok_abcdefghijklmnop", "user_1");
  const sql = (calls[0]?.sql ?? "").replace(/\s+/g, " ");

  check("one call, one statement — no transaction is opened around it",
    calls.length === 1 && !/\bBEGIN\b|\bCOMMIT\b/i.test(sql) && (sql.match(/;/g) ?? []).length === 0, sql);
  check("the token and the user are bound parameters, never interpolated text",
    JSON.stringify(calls[0]?.values) === JSON.stringify(["tok_abcdefghijklmnop", "user_1"]) && !sql.includes("tok_abcdefghijklmnop"));
  check("it never WAITS on a held row: the row is taken FOR UPDATE SKIP LOCKED", /FOR UPDATE SKIP LOCKED/.test(sql), sql);
  check("it is throttled in the database, so the limit holds across every instance",
    /"lastActiveAt" < \(now\(\) AT TIME ZONE 'UTC'\) - interval '(\d+) seconds'/.test(sql), sql);
  const literal = Number(/interval '(\d+) seconds'/.exec(sql)?.[1]);
  check("the SQL interval is the exported granularity", literal === SESSION_ACTIVITY_GRANULARITY_SECONDS,
    `${literal} vs ${SESSION_ACTIVITY_GRANULARITY_SECONDS}`);
  check("the granularity is coarse enough to matter and fine enough for 'Active … ago' (30 s–5 min)",
    SESSION_ACTIVITY_GRANULARITY_SECONDS >= 30 && SESSION_ACTIVITY_GRANULARITY_SECONDS <= 300);
  check("a revoked session is never touched, and only the owner's row matches",
    /"revokedAt" IS NULL/.test(sql) && /"userId" = \$\?/.test(sql) && /"sessionToken" = \$\?/.test(sql), sql);
  check("it reports rows written", n === 1);

  // ── The caller ────────────────────────────────────────────────────────────
  const auth = strip(read("lib/auth.ts"));
  check("lib/auth.ts no longer writes lastActiveAt through updateMany (BEGIN/UPDATE/COMMIT)",
    !/userSession\.updateMany\(\{[\s\S]{0,200}?lastActiveAt/.test(auth));
  check("lib/auth.ts AWAITS the touch — nothing outlives the request that started it",
    /await touchSessionActivity\(db, sessionToken, verdict\.userId\)/.test(auth));
  check("…and never launches it un-awaited anywhere else",
    (auth.match(/touchSessionActivity\(/g) ?? []).length === 1);
  check("…only on a LIVE check (a COALESCED or STALE_HIT caller adds no write)",
    /if \(outcome\.disposition === "LIVE"\) \{\s*await touchSessionActivity\(/.test(auth));
  check("…after the verdict: a refused session returns before any touch",
    auth.indexOf('if (verdict.kind === "refused") return refusedSession(session);') > 0
    && auth.indexOf('if (verdict.kind === "refused") return refusedSession(session);') < auth.indexOf("await touchSessionActivity("));
  check("…and a touch failure cannot change the verdict (it is swallowed to 0)",
    /await touchSessionActivity\(db, sessionToken, verdict\.userId\)\.then\(undefined, \(\) => 0\)/.test(auth));
  check("the touch runs on the auth client (fm_auth), the client lib/auth.ts already holds",
    /import \{ authDb as db \} from "@\/lib\/db";/.test(read("lib/auth.ts")));

  // No module anywhere may reintroduce a fire-and-forget activity write.
  const mod = strip(read("lib/auth/session-activity.ts"));
  check("the module opens no interactive or batch transaction", !/\$transaction/.test(mod));
}

main().then(() => {
  if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
  console.log("\nAll session-activity checks passed.");
});
