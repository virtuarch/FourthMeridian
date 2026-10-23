/**
 * lib/auth/admin-session-projection.test.ts — P1b: the DYNAMIC half of the
 * session-token proof.
 *
 * lib/auth/session-token-exposure.test.ts is a source scan: it proves no route
 * can be *written* in a shape that serialises a UserSession row. This file
 * proves the admin surface's actual bytes, by running the real exported
 * projection and the real NextResponse serialiser over a row that carries a
 * distinctive token, then reading the body back as a browser would.
 *
 * Why both: a source scan can only ever argue about shapes it anticipated, and
 * a `...s` is not the only way to leak a string. The assertion here is the
 * product fact — the token's VALUE does not appear in the response text —
 * which holds regardless of how the projection is spelled.
 *
 * Standalone tsx script (house pattern). No DB, no network: the route module
 * imports @/lib/db, but constructing a PrismaClient opens no connection, and
 * nothing here calls a query (verified — the import completes with DATABASE_URL
 * unset).
 *
 *   §1 the projection drops a token it is HANDED
 *   §2 the serialised HTTP body carries the safe fields and not the token
 *   §3 the fields are exactly SessionsList.tsx's SessionRow contract
 */

import { NextResponse } from "next/server";
import { toAdminSessionView } from "@/app/api/admin/security/users/[userId]/sessions/route";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Distinctive, non-empty, and shaped like nothing else in the payload, so a
 * substring search over the body cannot pass by coincidence. A real
 * sessionToken is an opaque random identifier, which is exactly this.
 */
const DISTINCTIVE_TOKEN = "fm-p1b-canary-9e3c1a7f-DO-NOT-SERIALISE-4b82d0";

/**
 * A full UserSession row, as `findMany()` WITHOUT a select would hand it over —
 * every column of prisma/schema.prisma's model, including the two the safe
 * select omits. Handing the projection more than it is allowed to return is the
 * point: §1 fails if the projection ever spreads its input.
 */
const row = {
  id:           "sess_canary",
  userId:       "user_canary",
  sessionToken: DISTINCTIVE_TOKEN,
  ipAddress:    "203.0.113.7",
  userAgent:    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36",
  lastActiveAt: new Date("2026-10-02T11:22:33.000Z"),
  revokedAt:    null,
  revokedById:  "admin_canary",
  createdAt:    new Date("2026-09-30T08:00:00.000Z"),
};

async function main() {
  // ── 1. the projection drops a token it is handed ───────────────────────────
  console.log("\n1. toAdminSessionView() drops a sessionToken it is handed");
  const view = toAdminSessionView(row) as Record<string, unknown>;
  check("the row really carried a non-empty token (the test is not vacuous)",
    typeof row.sessionToken === "string" && row.sessionToken.length > 20);
  check("the returned object has no sessionToken key", !("sessionToken" in view));
  check("no value of the returned object IS the token",
    !Object.values(view).some((v) => v === DISTINCTIVE_TOKEN));
  check("the returned object has no revokedById key", !("revokedById" in view));
  check("userAgent was parsed", typeof view.parsed === "object" && view.parsed !== null);

  // ── 2. the serialised HTTP body ────────────────────────────────────────────
  // The same expression the route's GET returns, over the same projection.
  console.log("\n2. the serialised response body");
  const res  = NextResponse.json({ sessions: [row, row].map((s) => toAdminSessionView(s)) });
  const text = await res.text();
  const body = JSON.parse(text) as { sessions: Record<string, unknown>[] };

  check("the body is a JSON object with a sessions array of 2", Array.isArray(body.sessions) && body.sessions.length === 2);
  check(`the distinctive token value does not occur in the ${text.length}-byte body`,
    !text.includes(DISTINCTIVE_TOKEN));
  check("the string \"sessionToken\" does not occur in the body", !text.includes("sessionToken"));
  check("the string \"revokedById\" does not occur in the body", !text.includes("revokedById"));
  // Non-vacuity for the two searches above: the same search over a body built
  // the OLD way must find it. This is what the repair changed, asserted here so
  // §2 cannot silently become a test of an empty payload.
  const leaky = await NextResponse.json({ sessions: [row].map((s) => ({ ...s })) }).text();
  check("…and the same search DOES find it in a spread-built body (needle works)",
    leaky.includes(DISTINCTIVE_TOKEN) && leaky.includes("sessionToken"));

  // ── 3. exactly the SessionRow contract ─────────────────────────────────────
  // SessionRow (components/security/SessionsList.tsx) is what the admin modal
  // types this response as; `isCurrent` is optional there and deliberately not
  // sent for another user's devices.
  console.log("\n3. the field set is exactly SessionRow minus isCurrent");
  const got  = Object.keys(body.sessions[0]).sort();
  const want = ["createdAt", "id", "ipAddress", "lastActiveAt", "parsed", "revokedAt", "userAgent", "userId"];
  check(`fields are exactly [${want.join(", ")}]`,
    JSON.stringify(got) === JSON.stringify(want), `got [${got.join(", ")}]`);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll admin session projection checks passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
