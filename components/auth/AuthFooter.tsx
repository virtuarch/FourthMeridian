/**
 * components/auth/AuthFooter.tsx  (UI Convergence Wave 2 — W2-A)
 *
 * The quiet block below an auth form — cross-links ("Create an account", "Back to
 * sign in") and the security reassurance line. A thin styled wrapper; callers pass
 * the actual links/notes so each page keeps its own copy.
 */

import type { ReactNode } from "react";

export function AuthFooter({ children }: { children: ReactNode }) {
  return <div className="space-y-2 text-center">{children}</div>;
}
