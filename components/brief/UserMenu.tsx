"use client";

/**
 * UserMenu
 *
 * Avatar circle showing user initials.
 * Click opens a small dropdown with navigation shortcuts, plus the
 * Appearance and Region controls for the Daily Brief hero.
 *
 * Appearance/Region used to be standalone glass buttons floating in
 * BriefHero's top-right corner. They were moved in here (Daily Brief
 * responsive polish pass) because that corner is also where this very
 * menu lives in BriefLayout's header — the two were overlapping/competing
 * for the same sliver of space on both desktop and mobile. Folding them
 * into this already-open dropdown removes that contention entirely.
 *
 * Region state is shared via HeroRegionProvider (see that file) since
 * this menu and BriefHero are siblings under BriefLayout, not
 * parent/child — there's no props path between them. Appearance reads
 * straight from the app-wide ThemeProvider, which was already globally
 * available.
 */

import { useState, useRef, useEffect } from "react";
import { useSession, signOut } from "next-auth/react";
import Link from "next/link";
import {
  LayoutDashboard,
  Settings,
  Brain,
  LogOut,
  ChevronDown,
  MoonStar,
  Sun,
  MonitorSmartphone,
  Globe,
  Check,
} from "lucide-react";
import { useTheme, type ThemeMode } from "@/components/theme/ThemeProvider";
import { useHeroRegion } from "./HeroRegionProvider";
import { HERO_REGIONS, HERO_REGION_LABEL, type HeroRegion } from "@/lib/hero-region";

function getInitials(name?: string | null, email?: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (parts[0][0] ?? "?").toUpperCase();
  }
  if (email) return email[0].toUpperCase();
  return "?";
}

const MENU_ITEMS = [
  { label: "Dashboard",       href: "/dashboard",          icon: LayoutDashboard },
  { label: "Analyze with AI", href: "/dashboard/analyze",  icon: Brain },
  { label: "Settings",        href: "/dashboard/settings", icon: Settings },
];

const APPEARANCE_OPTIONS: Array<{ id: ThemeMode; label: string; Icon: typeof MoonStar }> = [
  { id: "dark",   label: "Midnight Glass", Icon: MoonStar },
  { id: "light",  label: "Light Glass",    Icon: Sun },
  { id: "system", label: "System",         Icon: MonitorSmartphone },
];

type RegionChoice = HeroRegion | "auto";

const REGION_OPTIONS: Array<{ id: RegionChoice; label: string }> = [
  { id: "auto", label: "Auto" },
  ...HERO_REGIONS.map(r => ({ id: r as RegionChoice, label: HERO_REGION_LABEL[r] })),
];

/**
 * Shared row recipe for the Appearance/Region radio options — same shape
 * as nav items (icon + label, left-aligned) but with role/aria wired for
 * a mutually-exclusive choice and a trailing Check on the active one.
 * Kept local to this file since MENU_ITEMS' Link rows have a different
 * element type (`Link`, not `button`) and don't need aria-checked.
 */
function MenuRadioRow({
  label,
  isActive,
  onSelect,
  Icon,
}: {
  label: string;
  isActive: boolean;
  onSelect: () => void;
  Icon?: typeof MoonStar;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={isActive}
      onClick={onSelect}
      className={[
        "w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-sm)] text-sm text-left transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]",
        isActive
          ? "text-[var(--meridian-400)]"
          : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]",
      ].join(" ")}
    >
      {Icon ? (
        <Icon className="w-4 h-4 shrink-0" />
      ) : (
        <span className="w-4 h-4 shrink-0" aria-hidden="true" />
      )}
      <span className="flex-1">{label}</span>
      {isActive && <Check className="w-3.5 h-3.5 shrink-0" />}
    </button>
  );
}

/** Small uppercase section label — "Appearance" / "Region". */
function MenuSectionLabel({ children }: { children: string }) {
  return (
    <div className="px-3 pt-3 pb-1 text-[10px] font-semibold tracking-[0.14em] uppercase text-[var(--text-muted)]">
      {children}
    </div>
  );
}

export function UserMenu() {
  const { data: session } = useSession();
  const [open, setOpen]   = useState(false);
  const ref               = useRef<HTMLDivElement>(null);

  const { mode, setMode } = useTheme();
  const { overrideRegion, setOverrideRegion } = useHeroRegion();

  const name     = session?.user?.name;
  const email    = session?.user?.email;
  const initials = getInitials(name, email);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 group"
        aria-label="User menu"
      >
        {/* Avatar circle */}
        <div
          className="w-9 h-9 rounded-full backdrop-blur-sm flex items-center justify-center text-xs font-bold text-[var(--ink-0)] ring-2 ring-transparent group-hover:ring-white/10 transition-all"
          style={{
            background: "linear-gradient(135deg, rgba(88,150,251,0.4), rgba(29,78,216,0.4))",
            border: "1px solid var(--border-hairline-strong)",
          }}
        >
          {initials}
        </div>
        <ChevronDown
          className={`w-3.5 h-3.5 text-[var(--text-muted)] transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/* Dropdown */}
      {open && (
        <div
          role="menu"
          aria-label="User menu"
          className="absolute right-0 top-full mt-2 w-64 max-h-[calc(100vh-6rem)] overflow-y-auto overflow-x-hidden z-50"
          style={{
            borderRadius: "var(--radius-md)",
            background: "var(--glass-thick)",
            border: "1px solid var(--border-hairline-strong)",
            backdropFilter: "blur(28px) saturate(140%)",
            WebkitBackdropFilter: "blur(28px) saturate(140%)",
            boxShadow: "var(--shadow-e3)",
          }}
        >
          {/* User info */}
          {(name || email) && (
            <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border-hairline)" }}>
              {name && <p className="text-sm font-medium text-[var(--text-primary)] truncate">{name}</p>}
              {email && <p className="text-xs text-[var(--text-muted)] truncate mt-0.5">{email}</p>}
            </div>
          )}

          {/* Nav items */}
          <div className="p-1">
            {MENU_ITEMS.map(item => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-sm)] text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors"
              >
                <item.icon className="w-4 h-4 text-[var(--text-muted)]" />
                {item.label}
              </Link>
            ))}
          </div>

          {/* Appearance — Midnight Glass / Light Glass / System */}
          <div className="p-1" style={{ borderTop: "1px solid var(--border-hairline)" }}>
            <MenuSectionLabel>Appearance</MenuSectionLabel>
            {APPEARANCE_OPTIONS.map(opt => (
              <MenuRadioRow
                key={opt.id}
                label={opt.label}
                Icon={opt.Icon}
                isActive={mode === opt.id}
                onSelect={() => setMode(opt.id)}
              />
            ))}
          </div>

          {/* Region — overrides the auto-detected hero backdrop for the session */}
          <div className="p-1" style={{ borderTop: "1px solid var(--border-hairline)" }}>
            <MenuSectionLabel>Region</MenuSectionLabel>
            {REGION_OPTIONS.map(opt => {
              const isActive =
                opt.id === "auto" ? overrideRegion === null : overrideRegion === opt.id;
              return (
                <MenuRadioRow
                  key={opt.id}
                  label={opt.label}
                  Icon={opt.id === "auto" ? Globe : undefined}
                  isActive={isActive}
                  onSelect={() => setOverrideRegion(opt.id === "auto" ? null : opt.id)}
                />
              );
            })}
          </div>

          {/* Sign out */}
          <div className="p-1" style={{ borderTop: "1px solid var(--border-hairline)" }}>
            <button
              onClick={async () => { await signOut({ redirect: false }); window.location.href = "/login"; }}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-sm)] text-sm text-[var(--text-muted)] hover:text-[var(--coral-300)] hover:bg-[var(--coral-500)]/[0.06] transition-colors"
            >
              <LogOut className="w-4 h-4" />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
