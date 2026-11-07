/**
 * GET /api/platform/platform-ops/economics/providers  (Platform Economics — Providers, cost view)
 *
 * Per-provider COST this cycle (lib/platform/economics/providers-core.ts): OpenAI
 * from the AI ledger, Plaid Item-months × rate (Investments not evidenced ⇒
 * PARTIAL), every other provider UNAVAILABLE "not metered"; calls this cycle
 * MEASURED; quota "cap unknown". Provider HEALTH is not here — it stays in
 * Platform Operations › Providers.
 *
 * Read-only, identity-free. AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ"). Never cached.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getEconomicsProviders } from "@/lib/platform/economics/providers-entitlements";
import type { EconomicsProvidersView } from "@/lib/platform/economics/providers-core";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  const body = await getEconomicsProviders(Date.now());
  return NextResponse.json(body satisfies EconomicsProvidersView, { headers: { "Cache-Control": "no-store" } });
}
