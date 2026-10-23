"use client";

/**
 * components/platform/widgets/SecAuthPostureWidget.tsx  (PO1.1 · sec_auth_posture → BETA V2 host)
 *
 * BETA V2: the `sec_auth_posture` section is the HOST of the one Security posture
 * surface (SecurityPostureWidget.tsx) — it is the first key composed into the
 * SECURITY_OPS Overview (lib/platform/workspaces.ts), and the test pins that the
 * composition's first key is this one. The former card (MFA % hero + four
 * WidgetStats) is the surface's Coverage column now, with each ratio's
 * denominator stated.
 */

import type { PlatformSection } from "../widget-kit";
import { SecurityPostureWidget } from "./SecurityPostureWidget";

export function SecAuthPostureWidget({ section }: { section: PlatformSection }) {
  return <SecurityPostureWidget section={section} />;
}
