"use client";

/**
 * components/space/widgets/members/MembersRoster.tsx
 *
 * The "People" ledger — the roster in the established Fourth Meridian exploration
 * idiom: a read Surface of member rows, each opening its DETAIL in a RightPanel
 * ("tell me more about who I selected"). The Members analogue of
 * CashFlowCategoryLedger, minus the money weight-bar (a member has no share of a
 * total — the row carries identity + role, and the hover accent rail is the only
 * "opens a detail" signal). It COMPOSES the Atlas RightPanel; it is not a primitive.
 *
 * Presentation + wiring only: the rows are the roster the workspace already holds,
 * and the detail's actions call the mutation fns the workspace threads down (the
 * SAME routes the manage modal uses). No fetch, no policy here — just selection state
 * and the per-member gate arithmetic (which mirrors the server's member:* rules).
 */

import { useState } from "react";
import { Surface } from "@/components/atlas/Surface";
import { RightPanel, PanelHeader, PanelContent } from "@/components/atlas/panels";
import { ROLE_LABELS, type Member } from "@/components/space/manage/manage-shared";
import { avatarColor, memberDisplayName, memberInitial, ROLE_ICONS } from "./members-ui";
import { MemberDetail } from "./MemberDetail";

export function MembersRoster({
  members,
  currentUserId,
  canInvite,
  isOwner,
  changingRoleId,
  removingId,
  onChangeRole,
  onRemove,
}: {
  members: Member[];
  currentUserId: string;
  /** ADMIN+ on a shared Space — a precondition for the remove action. */
  canInvite: boolean;
  /** OWNER — a precondition for the change-role action. */
  isOwner: boolean;
  changingRoleId: string | null;
  removingId: string | null;
  onChangeRole: (userId: string, role: string) => void;
  onRemove: (userId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? members.find((m) => m.user.id === selectedId) ?? null : null;

  // Per-member gates — the SAME arithmetic the manage modal uses (never the OWNER,
  // never yourself; role change is OWNER-only, removal is ADMIN+). Kept here so the
  // RightPanel is handed a plain boolean, not the raw role strings.
  const gatesFor = (m: Member) => {
    const isSelf = m.user.id === currentUserId;
    const isOwnerTarget = m.role === "OWNER";
    return {
      isSelf,
      canManageRole: isOwner && !isOwnerTarget && !isSelf,
      canRemove: canInvite && !isOwnerTarget && !isSelf,
    };
  };

  return (
    <>
      <Surface className="overflow-hidden">
        <ul className="divide-y divide-[var(--border-hairline)]">
          {members.map((m) => {
            const isSelf = m.user.id === currentUserId;
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(m.user.id)}
                  className="group relative flex w-full items-center gap-3 overflow-hidden px-3.5 py-3 text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--meridian-400)]"
                >
                  {/* Hover accent rail — the affordance that this row opens a detail. */}
                  <span
                    aria-hidden
                    className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-[var(--meridian-400)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                  />
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
                    style={{ background: avatarColor(m.id) }}
                  >
                    <span className="text-xs font-semibold text-white">{memberInitial(m)}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                      {memberDisplayName(m)}
                      {isSelf && <span className="ml-1 text-[11px] font-normal text-[var(--text-muted)]">(you)</span>}
                    </p>
                    {m.user.username && (
                      <p className="truncate text-[11px] text-[var(--text-faint)]">@{m.user.username}</p>
                    )}
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                    {ROLE_ICONS[m.role] ?? null}
                    {ROLE_LABELS[m.role] ?? m.role}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Surface>

      {/* Right panel — the selected member's detail (contextual detail). */}
      <RightPanel open={selected != null} onClose={() => setSelectedId(null)} ariaLabel="Member detail">
        {selected && (
          <>
            <PanelHeader eyebrow="Member" title={memberDisplayName(selected)} />
            <PanelContent>
              {(() => {
                const g = gatesFor(selected);
                return (
                  <MemberDetail
                    member={selected}
                    isSelf={g.isSelf}
                    canManageRole={g.canManageRole}
                    canRemove={g.canRemove}
                    changing={changingRoleId === selected.user.id}
                    removing={removingId === selected.user.id}
                    onChangeRole={(role) => onChangeRole(selected.user.id, role)}
                    onRemove={() => onRemove(selected.user.id)}
                  />
                );
              })()}
            </PanelContent>
          </>
        )}
      </RightPanel>
    </>
  );
}
