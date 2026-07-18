"use client";

/**
 * components/space/widgets/members/members-ui.tsx
 *
 * Shared presentation atoms for the editorial Members workspace — the role icon,
 * the deterministic member-avatar colour, the display-name reader, and the
 * DISPLAY-ONLY role → access descriptor. None of this is authority: the avatar
 * recipe matches the Spaces card grid, and ROLE_ACCESS is a human sentence about
 * what a role already grants (a caption, NOT a permission engine — the engine is
 * the server's requireSpaceRole / policy.ts, untouched). The canonical role LABELS
 * stay in manage-shared so members and the manage modal read one vocabulary.
 */

import { Crown, Shield, Users, Eye } from "lucide-react";
import type { Member } from "@/components/space/manage/manage-shared";

/** Deterministic per-member avatar colour (matches SpacesClient's member stack). */
const AVATAR_PALETTE = [
  "var(--meridian-600)",
  "var(--brass-600)",
  "var(--violet-600)",
  "var(--emerald-600)",
  "var(--coral-600)",
];

export function avatarColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

export const ROLE_ICONS: Record<string, React.ReactNode> = {
  OWNER: <Crown size={12} className="text-[var(--brass-400)]" />,
  ADMIN: <Shield size={12} className="text-[var(--meridian-400)]" />,
  MEMBER: <Users size={12} className="text-[var(--text-secondary)]" />,
  VIEWER: <Eye size={12} className="text-[var(--text-muted)]" />,
};

/**
 * A one-line, human descriptor of what a role can DO in this Space — a caption
 * that reads back the server's role grants (lib/space.ts derivePermissions), never
 * a decision surface. Kept here as display copy so the RightPanel can say plainly
 * "Full access" / "View only" without inventing a permission model.
 */
export const ROLE_ACCESS: Record<string, string> = {
  OWNER: "Full access — owns the Space, manages members and settings",
  ADMIN: "Full access — can invite, manage members, and edit the Space",
  MEMBER: "Can view everything and add their own accounts",
  VIEWER: "View only — cannot invite, edit, or add accounts",
};

export function memberDisplayName(m: Pick<Member, "user">): string {
  return (
    m.user.name ??
    (m.user.username ? `@${m.user.username}` : null) ??
    m.user.email ??
    "Member"
  );
}

export function memberInitial(m: Pick<Member, "user">): string {
  return memberDisplayName(m).replace(/^@/, "")[0]?.toUpperCase() ?? "?";
}
