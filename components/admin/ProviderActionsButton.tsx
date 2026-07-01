"use client";

/**
 * components/admin/ProviderActionsButton.tsx
 *
 * Per-row ⋯ action menu in the Admin Providers table.
 * Owns both the dropdown menu state, the diagnostics drawer state,
 * and the Expand History flow state.
 * Receives only serializable props from the server component.
 *
 * Positioning: the dropdown uses fixed positioning calculated from the
 * trigger button's getBoundingClientRect(). This bypasses the table
 * wrapper's `overflow-hidden` (needed for rounded corners) that would
 * otherwise clip an absolutely-positioned child. Closes on outside click
 * or scroll, matching the AdminUserMenu pattern.
 *
 * Slice 2 — Expand History enabled for Chase / AmEx / Schwab:
 *   • Diagnostics       — enabled, opens the diagnostics drawer
 *   • Expand History    — enabled when expandHistoryEligible; Robinhood gets
 *                         a specific "Account matching not yet supported" tooltip;
 *                         other ineligible items get a generic disabled state.
 *   • Force Sync        — disabled (coming soon)
 *   • Disconnect        — disabled (coming soon)
 *
 * Eligibility is computed in the server component (page.tsx) and passed as a
 * boolean prop. The API endpoint re-validates server-side before touching Plaid.
 *
 * Robinhood detection uses ROBINHOOD_PLAID_INSTITUTION_ID from
 * lib/admin/provider-lifecycle.ts — the same constant used by the API.
 */

import { useEffect, useRef, useState } from "react";
import {
  MoreHorizontal,
  Activity,
  History,
  RefreshCw,
  Unplug,
} from "lucide-react";
import { ProviderDiagnosticsDrawer } from "./ProviderDiagnosticsDrawer";
import { AdminExpandHistoryFlow } from "./AdminExpandHistoryFlow";
import { ROBINHOOD_PLAID_INSTITUTION_ID } from "@/lib/admin/provider-lifecycle";

interface Props {
  plaidItemId:             string;
  institutionId:           string;
  institutionName:         string;
  /** True when status=ACTIVE and all linked accounts have a non-null mask.
   *  The API endpoint re-validates before touching Plaid — this is a UX hint. */
  expandHistoryEligible:   boolean;
}

// ── Shared class strings ──────────────────────────────────────────────────────

const ITEM_BASE   = "w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-left transition-colors";
const ITEM_ACTIVE = `${ITEM_BASE} text-gray-200 hover:bg-gray-800 hover:text-white`;
const ITEM_MUTED  = `${ITEM_BASE} text-gray-600 cursor-not-allowed`;

// ── Component ─────────────────────────────────────────────────────────────────

export function ProviderActionsButton({
  plaidItemId,
  institutionId,
  institutionName,
  expandHistoryEligible,
}: Props) {
  const triggerRef                                       = useRef<HTMLButtonElement>(null);
  const menuRef                                          = useRef<HTMLDivElement>(null);
  const [menuOpen,         setMenuOpen]                  = useState(false);
  const [menuPos,          setMenuPos]                   = useState<{ top: number; right: number } | null>(null);
  const [drawerOpen,       setDrawerOpen]                = useState(false);
  const [expandFlowOpen,   setExpandFlowOpen]            = useState(false);
  // Increment to trigger a page-level reload after expand history completes.
  // The server component doesn't re-render on client state, so we use a
  // lightweight window reload to show the updated table.
  const [, setRefreshKey] = useState(0);

  const isRobinhood = institutionId === ROBINHOOD_PLAID_INSTITUTION_ID;

  // ── Open menu — compute fixed position from trigger rect ─────────────────
  function handleToggle() {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setMenuPos({
        top:   rect.bottom + 6,
        right: window.innerWidth - rect.right,
      });
    }
    setMenuOpen(true);
  }

  // ── Close on outside click ────────────────────────────────────────────────
  useEffect(() => {
    if (!menuOpen) return;
    function handler(e: MouseEvent) {
      if (
        menuRef.current    && !menuRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  // ── Close on any scroll (menu position would drift) ──────────────────────
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [menuOpen]);

  // ── Diagnostics action ────────────────────────────────────────────────────
  function openDiagnostics() {
    setMenuOpen(false);
    setDrawerOpen(true);
  }

  // ── Expand History action ─────────────────────────────────────────────────
  function openExpandHistory() {
    setMenuOpen(false);
    setExpandFlowOpen(true);
  }

  function handleExpandDone() {
    // Trigger a soft reload so the table reflects the new PlaidItem.
    // Using window.location.reload() since this is a server-rendered table —
    // the simplest correct approach given that the parent is a server component.
    setRefreshKey((n) => n + 1);
    window.location.reload();
  }

  return (
    <>
      {/* ── Trigger button ── */}
      <button
        ref={triggerRef}
        onClick={handleToggle}
        aria-label="Provider actions"
        aria-expanded={menuOpen}
        className={`
          flex items-center justify-center w-7 h-7 rounded-lg transition-colors
          text-gray-500 hover:text-gray-200
          hover:bg-gray-700/60 border border-transparent
          hover:border-gray-700/60
          ${menuOpen ? "bg-gray-700/60 border-gray-700/60 text-gray-200" : ""}
        `}
      >
        <MoreHorizontal size={14} />
      </button>

      {/* ── Dropdown menu — fixed position, bypasses overflow-hidden ── */}
      {menuOpen && menuPos && (
        <div
          ref={menuRef}
          style={{ position: "fixed", top: menuPos.top, right: menuPos.right, zIndex: 200 }}
          className="w-52 bg-gray-900 border border-gray-700/80 rounded-xl shadow-2xl py-1 overflow-hidden"
        >
          {/* Diagnostics — primary action */}
          <button onClick={openDiagnostics} className={ITEM_ACTIVE}>
            <Activity size={13} className="shrink-0 text-gray-400" />
            Diagnostics
          </button>

          {/* Separator */}
          <div className="mx-2 my-1 border-t border-gray-800" />

          {/* Expand History — enabled for eligible items, specific tooltip for Robinhood */}
          {expandHistoryEligible ? (
            <button onClick={openExpandHistory} className={ITEM_ACTIVE}>
              <History size={13} className="shrink-0 text-gray-400" />
              <span className="flex-1">Expand History</span>
            </button>
          ) : (
            <button
              disabled
              title={
                isRobinhood
                  ? "Expand History is not yet available for Robinhood — account matching requires a non-null mask which Robinhood does not consistently provide."
                  : "Expand History is unavailable for this provider. Ensure the connection is active and all accounts have an account number mask."
              }
              className={ITEM_MUTED}
            >
              <History size={13} className="shrink-0" />
              <span className="flex-1">Expand History</span>
              {!isRobinhood && (
                <span className="text-[10px] text-gray-700 font-medium tracking-wide uppercase">
                  Soon
                </span>
              )}
            </button>
          )}

          {/* Force Sync — disabled */}
          <button
            disabled
            title="Coming soon."
            className={ITEM_MUTED}
          >
            <RefreshCw size={13} className="shrink-0" />
            <span className="flex-1">Force Sync</span>
            <span className="text-[10px] text-gray-700 font-medium tracking-wide uppercase">
              Soon
            </span>
          </button>

          {/* Disconnect — disabled */}
          <button
            disabled
            title="Coming soon."
            className={ITEM_MUTED}
          >
            <Unplug size={13} className="shrink-0" />
            <span className="flex-1">Disconnect</span>
            <span className="text-[10px] text-gray-700 font-medium tracking-wide uppercase">
              Soon
            </span>
          </button>
        </div>
      )}

      {/* ── Diagnostics drawer ── */}
      {drawerOpen && (
        <ProviderDiagnosticsDrawer
          plaidItemId={plaidItemId}
          institutionName={institutionName}
          onClose={() => setDrawerOpen(false)}
        />
      )}

      {/* ── Expand History flow ── */}
      {expandFlowOpen && (
        <AdminExpandHistoryFlow
          plaidItemId={plaidItemId}
          institutionName={institutionName}
          onClose={() => setExpandFlowOpen(false)}
          onDone={handleExpandDone}
        />
      )}
    </>
  );
}
