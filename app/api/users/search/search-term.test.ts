/**
 * app/api/users/search/search-term.test.ts — SEC-005: the user directory is
 * not a one-character oracle and is per-user rate-limited.
 *
 * PART A — parseSearchTerm, executed from the real route module (loaded under
 *          the server-only preload with a never-connected DATABASE_URL, the
 *          lib/auth/session-proof.test.ts technique).
 * PART B — source pins: the limiter runs before the query; the query branches
 *          on the parsed term; the old `q.length < 1` floor is gone.
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/users/search/search-term.test.ts
 */

process.env.DATABASE_URL ??= "postgresql://none:none@127.0.0.1:1/none"; // never connected: nothing below queries

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  const { parseSearchTerm, MIN_SEARCH_CHARS } = await import("./route");
  console.log("users/search term floor (SEC-005)\n\nA. parseSearchTerm");
  check("the floor is three characters", MIN_SEARCH_CHARS === 3);
  for (const short of ["", " ", "a", "ab", " ab ", "e", "s"]) {
    check(`${JSON.stringify(short)} → too-short (the runtime probe set a,e,o,s,j walked the directory)`,
      parseSearchTerm(short).kind === "too-short");
  }
  const sub = parseSearchTerm(" Ali ");
  check("three+ characters → substring, trimmed and lower-cased", sub.kind === "substring" && sub.term === "ali");
  const exact = parseSearchTerm("@Alice");
  check("@handle → exact-username, lower-cased, without the @", exact.kind === "exact-username" && exact.username === "alice");
  check("@ alone → too-short (not an empty exact match)", parseSearchTerm("@").kind === "too-short" && parseSearchTerm("@ ").kind === "too-short");
  check("@a (one-char handle) is an EXACT match, not a one-char substring", parseSearchTerm("@a").kind === "exact-username");

  console.log("\nB. the route wires the floor and the limiter");
  const route = readFileSync(path.join(process.cwd(), "app/api/users/search/route.ts"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const limiterAt = route.indexOf('limitByUser(user.id, "users-search"');
  const queryAt   = route.indexOf("db.user.findMany");
  const rosterAt  = route.indexOf("spaceMember.findMany");
  check("per-user limiter (60/h) is wired", limiterAt !== -1 && /limitByUser\(user\.id, "users-search", \{ limit: 60, windowSec: 3600 \}\)/.test(route));
  check("the limiter runs BEFORE the roster read and the user query",
    limiterAt !== -1 && limiterAt < rosterAt && limiterAt < queryAt);
  check("the old one-character floor is gone", !route.includes("q.length < 1"));
  check("a too-short term returns [] before any query", /parsed\.kind === "too-short"\) return NextResponse\.json\(\[\]\)/.test(route) &&
    route.indexOf('parsed.kind === "too-short"') < queryAt);
  check("exact-username branch uses equals, substring branch uses contains",
    /parsed\.kind === "exact-username"\s*\?\s*\{ username: \{ equals: parsed\.username/.test(route) &&
    /contains: parsed\.term/.test(route));
  check("the roster read is still gated on member:invite (unchanged)", /requireSpaceAction\(spaceId, "member:invite"\)/.test(route));

  if (failures > 0) { console.error(`\nusers/search term floor: ${failures} check(s) failed.`); process.exit(1); }
  console.log("\nusers/search term floor: all checks passed.");
}
main().catch((e) => { console.error(e); process.exit(1); });
