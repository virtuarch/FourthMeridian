"use client";

/**
 * components/space/widgets/members/MembersInvite.tsx
 *
 * The invite Form for the Members workspace — the "grant access" action, in the Atlas
 * field idiom. It reuses the SAME UserSearchInput the manage modal and Create-Space
 * onboarding mount (one search control, no duplication), pairs it with the Atlas
 * Select for the initial role, and sends through the workspace's invite() (POST
 * /api/spaces/[id]/invite — the existing route). Purely the composer + its own draft
 * state; the gate (canInvite) is decided upstream, so this only mounts when allowed.
 */

import { useState } from "react";
import { Loader2, Mail, X } from "lucide-react";
import { GlassButton } from "@/components/atlas/GlassButton";
import { Select } from "@/components/atlas/fields";
import {
  UserSearchInput,
  userDisplayName,
  type UserResult,
} from "@/components/space/manage/UserSearchInput";

const ROLE_OPTIONS = [
  { value: "ADMIN", label: "Admin" },
  { value: "MEMBER", label: "Member" },
  { value: "VIEWER", label: "Viewer" },
];

export function MembersInvite({
  spaceId,
  onInvite,
}: {
  spaceId: string;
  /** Sends the invite (POST …/invite); resolves an error string, or null on success. */
  onInvite: (username: string, role: string) => Promise<string | null>;
}) {
  const [selected, setSelected] = useState<UserResult | null>(null);
  const [role, setRole] = useState("MEMBER");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  const clearFeedback = () => { setError(""); setOk(""); };

  async function send() {
    if (!selected) return;
    setBusy(true);
    clearFeedback();
    const err = await onInvite(selected.username ?? selected.id, role);
    setBusy(false);
    if (err) {
      setError(err);
    } else {
      setOk(`Invite sent to ${userDisplayName(selected)}`);
      setSelected(null);
    }
  }

  return (
    <div className="space-y-2">
      {selected ? (
        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center gap-2 rounded-[var(--radius-md)] border border-[rgba(125,168,255,.3)] bg-[var(--surface-inset)] px-3 py-2">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[rgba(59,130,246,.20)]">
              <span className="text-[10px] font-semibold text-[var(--meridian-400)]">
                {userDisplayName(selected)[0].toUpperCase()}
              </span>
            </div>
            <p className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">{userDisplayName(selected)}</p>
            <button
              type="button"
              onClick={() => { setSelected(null); clearFeedback(); }}
              className="p-0.5 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
              aria-label="Clear selection"
            >
              <X size={13} />
            </button>
          </div>
          <Select
            value={role}
            options={ROLE_OPTIONS}
            onChange={(e) => setRole(e.target.value)}
            aria-label="Invite role"
            className="shrink-0"
          />
          <GlassButton onClick={send} disabled={busy} tone="meridian" size="sm">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Mail size={12} />}
            Send
          </GlassButton>
        </div>
      ) : (
        <UserSearchInput
          spaceId={spaceId}
          onSelect={(u) => { setSelected(u); clearFeedback(); }}
        />
      )}
      {error && <p className="text-xs text-[var(--coral-400)]">{error}</p>}
      {ok && <p className="text-xs text-[var(--emerald-400)]">{ok}</p>}
    </div>
  );
}
