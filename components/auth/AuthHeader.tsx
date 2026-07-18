/**
 * components/auth/AuthHeader.tsx  (UI Convergence Wave 2 — W2-A)
 *
 * The title block at the top of an auth card: a compact mark (mobile only —
 * desktop carries the brand in AuthShell's side panel) over a title + subtitle.
 * Replaces the per-page logo + heading stack.
 */

import { AppLogo } from "@/components/ui/AppLogo";
import type { ReactNode } from "react";

export function AuthHeader({
  title,
  subtitle,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
}) {
  return (
    <div className="text-center">
      <div className="mb-5 flex justify-center lg:hidden">
        <AppLogo size={40} priority />
      </div>
      <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
        {title}
      </h1>
      {subtitle && (
        <p className="mt-1.5 text-sm text-[var(--text-secondary)]">{subtitle}</p>
      )}
    </div>
  );
}
