/**
 * lib/spaces/invite-role.test.ts
 *
 * W1-D3 — invite-role allowlist tests (pure, no DB). House-style standalone
 * tsx script, auto-discovered by scripts/run-tests.ts.
 *
 * THE GAP THIS PINS SHUT: POST /api/spaces/[id]/invite used to persist the
 * client-sent role with `role as never` — no validation — so an ADMIN could
 * invite a user as OWNER and the acceptance route would mint a second OWNER.
 * Two boundaries now enforce the allowlist (ADMIN/MEMBER/VIEWER, never OWNER):
 *   1. invite creation  — parseInviteRoleInput (400 on anything else)
 *   2. invite acceptance — isInvitableSpaceRole on the PERSISTED invite.role,
 *      at the point the SpaceMember row is written, so a pre-existing bad
 *      invite row cannot mint an OWNER either.
 *
 * Part A tests the pure helpers; Part B source-scans both routes so the
 * enforcement cannot silently drift out (same pattern as
 * app/api/spaces/[id]/personal-single-user.test.ts).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  INVITABLE_SPACE_ROLES,
  isInvitableSpaceRole,
  parseInviteRoleInput,
} from "./invite-role";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── Part A — pure helper behaviour ────────────────────────────────────────────

// The allowlist is exactly SpaceMemberRole minus OWNER, and matches both the
// invite UI (MembersInvite ROLE_OPTIONS) and the role-change route's
// PROMOTABLE_ROLES.
check("allowlist is exactly ADMIN, MEMBER, VIEWER",
  JSON.stringify([...INVITABLE_SPACE_ROLES].sort()) === JSON.stringify(["ADMIN", "MEMBER", "VIEWER"]));
check("OWNER is NOT in the allowlist", !(INVITABLE_SPACE_ROLES as readonly string[]).includes("OWNER"));

for (const role of INVITABLE_SPACE_ROLES) {
  const r = parseInviteRoleInput(role);
  check(`parse accepts ${role}`, r.ok && r.role === role);
  check(`guard accepts ${role}`, isInvitableSpaceRole(role));
}

// Absent role → MEMBER, the pre-existing route default (byte-identical
// behaviour for the omitted-role request).
{
  const r = parseInviteRoleInput(undefined);
  check("absent role defaults to MEMBER", r.ok && r.role === "MEMBER");
}

// THE escalation vector: OWNER must be rejected at both boundaries.
{
  const r = parseInviteRoleInput("OWNER");
  check("parse REJECTS OWNER (no second OWNER by invite)", !r.ok);
  check("parse OWNER rejection names the allowed set",
    !r.ok && /ADMIN, MEMBER, VIEWER/.test(r.error));
  check("guard REJECTS OWNER (acceptance boundary)", !isInvitableSpaceRole("OWNER"));
}

// Everything else fails closed: unknown strings, case/whitespace variants,
// and non-strings (the body field is untyped client input).
{
  const bad: unknown[] = [
    "owner", "admin", "member", "viewer", // case-sensitive — enum values are upper
    " ADMIN", "ADMIN ", "MODERATOR", "SUPERUSER", "",
    null, 42, true, {}, ["ADMIN"], () => "ADMIN",
  ];
  const allRejected = bad.every((c) => parseInviteRoleInput(c).ok === false);
  check(`every invalid input rejected (${bad.length} cases)`, allRejected);
  check("guard rejects unknown strings", !isInvitableSpaceRole("MODERATOR") && !isInvitableSpaceRole(""));
}

// ── Part B — source-scan drift guards on both routes ──────────────────────────

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf8");
// Strip comments so prose ("this replaces the old `role as never` cast")
// can't satisfy or trip a code scan — same trap background-authority.test.ts
// documents.
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// -- invite route: validated role, no raw cast, validation before the upsert --
{
  const src = read("app", "api", "spaces", "[id]", "invite", "route.ts");
  const code = stripComments(src);
  check("invite route imports parseInviteRoleInput", src.includes("parseInviteRoleInput"));
  check("invite route no longer casts role with `as never`", !code.includes("as never"));
  const parseAt  = src.indexOf("parseInviteRoleInput(");
  const upsertAt = src.indexOf("spaceInvite.upsert");
  check("role validation fires before the invite upsert",
    parseAt !== -1 && upsertAt !== -1 && parseAt < upsertAt, `parse@${parseAt} upsert@${upsertAt}`);
  check("invalid role maps to a 400", /parsedRole\.ok[\s\S]{0,200}status:\s*400/.test(src));
}

// -- acceptance route: persisted invite.role re-validated before the member write --
{
  const src = read("app", "api", "spaces", "[id]", "invites", "[inviteId]", "route.ts");
  check("accept route imports isInvitableSpaceRole", src.includes("isInvitableSpaceRole"));
  const guardAt  = src.indexOf("isInvitableSpaceRole(invite.role)");
  const acceptAt = src.indexOf('action === "accept"');
  const memberAt = src.indexOf("spaceMember.upsert");
  check("accept route re-validates the PERSISTED invite role", guardAt !== -1);
  check("acceptance guard is inside the accept branch", acceptAt !== -1 && guardAt > acceptAt);
  check("acceptance guard fires before the membership upsert",
    guardAt !== -1 && memberAt !== -1 && guardAt < memberAt, `guard@${guardAt} member@${memberAt}`);
}

// ── Report ────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\ninvite-role: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`invite-role: ${passed} checks passed`);
