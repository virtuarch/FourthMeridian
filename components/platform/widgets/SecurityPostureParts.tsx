"use client";

/**
 * components/platform/widgets/SecurityPostureParts.tsx  (BETA V2 · Workstream W4)
 *
 * The two React pieces every group of the Security posture surface shares,
 * kept in their own module so the groups (Sec*.tsx) and the surface
 * (SecurityPostureWidget.tsx) import downward only — no cycle.
 */

import type { ReactNode } from "react";
import { WidgetMessage } from "../widget-kit";
import { BigStat, Unavailable } from "../platform-surface";
import { sourceFailedText, type Fetched, type Reading } from "./security-posture-view";

/** One BigStat per reading; a null value is Unavailable with its reason, in full weight. */
export function ReadingStat({ r }: { r: Reading }) {
  return (
    <BigStat
      label={r.label}
      value={r.value ?? <Unavailable reason={r.reason ?? "not derivable"} />}
      qualifier={r.qualifier}
      derivation={r.derivation}
    />
  );
}

/** A fetched source's loading / error gate; renders children only with data. */
export function SourceGate<T>({ source, fetched, children }: { source: string; fetched: Fetched<T>; children: (data: T) => ReactNode }) {
  if (fetched.loading) return <WidgetMessage loading />;
  if (fetched.error || !fetched.data) return <WidgetMessage error={sourceFailedText(source, fetched.error ?? "no payload")} />;
  return <>{children(fetched.data)}</>;
}
