"use client";

/**
 * components/connections/ConnectionsActions.tsx
 *
 * D2.x — page-level provider action cluster for the Connections hub, the single
 * entry point for all financial sources.
 *
 * PB-2 (owner addendum 2026-11-01) — two actions instead of three side-by-side
 * buttons, so the header never grows a toolbar:
 *   - "+ Connect"          → a small menu of the provider flows:
 *        Bank or brokerage → Plaid Link (usePlaid().openLink)
 *        Crypto wallet     → the existing AddWalletModal (address or xpub)
 *     Anchored popover on sm+; a bottom sheet on mobile (same element, one set
 *     of items — no second copy of the flows).
 *   - "+ Add Manual Asset" → the existing AddManualAssetModal (RWA-1: a home,
 *     vehicle or valuable the user values themselves — a first-class asset, not
 *     a provider connection).
 *
 * Every workflow is the one that existed before; only the entry point moved.
 * Personal button language (GlassButton), no Liquid WebGL CTA. "+ Connect" stays
 * the first button in [data-connections-actions], so ConnectionsList's "Add
 * another connection" focuses it.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Building2, ChevronDown, Loader2, Plus, Wallet } from "lucide-react";
import { usePlaid } from "@/context/PlaidContext";
import { GlassButton } from "@/components/atlas/GlassButton";
import { AddWalletModal } from "@/components/dashboard/AddWalletModal";
import { AddManualAssetModal } from "@/components/dashboard/AddManualAssetModal";

interface Props {
  /** Center the cluster (used by the empty state). Default false. */
  centered?: boolean;
  /** PO-5A — whether Plaid bank connections are available (server env.isPlaidEnabled).
   *  When false, the bank item stays visible but disabled with an honest
   *  "being set up" note, so the user never hits a silent dead end. Default true
   *  (backward compatible). Self-custody wallets are unaffected. */
  plaidEnabled?: boolean;
}

export function ConnectionsActions({ centered = false, plaidEnabled = true }: Props) {
  const router = useRouter();
  const { openLink, isLoading, error } = usePlaid();
  const [menuOpen, setMenuOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [assetOpen, setAssetOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // Below sm the menu is a bottom sheet, portalled to <body> so no ancestor's
  // backdrop-filter / transform can become its containing block.
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639.98px)");
    const sync = () => setSheet(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Outside click / Escape close the menu; Escape returns focus to the trigger.
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !menu.current?.contains(t)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    // Focus the first enabled item so the menu is keyboard-reachable at once.
    menu.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not([disabled])")?.focus();
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  /** Arrow keys move between the menu's enabled items. Tab / Shift+Tab close it and let
   *  focus continue NATURALLY to the next / previous element — no trap, no refocus
   *  (returning focus to the trigger is Escape's job). */
  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Tab") { setMenuOpen(false); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not([disabled])") ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const connectBank = () => {
    setMenuOpen(false);
    openLink();
  };
  const connectWallet = () => {
    setMenuOpen(false);
    setWalletOpen(true);
  };

  const itemClass =
    "flex w-full items-start gap-3 rounded-[var(--radius-sm)] px-3 py-2.5 text-left transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:bg-[var(--glass-ultrathin)] focus-visible:bg-[var(--glass-ultrathin)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent";

  const menuPanel = (
    <div
      ref={menu}
      role="menu"
      aria-label="Connect"
      onKeyDown={onMenuKey}
      onBlur={(e) => {
        // Focus moving to another focusable outside the trigger root and the menu closes it.
        // A null relatedTarget is deliberately NOT a close: Safari does not focus buttons on
        // click, so tapping a menu item blurs to null BEFORE its click lands — closing here
        // would swallow the selection. Click-away is the document mousedown handler's job.
        const to = e.relatedTarget as Node | null;
        if (to && !root.current?.contains(to) && !menu.current?.contains(to)) setMenuOpen(false);
      }}
      data-connect-menu
      className={[
        "z-50 p-1.5 shadow-[var(--shadow-e3)]",
        // Mobile: a bottom sheet across the viewport.
        "fixed inset-x-0 bottom-0 rounded-t-[var(--radius-lg,16px)] pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        // sm+: an anchored popover under the trigger.
        "sm:absolute sm:inset-x-auto sm:bottom-auto sm:top-full sm:mt-1.5 sm:w-72 sm:rounded-[var(--radius-md)] sm:pb-1.5",
        centered ? "sm:left-1/2 sm:-translate-x-1/2" : "sm:right-0",
      ].join(" ")}
      style={{
        background: "var(--glass-thick)",
        border: "1px solid var(--border-hairline-strong)",
        backdropFilter: "blur(48px) saturate(150%)",
        WebkitBackdropFilter: "blur(48px) saturate(150%)",
      }}
    >
      <p className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)] sm:hidden">Connect</p>
      <button role="menuitem" type="button" className={itemClass} onClick={connectBank} disabled={!plaidEnabled} data-connect-bank>
        <Building2 size={18} className="mt-0.5 shrink-0 text-[var(--text-secondary)]" />
        <span className="flex flex-col">
          <span className="text-sm font-medium text-[var(--text-primary)]">Bank or brokerage</span>
          <span className="text-xs text-[var(--text-muted)]">
            {/* PO-5A — honest notice when Plaid is unavailable, never a silent dead end. */}
            {plaidEnabled ? "Securely link an institution with Plaid" : "Bank connections are being set up — check back soon."}
          </span>
        </span>
      </button>
      <button role="menuitem" type="button" className={itemClass} onClick={connectWallet} data-connect-wallet>
        <Wallet size={18} className="mt-0.5 shrink-0 text-[var(--text-secondary)]" />
        <span className="flex flex-col">
          <span className="text-sm font-medium text-[var(--text-primary)]">Crypto wallet</span>
          <span className="text-xs text-[var(--text-muted)]">Add a self-custody address or xpub</span>
        </span>
      </button>
    </div>
  );

  return (
    <div data-connections-actions className={centered ? "flex flex-col items-stretch gap-2.5 sm:flex-row sm:justify-center" : "flex flex-col items-stretch gap-2.5 sm:flex-row sm:justify-end"}>
      <div className="flex flex-col gap-2.5 sm:flex-row">
        <div ref={root} className="relative">
          <GlassButton
            ref={trigger}
            tone="meridian"
            fullWidth
            className="sm:w-auto"
            onClick={() => setMenuOpen((v) => !v)}
            disabled={isLoading}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-connect-trigger
          >
            {isLoading ? <Loader2 size={16} className="animate-spin shrink-0" /> : <Plus size={16} className="shrink-0" />}
            <span className="whitespace-nowrap">{isLoading ? "Opening…" : "Connect"}</span>
            <ChevronDown size={14} className={["shrink-0 opacity-70 transition-transform duration-[var(--dur-fast)]", menuOpen ? "rotate-180" : ""].join(" ")} />
          </GlassButton>

          {menuOpen && !sheet && menuPanel}
        </div>

        <GlassButton tone="neutral" fullWidth className="sm:w-auto" onClick={() => setAssetOpen(true)} data-add-manual-asset>
          <Plus size={16} className="shrink-0" />
          <span className="whitespace-nowrap">Add Manual Asset</span>
        </GlassButton>
      </div>

      {menuOpen && sheet && createPortal(
        <>
          {/* Mobile: a dimmed backdrop under the bottom sheet; a tap closes it. */}
          <div aria-hidden className="fixed inset-0 z-40 bg-black/40" onClick={() => setMenuOpen(false)} />
          {menuPanel}
        </>,
        document.body,
      )}

      {error && (
        <p className="text-xs text-[var(--coral-400)] sm:self-center">{error}</p>
      )}

      {assetOpen && (
        <AddManualAssetModal
          onClose={() => setAssetOpen(false)}
          onAdd={() => router.refresh()}
        />
      )}

      {walletOpen && (
        <AddWalletModal
          onClose={() => setWalletOpen(false)}
          onAdd={() => router.refresh()}
        />
      )}
    </div>
  );
}
