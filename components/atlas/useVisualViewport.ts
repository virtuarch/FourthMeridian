"use client";
import { useEffect, useState, type CSSProperties } from "react";

/** Fixed overlays follow the visible viewport when a software keyboard opens. */
export function useVisualViewport(active: boolean): CSSProperties | undefined {
  const [viewport, setViewport] = useState<{ height: number; top: number } | null>(null);
  useEffect(() => {
    if (!active || !window.visualViewport) return;
    const visual = window.visualViewport;
    const update = () => setViewport({ height: visual.height, top: visual.offsetTop });
    const frame = requestAnimationFrame(update);
    visual.addEventListener("resize", update);
    visual.addEventListener("scroll", update);
    return () => { cancelAnimationFrame(frame); visual.removeEventListener("resize", update); visual.removeEventListener("scroll", update); };
  }, [active]);
  return active && viewport ? { top: viewport.top, height: viewport.height, bottom: "auto", "--visible-height": `${viewport.height}px` } as CSSProperties : undefined;
}
