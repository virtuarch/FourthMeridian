"use client";

/**
 * components/space/manage/OverviewSectionsPanel.tsx  (MSM decomposition)
 *
 * The "Overview" tab of Manage Space, extracted verbatim from the former single-
 * file ManageSpaceModal (DashboardTab). Toggles dashboard-section visibility for
 * the whole Space against the canonical GET /api/spaces/[id]/sections + PATCH
 * .../sections/[sectionId] routes (server enforces section:edit = ADMIN).
 * Behavior-preserving. Consumes the canonical DashboardSection type instead of
 * re-declaring it — the modal's former local copy shadowed lib/space's shape.
 */

import { useState, useEffect, useCallback } from "react";
import { Loader2, LayoutDashboard, RotateCcw, Eye, EyeOff } from "lucide-react";
import type { DashboardSection } from "@/lib/space/dashboard-types";

const TAB_LABELS_SECTION: Record<string, string> = {
  OVERVIEW: "Overview", GOALS: "Goals", ACCOUNTS: "Accounts",
  DEBT: "Debt", INVESTMENTS: "Investments", RETIREMENT: "Retirement",
  ACTIVITY: "Activity", SETTINGS: "Settings",
};

export function OverviewSectionsPanel({
  spaceId,
}: {
  spaceId: string;
}) {
  const [sections,   setSections]   = useState<DashboardSection[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const loadSections = useCallback(async () => {
    const res = await fetch(`/api/spaces/${spaceId}/sections`);
    if (res.ok) setSections(await res.json());
    setLoading(false);
  }, [spaceId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadSections(); }, [loadSections]);

  async function toggle(s: DashboardSection) {
    setTogglingId(s.id);
    try {
      await fetch(`/api/spaces/${spaceId}/sections/${s.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ enabled: !s.enabled }),
      });
      loadSections();
    } finally {
      setTogglingId(null);
    }
  }

  if (loading) return <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-[var(--text-muted)]" /></div>;

  if (sections.length === 0) {
    return (
      <div className="text-center py-8">
        <LayoutDashboard size={28} className="text-[var(--text-muted)] mx-auto mb-2" />
        <p className="text-sm text-[var(--text-muted)]">No dashboard sections</p>
        <p className="text-xs text-[var(--text-muted)] mt-1">This Space was created without a template.</p>
      </div>
    );
  }

  const byTab = sections.reduce<Record<string, DashboardSection[]>>((acc, s) => {
    (acc[s.tab] ??= []).push(s);
    return acc;
  }, {});

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-[var(--text-muted)] flex-1">
          Toggle sections to show or hide them. Changes apply to all members.
        </p>
        <button
          type="button"
          onClick={() => { setLoading(true); loadSections(); }}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] border border-[var(--border-hairline)] transition-colors shrink-0"
        >
          <RotateCcw size={12} /> Refresh
        </button>
      </div>
      {Object.entries(byTab).map(([tab, items]) => (
        <div key={tab}>
          <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest mb-2">
            {TAB_LABELS_SECTION[tab] ?? tab}
          </p>
          <div className="space-y-1">
            {items.map((s) => (
              <div key={s.id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-[var(--surface-muted)]">
                <div className="flex-1 min-w-0">
                  <p className={`text-sm truncate ${s.enabled ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`}>{s.label}</p>
                </div>
                <button onClick={() => toggle(s)} disabled={togglingId === s.id}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                    s.enabled
                      ? "bg-[rgba(59,130,246,.20)] text-[var(--meridian-400)] hover:bg-[rgba(59,130,246,.30)]"
                      : "bg-[var(--surface-hover-strong)] text-[var(--text-muted)] hover:bg-[var(--surface-hover-strong)]"
                  }`}>
                  {togglingId === s.id
                    ? <Loader2 size={11} className="animate-spin" />
                    : s.enabled ? <><Eye size={11} /> Shown</> : <><EyeOff size={11} /> Hidden</>}
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Layout (Unified Space Widget Layout, slice 1) — this modal is for
          Space-level settings, NOT per-drag layout editing (that lives on the
          dashboard via Edit layout). No reset/default-layout control here until
          a real implementation exists. Saved layouts are a future slice and
          render as a disabled placeholder only — not built here. */}
      <div className="pt-4 border-t border-[var(--border-hairline)]">
        <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest mb-2">Layout</p>
        <p className="text-xs text-[var(--text-muted)] mb-2">
          To reorder sections, use <span className="text-[var(--text-primary)]">Edit layout</span> on the dashboard.
        </p>
        <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-[var(--surface-muted)]">
          <div className="min-w-0">
            <p className="text-sm text-[var(--text-primary)]">Saved layouts</p>
            <p className="text-xs text-[var(--text-muted)]">Save and switch between dashboard layouts. Coming soon.</p>
          </div>
          <span className="text-[10px] font-medium text-[var(--text-muted)] bg-[var(--surface-hover-strong)] px-2 py-1 rounded-full shrink-0">Soon</span>
        </div>
      </div>
    </div>
  );
}
