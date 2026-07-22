"use client";

/**
 * components/space/widgets/members/PendingInvites.tsx
 *
 * The pending-invite queue for the Members workspace — the people who've been asked
 * but haven't accepted yet, on a read Surface, each rescindable (DELETE …/invites/[id]
 * — the existing route). Presentation + wiring only; the queue is the workspace's, the
 * rescind fn is threaded down. Mounts only when the caller may invite (decided upstream).
 */

import { Loader2, X } from "lucide-react";
import { formatDate } from "@/lib/format";
import { Surface } from "@/components/atlas/Surface";
import { ROLE_LABELS } from "@/components/space/manage/manage-shared";
import { userDisplayName, type UserResult } from "@/components/space/manage/UserSearchInput";
import type { QueuedInvite } from "./use-space-members";

export function PendingInvites({
  queue,
  rescindingId,
  onRescind,
}: {
  queue: QueuedInvite[];
  rescindingId: string | null;
  onRescind: (inviteId: string) => void;
}) {
  if (queue.length === 0) {
    return (
      <p className="px-1 text-xs text-[var(--text-muted)]">No pending invites.</p>
    );
  }

  return (
    <Surface className="overflow-hidden">
      <ul className="divide-y divide-[var(--border-hairline)]">
        {queue.map((inv) => (
          <li key={inv.id} className="flex items-center gap-3 px-3.5 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-[var(--text-primary)]">
                {userDisplayName(inv.invitedUser as UserResult)}
              </p>
              <p className="text-[11px] text-[var(--text-faint)]">
                {ROLE_LABELS[inv.role] ?? inv.role} · sent {formatDate(inv.createdAt)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onRescind(inv.id)}
              disabled={rescindingId === inv.id}
              className="rounded-[var(--radius-sm)] p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[rgba(237,82,71,.10)] hover:text-[var(--coral-400)] disabled:opacity-50"
              title="Rescind invite"
              aria-label="Rescind invite"
            >
              {rescindingId === inv.id ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
            </button>
          </li>
        ))}
      </ul>
    </Surface>
  );
}
