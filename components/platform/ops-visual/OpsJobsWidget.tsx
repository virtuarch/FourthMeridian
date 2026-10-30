"use client";

/**
 * components/platform/ops-visual/OpsJobsWidget.tsx  (ops_job_health — the unified Jobs list, full)
 *
 * The `ops_job_health` section's widget: the unified Jobs experience with every
 * scheduled job and a search, in the Operations › Jobs drill-down. It replaces
 * the former job registry table and absorbs `ops_manual_operations` (declared in
 * lib/platform/workspaces.ts PLATFORM_SECTION_REPRESENTATION): every manual
 * operation is reached from its job's row or detail.
 */

import { useState } from "react";
import type { SpaceMountAccess } from "@/lib/space/mount-context";
import type { PlatformSection } from "../widget-kit";
import { UnifiedJobs } from "./UnifiedJobs";

export function OpsJobsWidget({ access }: { section: PlatformSection; access?: SpaceMountAccess }) {
  const [nowMs] = useState(() => Date.now());
  return <UnifiedJobs mode="full" access={access} nowMs={nowMs} />;
}
