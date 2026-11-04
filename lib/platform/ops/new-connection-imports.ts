/**
 * lib/platform/ops/new-connection-imports.ts  (PB-7 — "New-connection imports (7 d)")
 *
 * IDENTITY-FREE by ruling (Platform Ops never names a customer): Plaid Items
 * linked in the window by active customers, folded through the ONE import rule
 * (lib/platform/onboarding/import-status-core.ts) and reduced to COUNTS. No
 * user id, email, name, institution or item id leaves this module — the owner
 * is a join filter only and is never selected.
 *
 * started = every item linked in the window; the other figures partition it
 * (complete · recovered · in progress · failed · removed). "Recovered" is an
 * import whose first pass was interrupted (e.g. killed at the 300 s function
 * limit) and that a later run — typically resume-stale-imports — completed.
 */

import "server-only";
import { loadImportsLinkedSince } from "@/lib/platform/onboarding/import-facts";
import { buildNewConnectionImports, type NewConnectionImports } from "./new-connection-imports-core";

export const NEW_CONNECTION_WINDOW_DAYS = 7;

export async function getNewConnectionImports(now: Date = new Date()): Promise<NewConnectionImports> {
  const since = new Date(now.getTime() - NEW_CONNECTION_WINDOW_DAYS * 86_400_000);
  const { items, floor } = await loadImportsLinkedSince(since, now);
  return buildNewConnectionImports(items.map((i) => i.verdict), { windowDays: NEW_CONNECTION_WINDOW_DAYS, floor, checkedAt: now });
}
