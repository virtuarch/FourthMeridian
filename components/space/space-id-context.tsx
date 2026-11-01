"use client";

/**
 * components/space/space-id-context.tsx  (Connections pass PR 4b)
 *
 * The active Space's id for descendants that need it without threading a prop
 * through pinned widgets (PerspectiveEmptyState). Provided once by SpaceDashboard.
 * No layout, no state — a value.
 */

import { createContext, useContext, type ReactNode } from "react";

const SpaceIdContext = createContext<string | null>(null);

export function SpaceIdProvider({ spaceId, children }: { spaceId: string; children: ReactNode }) {
  return <SpaceIdContext.Provider value={spaceId}>{children}</SpaceIdContext.Provider>;
}

export function useSpaceIdContext(): string | null {
  return useContext(SpaceIdContext);
}
