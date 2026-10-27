/**
 * components/platform/PlatformSpaceDirectory.tsx  (UX-P2 — navigation separation)
 *
 * The Platform Spaces DIRECTORY — the one home of the HQ cards, rendered by
 * app/(shell)/dashboard/platform/page.tsx. This is the "Fourth Meridian HQ" card
 * group that used to lead the Spaces launcher (SpacesClient `PlatformSpaceGroup`,
 * PO1.0 → UX-P1 D2), moved out entirely (UX-P2 decision N1) now that the
 * GlobalHeader's context switch is the door between the two axes.
 *
 * Same design language as the personal directory (SpacesHeader + Surface rows),
 * deliberately NOT the same component: there is no Create CTA (Platform Spaces
 * are provisioned by grant, never created), no active-Space accent (none is ever
 * "current" — they are not switch targets), no money.
 *
 * Each card is a plain LINK to the bare area URL (`/dashboard/platform/<AREA>`,
 * = its default workspace). No cookie write, no `/api/space/switch`, no stored
 * "last area", no auto-open — pinned by platform-directory.test.ts. The rows
 * arrive already authorized and ordered from lib/platform/directory.server.ts
 * (registry order); this file sorts nothing and decides nothing.
 *
 * Not a Client Component: there is no state here, and the page that renders it
 * is a Server Component, so the directory ships as HTML.
 */

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Surface } from "@/components/atlas/Surface";
import { displaySpaceName } from "@/lib/format";
import { platformAreaHref, type PlatformDirectoryRow } from "@/lib/platform/directory";
// Redesign §4.1 — each card carries its area's live pulse (a client island that
// reads ONE of that area's own routes under the viewer's grant; see the file).
import { PlatformAreaPulse } from "./PlatformAreaPulse";

export function PlatformSpaceDirectory({ spaces }: { spaces: readonly PlatformDirectoryRow[] }) {
  return (
    <div className="min-h-[70vh]">
      <div className="mx-auto max-w-[1400px] pb-16">
        {/* Header — the launcher's floating-title treatment (no hero panel),
            title + one line of framing, and NO call to action on the right. */}
        <div className="flex flex-col gap-5 pt-2 pb-8 md:pb-10">
          <div className="min-w-0">
            <h1 className="text-3xl font-semibold tracking-tight text-[var(--text-primary)] md:text-[2.5rem]">
              Platform Spaces
            </h1>
            <p className="mt-1.5 max-w-md text-sm text-[var(--text-secondary)]">
              The operator areas your grants reach. Provisioned by grant, never created here.
            </p>
          </div>
        </div>

        {spaces.length === 0 ? (
          // Reached only if a caller renders with no rows (the page redirects at
          // zero grants): an honest empty state, never an empty list.
          <p className="text-sm text-[var(--text-muted)]">No Platform Space is granted to this account.</p>
        ) : (
          <ul className="space-y-2.5">
            {spaces.map((p) => (
              <Surface
                as="li"
                key={p.id}
                className="group transition-colors duration-[var(--dur-base)] ease-[var(--ease-standard)] hover:border-[var(--border-hairline-strong)]"
              >
                <Link
                  href={platformAreaHref(p.area)}
                  prefetch={false}
                  aria-label={`Open ${displaySpaceName(p.name)}`}
                  className="flex w-full items-center gap-4 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--meridian-400)] sm:p-5"
                >
                  {/* HQ badge — operator identity, never a financial figure. */}
                  <span className="grid size-9 shrink-0 place-items-center rounded-full border border-[var(--border-hairline-strong)] text-[9px] font-semibold text-[var(--brass-300)]">
                    HQ
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="break-words font-semibold text-[var(--text-primary)]">{displaySpaceName(p.name)}</h2>
                    <p className="mt-1 break-words text-xs text-[var(--text-muted)]">Platform area · {p.access}</p>
                    <div className="mt-3">
                      <PlatformAreaPulse area={p.area} />
                    </div>
                  </div>
                  <ArrowUpRight
                    size={15}
                    aria-hidden
                    className="shrink-0 text-[var(--text-muted)] transition-[transform,color] duration-[var(--dur-base)] ease-[var(--ease-standard)] group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-[var(--text-secondary)]"
                  />
                </Link>
              </Surface>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
