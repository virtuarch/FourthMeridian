"use client";

/**
 * components/platform/PlatformSpaceSwitcher.tsx  (Platform Operations 2.0 — R1; Spaces 2.0 interaction pass)
 *
 * The MOBILE Space switcher, beside the Current Space's title in its (sticky)
 * header (SpaceShell `titleAccessory`, shown below lg only — on desktop the
 * rail's nested list is the switcher). Each granted Space is a plain link
 * (opening one makes it the Current Space).
 *
 * POSITIONING (owner: "renders outside the visible page when opened at the
 * top-left"): the former <details> menu was anchored `right-0` to a chevron that
 * sits just after a LEFT-aligned title, so a 256 px menu opened leftwards off
 * the screen. The menu now PORTALS to <body> as a fixed layer measured from the
 * trigger's rect and CLAMPED to the viewport (8 px gutter): left-aligned to the
 * trigger, shifted left only as far as the right edge needs, flipped above the
 * trigger when there is no room below, height-capped with internal scroll. It
 * sits above the sticky header and the page (z-50), and below dialogs/drawers,
 * which render their own higher layers.
 *
 * Closing: Escape (focus returns to the trigger), a pointer-down outside, a
 * choice, or a resize. Scrolling repositions instead of closing, so a menu opened
 * from the sticky header follows it.
 *
 * The list is the Platform nav provider's GRANTED rows — never a literal, never
 * an ungranted area. With fewer than two Spaces there is nothing to switch to.
 */

import Link from "next/link";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { platformAreaHref } from "@/lib/platform/directory";
import type { PlatformSpaceOption } from "@/lib/platform/nav";

const GUTTER = 8;
const MENU_W = 256;

/** Pure: where the menu goes for a trigger rect in a viewport (exported for the test). */
export function placeMenu(
  trigger: { left: number; top: number; bottom: number },
  viewport: { width: number; height: number },
  menu: { width: number; height: number },
): { left: number; top: number; maxHeight: number } {
  const width = Math.min(menu.width, viewport.width - 2 * GUTTER);
  const left = Math.max(GUTTER, Math.min(trigger.left, viewport.width - GUTTER - width));
  const below = viewport.height - trigger.bottom - GUTTER - 4;
  const above = trigger.top - GUTTER - 4;
  const openUp = menu.height > below && above > below;
  const room = Math.max(120, openUp ? above : below);
  const height = Math.min(menu.height, room);
  return { left, top: openUp ? trigger.top - 4 - height : trigger.bottom + 4, maxHeight: room };
}

export function PlatformSpaceSwitcher({ spaces, currentArea }: { spaces: readonly PlatformSpaceOption[]; currentArea: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLElement>(null);
  const menuId = useId();

  const place = useCallback(() => {
    const t = trigger.current?.getBoundingClientRect();
    if (!t) return;
    const h = menu.current?.scrollHeight ?? spaces.length * 46 + 10;
    setPos(placeMenu(t, { width: window.innerWidth, height: window.innerHeight }, { width: MENU_W, height: h }));
  }, [spaces.length]);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);

  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(true); } };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !trigger.current?.contains(t)) close(false);
    };
    const onResize = () => close(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", place, true);
    // Focus the current Space's link (else the first) so the keyboard lands in the list.
    const first = menu.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? menu.current?.querySelector<HTMLElement>("a");
    first?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, close, place]);

  if (spaces.length < 2) return null;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label="Switch Platform Space"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]"
        data-space-switcher
      >
        <ChevronDown size={16} aria-hidden className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <nav
          id={menuId}
          ref={menu}
          aria-label="Platform Spaces"
          className="fixed z-50 flex flex-col gap-0.5 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-hairline)] p-1"
          style={{
            left: pos?.left ?? GUTTER, top: pos?.top ?? 0, width: `min(${MENU_W}px, calc(100vw - ${2 * GUTTER}px))`,
            maxHeight: pos?.maxHeight, visibility: pos ? "visible" : "hidden",
            background: "var(--glass-thick, var(--glass-regular))", backdropFilter: "blur(30px) saturate(160%)", WebkitBackdropFilter: "blur(30px) saturate(160%)", boxShadow: "var(--shadow-e3, var(--shadow-e2))",
          }}
          data-space-switcher-menu
        >
          {spaces.map((s) => {
            const on = s.area === currentArea;
            return (
              <Link
                key={s.id}
                href={platformAreaHref(s.area)}
                prefetch={false}
                aria-current={on ? "page" : undefined}
                onClick={() => close(false)}
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
        </nav>,
        document.body,
      )}
    </>
  );
}
