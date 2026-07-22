"use client";

/**
 * components/ui/BottomNav.tsx
 *
 * The mobile presentation of the ONE navigation model (lib/space-nav GLOBAL_NAV)
 * — the same five destinations the desktop ContextualNavbar renders in global
 * mode: Spaces · Brief · AI · Connections · Settings. Desktop and mobile are two
 * responsive presentations of one model, not two separate legacy systems (the
 * former four-item Brief/Spaces/AI/Settings bar, which diverged from the model
 * and dropped Connections, is retired).
 *
 * Prototype behaviour (DS-5 §6): a phone has room for one nav level, so it shows
 * the top-level app destinations and lets in-Space navigation become the
 * Space-local rail. AI takes the centre slot, standalone, emphasised through a
 * filled accent disc at an IDENTICAL footprint to its neighbours — emphasis
 * through contrast, not size. It is the only filled thing on the bar.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Layers,
  Newspaper,
  Sparkles,
  Link2,
  Settings as SettingsIcon,
  type LucideIcon,
} from "lucide-react";
import { GLOBAL_NAV, isGlobalDestActive, type GlobalDestId } from "@/lib/space-nav";

const NAV_ICONS: Record<GlobalDestId, LucideIcon> = {
  spaces: Layers,
  brief: Newspaper,
  ai: Sparkles,
  connections: Link2,
  settings: SettingsIcon,
};

export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Sections"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border-hairline)] lg:hidden"
      style={{
        background: "var(--glass-regular)",
        backdropFilter: "blur(30px) saturate(160%)",
        WebkitBackdropFilter: "blur(30px) saturate(160%)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <div className="flex h-14 items-stretch">
        {GLOBAL_NAV.map((d) => {
          const Icon = NAV_ICONS[d.id];
          const on = isGlobalDestActive(d.id, pathname);
          const isAI = d.id === "ai";
          return (
            <Link
              key={d.id}
              href={d.href}
              aria-current={on ? "true" : undefined}
              aria-label={d.label}
              className="flex flex-1 flex-col items-center justify-center gap-1"
            >
              <span
                className={[
                  "grid size-7 place-items-center rounded-full",
                  "transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                  isAI
                    ? on
                      ? "bg-[var(--meridian-400)] text-[var(--ink-950)]"
                      : "bg-[rgba(88,150,251,.18)] text-[var(--meridian-400)]"
                    : on
                      ? "text-[var(--text-primary)]"
                      : "text-[var(--text-muted)]",
                ].join(" ")}
              >
                <Icon size={16} strokeWidth={on && !isAI ? 2.25 : 1.75} />
              </span>
              <span
                className={[
                  "text-[9px] leading-none transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                  on ? "text-[var(--text-secondary)]" : "text-[var(--text-muted)]",
                ].join(" ")}
              >
                {d.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
