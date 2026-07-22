/**
 * components/marketing/Wordmark.tsx
 *
 * Server-only Fourth Meridian mark + wordmark for the public landing pages.
 *
 * Deliberately NOT the app's shared components/ui/AppLogo: that is a
 * "use client" component that pulls in the ThemeProvider context, which would
 * (a) drag client-side weight into pages that should stay light and fast and
 * (b) violate the marketing → app-client-library boundary
 * (lib/marketing-boundary.test.ts). The landing page always renders on a fixed
 * dark background, so it just uses the dark mark directly — no theme swap
 * needed, no client boundary.
 */

import Image from "next/image";

export function Wordmark({ size = 30 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5 min-w-0">
      <Image
        src="/fm-mark-dark.png"
        alt="Fourth Meridian"
        width={size}
        height={size}
        className="rounded-lg object-contain shrink-0"
        priority
      />
      <span
        className="font-bold tracking-tight truncate"
        style={{ color: "var(--text-primary)" }}
      >
        Fourth Meridian
      </span>
    </span>
  );
}
