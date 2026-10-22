"use client";

/**
 * app/(shell)/dashboard/error.tsx  (UI-007)
 *
 * Segment error boundary for everything under /dashboard. It renders INSIDE
 * the dashboard layout, so DashboardChrome (header + navigation) stays mounted
 * and a failed render no longer drops the customer onto the unstyled
 * app/global-error.tsx page. `reset` re-renders the segment.
 */

import { RouteErrorFallback } from "@/components/ui/RouteErrorFallback";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorFallback error={error} reset={reset} what="this page" />;
}
