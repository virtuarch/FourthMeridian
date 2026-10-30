"use client";

/**
 * components/platform/PlatformSpaceSwitcher.tsx  (Platform Operations 2.0 — R1)
 *
 * The MOBILE Space switcher, beside the Current Space's title in its header
 * (SpaceShell `titleAccessory`, shown below lg only — on desktop the rail's
 * nested list is the switcher). A native <details> dropdown: keyboard and
 * screen-reader operable with no script state, a ≥ 44 px trigger, and each
 * granted Space a plain link (opening one makes it the Current Space).
 *
 * The list is the Platform nav provider's GRANTED rows (server-loaded as the
 * tenant) — never a literal, never an ungranted area. With fewer than two
 * Spaces there is nothing to switch to, so nothing renders.
 */

import Link from "next/link";
import { Check, ChevronDown } from "lucide-react";
import { platformAreaHref } from "@/lib/platform/directory";
import type { PlatformSpaceOption } from "@/lib/platform/nav";

export function PlatformSpaceSwitcher({ spaces, currentArea }: { spaces: readonly PlatformSpaceOption[]; currentArea: string }) {
  if (spaces.length < 2) return null;
  return (
    <details className="group relative shrink-0">
      <summary
        aria-label="Switch Platform Space"
        className="grid size-11 cursor-pointer list-none place-items-center rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] [&::-webkit-details-marker]:hidden"
      >
        <ChevronDown size={16} aria-hidden className="transition-transform group-open:rotate-180" />
      </summary>
      <nav
        aria-label="Platform Spaces"
        className="absolute left-0 top-full z-30 mt-1 flex w-64 max-w-[calc(100vw-2rem)] flex-col gap-0.5 rounded-[var(--radius-md)] border border-[var(--border-hairline)] p-1"
        style={{ background: "var(--glass-regular)", backdropFilter: "blur(30px) saturate(160%)", WebkitBackdropFilter: "blur(30px) saturate(160%)", boxShadow: "var(--shadow-e2)" }}
      >
        {spaces.map((s) => {
          const on = s.area === currentArea;
          return (
            <Link
              key={s.id}
              href={platformAreaHref(s.area)}
              prefetch={false}
              aria-current={on ? "page" : undefined}
              className={[
                "flex min-h-11 items-center gap-2 rounded-[var(--radius-sm)] px-3 text-sm",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]",
                on ? "font-medium text-[var(--text-primary)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
              ].join(" ")}
            >
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              {on && <Check size={14} aria-hidden className="shrink-0 text-[var(--meridian-400)]" />}
            </Link>
          );
        })}
      </nav>
    </details>
  );
}
