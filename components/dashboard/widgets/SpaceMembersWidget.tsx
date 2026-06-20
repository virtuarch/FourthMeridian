"use client";

/**
 * SpaceMembersWidget
 *
 * Read-only member roster for the new Members tab — self-fetches via the
 * existing GET /api/workspaces/[id] route (the same endpoint
 * ManageWorkspaceModal already uses internally), so this ships with real
 * data on day one rather than a placeholder. All actual management
 * (invite, remove, role change) stays inside ManageWorkspaceModal, which
 * this widget links out to via `onManage` rather than re-implementing —
 * one source of truth for member mutations.
 *
 * Avatar fill recipe matches the member-avatar-stack already used on the
 * Spaces card grid (components/dashboard/SpacesClient.tsx) — deterministic
 * per-member color from existing category/tone tokens, kept in sync
 * visually with the rest of the Spaces redesign.
 */

import { useEffect, useState } from "react";
import { Crown, Shield, Eye, Loader2, Settings } from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { GlassButton } from "@/components/atlas/GlassButton";

type Member = {
  id: string;
  role: string;
  joinedAt: string;
  user: { id: string; name: string | null; username: string | null; email: string | null };
};

const AVATAR_PALETTE = [
  "var(--meridian-600)",
  "var(--brass-600)",
  "var(--violet-600)",
  "var(--emerald-600)",
  "var(--coral-600)",
];

function avatarColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

const ROLE_ICON: Record<string, React.ReactNode> = {
  OWNER:  <Crown size={11} className="text-[var(--brass-400)]" />,
  ADMIN:  <Shield size={11} className="text-[var(--meridian-400)]" />,
  VIEWER: <Eye size={11} className="text-[var(--text-muted)]" />,
};

export function SpaceMembersWidget({
  workspaceId,
  onManage,
}: {
  workspaceId: string;
  onManage?: () => void;
}) {
  const [members, setMembers] = useState<Member[] | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/workspaces/${workspaceId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (active) setMembers(data?.members ?? []); })
      .catch(() => { if (active) setMembers([]); });
    return () => { active = false; };
  }, [workspaceId]);

  if (members === null) {
    return (
      <div className="flex items-center justify-center py-10 text-[var(--text-muted)]">
        <Loader2 size={16} className="animate-spin mr-2" /> Loading members…
      </div>
    );
  }

  return (
    <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4">
      <div className="flex items-center justify-between px-1 mb-2">
        <p className="text-sm font-semibold text-[var(--text-primary)]">
          {members.length} {members.length === 1 ? "member" : "members"}
        </p>
        {onManage && (
          <GlassButton size="sm" onClick={onManage}>
            <Settings size={12} /> Manage
          </GlassButton>
        )}
      </div>
      <div className="space-y-0.5">
        {members.map((m) => {
          const label = m.user.name ?? m.user.username ?? m.user.email ?? "Member";
          const initial = label[0]?.toUpperCase() ?? "?";
          return (
            <div key={m.id} className="flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-sm)]">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                style={{ background: avatarColor(m.id) }}
              >
                <span className="text-xs font-semibold text-white">{initial}</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-[var(--text-primary)] truncate">{label}</p>
              </div>
              <div className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] shrink-0">
                {ROLE_ICON[m.role]}
                {m.role}
              </div>
            </div>
          );
        })}
      </div>
    </GlassPanel>
  );
}
