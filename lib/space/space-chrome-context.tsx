"use client";

/**
 * lib/space/space-chrome-context.tsx
 *
 * The bridge that lets the in-Space host (SpaceDashboard, rendered as the
 * /dashboard route child) drive the app-global chrome (ContextualNavbar,
 * mounted by DashboardChrome ABOVE the route children).
 *
 * WHY A BRIDGE AND NOT PROPS: production's chrome is a Next.js layout that
 * wraps every dashboard route; the active Space's identity / sections / FX
 * control / Manage handler are owned by the route child, which sits BELOW the
 * chrome in the tree. React props only flow down, so the child publishes its
 * Space-mode payload UP through this context and the sidebar reads it. When a
 * payload is present the ContextualNavbar transforms to Space mode; when null
 * (any non-Space route) it renders global navigation. This is the production
 * analog of the prototype's single-page sidebar that TRANSFORMS rather than
 * appears (DS-4 §6).
 *
 * TWO SETTERS, NOT ONE: the FX control is a ReactNode with its own state owned
 * one level up (PersonalDashboard's ViewCurrencyOverride), so it is published
 * separately from the identity/sections payload. Each setter is called from an
 * effect keyed on the values it actually depends on, so neither re-render loops
 * against the other (a single combined payload would churn identity every
 * render because the FX node is recreated inline each render).
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/** One Space-mode sidebar section row (a scroll-anchor into the workspace). */
export interface SpaceChromeSection {
  label: string;
  /** Element id to scrollIntoView, or null for an inert "· soon" row. */
  anchor: string | null;
}

/** Domain-agnostic Space identity — a finance Space or a platform HQ Space
 *  both render here, differing only in data (DS-5). */
export interface SpaceChromeIdentity {
  name: string;
  subtitle: string;
  /** Pre-formatted "Updated 2h ago" line, or null to omit. */
  updatedLabel?: string | null;
  shared?: boolean;
}

/** The identity/navigation half of Space mode, published by SpaceDashboard. */
export interface SpaceChromeSpace {
  identity: SpaceChromeIdentity;
  sections: SpaceChromeSection[];
  activeSection: string;
  onSelectSection: (label: string) => void;
  /** Opens the Manage dialog; omitted ⇒ no Manage affordance (e.g. no rights). */
  onManage?: () => void;
  /** "All Spaces" — back to the Spaces launcher (pure navigation). */
  onLeave: () => void;
  /** Membership leave (destructive; shared Spaces only). Omitted ⇒ no affordance
   *  — e.g. a Personal Space, or an Owner/Admin who cannot leave their own. */
  onLeaveSpace?: () => void;
}

interface SpaceChromeValue {
  /** The active Space payload, or null on non-Space routes ⇒ global nav. */
  space: SpaceChromeSpace | null;
  /** The Space-level display-currency ("view as" / FX) control node, or null. */
  currencyControl: ReactNode | null;
  setSpace: (s: SpaceChromeSpace | null) => void;
  setCurrencyControl: (node: ReactNode | null) => void;
}

const SpaceChromeContext = createContext<SpaceChromeValue | null>(null);

export function SpaceChromeProvider({ children }: { children: ReactNode }) {
  const [space, setSpace] = useState<SpaceChromeSpace | null>(null);
  const [currencyControl, setCurrencyControl] = useState<ReactNode | null>(null);

  const value = useMemo<SpaceChromeValue>(
    () => ({ space, currencyControl, setSpace, setCurrencyControl }),
    [space, currencyControl],
  );

  return <SpaceChromeContext.Provider value={value}>{children}</SpaceChromeContext.Provider>;
}

/** Read the current Space-mode payload (for the ContextualNavbar / chrome). */
export function useSpaceChrome(): SpaceChromeValue {
  const ctx = useContext(SpaceChromeContext);
  if (!ctx) {
    // Outside the provider the chrome simply behaves as "no active Space".
    return {
      space: null,
      currencyControl: null,
      setSpace: () => {},
      setCurrencyControl: () => {},
    };
  }
  return ctx;
}

/**
 * Publisher hook for the host. Returns two stable setters; callers drive them
 * from effects keyed on their own inputs and clear on unmount. Kept separate
 * from useSpaceChrome so hosts can't accidentally read chrome state.
 */
export function useSpaceChromePublisher(): {
  publishSpace: (s: SpaceChromeSpace | null) => void;
  publishCurrencyControl: (node: ReactNode | null) => void;
} {
  const { setSpace, setCurrencyControl } = useSpaceChrome();
  const publishSpace = useCallback((s: SpaceChromeSpace | null) => setSpace(s), [setSpace]);
  const publishCurrencyControl = useCallback(
    (node: ReactNode | null) => setCurrencyControl(node),
    [setCurrencyControl],
  );
  return { publishSpace, publishCurrencyControl };
}
