"use client";

/**
 * components/space/manage/GeneralSettingsPanel.tsx  (MSM decomposition)
 *
 * The "General" tab of Manage Space, extracted verbatim from the former single-
 * file ManageSpaceModal (GeneralTab). Owns Space name / description / visibility
 * / category / reporting-currency editing and the PATCH /api/spaces/[id] save.
 * OWNER-only tab (gated by the shell). Behavior-preserving: identical markup,
 * state, save handler, and the currency-change broadcast + router.refresh.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Settings, Loader2, Check, Globe, Lock, ChevronRight, Save,
  Users, Landmark, LayoutDashboard, Target, AlertTriangle, Shield,
} from "lucide-react";
import { FX_BASE, SUPPORTED_QUOTES } from "@/lib/fx/config";
import {
  CATEGORY_LABELS, CATEGORY_ICONS,
  PRIMARY_CATEGORIES, SECONDARY_CATEGORIES,
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
  const [name,        setName]        = useState(space.name);
  const [description, setDescription] = useState(space.description ?? "");
  const [isPublic,    setIsPublic]    = useState(space.isPublic);
  const [category,    setCategory]    = useState(space.category);
  // MC1 Phase 4 Slice 2 (plan D-2) — Space reporting-currency selector.
  const [reportingCurrency, setReportingCurrency] = useState(space.reportingCurrency ?? "USD");
  const settingsRouter = useRouter();
  const currencyChanged = reportingCurrency !== (space.reportingCurrency ?? "USD");
  const [busy,        setBusy]        = useState(false);
  const [error,       setError]       = useState("");
  const [saved,       setSaved]       = useState(false);
  const [showCatPicker, setShowCatPicker] = useState(false);

  const allCategories = [...PRIMARY_CATEGORIES, ...SECONDARY_CATEGORIES];

  async function handleSave() {
    if (!name.trim()) { setError("Name is required"); return; }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/spaces/${space.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          name:        name.trim(),
          description: description.trim() || null,
          isPublic,
          category,
          // MC1 P4 Slice 2 — only sent when changed (audit stays quiet otherwise)
          ...(currencyChanged ? { reportingCurrency } : {}),
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to save");
      } else {
        onSaved({ name: name.trim(), description: description.trim() || null, isPublic, category, reportingCurrency });
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
        if (currencyChanged) {
          window.dispatchEvent(
            new CustomEvent(SPACE_CURRENCY_CHANGED_EVENT, {
              detail: { spaceId: space.id, currency: reportingCurrency },
            }),
          );
          settingsRouter.refresh();
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
    name.trim()       !== space.name ||
    (description.trim() || null) !== space.description ||
    isPublic          !== space.isPublic ||
    category          !== space.category ||
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

      {/* Visibility */}
      <div>
        <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1.5">Visibility</label>
        <div className="grid grid-cols-2 gap-2">
          {([false, true] as const).map((pub) => (
            <button
              key={String(pub)}
              type="button"
              onClick={() => setIsPublic(pub)}
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-left transition-colors ${
                isPublic === pub
                  ? "border-[rgba(125,168,255,.4)] bg-[rgba(59,130,246,.10)]"
                  : "border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)]"
              }`}
            >
              <div className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 transition-colors ${
                isPublic === pub ? "border-[var(--meridian-400)] bg-[var(--meridian-400)]" : "border-[var(--border-hairline-strong)]"
              }`} />
              <div>
                <p className="text-xs font-medium text-[var(--text-primary)] flex items-center gap-1.5">
                  {pub ? <Globe size={11} /> : <Lock size={11} />}
                  {pub ? "Public" : "Private"}
                </p>
                <p className="text-[10px] text-[var(--text-muted)]">
                  {pub ? "Anyone can view" : "Invite only"}
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Category */}
      <div>
        <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1.5">Category</label>
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
