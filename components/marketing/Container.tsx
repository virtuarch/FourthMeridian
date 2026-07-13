/**
 * components/marketing/Container.tsx
 *
 * Server-only layout primitive for the public landing pages: a centered,
 * max-width content column with responsive horizontal padding. Marketing pages
 * compose this instead of reaching into the authenticated app's client
 * component library (see the boundary test, lib/marketing-boundary.test.ts).
 */

import type { ReactNode } from "react";

export function Container({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mx-auto w-full max-w-5xl px-5 sm:px-8 ${className}`}>
      {children}
    </div>
  );
}
