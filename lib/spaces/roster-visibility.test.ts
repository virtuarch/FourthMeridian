/**
 * lib/spaces/roster-visibility.test.ts
 *
 * W1-D3 — public-Space roster privacy tests (pure, no DB). House-style
 * standalone tsx script, auto-discovered by scripts/run-tests.ts.
 *
 * THE GAP THIS PINS SHUT: GET /api/spaces/[id] on a PUBLIC Space is readable
 * by any authenticated user, and it used to return raw SpaceMember rows —
 * including user.email — to non-members. rosterForViewer now serializes the
 * roster per viewer: members get the rows untouched; non-members get ONLY the
 * intentionally-public shape ({ id, role, joinedAt, user: { id, name,
 * username } } — the same shape /dashboard/spaces already publishes), built by
 * PICKING allowlisted fields so unknown future fields fail closed.
 *
 * Part A tests the pure serializer; Part B source-scans the route so the
 * wiring cannot silently drift out.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { rosterForViewer, type PublicRosterMember } from "./roster-visibility";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Every key present anywhere in a JSON-ish value (deep). */
function deepKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) { for (const x of v) deepKeys(x, out); return out; }
  if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) { out.add(k); deepKeys(x, out); }
  }
  return out;
}

// Fixture mirrors what the route's `include` actually loads: full SpaceMember
// scalars + a user with email — PLUS a fabricated future column on each level,
// to prove the non-member path is a pick-allowlist, not a delete-denylist.
const joined = new Date("2026-01-02T03:04:05.000Z");
const members = [
  {
    id: "sm-1", role: "OWNER", joinedAt: joined,
    userId: "u-1", spaceId: "sp-1", status: "ACTIVE",
    revokedAt: null, revokedById: null,
    futureScalar: "MUST-NOT-LEAK",
    user: { id: "u-1", name: "Avery Owner", username: "avery", email: "avery@example.com", futureUserField: "MUST-NOT-LEAK" },
  },
  {
    id: "sm-2", role: "MEMBER", joinedAt: joined,
    userId: "u-2", spaceId: "sp-1", status: "ACTIVE",
    revokedAt: null, revokedById: null,
    futureScalar: "MUST-NOT-LEAK",
    user: { id: "u-2", name: null, username: "kai", email: "kai@example.com", futureUserField: "MUST-NOT-LEAK" },
  },
];

// ── Part A1 — member view is untouched (byte-identical) ───────────────────────
{
  const out = rosterForViewer(members, true);
  check("member view returns the SAME array reference (byte-identical JSON)", out === members);
  check("member view still carries emails (members' own view unchanged)",
    (out as typeof members)[0].user.email === "avery@example.com");
}

// ── Part A2 — non-member view: allowlist only, fail closed ────────────────────
{
  const out = rosterForViewer(members, false) as PublicRosterMember[];
  check("non-member view is a new array (no shared row references)",
    (out as unknown) !== members && out.every((row, i) => (row as unknown) !== members[i]));
  check("length preserved (member COUNT is intentionally public)", out.length === members.length);
  check("order preserved", out[0].id === "sm-1" && out[1].id === "sm-2");

  const keys = deepKeys(out);
  check("NO email anywhere in the non-member payload", !keys.has("email"));
  check("no SpaceMember scalars leak (userId/spaceId/status/revoked*)",
    !keys.has("userId") && !keys.has("spaceId") && !keys.has("status") &&
    !keys.has("revokedAt") && !keys.has("revokedById"));
  check("unknown FUTURE fields fail closed (pick, not delete)",
    !keys.has("futureScalar") && !keys.has("futureUserField") &&
    !JSON.stringify(out).includes("MUST-NOT-LEAK"));

  // Exact top-level and user-level key sets — nothing more, nothing less.
  const rowKeys  = Object.keys(out[0]).sort().join(",");
  const userKeys = Object.keys(out[0].user).sort().join(",");
  check("row keys are exactly {id, joinedAt, role, user}", rowKeys === "id,joinedAt,role,user", rowKeys);
  check("user keys are exactly {id, name, username}", userKeys === "id,name,username", userKeys);

  // What the public surfaces genuinely render survives: the OWNER's display
  // identity and the roster size.
  const owner = out.find((m) => m.role === "OWNER");
  check("owner display identity survives (name/@username)",
    owner?.user.name === "Avery Owner" && owner?.user.username === "avery");
  check("joinedAt value passes through", out[0].joinedAt === joined);
}

// Empty roster: trivially safe both ways.
{
  check("empty roster (member) stays empty", rosterForViewer([], true).length === 0);
  check("empty roster (non-member) stays empty", rosterForViewer([], false).length === 0);
}

// ── Part B — source-scan drift guard on the route ─────────────────────────────
{
  const ROOT = process.cwd();
  const src = readFileSync(path.join(ROOT, "app", "api", "spaces", "[id]", "route.ts"), "utf8");
  check("GET route imports rosterForViewer", src.includes('from "@/lib/spaces/roster-visibility"'));
  check("GET route serializes members through rosterForViewer(…, isActiveMember)",
    /members:\s*rosterForViewer\(space\.members,\s*isActiveMember\)/.test(src));
  // The raw spread must not reintroduce the unfiltered roster: the members key
  // must be overridden AFTER `...space` in the response literal.
  const spreadAt = src.indexOf("...space");
  const rosterAt = src.indexOf("rosterForViewer(space.members");
  check("roster override comes after the ...space spread",
    spreadAt !== -1 && rosterAt !== -1 && rosterAt > spreadAt, `spread@${spreadAt} roster@${rosterAt}`);
}

// ── Report ────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\nroster-visibility: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`roster-visibility: ${passed} checks passed`);
