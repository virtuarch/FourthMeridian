"use client";

/**
 * components/atlas/panels/PanelStack.tsx
 *
 * Coordinates NESTED / STACKED panels so a panel opened from within another panel
 * layers ABOVE it instead of tying its z-index. Optional: a lone <Panel> works
 * without a stack (depth 0). When present, each open panel acquires the next depth on
 * mount and releases it on unmount; <Panel> offsets its z-index by that depth.
 *
 * Presentation-only, domain-free: it counts panels, nothing more.
 */

import { createContext, useContext, useState, type ReactNode } from "react";

export interface PanelStackApi {
  /** Claim the next stacking depth (0-based). Returns the depth for this panel. */
  acquire: () => number;
  /** Release a previously-acquired depth. */
  release: (depth: number) => void;
}

/**
 * The pure depth allocator behind <PanelStack>, extracted so its behavior is
 * unit-testable without React. `acquire` returns the smallest free non-negative
 * integer, so a close-then-open reuses a freed slot rather than climbing forever;
 * `release` frees a slot. Concurrent opens in one commit get distinct, ordered depths.
 */
export function createDepthAllocator(): PanelStackApi {
  const claimed = new Set<number>();
  return {
    acquire: () => {
      let d = 0;
      while (claimed.has(d)) d += 1;
      claimed.add(d);
      return d;
    },
    release: (depth: number) => {
      claimed.delete(depth);
    },
  };
}

const PanelStackContext = createContext<PanelStackApi | null>(null);

/** Optional depth allocator for the calling <Panel>; null when no <PanelStack>. */
export function usePanelStack(): PanelStackApi | null {
  return useContext(PanelStackContext);
}

export function PanelStack({ children }: { children: ReactNode }) {
  // One allocator per stack instance, created once (lazy init) and stable across renders.
  const [api] = useState(createDepthAllocator);
  return <PanelStackContext.Provider value={api}>{children}</PanelStackContext.Provider>;
}
