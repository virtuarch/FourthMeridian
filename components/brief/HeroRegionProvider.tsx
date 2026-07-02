"use client";

/**
 * components/brief/HeroRegionProvider.tsx
 *
 * Shares the Daily Brief hero's region state (auto-detected + optional
 * manual override) across sibling subtrees.
 *
 * Why this exists: UserMenu (rendered in BriefLayout's header) and
 * BriefHero (rendered inside BriefLayout's `{children}`) are siblings, not
 * parent/child — there is no props path between them. The region override
 * control used to live next to ThemeToggle in BriefHero's own top-right
 * corner, which kept the state local. Now that both the Appearance and
 * Region controls live inside UserMenu's dropdown (see the "Daily Brief
 * responsive polish pass" — controls were fighting for horizontal space
 * with the hero's top-right corner on small viewports), the region state
 * has to live above both of them. This provider wraps BriefLayout's full
 * return value (header + page content) so any descendant can read or set
 * it via `useHeroRegion()`.
 *
 * Detection behavior is unchanged from the old BriefHero-local state:
 * client-only, deferred via rAF after mount (server render and the
 * client's first paint both show the default wide Earth, then it swaps in
 * once `detectHeroRegion()` resolves) — this avoids a hydration mismatch.
 * The manual override is plain React state, never persisted to
 * localStorage/cookie/backend; a full reload always returns to
 * auto-detection. Same contract as before, just hoisted.
 *
 * No backend, schema, auth, or Plaid involvement — this only decides which
 * static Earth asset EarthBackground renders.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { detectHeroRegion, type HeroRegion } from "@/lib/hero-region";

interface HeroRegionContextValue {
  /** Auto-detected region, or the manual override when one is set. */
  effectiveRegion: HeroRegion | null;
  /** Non-null only when the viewer has manually overridden detection. */
  overrideRegion: HeroRegion | null;
  /** Pass a region to override, or null to return to auto-detection. */
  setOverrideRegion: (region: HeroRegion | null) => void;
}

const HeroRegionContext = createContext<HeroRegionContextValue | null>(null);

export function HeroRegionProvider({ children }: { children: ReactNode }) {
  const [detectedRegion, setDetectedRegion] = useState<HeroRegion | null>(null);
  const [overrideRegion, setOverrideRegion] = useState<HeroRegion | null>(null);

  useEffect(() => {
    // Deferred via rAF (rather than called synchronously in the effect
    // body) to satisfy the project's set-state-in-effect lint rule — same
    // pattern this used when it lived directly in BriefHero.
    const raf = requestAnimationFrame(() => setDetectedRegion(detectHeroRegion()));
    return () => cancelAnimationFrame(raf);
  }, []);

  const effectiveRegion = overrideRegion ?? detectedRegion;

  const setOverride = useCallback((region: HeroRegion | null) => {
    setOverrideRegion(region);
  }, []);

  return (
    <HeroRegionContext.Provider
      value={{ effectiveRegion, overrideRegion, setOverrideRegion: setOverride }}
    >
      {children}
    </HeroRegionContext.Provider>
  );
}

export function useHeroRegion(): HeroRegionContextValue {
  const ctx = useContext(HeroRegionContext);
  if (!ctx) throw new Error("useHeroRegion must be used within a HeroRegionProvider");
  return ctx;
}
