"use client";

/**
 * components/ui/PlatformNavContext.tsx  (Platform Operations 2.0 — R1)
 *
 * The ONE client home of the Platform context's navigation state: the granted
 * Platform Spaces (server-loaded by the dashboard layout as the tenant — so the
 * mobile bar and the desktop rail render the right Current Space label on the
 * first paint, with no client fetch and no pop-in) and the Current Space.
 *
 * Current Space = lib/platform/nav `resolveCurrentPlatformSpace` over the
 * granted rows: the area the route stands in, else the remembered one, else the
 * first granted. The remembered value starts from the layout's validated
 * `fm_platform_space` cookie and follows every visit to a granted
 * `/dashboard/platform/<AREA>` route (state adjusted during render — no effect
 * round-trip — and the cookie written in an effect).
 *
 * NOT an authority. The cookie holds an area enum only; it is intersected with
 * the ACTIVE grants on every read (server and client) and the Space page
 * re-checks the grant through the shared guard on every request. Mounted once,
 * by DashboardChrome; outside it (e.g. a DOM-less test render of the sidebar)
 * the default value is "no Platform Spaces", which renders nothing invented.
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  platformAreaFromPath,
  platformSpaceCookie,
  resolveCurrentPlatformSpace,
  type PlatformSpaceOption,
} from "@/lib/platform/nav";

export interface PlatformNavValue {
  /** The granted Platform Spaces, registry order (empty for a non-operator). */
  spaces:  readonly PlatformSpaceOption[];
  /** The Current Space, always one of `spaces` (null only when there are none). */
  current: PlatformSpaceOption | null;
}

const NO_SPACES: readonly PlatformSpaceOption[] = [];
const PlatformNavCtx = createContext<PlatformNavValue>({ spaces: NO_SPACES, current: null });

export function PlatformNavProvider({
  spaces = NO_SPACES,
  rememberedArea = null,
  pathname,
  children,
}: {
  spaces?:         readonly PlatformSpaceOption[];
  /** The layout's cookie value, ALREADY resolved against the grants (or null). */
  rememberedArea?: string | null;
  pathname:        string | null;
  children?:       ReactNode;
}) {
  const pathArea = platformAreaFromPath(pathname);
  const visited = pathArea !== null && spaces.some((s) => s.area === pathArea) ? pathArea : null;

  // Remember the last visited GRANTED area. Adjusted during render (React's
  // "store information from previous renders" pattern), so the label never lags
  // a navigation by a frame.
  const [remembered, setRemembered] = useState<string | null>(rememberedArea);
  if (visited !== null && visited !== remembered) setRemembered(visited);

  // Persist the visit (first-party, area enum only). Never on an ungranted area:
  // `visited` is already intersected with the grants.
  useEffect(() => {
    if (visited === null) return;
    const cookie = platformSpaceCookie(visited, window.location.protocol === "https:");
    if (cookie) document.cookie = cookie;
  }, [visited]);

  const value = useMemo<PlatformNavValue>(
    () => ({ spaces, current: resolveCurrentPlatformSpace(spaces, visited, remembered) }),
    [spaces, visited, remembered],
  );
  return <PlatformNavCtx.Provider value={value}>{children}</PlatformNavCtx.Provider>;
}

/** The granted Platform Spaces + the Current Space (see the file header). */
export function usePlatformNav(): PlatformNavValue {
  return useContext(PlatformNavCtx);
}
