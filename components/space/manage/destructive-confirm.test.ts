/**
 * components/space/manage/destructive-confirm.test.ts  (UI-003)
 *
 * Destructive customer actions are never one click. Pinned:
 *   1. the confirmation copy states the CONSEQUENCE (member removal un-shares every
 *      account they shared; role change names both roles; archive is reversible;
 *      account revoke is not a delete)
 *   2. every destructive mutation is reachable ONLY through a ConfirmDialog's
 *      onConfirm — the trigger button / select merely stages it
 *   3. the trigger surfaces still render (renderToStaticMarkup) and no dialog is
 *      open on first render
 *
 *   npx tsx components/space/manage/destructive-confirm.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  archiveSpaceConfirm, changeRoleConfirm, leaveSpaceConfirm, removeMemberConfirm, rescindInviteConfirm, revokeAccountConfirm,
} from "./destructive-confirm";
import { MemberDetail } from "@/components/space/widgets/members/MemberDetail";
import type { Member } from "./manage-shared";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const code = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const count = (hay: string, re: RegExp) => (hay.match(re) ?? []).length;

console.log("1. The copy states the consequence");
{
  const r = removeMemberConfirm("Ana");
  check("remove: names the member", r.title.includes("Ana"));
  check("remove: says every shared account is un-shared", /every account they shared/i.test(r.message) && /un-shared/i.test(r.message));
  check("remove: says access ends immediately", /immediately/i.test(r.message));
  check("remove: says rejoining needs a new invite", /new invite/i.test(r.message));
  check("remove: confirm label is the action, not 'Confirm'", r.confirmLabel === "Remove member");

  const c = changeRoleConfirm("Ana", "ADMIN", "VIEWER", "View only — cannot invite");
  check("role: names FROM and TO roles", c.message.includes("Admin") && c.message.includes("Viewer"));
  check("role: carries what the new role grants", c.message.includes("View only"));
  check("role: article agrees with the role (an Admin / a Viewer)",
    changeRoleConfirm("A", "VIEWER", "ADMIN").title === "Make A an Admin?" && c.title === "Make Ana a Viewer?");

  const a = archiveSpaceConfirm("Household");
  check("archive: names the Space", a.title.includes("Household"));
  check("archive: says it is reversible and where", /unarchive/i.test(a.message) && a.message.includes("Archive & Trash"));

  const l = leaveSpaceConfirm("Household");
  check("leave: says shared accounts leave with you", /every account you shared/i.test(l.message));

  const v = revokeAccountConfirm("Chase Checking");
  check("revoke: names the account", v.title.includes("Chase Checking"));
  check("revoke: says it leaves the totals for everyone", /totals/i.test(v.message) && /members/i.test(v.message));
  check("revoke: says the account is NOT deleted", /not deleted/i.test(v.message));
}

{
  const ri = rescindInviteConfirm("Ana");
  check("rescind: names the invitee", ri.title.includes("Ana"));
  check("rescind: says the sent link stops working immediately", /link/i.test(ri.message) && /immediately/i.test(ri.message));
  check("rescind: says re-adding needs a new invite", /new invite/i.test(ri.message));
  check("rescind: confirm label is the action", ri.confirmLabel === "Rescind invite");
}

console.log("2. Each mutation is reachable only through ConfirmDialog onConfirm");
{
  // A7 (2026-10-22) — the pending-invite rescind fired on one click in both
  // surfaces; the button now only stages it.
  const pi = code("components/space/widgets/members/PendingInvites.tsx");
  check("PendingInvites: onRescind( called once, inside ConfirmDialog onConfirm",
    count(pi, /\bonRescind\(/g) === 1 && /onConfirm=\{\(\) => \{ const id = pending\.id; setPending\(null\); onRescind\(id\); \}\}/.test(pi));
  check("PendingInvites: the X button only stages the rescind", pi.includes("onClick={() => setPending(inv)}"));
  const mp2 = code("components/space/manage/MembersPanel.tsx");
  check("MembersPanel: handleRescind( only in the declaration + onConfirm",
    count(mp2, /handleRescind\(/g) === 2 && mp2.includes("void handleRescind(id)") && mp2.includes("onClick={() => setPendingRescind(inv)}"));
  const rt = code("app/api/spaces/[id]/invites/[inviteId]/route.ts");
  check("rescind route writes MEMBER_INVITE_CANCELLED in the same transaction as the delete",
    /deleteMany\(\{ where: scope \}\)[\s\S]*?auditLog\.create\([\s\S]*?MEMBER_INVITE_CANCELLED/.test(rt));
}
{
  // MemberDetail — onRemove / onChangeRole are called only in the confirm handlers,
  // which are referenced only from <ConfirmDialog onConfirm=…>.
  const md = code("components/space/widgets/members/MemberDetail.tsx");
  check("MemberDetail imports ConfirmDialog", md.includes('from "@/components/atlas/ConfirmDialog"'));
  check("MemberDetail: onRemove called once, inside confirmRemoval",
    count(md, /\bonRemove\(\)/g) === 1 && /async function confirmRemoval\(\)[\s\S]*?await onRemove\(\)/.test(md));
  check("MemberDetail: onChangeRole called once, inside confirmRoleChange",
    count(md, /\bonChangeRole\(/g) === 1 && /async function confirmRoleChange\(\)[\s\S]*?await onChangeRole\(role\)/.test(md));
  check("MemberDetail: confirm handlers only wired to onConfirm",
    count(md, /confirmRemoval\b/g) === 2 && md.includes("onConfirm={confirmRemoval}") &&
    count(md, /confirmRoleChange\b/g) === 2 && md.includes("onConfirm={confirmRoleChange}"));
  check("MemberDetail: Remove button only opens the confirm", md.includes("onClick={() => { setRemoveError(null); setConfirmRemove(true); }}"));
  check("MemberDetail: role Select only stages the change", md.includes("setPendingRole(e.target.value)") && !/onChange=\{\(e\) => onChangeRole/.test(md));

  const mp = code("components/space/manage/MembersPanel.tsx");
  check("MembersPanel: handleRemove( only in the declaration + onConfirm",
    count(mp, /handleRemove\(/g) === 2 && mp.includes("onConfirm={() => handleRemove(pendingRemove.userId)}"));
  check("MembersPanel: handleRoleChange( only in the declaration + onConfirm",
    count(mp, /handleRoleChange\(/g) === 2 && /onConfirm=\{\(\) => \{ const p = pendingRole; setPendingRole\(null\); void handleRoleChange\(p\.userId, p\.to\)/.test(mp));
  check("MembersPanel: a refused removal/role change is shown (role=alert)", mp.includes('role="alert" className="mt-2 text-xs text-[var(--coral-400)]">{memberError}'));

  const dz = code("components/space/manage/DangerZonePanel.tsx");
  check("DangerZone: handleLeave only as onConfirm", count(dz, /handleLeave\b/g) === 2 && dz.includes("onConfirm={handleLeave}"));
  check("DangerZone: handleArchive only as onConfirm", count(dz, /handleArchive\b/g) === 2 && dz.includes("onConfirm={handleArchive}"));
  check("DangerZone: a refused Leave is reported", dz.includes('"Failed to leave Space."'));

  const ad = code("components/space/widgets/accounts/AccountDetail.tsx");
  check("AccountDetail: removeFromSpace only as onConfirm", count(ad, /removeFromSpace\b/g) === 2 && ad.includes("onConfirm={removeFromSpace}"));

  const fp = code("components/space/manage/FinancesPanel.tsx");
  check("FinancesPanel: handleRevoke( only in the declaration + onConfirm",
    count(fp, /handleRevoke\(/g) === 2 && fp.includes("onConfirm={() => handleRevoke(pendingRevoke.id)}"));
}

console.log("3. Render: triggers render, no dialog open at first paint");
{
  const member: Member = { id: "m1", role: "ADMIN", joinedAt: "2026-01-01T00:00:00.000Z", user: { id: "u1", name: "Ana", username: "ana" } };
  let called = 0;
  const html = renderToStaticMarkup(createElement(MemberDetail, {
    member, isSelf: false, canManageRole: true, canRemove: true, changing: false, removing: false,
    onChangeRole: () => { called++; }, onRemove: () => { called++; },
  }));
  check("Remove button renders", html.includes("Remove from Space"));
  check("role select is labelled (label for= the select id)", html.includes('for="member-role-m1"') && html.includes('id="member-role-m1"'));
  check("no alertdialog on first render", !html.includes("alertdialog"));
  check("rendering never invokes a mutation", called === 0);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll UI-003 checks passed.");
