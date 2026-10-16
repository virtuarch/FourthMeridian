"use client";

import { useRef, useState, type CSSProperties, type PointerEvent } from "react";

export const SHEET_SNAPS = [45, 70, 92] as const;
export function nearestSheetSnap(height: number): number {
  return SHEET_SNAPS.reduce<number>((best, snap) => Math.abs(snap - height) < Math.abs(best - height) ? snap : best, 92);
}

/** Handle-only gestures leave scrolling, selection and form controls untouched.
 * Resizing never dismisses a surface or discards its contents. */
export function useSheetResize() {
  const [height, setHeight] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const moved = useRef(false);
  const start = useRef<{ y: number; height: number; viewport: number } | null>(null);
  const style = height === null ? undefined : { "--sheet-height": `calc(var(--visible-height, 100dvh) * ${height / 100})` } as CSSProperties;
  return {
    style,
    dragging,
    handle: {
      height,
      onPointerDown(e: PointerEvent<HTMLButtonElement>) {
        if (e.button !== 0) return;
        moved.current = false;
        const frame = e.currentTarget.closest('[role="dialog"], [role="alertdialog"]');
        const viewport = window.visualViewport?.height ?? window.innerHeight;
        start.current = { y: e.clientY, height: height ?? ((frame?.getBoundingClientRect().height ?? viewport * .7) / viewport * 100), viewport };
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      },
      onPointerMove(e: PointerEvent<HTMLButtonElement>) {
        if (!start.current) return;
        if (Math.abs(start.current.y - e.clientY) > 4) moved.current = true;
        setHeight(Math.max(35, Math.min(96, start.current.height + (start.current.y - e.clientY) / start.current.viewport * 100)));
      },
      onPointerUp(e: PointerEvent<HTMLButtonElement>) {
        if (!start.current) return;
        const next = start.current.height + (start.current.y - e.clientY) / start.current.viewport * 100;
        if (moved.current) setHeight(nearestSheetSnap(next));
        start.current = null;
        setDragging(false);
      },
      onPointerCancel() { start.current = null; setDragging(false); },
      onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
        const current = height ?? 70;
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        setHeight(e.key === "Home" ? 45 : e.key === "End" ? 92 : e.key === "ArrowUp" ? SHEET_SNAPS.find(s => s > current) ?? 92 : [...SHEET_SNAPS].reverse().find(s => s < current) ?? 45);
      },
      onClick() { if (!moved.current) setHeight((height ?? 70) >= 92 ? 45 : (height ?? 70) < 70 ? 70 : 92); },
    },
  };
}

export function SheetHandle({ height, ...events }: ReturnType<typeof useSheetResize>["handle"]) {
  return <button type="button" {...events} aria-label={`Resize panel${height ? `, ${Math.round(height)} percent height` : ""}. Use up and down arrows or drag.`} className="sheet-handle flex h-11 w-full shrink-0 touch-none items-center justify-center rounded-t-[var(--radius-xl)] focus-visible:outline-2 focus-visible:outline-[var(--meridian-400)] sm:hidden"><span aria-hidden="true" className="h-1 w-9 rounded-full bg-[var(--border-hairline-strong)]" /></button>;
}
