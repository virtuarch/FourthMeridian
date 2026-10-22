/**
 * IDEMP-010 — may this membership be ended without stranding the Space?
 * Pure; the route reads the facts in one tenant phase and asks this.
 */
export type LeaveGuardVerdict = { ok: true } | { ok: false; status: 400 | 409; error: string };

export function decideMemberRemoval(input: {
  targetRole: string;
  spaceType: string | null;
  otherActiveOwners: number;
}): LeaveGuardVerdict {
  if (input.targetRole !== "OWNER") return { ok: true };
  if (input.spaceType === "PERSONAL") return { ok: false, status: 400, error: "You cannot leave your Personal Space." };
  if (input.otherActiveOwners === 0) {
    return { ok: false, status: 409, error: "You are the last owner of this Space. Transfer ownership to another member before leaving." };
  }
  return { ok: true };
}
