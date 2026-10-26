"use client";

/**
 * components/space/manage/GeneralSettingsPanel.tsx  (MSM decomposition)
 *
 * The "General" tab of Manage Space, extracted verbatim from the former single-
 * file ManageSpaceModal (GeneralTab). Owns Space name / description / visibility
 * / category / reporting-currency editing and the PATCH /api/spaces/[id] save.
 * OWNER-only tab (gated by the shell).
 *
 * v2.7 P1:
 *   - NAME: the field edits the name customers SEE. Legacy rows still store
 *     "X's Dashboard" / "Chris's Space", which every customer surface renders
 *     through displaySpaceName() ("Chris' Space") — the field used to show the
 *     raw stored string, so General disagreed with the header. The field now
 *     starts from the displayed name, and `name` is sent ONLY when the customer
 *     changes it (an untouched legacy row is never silently rewritten). A rename
 *     broadcasts SPACE_LIST_CHANGED_EVENT (My Spaces, sidebar lists), reports
 *     the new name to the host (header + chrome, immediately) and refreshes the
 *     server tree. IDs, membership, routing and permissions are untouched.
 *   - VISIBILITY: no public publishing from here. `isPublic` is never sent; the
 *     public-Space schema, data and server authorization are unchanged. A Space
 *     that is ALREADY public says so and can be made private (narrowing only).
 *   - CATEGORY: a Personal Space's category is fixed — shown read-only as
 *     "Personal" and never sent. Other Space types keep the existing picker
 *     (server allowlist unchanged).
 */

import { useState } from "react";
import { displaySpaceName } from "@/lib/format";
import { useRouter } from "next/navigation";
import {
  Settings, Loader2, Check, Globe, ChevronRight, Save,
  Users, Landmark, LayoutDashboard, Target, AlertTriangle, Shield,
} from "lucide-react";
import { FX_BASE, SUPPORTED_QUOTES } from "@/lib/fx/config";
import {
  CATEGORY_LABELS, CATEGORY_ICONS,
  RECATEGORIZE_CATEGORIES,
  SpaceCategory,
} from "@/lib/space-presets";
import {
  SPACE_LIST_CHANGED_EVENT,
  SPACE_CURRENCY_CHANGED_EVENT,
} from "@/lib/space-nav";
import { GlassButton } from "@/components/atlas/GlassButton";
import type { SpaceDetail } from "./manage-shared";

const ICON_MAP: Record<string, React.ReactNode> = {
  User: <Users size={16} />, Home: <Landmark size={16} />, Users: <Users size={16} />,
  Briefcase: <Settings size={16} />, Building2: <LayoutDashboard size={16} />,
  Car: <Settings size={16} />, Plane: <Target size={16} />, TrendingUp: <Target size={16} />,
  Wrench: <Settings size={16} />, Sunset: <Target size={16} />, CreditCard: <AlertTriangle size={16} />,
  Shield: <Shield size={16} />, Target: <Target size={16} />,
  LayoutDashboard: <LayoutDashboard size={16} />, MoreHorizontal: <Settings size={16} />,
};

export function GeneralSettingsPanel({
  space,
  onSaved,
}: {
  space: SpaceDetail;
  onSaved: (updated: Partial<SpaceDetail>) => void;
}) {
  const shownName = displaySpaceName(space.name);
  const isPersonal = space.type === "PERSONAL";
  const [name,        setName]        = useState(shownName);
  const [description, setDescription] = useState(space.description ?? "");
  const [makePrivate, setMakePrivate] = useState(false);
  const [category,    setCategory]    = useState(space.category);
  // MC1 Phase 4 Slice 2 (plan D-2) — Space reporting-currency selector.
  const [reportingCurrency, setReportingCurrency] = useState(space.reportingCurrency ?? "USD");
  const settingsRouter = useRouter();
  const currencyChanged = reportingCurrency !== (space.reportingCurrency ?? "USD");
  const [busy,        setBusy]        = useState(false);
  const [error,       setError]       = useState("");
  const [saved,       setSaved]       = useState(false);
  const [showCatPicker, setShowCatPicker] = useState(false);

  // REVIEW-3 (slice F): the picker offers only the currently-supported,
  // re-categorizable set (FAMILY / CUSTOM / OTHER) — it used to offer all 13
  // primary+secondary categories against an unvalidated PATCH. The Space's
  // CURRENT category is shown even when legacy/unsupported (read-only truth);
  // the server rejects writing any category outside the allowlist.
  const allCategories = RECATEGORIZE_CATEGORIES;

  const nameChanged     = name.trim() !== shownName;
  const categoryChanged = !isPersonal && category !== space.category;

  async function handleSave() {
    if (!name.trim()) { setError("Name is required"); return; }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/spaces/${space.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          ...(nameChanged ? { name: name.trim() } : {}),
          description: description.trim() || null,
          ...(makePrivate ? { isPublic: false } : {}),
          ...(categoryChanged ? { category } : {}),
          // MC1 P4 Slice 2 — only sent when changed (audit stays quiet otherwise)
          ...(currencyChanged ? { reportingCurrency } : {}),
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to save");
      } else {
        onSaved({
          ...(nameChanged ? { name: name.trim() } : {}),
          description: description.trim() || null,
          ...(makePrivate ? { isPublic: false } : {}),
          ...(categoryChanged ? { category } : {}),
          reportingCurrency,
        });
        setMakePrivate(false);
        // MC1 P4 Slice 2 — a currency change re-denominates every aggregate
        // at read time; refresh the current view so converted totals and the
        // display-currency provider pick it up immediately.
        //
        // MC1 QA Q6 — router.refresh() re-runs the server tree (layout provider
        // + card props) but NOT a client host's own spaceId-keyed fetches;
        // broadcast so SpaceDashboard refetches its snapshots/perspectives/tx
        // for the changed Space. The PATCH has already persisted the new
        // currency, so an immediate refetch returns new-currency data — the
        // event and refresh are independent, so ordering between them is safe.
        // A rename re-runs the server tree too, so server-rendered consumers of
        // the name (page props, the Space chrome) agree without a reload.
        if (currencyChanged || nameChanged) settingsRouter.refresh();
        if (currencyChanged) {
          window.dispatchEvent(
            new CustomEvent(SPACE_CURRENCY_CHANGED_EVENT, {
              detail: { spaceId: space.id, currency: reportingCurrency },
            }),
          );
        }
        // Sidebar caches its Space list client-side and only refetches on this
        // event — without it, a rename here (e.g. fixing legacy "X's Dashboard"
        // grammar) would update the page but leave the sidebar showing the old
        // stale name until a full reload.
        window.dispatchEvent(new CustomEvent(SPACE_LIST_CHANGED_EVENT));
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch { setError("Network error"); }
    finally { setBusy(false); }
  }

  const isDirty =
    nameChanged ||
    (description.trim() || null) !== space.description ||
    makePrivate ||
    categoryChanged ||
    currencyChanged;

  return (
    <div className="space-y-5">
      {/* Name */}
      <div>
        <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1.5">Space name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-xl px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--meridian-400)] transition-colors"
        />
      </div>

      {/* Description */}
      <div>
        <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1.5">
          Description <span className="text-[var(--text-muted)]">(optional)</span>
        </label>
        <textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this Space for?"
          className="w-full bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-xl px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--meridian-400)] transition-colors resize-none"
        />
      </div>

      {/* Visibility — no customer-facing publishing (v2.7 P1). Only a Space that
          is ALREADY public says so, and may be narrowed to private. */}
      {space.isPublic && (
        <div className="px-3 py-2.5 rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-muted)]" data-public-notice>
          <p className="text-xs font-medium text-[var(--text-primary)] flex items-center gap-1.5">
            <Globe size={11} /> {makePrivate ? "Will be made private when you save" : "This Space is currently public"}
          </p>
          <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
            Public publishing is no longer offered. You can make this Space invite-only.
          </p>
          <button
            type="button"
            onClick={() => setMakePrivate((v) => !v)}
            className="mt-2 text-xs font-medium text-[var(--meridian-400)] hover:underline"
          >
            {makePrivate ? "Keep it public for now" : "Make private"}
          </button>
        </div>
      )}

      {/* Category */}
      <div>
        <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1.5">Category</label>
        {isPersonal ? (
          <div className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-muted)]" data-category-fixed>
            <span className="text-[var(--text-muted)]">{ICON_MAP[CATEGORY_ICONS[SpaceCategory.PERSONAL]] ?? <Settings size={16} />}</span>
            <span className="text-sm text-[var(--text-primary)] flex-1">{CATEGORY_LABELS[SpaceCategory.PERSONAL]}</span>
            <span className="text-[10px] text-[var(--text-muted)]">Fixed for your Personal Space</span>
          </div>
        ) : (<>
        <button
          type="button"
          onClick={() => setShowCatPicker((p) => !p)}
          className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)] bg-[var(--surface-muted)] text-left transition-colors"
        >
          <span className="text-[var(--text-muted)]">{ICON_MAP[CATEGORY_ICONS[category as SpaceCategory]] ?? <Settings size={16} />}</span>
          <span className="text-sm text-[var(--text-primary)] flex-1">{CATEGORY_LABELS[category as SpaceCategory] ?? category}</span>
          <ChevronRight size={13} className={`text-[var(--text-muted)] transition-transform ${showCatPicker ? "rotate-90" : ""}`} />
        </button>

        {showCatPicker && (
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {allCategories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => { setCategory(cat); setShowCatPicker(false); }}
                className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-left transition-colors ${
                  category === cat
                    ? "border-[rgba(125,168,255,.4)] bg-[rgba(59,130,246,.10)]"
                    : "border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)] bg-[var(--surface-muted)]"
                }`}
              >
                <span className="text-[var(--text-muted)] shrink-0">{ICON_MAP[CATEGORY_ICONS[cat]] ?? <Settings size={14} />}</span>
                <span className="text-xs text-[var(--text-primary)] truncate">{CATEGORY_LABELS[cat]}</span>
              </button>
            ))}
          </div>
        )}
        </>)}
      </div>

      {/* Reporting currency — MC1 Phase 4 Slice 2 (plan D-2) */}
      <div>
        <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1.5">Reporting currency</label>
        <select
          value={reportingCurrency}
          onChange={(e) => setReportingCurrency(e.target.value)}
          className="w-full bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-xl px-3 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--meridian-400)] transition-colors"
        >
          {[FX_BASE, ...SUPPORTED_QUOTES].map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <p className="text-[10px] text-[var(--text-muted)] mt-1.5">
          Totals, charts, and AI summaries for this Space are shown in this currency.
        </p>
        {currencyChanged && (
          <div className="mt-2 px-3 py-2.5 rounded-xl border border-[rgba(255,196,87,.35)] bg-[rgba(255,196,87,.08)]">
            <p className="text-xs text-[var(--text-primary)]">
              Totals, charts, and AI summaries will show {reportingCurrency} from now on.
              Past history keeps the currency it was recorded in — nothing is converted or rewritten.
            </p>
          </div>
        )}
      </div>

      {error && <p className="text-xs text-[var(--coral-400)]">{error}</p>}

      <GlassButton
        onClick={handleSave}
        disabled={busy || !isDirty}
        tone="meridian"
        fullWidth
      >
        {busy
          ? <Loader2 size={14} className="animate-spin" />
          : saved
            ? <Check size={14} />
            : <Save size={14} />}
        {saved ? "Saved!" : "Save changes"}
      </GlassButton>
    </div>
  );
}
