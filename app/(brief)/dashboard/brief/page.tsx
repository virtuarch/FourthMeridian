/**
 * /dashboard/brief
 *
 * Daily Brief page — standalone page under the dashboard shell.
 * Client-side data fetching via DailyBriefClient.
 */

import { Suspense }          from "react";
import { DailyBriefClient } from "@/components/brief/DailyBriefClient";

export const metadata = {
  title: "Daily Brief · FinTracker",
};

function BriefFallback() {
  return (
    <div className="space-y-4 animate-pulse max-w-2xl mx-auto">
      <div className="h-[220px] rounded-2xl bg-gray-800/50" />
      <div className="h-28 rounded-xl bg-gray-800/40" />
      <div className="h-24 rounded-xl bg-gray-800/30" />
    </div>
  );
}

export default function DailyBriefPage() {
  return (
    <Suspense fallback={<BriefFallback />}>
      <DailyBriefClient />
    </Suspense>
  );
}
