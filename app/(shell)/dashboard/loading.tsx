/**
 * app/(shell)/dashboard/loading.tsx  (UI-007)
 *
 * Streaming fallback for /dashboard segments: a skeleton rendered INSIDE the
 * dashboard layout (the chrome stays), shown while a server segment renders.
 */

import { RouteLoadingSkeleton } from "@/components/ui/RouteErrorFallback";

export default function DashboardLoading() {
  return <RouteLoadingSkeleton />;
}
