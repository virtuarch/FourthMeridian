"use client";

/**
 * components/space/manage/DangerZonePanel.tsx  (MSM decomposition)
 *
 * The "Delete / Leave Space" tab of Manage Space, extracted verbatim from the
 * former single-file ManageSpaceModal (DangerZoneTab).
 *
 * Archive and Move to trash are the only destructive-ish actions surfaced
 * here, and both are reversible. A real, irreversible delete
 * (db.space.delete) only exists at app/api/spaces/[id]/permanent —
 * and that route only accepts spaces that are already trashed, so it is
 * intentionally not reachable from this modal. It's only ever offered from
 * the Archive & Trash page (/dashboard/settings/archive), once a space
 * is already sitting in trash. This is also the single entry point for
 * owner-initiated destructive actions — the old per-card "Delete space"
 * shortcut in SpacesClient's SpaceDetail modal has been removed so
 * there's exactly one place owners go for this. The shell keeps this tab
 * hidden entirely for PERSONAL Spaces (server routes also fail closed).
 *
 * UI-003 — Leave and Archive no longer fire on the first click: each button opens a
 * ConfirmDialog that states the consequence, and handleLeave / handleArchive are
 * reachable from that dialog's onConfirm alone. A refused Leave now says so.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, UserMinus, Archive, Trash2, AlertTriangle } from "lucide-react";
import { displaySpaceName } from "@/lib/format";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { GlassButton } from "@/components/atlas/GlassButton";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { archiveSpaceConfirm, leaveSpaceConfirm } from "./destructive-confirm";
import type { SpaceDetail } from "./manage-shared";

export function DangerZonePanel({
  space,
  myRole,
  currentUserId,
  onClose,
  onRefresh,
  onDeleted,
}: {
  space:     SpaceDetail;
  myRole:        string;
  currentUserId: string;
  onClose:       () => void;
  onRefresh:     () => void;
  onDeleted?:    () => void;
}) {
  const router = useRouter();
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiveBusy,  setArchiveBusy]  = useState(false);
  const [trashBusy,    setTrashBusy]    = useState(false);
  const [leaveBusy,    setLeaveBusy]    = useState(false);
  const [error,        setError]        = useState<string | null>(null);

  const isOwner = myRole === "OWNER";

  async function handleLeave() {
    setLeaveBusy(true);
    try {
      const res = await fetch(`/api/spaces/${space.id}/members/${currentUserId}`, { method: "DELETE" });
      if (res.ok) {
        onRefresh();
        onClose();
        router.push(`/dashboard/spaces?left=${encodeURIComponent(displaySpaceName(space.name))}`);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to leave Space.");
      }
    } catch {
      setError("Network error — you have not left this Space.");
    } finally {
      setLeaveBusy(false);
      setConfirmLeave(false);
    }
  }

  async function handleArchive() {
    setArchiveBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/spaces/${space.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ archivedAt: new Date().toISOString() }),
      });
      if (res.ok) {
        onDeleted?.(); // it leaves the active list the same way a trashed space does
        onRefresh();
        onClose();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to archive Space.");
      }
    } catch {
      setError("Network error — the Space was not archived.");
    } finally {
      setArchiveBusy(false);
      setConfirmArchive(false);
    }
  }

  async function handleTrash() {
    setTrashBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/spaces/${space.id}`, { method: "DELETE" });
      if (res.ok) {
        onDeleted?.();
        onRefresh();
        onClose();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to move Space to trash.");
        setConfirmTrash(false);
      }
    } finally {
      setTrashBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {!isOwner && (
        <GlassPanel depth="thin" elevation="e1" radius="lg" glow="coral" className="block">
          <div className="p-4 space-y-3">
            <p className="text-xs font-semibold text-[var(--coral-400)] uppercase tracking-widest">Leave Space</p>
            <div className="space-y-1.5">
              <p className="text-xs text-[var(--text-secondary)]">
                You will be removed from <span className="text-[var(--text-primary)] font-medium">{displaySpaceName(space.name)}</span> and lose access immediately.
              </p>
              <ul className="space-y-1">
                {[
                  "You won't see this Space in your sidebar.",
                  "Any accounts you shared into this Space will be removed from the Space when you leave.",
                  "You can only rejoin if an owner sends you a new invite.",
                ].map((line) => (
                  <li key={line} className="flex items-start gap-1.5 text-xs text-[var(--text-muted)]">
                    <span className="mt-0.5 shrink-0 w-1 h-1 rounded-full bg-[var(--surface-hover-strong)] translate-y-1" />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
            <GlassButton onClick={() => { setError(null); setConfirmLeave(true); }} disabled={leaveBusy} tone="danger" size="sm">
              {leaveBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <UserMinus size={14} aria-hidden />}
              Leave Space
            </GlassButton>
          </div>
        </GlassPanel>
      )}

      {isOwner && (
        <>
          <GlassPanel depth="thin" elevation="e1" radius="lg" className="block">
            <div className="p-4 space-y-3">
              <p className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-widest">Archive Space</p>
              <p className="text-xs text-[var(--text-secondary)]">
                Hide <span className="text-[var(--text-primary)] font-medium">{displaySpaceName(space.name)}</span> from your active Space list. Members, shared accounts, and history all stay intact — unarchive it any time from the Archive &amp; Trash page.
              </p>
              <GlassButton onClick={() => { setError(null); setConfirmArchive(true); }} disabled={archiveBusy} tone="neutral" size="sm">
                {archiveBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Archive size={14} aria-hidden />}
                Archive Space
              </GlassButton>
            </div>
          </GlassPanel>

          <GlassPanel depth="thin" elevation="e1" radius="lg" glow="coral" className="block">
            <div className="p-4 space-y-3">
              <p className="text-xs font-semibold text-[var(--coral-400)] uppercase tracking-widest">Delete Space</p>
              <p className="text-xs text-[var(--text-secondary)]">
                Move <span className="text-[var(--text-primary)] font-medium">{displaySpaceName(space.name)}</span> to trash. It&apos;s hidden from active use but can still be restored from the Archive &amp; Trash page until it&apos;s permanently deleted there.
              </p>
              {!confirmTrash ? (
                <GlassButton onClick={() => setConfirmTrash(true)} tone="danger" size="sm">
                  <Trash2 size={14} /> Move to trash
                </GlassButton>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-[var(--text-secondary)]">Move this Space to trash?</p>
                  <div className="flex gap-2">
                    <GlassButton onClick={() => setConfirmTrash(false)} tone="neutral" size="sm" fullWidth>
                      Cancel
                    </GlassButton>
                    <GlassButton onClick={handleTrash} disabled={trashBusy} tone="danger" size="sm" fullWidth>
                      {trashBusy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                      Move to trash
                    </GlassButton>
                  </div>
                </div>
              )}
            </div>
          </GlassPanel>

          <p className="text-[11px] text-[var(--text-muted)] px-1">
            Permanent deletion is only available from the Archive &amp; Trash page, and only once this Space is already in trash.
          </p>
        </>
      )}

      {error && (
        <p role="alert" className="text-xs text-[var(--coral-400)] flex items-center gap-1.5 px-1">
          <AlertTriangle size={11} aria-hidden /> {error}
        </p>
      )}

      {/* UI-003 — the ONLY paths to handleLeave / handleArchive. */}
      {confirmLeave && (() => {
        const copy = leaveSpaceConfirm(displaySpaceName(space.name));
        return (
          <ConfirmDialog
            onClose={() => setConfirmLeave(false)}
            onConfirm={handleLeave}
            busy={leaveBusy}
            icon={UserMinus}
            title={copy.title}
            message={copy.message}
            confirmLabel={copy.confirmLabel}
          />
        );
      })()}
      {confirmArchive && (() => {
        const copy = archiveSpaceConfirm(displaySpaceName(space.name));
        return (
          <ConfirmDialog
            onClose={() => setConfirmArchive(false)}
            onConfirm={handleArchive}
            busy={archiveBusy}
            icon={Archive}
            title={copy.title}
            message={copy.message}
            confirmLabel={copy.confirmLabel}
            confirmTone="neutral"
          />
        );
      })()}
    </div>
  );
}
