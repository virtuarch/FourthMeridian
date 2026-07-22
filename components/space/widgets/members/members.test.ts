/**
 * components/space/widgets/members/members.test.ts
 *
 * Durable-invariant ratchets for the Members editorial convergence (house pattern —
 * pure, DB-free string reads). These pin the CONVERGENCE CONTRACT, not brittle markup:
 *
 *   1. The Members destination speaks the editorial language (Hero + read Surface/Block
 *      + RightPanel drill) — not the retired read-only GlassPanel roster.
 *   2. It is presentation-only: the workspace + its hook reuse the EXISTING member/
 *      invite routes; no new endpoint, no policy engine is introduced here.
 *   3. The client gates MIRROR the server's member:* rules (OWNER changes roles,
 *      ADMIN+ removes, never the OWNER, never yourself).
 *   4. Members stays a registered standard workspace (envelope "none", self-fetch),
 *      the host still mounts <MembersWorkspace>, and the old widget is retired.
 *
 *   npx tsx components/space/widgets/members/members.test.ts
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (...seg: string[]) => readFileSync(path.join(ROOT, ...seg), "utf8");
const MEM = (f: string) => read("components", "space", "widgets", "members", f);

// Strip comments for checks that assert real CODE (not prose): the file headers
// legitimately name the retired widget / the server policy they mirror.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const WORKSPACE = read("components", "space", "workspaces", "MembersWorkspace.tsx");
const WORKSPACE_CODE = strip(WORKSPACE);
const HOOK = MEM("use-space-members.ts");
const HOOK_CODE = strip(HOOK);
const ROSTER = MEM("MembersRoster.tsx");
const ROSTER_CODE = strip(ROSTER);
const DETAIL = MEM("MemberDetail.tsx");
const DETAIL_CODE = strip(DETAIL);
const HERO = MEM("MembersHero.tsx");
const INVITE = MEM("MembersInvite.tsx");
const PENDING = MEM("PendingInvites.tsx");
const DASH = read("components", "dashboard", "SpaceDashboard.tsx");
const PERSPECTIVES = read("lib", "perspectives.ts");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function count(hay: string, needle: string): number {
  let n = 0, i = 0;
  for (;;) { const j = hay.indexOf(needle, i); if (j === -1) return n; n++; i = j + needle.length; }
}

console.log("1. The Members destination speaks the editorial language");
{
  // The workspace composes the editorial primitives: the lede Hero, labelled read
  // Blocks, and the roster (which owns the RightPanel drill).
  check("workspace mounts the editorial Hero", WORKSPACE.includes("<MembersHero"));
  check("workspace lays out labelled Blocks", WORKSPACE.includes("<Block"));
  check("workspace mounts the People roster ledger", WORKSPACE.includes("<MembersRoster"));
  // The roster drills into a RightPanel detail (the "tell me more" primitive),
  // composing the member detail body — never re-implementing a modal.
  check("roster composes the Atlas RightPanel", ROSTER.includes("<RightPanel") && ROSTER.includes('from "@/components/atlas/panels"'));
  check("roster reads on a Surface (opaque read material)", ROSTER.includes("<Surface"));
  check("RightPanel renders the member detail body", ROSTER.includes("<MemberDetail"));
  // The retired read-only widget is gone (its GlassPanel roster is replaced).
  check("the old SpaceMembersWidget is retired", !existsSync(path.join(ROOT, "components", "dashboard", "widgets", "SpaceMembersWidget.tsx")));
  check("workspace no longer wraps SpaceMembersWidget", !WORKSPACE_CODE.includes("SpaceMembersWidget"));
}

console.log("2. Presentation-only: the EXISTING routes are reused, no new backend");
{
  // Every mutation the workspace performs hits a route the manage modal already used.
  check("hook reads the roster side-payload (GET /api/spaces/[id])", HOOK.includes("`/api/spaces/${spaceId}`"));
  check("hook reads the pending queue (GET …/invites)", HOOK.includes("`/api/spaces/${spaceId}/invites`"));
  check("hook invites via the existing route (POST …/invite)", HOOK.includes("`/api/spaces/${spaceId}/invite`"));
  check("hook rescinds via the existing route (DELETE …/invites/[id])", HOOK.includes("`/api/spaces/${spaceId}/invites/${inviteId}`"));
  check("hook changes role + removes via the existing member route", HOOK.includes("`/api/spaces/${spaceId}/members/${userId}`"));
  // No permission engine is invented in this surface — the access descriptor is a
  // display caption, and gating is boolean arithmetic over the role, not a policy.
  check("no policy engine imported into the Members surface",
    !HOOK_CODE.includes("lib/spaces/policy") && !ROSTER_CODE.includes("lib/spaces/policy") && !DETAIL_CODE.includes("lib/spaces/policy"));
  // A removal revokes shared accounts server-side; the hook signals the host to refresh.
  check("removal signals the host account listener", HOOK.includes("SPACE_ACCOUNTS_CHANGED_EVENT"));
}

console.log("3. Client gates MIRROR the server member:* rules");
{
  // Invite/manage are OWNER/ADMIN; role change is OWNER-only; both exclude the OWNER
  // target and yourself. The arithmetic lives in the hook (canInvite/isOwner) + roster.
  check("hook gates invite on OWNER/ADMIN of a shared Space",
    HOOK.includes('["OWNER", "ADMIN"].includes(myRole)') && HOOK.includes("!isPersonal"));
  check("hook exposes isOwner for the role-change gate", HOOK.includes("isOwner"));
  check("roster never offers role change to the OWNER or to yourself",
    ROSTER.includes('m.role === "OWNER"') && ROSTER.includes("isSelf") && ROSTER.includes("canManageRole"));
  check("roster removal requires ADMIN+ and excludes OWNER/self", ROSTER.includes("canRemove"));
  // The detail only shows an action the caller may take (no dead controls).
  check("detail renders actions only when permitted", DETAIL.includes("canManageRole || canRemove") && DETAIL.includes("!canManageRole && !canRemove"));
}

console.log("4. Members stays a registered standard workspace; host still mounts it");
{
  check("registry keeps Members as a self-fetching, envelope-none standard workspace",
    PERSPECTIVES.includes('id: "members"') && PERSPECTIVES.includes('envelope: "none"'));
  check("host gates + mounts <MembersWorkspace>",
    DASH.includes('activeTab === "MEMBERS"') && DASH.includes("<MembersWorkspace"));
  check("host threads role + current user + refresh into the workspace",
    DASH.includes("myRole={myRole}") && DASH.includes("currentUserId={currentUserId}"));
  // One vocabulary: the members surfaces read role labels from manage-shared.
  check("members surfaces reuse the canonical ROLE_LABELS vocabulary",
    HERO.includes("ROLE_LABELS") && DETAIL.includes("ROLE_LABELS") && count(MEM("members-ui.tsx"), "ROLE_LABELS") === 0);
  // Invite + pending reuse the SHARED search control + display-name helper (no dup).
  check("invite reuses the shared UserSearchInput", INVITE.includes("UserSearchInput"));
  check("pending reuses the shared userDisplayName", PENDING.includes("userDisplayName"));
}

if (failures > 0) { console.error(`\n${failures} members check(s) failed`); process.exit(1); }
console.log("\nAll Members convergence checks passed");
