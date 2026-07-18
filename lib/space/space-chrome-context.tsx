"use client";

/**
 * lib/space/space-chrome-context.tsx
 *
 * The bridge that lets the in-Space host (SpaceDashboard, rendered as the
 * /dashboard route child) drive the app-global chrome (ContextualNavbar,
 * mounted by DashboardChrome ABOVE the route children).
 *
 * WHY A BRIDGE AND NOT PROPS: production's chrome is a Next.js layout that
 * wraps every dashboard route; the active Space's identity / FX control / Manage
 * handler / workspace sections are owned BELOW the chrome in the tree. React
 * props only flow down, so those surfaces publish UP through this context and
 * the sidebar reads them. When a Space payload is present the ContextualNavbar
 * transforms to Space mode; when null (any non-Space route) it renders global
 * navigation — the production analog of the prototype's transforming sidebar.
 *
 * THREE INDEPENDENT CHANNELS, not one payload, each published from an effect
 * keyed on its own inputs so none re-render-loops against the others:
 *   • space           — identity + Manage/Leave (SpaceDashboard).
 *   • currencyControl  — the FX ReactNode (owned a level up; recreated each render).
 *   • sections         — the active WORKSPACE's section anchors + which is active.
 *     Published by the workspace itself (e.g. WealthWorkspace), so the sidebar
 *     shows "what's inside" the workspace — exactly the prototype's Sections list.
 *     Active-section state lives HERE so both the sidebar (highlight) and the
 *     click handler (set active) share one source.
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

/** The identity half of Space mode, published by SpaceDashboard. */
export interface SpaceChromeSpace {
  identity: SpaceChromeIdentity;
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
  /** The active workspace's section anchors (empty ⇒ no Sections list). */
  sections: SpaceChromeSection[];
  /** Which section label is active (highlighted in the sidebar). */
  activeSection: string;
  setSpace: (s: SpaceChromeSpace | null) => void;
  setCurrencyControl: (node: ReactNode | null) => void;
  setSections: (s: SpaceChromeSection[]) => void;
  setActiveSection: (label: string) => void;
}

const SpaceChromeContext = createContext<SpaceChromeValue | null>(null);

export function SpaceChromeProvider({ children }: { children: ReactNode }) {
  const [space, setSpace] = useState<SpaceChromeSpace | null>(null);
  const [currencyControl, setCurrencyControl] = useState<ReactNode | null>(null);
  const [sections, setSections] = useState<SpaceChromeSection[]>([]);
  const [activeSection, setActiveSection] = useState<string>("");

  const value = useMemo<SpaceChromeValue>(
    () => ({ space, currencyControl, sections, activeSection, setSpace, setCurrencyControl, setSections, setActiveSection }),
    [space, currencyControl, sections, activeSection],
  );

  return <SpaceChromeContext.Provider value={value}>{children}</SpaceChromeContext.Provider>;
}

const NOOP = () => {};

/** Read the current Space-mode payload (for the ContextualNavbar / chrome). */
export function useSpaceChrome(): SpaceChromeValue {
  const ctx = useContext(SpaceChromeContext);
  if (!ctx) {
    // Outside the provider the chrome simply behaves as "no active Space".
    return {
      space: null,
      currencyControl: null,
      sections: [],
      activeSection: "",
      setSpace: NOOP,
      setCurrencyControl: NOOP,
      setSections: NOOP,
      setActiveSection: NOOP,
    };
  }
  return ctx;
}

/**
 * Publisher hook for the host (SpaceDashboard). Returns stable setters; callers
 * drive them from effects keyed on their own inputs and clear on unmount.
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

/**
 * Publisher hook for a WORKSPACE to declare its own section anchors — the list
 * the sidebar renders as "what's inside" this workspace. Each workspace calls
 * this from an effect (publish on mount with a stable list; clear on unmount),
 * so the pattern extends to every perspective as its body is designed.
 */
export function useSpaceSectionsPublisher(): (s: SpaceChromeSection[]) => void {
  const { setSections } = useSpaceChrome();
  return useCallback((s: SpaceChromeSection[]) => setSections(s), [setSections]);
}
