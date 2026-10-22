"use client";

/**
 * app/(shell)/dashboard/platform/[area]/error.tsx  (UI-007)
 *
 * Error boundary for one platform Space. It sits inside the dashboard chrome,
 * so an operator whose Space failed to render keeps navigation and can retry
 * or return to the Platform Spaces directory. Discloses nothing about the area
 * (the page's own gates decide existence; this only handles a render failure).
 */

import { RouteErrorFallback } from "@/components/ui/RouteErrorFallback";

export default function PlatformAreaError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteErrorFallback
      error={error}
      reset={reset}
      what="this platform Space"
      backHref="/dashboard/platform"
      backLabel="Back to Platform Spaces"
    />
  );
}
