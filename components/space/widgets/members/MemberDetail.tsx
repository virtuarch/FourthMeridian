"use client";

/**
 * components/space/widgets/members/MemberDetail.tsx
 *
 * The per-member DETAIL body, shown inside the roster's RightPanel (the Atlas panel
 * primitive — "tell me more about who I selected"). The Members analogue of
 * CashFlowCategoryDetail / HoldingDetail: it leads with the member's identity, states
 * their role and — in plain language — what that role grants (ROLE_ACCESS, a caption
 * over the server's own grants, never a new engine), then exposes the two actions the
 * caller is permitted to take: change access (OWNER only) and remove.
 *
 * HONESTY: the gates below mirror the server (member:manageRoles = OWNER,
 * member:remove = ADMIN+, never the OWNER, never yourself here — self-leave lives in
 * the Danger tab). The Select + Remove call the SAME routes the manage modal uses; the
 * panel invents no permission it cannot enforce, and shows no action it cannot offer.
 */

import { Loader2, UserMinus } from "lucide-react";
import { formatDate } from "@/lib/format";
import { Select } from "@/components/atlas/fields";
import { ROLE_LABELS, type Member } from "@/components/space/manage/manage-shared";
import { avatarColor, memberDisplayName, memberInitial, ROLE_ICONS, ROLE_ACCESS } from "./members-ui";

const PROMOTABLE = [
  { value: "ADMIN", label: "Admin" },
  { value: "MEMBER", label: "Member" },
  { value: "VIEWER", label: "Viewer" },
];

export function MemberDetail({
  member,
  isSelf,
  canManageRole,
  canRemove,
  changing,
  removing,
  onChangeRole,
  onRemove,
}: {
  member: Member;
  isSelf: boolean;
  /** OWNER viewing a non-owner, non-self member. */
  canManageRole: boolean;
  /** ADMIN+ viewing a non-owner, non-self member. */
  canRemove: boolean;
  changing: boolean;
  removing: boolean;
  onChangeRole: (role: string) => void;
  onRemove: () => void;
}) {
  const name = memberDisplayName(member);

  return (
    <div className="min-w-0">
      {/* Identity. */}
      <div className="flex items-center gap-3">
        <div
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full"
          style={{ background: avatarColor(member.id) }}
        >
          <span className="text-base font-semibold text-white">{memberInitial(member)}</span>
        </div>
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold text-[var(--text-primary)]">
            {name}
            {isSelf && <span className="ml-1.5 text-xs font-normal text-[var(--text-muted)]">(you)</span>}
          </p>
          {member.user.username && (
            <p className="truncate text-xs text-[var(--text-muted)]">@{member.user.username}</p>
          )}
        </div>
      </div>

      {/* Role + what it grants (display caption over the server's own grants). */}
      <div className="mt-5 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--surface-inset)] px-3.5 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Role</span>
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--text-primary)]">
            {ROLE_ICONS[member.role] ?? null}
            {ROLE_LABELS[member.role] ?? member.role}
          </span>
        </div>
        <p className="mt-2 text-[13px] leading-snug text-[var(--text-secondary)]">
          {ROLE_ACCESS[member.role] ?? "Access to this Space."}
        </p>
      </div>

      {/* Joined. */}
      <p className="mt-3 text-[11px] text-[var(--text-faint)]">
        Joined {formatDate(member.joinedAt)}
      </p>

      {/* Actions — only what this caller may do; nothing shown it cannot enforce. */}
      {(canManageRole || canRemove) && (
        <div className="mt-5 space-y-3 border-t border-[var(--border-hairline)] pt-5">
          {canManageRole && (
            <div>
              <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                Manage access
              </label>
              <Select
                value={member.role}
                disabled={changing}
                options={PROMOTABLE}
                onChange={(e) => onChangeRole(e.target.value)}
                className="w-full"
              />
              {changing && (
                <p className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                  <Loader2 size={11} className="animate-spin" /> Updating role…
                </p>
              )}
            </div>
          )}

          {canRemove && (
            <button
              type="button"
              onClick={onRemove}
              disabled={removing}
              className="flex w-full items-center justify-center gap-2 rounded-[var(--radius-md)] border border-[rgba(237,82,71,.3)] px-3 py-2.5 text-sm font-medium text-[var(--coral-400)] transition-colors hover:bg-[rgba(237,82,71,.10)] disabled:opacity-50 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--coral-400)]"
            >
              {removing ? <Loader2 size={14} className="animate-spin" /> : <UserMinus size={14} />}
              Remove from Space
            </button>
          )}
        </div>
      )}

      {/* When no action is available, say why plainly rather than showing dead controls. */}
      {!canManageRole && !canRemove && (
        <p className="mt-5 border-t border-[var(--border-hairline)] pt-5 text-[11px] leading-snug text-[var(--text-faint)]">
          {isSelf
            ? "This is you. To leave this Space, use Manage Space."
            : member.role === "OWNER"
              ? "The owner can't be changed or removed here."
              : "You don't have permission to change this member."}
        </p>
      )}
    </div>
  );
}
