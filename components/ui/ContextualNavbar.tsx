"use client";

/**
 * components/ui/ContextualNavbar.tsx
 *
 * The one desktop sidebar (prototype DS-4 §6 — components/shell/Sidebar.tsx).
 * It TRANSFORMS rather than appears:
 *
 *   global   — on the launcher and every non-Space route: the top-level app
 *              destinations (Spaces · Brief · AI · Connections · Settings), plus
 *              any platform-HQ destinations the user is granted.
 *   space    — inside a Space (published through SpaceChrome by SpaceDashboard):
 *              back-to-Spaces, the Space's identity, its display-currency + Manage
 *              controls, and the section anchors for the active workspace.
 *
 * Both modes share DOM position and the left-accent-bar selection idiom, so
 * moving between them reads as the sidebar re-resolving, not one panel replacing
 * another. This REPLACES the former components/ui/Sidebar.tsx, whose persistent
 * global tree, inline Spaces list, footer Refresh/Sign-out and brand row are all
 * retired — brand → GlobalHeader, Refresh/identity/Sign-out → GlobalActions,
 * the in-Space identity/FX/Manage/sections → Space mode here.
 *
 * Navigation is route-based (production uses real routes, not the prototype's
 * single-page state), so the mobile presentation of this SAME model is
 * BottomNav — the two are one navigation model, two responsive presentations.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  Layers,
  Newspaper,
  Sparkles,
  Link2,
  Settings as SettingsIcon,
  Shield,
  ArrowLeft,
  LayoutGrid,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { useSpaceChrome, type SpaceChromeSpace } from "@/lib/space/space-chrome-context";
import { SpaceControls } from "@/components/space/shell/SpaceControls";
import {
  GLOBAL_NAV,
  isGlobalDestActive,
  type GlobalDestId,
} from "@/lib/space-nav";
import {
  SPACE_LIST_CHANGED_EVENT,
  SPACE_INVITES_CHANGED_EVENT,
} from "@/lib/space-nav";

const NAV_ICONS: Record<GlobalDestId, LucideIcon> = {
  spaces: Layers,
  brief: Newspaper,
  ai: Sparkles,
  connections: Link2,
  settings: SettingsIcon,
};

type PlatformItem = { id: string; name: string; platformArea: string };

export function ContextualNavbar() {
  const { space, currencyControl } = useSpaceChrome();

  return (
    <aside className="hidden w-[212px] shrink-0 lg:block">
      <div className="sticky top-12 flex max-h-[calc(100dvh-3rem)] flex-col gap-5 overflow-y-auto py-6 pr-5">
        {space ? (
          <SpaceMode space={space} currencyControl={currencyControl} />
        ) : (
          <GlobalMode />
        )}
      </div>
    </aside>
  );
}

// ── global mode ──────────────────────────────────────────────────────────────

function GlobalMode() {
  const pathname = usePathname();
  const [platform, setPlatform] = useState<PlatformItem[]>([]);
  const [pendingInvites, setPendingInvites] = useState(0);

  // Lightweight: the sidebar no longer inlines the Spaces list (the prototype's
  // flat nav model — switching happens on the Spaces launcher). It still needs
  // two things from the network: the pending-invite badge on Spaces, and the
  // access-derived platform destinations. Both are no-ops for users without them.
  // State is set only from the fetch callbacks (external-subscription shape), so a
  // route change / re-fire never races a slow response into a stale setState.
  const load = useCallback((signal: () => boolean) => {
    fetch("/api/spaces")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (signal() || !data) return;
        setPlatform(
          (data.platform ?? []).map((p: PlatformItem) => ({
            id: p.id,
            name: p.name,
            platformArea: p.platformArea,
          })),
        );
      })
      .catch(() => {
        /* non-fatal */
      });
    fetch("/api/spaces/invites/pending")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (signal() || !data) return;
        setPendingInvites(data.count ?? 0);
      })
      .catch(() => {
        /* non-fatal */
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    const handle = () => load(() => false);
    window.addEventListener(SPACE_LIST_CHANGED_EVENT, handle);
    window.addEventListener(SPACE_INVITES_CHANGED_EVENT, handle);
    return () => {
      window.removeEventListener(SPACE_LIST_CHANGED_EVENT, handle);
      window.removeEventListener(SPACE_INVITES_CHANGED_EVENT, handle);
    };
  }, [load]);

  return (
    <>
      <p className="px-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        Fourth Meridian
      </p>
      <nav aria-label="Global" className="flex flex-col gap-0.5">
        {GLOBAL_NAV.map((d) => {
          const Icon = NAV_ICONS[d.id];
          const on = isGlobalDestActive(d.id, pathname);
          const live = d.live;
          return (
            <Link
              key={d.id}
              href={d.href}
              aria-current={on ? "true" : undefined}
              aria-disabled={!live}
              tabIndex={live ? undefined : -1}
              onClick={(e) => {
                if (!live) e.preventDefault();
              }}
              className={[
                "group relative flex items-center gap-2.5 rounded-[var(--radius-sm)] py-1.5 pl-3 pr-2 text-left text-[13px]",
                "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                !live
                  ? "cursor-default text-[var(--text-muted)]"
                  : on
                    ? "text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
              ].join(" ")}
            >
              <span
                aria-hidden
                className={[
                  "absolute inset-y-1 left-0 w-0.5 rounded-full bg-[var(--meridian-400)]",
                  "transition-opacity duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                  on && live ? "opacity-100" : "opacity-0",
                ].join(" ")}
              />
              <Icon size={14} strokeWidth={1.75} className="shrink-0" />
              <span className="flex-1">{d.label}</span>
              {d.id === "spaces" && pendingInvites > 0 && (
                <span
                  className="flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-bold text-white"
                  style={{ background: "var(--coral-500)" }}
                >
                  {pendingInvites > 9 ? "9+" : pendingInvites}
                </span>
              )}
              {!live && <span className="text-[10px] text-[var(--text-muted)]">soon</span>}
            </Link>
          );
        })}
      </nav>

      {platform.length > 0 && (
        <div>
          <p className="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            Platform
          </p>
          <nav aria-label="Platform" className="flex flex-col gap-0.5">
            {platform.map((p) => {
              const href = `/dashboard/platform/${p.platformArea}`;
              const on = pathname === href;
              return (
                <Link
                  key={p.id}
                  href={href}
                  aria-current={on ? "true" : undefined}
                  className={[
                    "group relative flex items-center gap-2.5 rounded-[var(--radius-sm)] py-1.5 pl-3 pr-2 text-left text-[13px]",
                    "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                    on
                      ? "text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                  ].join(" ")}
                >
                  <span
                    aria-hidden
                    className={[
                      "absolute inset-y-1 left-0 w-0.5 rounded-full bg-[var(--meridian-400)]",
                      "transition-opacity duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                      on ? "opacity-100" : "opacity-0",
                    ].join(" ")}
                  />
                  <Shield size={14} strokeWidth={1.75} className="shrink-0" />
                  <span className="flex-1 truncate">{p.name}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      )}
    </>
  );
}

// ── space mode ───────────────────────────────────────────────────────────────

function SpaceMode({
  space,
  currencyControl,
}: {
  space: SpaceChromeSpace;
  currencyControl: React.ReactNode;
}) {
  const { identity, sections, activeSection, onSelectSection, onManage, onLeave, onLeaveSpace } = space;

  return (
    <>
      <div>
        <button
          onClick={onLeave}
          className="-ml-1 mb-2.5 flex items-center gap-1.5 rounded-[var(--radius-sm)] px-1 py-0.5 text-[11px] font-medium text-[var(--text-muted)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:text-[var(--text-secondary)]"
        >
          <ArrowLeft size={11} strokeWidth={2} />
          All Spaces
        </button>

        <div className="flex items-center gap-2">
          <h1 className="truncate text-[15px] font-semibold text-[var(--text-primary)]">
            {identity.name}
          </h1>
          {identity.shared && (
            <span
              className="rounded-full px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]"
              style={{ background: "var(--surface-hover)", border: "1px solid var(--border-hairline)" }}
            >
              Shared
            </span>
          )}
        </div>
        <p className="mt-1 text-[11px] text-[var(--text-muted)]">{identity.subtitle}</p>
        {identity.updatedLabel && (
          <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{identity.updatedLabel}</p>
        )}

        {/* SpaceControls — the canonical FX + Manage cluster. At this (wide)
            width it lives here in the Space sidebar, exactly like the prototype.
            Narrow widths get the SAME cluster relocated near the rail (see
            SpaceShell). One state source: the FX node is owned above, Manage is
            the host's handler; this is purely the wide mount point. */}
        <div className="mt-3">
          <SpaceControls currencyControl={currencyControl} onManage={onManage} />
        </div>
      </div>

      {sections.length > 0 && (
        <div>
          <p className="mb-1.5 flex items-center gap-1.5 px-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            <LayoutGrid size={10} strokeWidth={2} />
            Sections
          </p>
          <nav aria-label="Sections" className="flex flex-col gap-0.5">
            {sections.map((s) => {
              const on = s.label === activeSection;
              const live = s.anchor != null;
              return (
                <button
                  key={s.label}
                  disabled={!live}
                  onClick={() => {
                    if (!s.anchor) return;
                    onSelectSection(s.label);
                    document
                      .getElementById(s.anchor)
                      ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                  aria-current={on ? "true" : undefined}
                  className={[
                    "group relative rounded-[var(--radius-sm)] py-1.5 pl-3 pr-2 text-left text-[13px]",
                    "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                    !live
                      ? "cursor-default text-[var(--text-muted)]"
                      : on
                        ? "text-[var(--text-primary)]"
                        : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                  ].join(" ")}
                >
                  <span
                    aria-hidden
                    className={[
                      "absolute inset-y-1 left-0 w-0.5 rounded-full bg-[var(--meridian-400)]",
                      "transition-opacity duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                      on && live ? "opacity-100" : "opacity-0",
                      live && !on ? "group-hover:opacity-40" : "",
                    ].join(" ")}
                  />
                  {s.label}
                  {!live && <span className="ml-1.5 text-[10px] text-[var(--text-muted)]">· soon</span>}
                </button>
              );
            })}
          </nav>
        </div>
      )}

      {onLeaveSpace && (
        <button
          onClick={onLeaveSpace}
          className="mt-auto flex items-center gap-2.5 rounded-[var(--radius-sm)] px-3 py-1.5 text-left text-[13px] text-[var(--text-muted)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:text-[var(--accent-negative)]"
        >
          <LogOut size={13} strokeWidth={1.75} className="shrink-0" />
          Leave Space
        </button>
      )}
    </>
  );
}
