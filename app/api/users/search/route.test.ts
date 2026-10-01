/**
 * app/api/users/search/route.test.ts
 *
 * RLS Slice 2 — the users/search membership oracle is closed.
 *
 * THE GAP THIS PINS SHUT: GET /api/users/search?q=…&exclude=<spaceId> ran
 * `spaceMember.findMany({ where: { spaceId, status: ACTIVE } })` for a
 * caller-supplied Space id under `requireUser()` ALONE. The roster was never
 * returned, but it was a DIFFERENTIAL oracle: issue the same query with and
 * without `&exclude=<victimSpaceId>` and a result that disappears proves that
 * user is an ACTIVE member of a Space the caller has no relationship to. This
 * was the one confirmed live cross-tenant disclosure in
 * docs/plans/POSTGRES-RLS-ARCHITECTURE-INVESTIGATION.md §17.1 item 1.
 *
 * The door is now `requireSpaceAction(spaceId, "member:invite")` — ADMIN+ and
 * ACTIVE in the named Space, which is exactly the authority the endpoint serves
 * (its only caller is the invite control, rendered only for OWNER/ADMIN).
 *
 * PART A is pure authority: the policy decision the door delegates to.
 * PART B/C source-scan the route, because importing it is not practical here —
 * it pulls in `server-only`, `@/lib/db` (Prisma engine) and next/server, none of
 * which load under a bare tsx script. Same shape as lib/spaces/authorize.test.ts.
 *
 *     npx tsx app/api/users/search/route.test.ts
 */

import { readFileSync } from "node:fs";
import { join }         from "node:path";
import { can }          from "@/lib/spaces/policy";
import type { SpaceMemberRole, SpaceMemberStatus, SpaceType } from "@prisma/client";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

/** strip comments so scans match real code, not the prose above. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}

const A = (role: SpaceMemberRole, status: SpaceMemberStatus, spaceType: SpaceType = "SHARED") =>
  ({ role, status, spaceType });

// ─────────────────────────────────────────────────────────────────────────────
// PART A — the authority the door delegates to: can("member:invite", …).
// A caller who may not invite may not read the roster, so the oracle closes
// exactly where invite authority stops.
// ─────────────────────────────────────────────────────────────────────────────

// Allowed: ADMIN and OWNER, ACTIVE.
check("A member:invite OWNER/ACTIVE allow",  can("member:invite", A("OWNER",  "ACTIVE")) === true);
check("A member:invite ADMIN/ACTIVE allow",  can("member:invite", A("ADMIN",  "ACTIVE")) === true);

// Denied: a member who can SEE the Space but cannot invite into it.
check("A member:invite MEMBER/ACTIVE deny",  can("member:invite", A("MEMBER", "ACTIVE")) === false);
check("A member:invite VIEWER/ACTIVE deny",  can("member:invite", A("VIEWER", "ACTIVE")) === false);

// Denied: a departed member keeps no residual oracle, at ANY role.
for (const role of ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as SpaceMemberRole[]) {
  for (const status of ["REMOVED", "LEFT"] as SpaceMemberStatus[]) {
    check(`A member:invite ${role}/${status} deny`, can("member:invite", A(role, status)) === false);
  }
}

// The invite door is NOT sharedOnly — a PERSONAL Space's OWNER still passes it,
// which is what keeps the CreateSpaceModal / Manage flows working on a PERSONAL
// Space. (A non-member has no ctx at all and is denied by the adapter's null
// membership branch, pinned structurally in Part B of lib/spaces/authorize.test.ts.)
check("A member:invite PERSONAL OWNER allow (door is not sharedOnly)",
  can("member:invite", A("OWNER", "ACTIVE", "PERSONAL")) === true);
check("A member:invite PERSONAL VIEWER deny",
  can("member:invite", A("VIEWER", "ACTIVE", "PERSONAL")) === false);

// ─────────────────────────────────────────────────────────────────────────────
// PART B — the route wires that door.
// ─────────────────────────────────────────────────────────────────────────────

const routeRaw = readFileSync(
  join(process.cwd(), "app", "api", "users", "search", "route.ts"), "utf8");
const route = code(routeRaw);

check("B route imports requireSpaceAction from the canonical adapter",
  /requireSpaceAction/.test(route) && /from\s+["']@\/lib\/spaces\/authorize["']/.test(route));
check("B route gates the roster on requireSpaceAction(spaceId, \"member:invite\")",
  /requireSpaceAction\(\s*spaceId\s*,\s*["']member:invite["']\s*\)/.test(route));
check("B route returns the adapter's error response (never swallows it)",
  /if\s*\(\s*spaceErr\s*\)\s*return\s+spaceErr/.test(route));
check("B route still requires a session first (requireUser)",
  /requireUser\s*\(\s*\)/.test(route));

// ─────────────────────────────────────────────────────────────────────────────
// PART C — ORDER is the invariant. The roster must never be loaded before the
// check: an authorization that runs after the read has already answered the
// oracle. Pinned as a positional fact, not a vibe.
// ─────────────────────────────────────────────────────────────────────────────

const guardAt  = route.indexOf('requireSpaceAction(spaceId, "member:invite")');
const rosterAt = route.indexOf("spaceMember.findMany");

check("C both the guard and the roster read are present",
  guardAt !== -1 && rosterAt !== -1, `guard@${guardAt} roster@${rosterAt}`);
check("C the guard precedes spaceMember.findMany (roster never loaded first)",
  guardAt !== -1 && rosterAt !== -1 && guardAt < rosterAt,
  `guard@${guardAt} roster@${rosterAt}`);

// Both live inside the `if (spaceId)` branch: no `exclude` param ⇒ no Space is
// named ⇒ nothing to authorize, and the search stays open as before.
const branchAt = route.indexOf("if (spaceId)");
check("C the guard sits inside the if (spaceId) branch",
  branchAt !== -1 && branchAt < guardAt, `branch@${branchAt} guard@${guardAt}`);

// The roster read keeps its ACTIVE filter — REMOVED/LEFT rows must stay out of
// the exclude list so a previously-removed user can be re-invited.
check("C roster read still filters status: ACTIVE",
  /status:\s*SpaceMemberStatus\.ACTIVE/.test(route));

// The caller's own id stays excluded regardless of the Space branch.
check("C caller is still excluded from their own search results",
  /excludeIds[^=]*=\s*\[\s*user\.id\s*\]/.test(route));

// ─────────────────────────────────────────────────────────────────────────────
// PART D — the product cannot break: the ONLY caller of this endpoint is the
// invite control, and every mount point renders it for an OWNER/ADMIN only.
// ─────────────────────────────────────────────────────────────────────────────

const searchInput = readFileSync(
  join(process.cwd(), "components", "space", "manage", "UserSearchInput.tsx"), "utf8");
check("D UserSearchInput is the caller of /api/users/search",
  searchInput.includes("/api/users/search?q="));

const mounts: Array<[string, string[]]> = [
  ["MembersPanel",     ["components", "space", "manage", "MembersPanel.tsx"]],
  ["MembersInvite",    ["components", "space", "widgets", "members", "MembersInvite.tsx"]],
  ["CreateSpaceModal", ["components", "dashboard", "CreateSpaceModal.tsx"]],
];
for (const [label, rel] of mounts) {
  const src = readFileSync(join(process.cwd(), ...rel), "utf8");
  check(`D ${label} mounts UserSearchInput`, src.includes("<UserSearchInput"));
}

// MembersPanel + the Members workspace hook both derive the invite gate from the
// SAME role set the server door now enforces (OWNER/ADMIN), so the client never
// shows a control that would 403.
for (const rel of [
  ["components", "space", "manage", "MembersPanel.tsx"],
  ["components", "space", "widgets", "members", "use-space-members.ts"],
]) {
  const src = readFileSync(join(process.cwd(), ...rel), "utf8");
  check(`D ${rel[rel.length - 1]} gates invite on OWNER/ADMIN (mirrors member:invite)`,
    /\["OWNER",\s*"ADMIN"\]\.includes\(myRole\)/.test(src));
}

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passes} passed, ${failures} failed (${passes + failures} checks).`);
if (failures > 0) { console.log("users/search authorization tests FAILED."); process.exit(1); }
console.log("users/search authorization tests passed.");
process.exit(0);
