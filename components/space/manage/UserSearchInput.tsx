"use client";

/**
 * components/space/manage/UserSearchInput.tsx  (MSM decomposition)
 *
 * The user search-and-select control + its result type and display-name helper,
 * extracted verbatim from the former single-file ManageSpaceModal. Exported (as
 * before) so BOTH the Members panel's invite form AND the Create Space
 * onboarding flow's Invite step (CreateSpaceModal.tsx) mount the exact same
 * component and types — same component, two mount points, no duplication.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Loader2, Search } from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";

export type UserResult = {
  id: string;
  name: string | null;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
};

export function userDisplayName(u: UserResult) {
  if (u.name) return u.name;
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ");
  return full || u.username || "Unknown";
}

export function UserSearchInput({
  spaceId,
  onSelect,
}: {
  spaceId: string;
  onSelect: (user: UserResult) => void;
}) {
  const [query,   setQuery]   = useState("");
  const [results, setResults] = useState<UserResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open,    setOpen]    = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const search = useCallback(async (q: string) => {
    if (q.length < 1) { setResults([]); setOpen(false); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}&exclude=${spaceId}`);
      const data = await res.json();
      setResults(data);
      setOpen(true);
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    const t = setTimeout(() => search(query), 250);
    return () => clearTimeout(t);
  }, [query, search]);

  function handleSelect(user: UserResult) {
    onSelect(user);
    setQuery("");
    setResults([]);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <div className="relative">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => query.length >= 1 && results.length > 0 && setOpen(true)}
          placeholder="Search by name or @username…"
          className="w-full bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-xl pl-8 pr-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--meridian-400)] transition-colors"
        />
        {loading && <Loader2 size={13} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] animate-spin" />}
      </div>
      {/* Results popup: deliberately rendered as opaque/"thick" glass rather
          than the --surface-muted token the search field itself uses —
          --surface-muted is only a ~5% tint (by design, so inputs read as a
          subtle recess in the panel behind them), which made this dropdown
          nearly see-through against the modal's own backdrop. A floating
          menu needs to read as solid above everything behind it, so this
          uses GlassPanel's "thick" depth (the same opaque recipe the modal
          sheets themselves use) plus a stronger hairline and elevated
          shadow, lifted to z-30 to clear any sibling content in this
          modal's stacking context. */}
      {open && results.length > 0 && (
        <GlassPanel
          depth="thick"
          elevation="e3"
          radius="md"
          className="absolute z-30 w-full mt-1.5 overflow-hidden"
          style={{ border: "1px solid var(--border-hairline-strong)" }}
        >
          {results.map((u) => (
            <button
              key={u.id}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); handleSelect(u); }}
              className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-[var(--surface-hover-strong)] transition-colors text-left"
            >
              <div className="w-7 h-7 rounded-full bg-[var(--surface-hover-strong)] flex items-center justify-center shrink-0">
                <span className="text-[10px] font-semibold text-[var(--text-primary)]">{userDisplayName(u)[0].toUpperCase()}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-[var(--text-primary)] truncate">{userDisplayName(u)}</p>
                {u.username && <p className="text-xs text-[var(--text-muted)]">@{u.username}</p>}
              </div>
            </button>
          ))}
        </GlassPanel>
      )}
      {open && !loading && query.length >= 1 && results.length === 0 && (
        <GlassPanel
          depth="thick"
          elevation="e3"
          radius="md"
          className="absolute z-30 w-full mt-1.5 px-3 py-3"
          style={{ border: "1px solid var(--border-hairline-strong)" }}
        >
          <p className="text-sm text-[var(--text-muted)]">No users found for &ldquo;{query}&rdquo;</p>
        </GlassPanel>
      )}
    </div>
  );
}
