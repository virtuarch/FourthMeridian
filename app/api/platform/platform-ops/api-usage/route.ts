/**
 * GET /api/platform/platform-ops/api-usage
 *
 * Wave 2 S7 — external-provider API usage for the `ops_api_usage` widget.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ").
 *
 * HONEST LEADING INDICATOR, not a bill: neither Plaid nor OpenAI exposes a
 * billing API this app can poll, so this reports call volume + token counts
 * (from ApiUsageCounter). A dollar figure is returned ONLY if lib/usage/pricing.ts
 * has been populated with contract-specific per-unit prices, and it is then
 * explicitly labeled an estimate — the GrowthSignupsWidget honesty-footnote idiom.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { estimateUnitSpendUsd, isPricingConfigured } from "@/lib/usage/pricing";

export const runtime = "nodejs";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ProviderUsage {
  provider:   string;
  callsToday: number;
  calls7d:    number;
  calls30d:   number;
}

export interface ModelTokenUsage {
  metric:              string; // e.g. "chat.completions:gpt-4o-mini"
  promptTokens30d:     number;
  completionTokens30d: number;
}

export interface ApiUsageResponse {
  since:             string; // ISO — 30-day window start (UTC day bucket)
  providers:         ProviderUsage[];
  models:            ModelTokenUsage[];
  pricingConfigured: boolean;
  estimatedSpendUsd: number | null; // null unless pricing.ts is populated
}

/** Start of the UTC day, matching the recorder's day bucket. */
function utcDayBucket(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  const today      = utcDayBucket(new Date());
  const monthStart = new Date(today.getTime() - 29 * DAY_MS); // 30 day-buckets incl. today
  const weekStart  = new Date(today.getTime() - 6 * DAY_MS);  // 7 day-buckets incl. today

  const rows = await db.apiUsageCounter.findMany({
    where:  { day: { gte: monthStart } },
    select: { provider: true, metric: true, unit: true, day: true, count: true },
  });

  const providers = new Map<string, ProviderUsage>();
  const models    = new Map<string, ModelTokenUsage>();
  let estimate: number | null = null;

  for (const r of rows) {
    const n = Number(r.count);

    if (r.unit === "calls") {
      const p = providers.get(r.provider) ?? { provider: r.provider, callsToday: 0, calls7d: 0, calls30d: 0 };
      p.calls30d += n;
      if (r.day.getTime() >= weekStart.getTime()) p.calls7d += n;
      if (r.day.getTime() >= today.getTime())     p.callsToday += n;
      providers.set(r.provider, p);
    } else if (r.unit === "prompt_tokens" || r.unit === "completion_tokens") {
      const m = models.get(r.metric) ?? { metric: r.metric, promptTokens30d: 0, completionTokens30d: 0 };
      if (r.unit === "prompt_tokens") m.promptTokens30d += n;
      else                            m.completionTokens30d += n;
      models.set(r.metric, m);
    }

    // Optional dollar estimate — only accrues when a price exists for this tuple.
    const unitSpend = estimateUnitSpendUsd(r.provider, r.metric, r.unit, n);
    if (unitSpend !== null) estimate = (estimate ?? 0) + unitSpend;
  }

  return NextResponse.json({
    since:             monthStart.toISOString(),
    providers:         [...providers.values()].sort((a, b) => b.calls30d - a.calls30d),
    models:            [...models.values()].sort((a, b) => b.promptTokens30d - a.promptTokens30d),
    pricingConfigured: isPricingConfigured(),
    estimatedSpendUsd: isPricingConfigured() ? (estimate ?? 0) : null,
  } satisfies ApiUsageResponse);
}
