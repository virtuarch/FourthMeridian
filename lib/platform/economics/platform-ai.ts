/**
 * lib/platform/economics/platform-ai.ts  (Platform Economics — PR C: the Platform AI category)
 *
 * AI invoked for an OPERATOR, not a customer — today Comms Center authoring
 * (surface "comms_authoring", lib/notifications/content/deps.ts). The KPI is
 * the Overview's `platform_ai_cost` figure (snapshot-core.ts: RETURNED calls on
 * PLATFORM_AI_SURFACES, priced per (model, UTC day)); this module adds its
 * RECORDS: every invocation in the window — returned AND failed — with model,
 * sub-surface, in / out / cached tokens, latency, outcome and error code, its
 * estimated cost (the same pricer, one invocation per group), and the operator
 * as an OPAQUE reference. Plus per-model rollups and latency percentiles.
 *
 * Σ cost of the RETURNED rows = the KPI (pinned in platform-ai.test.ts). A
 * failure costs nothing and is "not counted", never $0; an unpriced call is
 * "unpriced", never $0. Read-only, fm_system (AiInvocation is revoked from fm_app).
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { PLATFORM_AI_SURFACES, priceSpendGroup } from "@/lib/platform/ai/spend-by-surface-core";
import { opaqueUserRef } from "@/lib/platform/opaque-user-ref";
import { loadEconomicsInputs, type EconomicsDeps } from "@/lib/platform/economics/snapshot";
import { economicsFigure, windowRange, type EconomicsFigure, type EconomicsWindow } from "@/lib/platform/economics/snapshot-core";

export const PLATFORM_AI_PAGE_SIZE = 25;
/** Operator traffic is small; the window read is capped and says so when it truncates. */
export const PLATFORM_AI_READ_CAP = 5000;

export interface PlatformAiInvocationSource {
  id: string; occurredAt: Date; provider: string; model: string; surface: string | null; subSurface: string | null;
  outcome: string; errorCode: string | null; promptTokens: number; cachedPromptTokens: number; completionTokens: number;
  latencyMs: number; userId: string | null;
}

export type PlatformAiPricing = "PRICED" | "UNPRICED" | "NO_TOKENS" | "NOT_COUNTED";

export interface PlatformAiCallRow {
  id: string; occurredAt: string; subSurface: string | null; model: string; outcome: string; errorCode: string | null;
  promptTokens: number; cachedPromptTokens: number; completionTokens: number; latencyMs: number;
  pricing: PlatformAiPricing; costUsd: number | null;
  /** Opaque operator reference — never the id. */
  operatorRef: string | null;
}

export interface PlatformAiRecords {
  /** THE KPI (the Overview's figure for the same window and window end). */
  figure: EconomicsFigure;
  window: { key: EconomicsWindow; from: string; to: string };
  counts: { total: number; returned: number; failed: number; unpriced: number };
  /** Σ cost of the returned, priced rows — equals figure.value. */
  returnedCostUsd: number | null;
  latencyMs: { p50: number; p95: number; n: number } | null;
  byModel: { model: string; calls: number; failed: number; costUsd: number | null; promptTokens: number; completionTokens: number; cachedPromptTokens: number }[];
  page: { page: number; pageSize: number; total: number; rows: PlatformAiCallRow[] };
  truncated: boolean;
  checkedAt: string;
}

export interface PlatformAiDeps extends EconomicsDeps {
  list?: (since: Date, until: Date, take: number) => Promise<PlatformAiInvocationSource[]>;
}

const listPlatformAi = (since: Date, until: Date, take: number) => systemDb.aiInvocation.findMany({
  where: { occurredAt: { gte: since, lte: until }, surface: { in: [...PLATFORM_AI_SURFACES] } },
  orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
  take,
  select: {
    id: true, occurredAt: true, provider: true, model: true, surface: true, subSurface: true, outcome: true, errorCode: true,
    promptTokens: true, cachedPromptTokens: true, completionTokens: true, latencyMs: true, userId: true,
  },
});

function priceOne(r: PlatformAiInvocationSource): { pricing: PlatformAiPricing; costUsd: number | null } {
  if (r.outcome !== "RETURNED") return { pricing: "NOT_COUNTED", costUsd: null };
  if (r.promptTokens + r.completionTokens === 0) return { pricing: "NO_TOKENS", costUsd: null };
  const p = priceSpendGroup({
    provider: r.provider, model: r.model, surface: r.surface, day: r.occurredAt.toISOString().slice(0, 10), invocations: 1,
    promptTokens: r.promptTokens, cachedPromptTokens: r.cachedPromptTokens, completionTokens: r.completionTokens,
  });
  return p.usd === null ? { pricing: "UNPRICED", costUsd: null } : { pricing: "PRICED", costUsd: p.usd };
}

const pct = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];

export async function getPlatformAiRecords(q: { window: EconomicsWindow; untilMs: number; page: number }, deps: PlatformAiDeps = {}): Promise<PlatformAiRecords> {
  const range = windowRange(q.window, q.untilMs);
  const since = new Date(`${range.from}T00:00:00Z`);
  const until = new Date(q.untilMs);
  const [inputs, raw] = await Promise.all([
    loadEconomicsInputs(q.untilMs, deps),
    (deps.list ?? listPlatformAi)(since, until, PLATFORM_AI_READ_CAP + 1),
  ]);
  const checkedAt = until.toISOString();
  const truncated = raw.length > PLATFORM_AI_READ_CAP;
  const src = raw.slice(0, PLATFORM_AI_READ_CAP);
  const ref = deps.ref ?? opaqueUserRef;
  const rows: PlatformAiCallRow[] = src.map((r) => ({
    id: r.id, occurredAt: r.occurredAt.toISOString(), subSurface: r.subSurface, model: r.model, outcome: r.outcome, errorCode: r.errorCode,
    promptTokens: r.promptTokens, cachedPromptTokens: r.cachedPromptTokens, completionTokens: r.completionTokens, latencyMs: r.latencyMs,
    ...priceOne(r), operatorRef: r.userId ? ref(r.userId) : null,
  }));
  let returnedCostUsd: number | null = null;
  for (const r of rows) if (r.costUsd !== null) returnedCostUsd = (returnedCostUsd ?? 0) + r.costUsd;
  const lat = rows.filter((r) => r.outcome === "RETURNED").map((r) => r.latencyMs).sort((a, b) => a - b);
  const models = new Map<string, PlatformAiRecords["byModel"][number]>();
  for (const r of rows) {
    const m = models.get(r.model) ?? { model: r.model, calls: 0, failed: 0, costUsd: null, promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 };
    m.calls++; if (r.outcome !== "RETURNED") m.failed++;
    if (r.costUsd !== null) m.costUsd = (m.costUsd ?? 0) + r.costUsd;
    m.promptTokens += r.promptTokens; m.completionTokens += r.completionTokens; m.cachedPromptTokens += r.cachedPromptTokens;
    models.set(r.model, m);
  }
  const page = Math.max(1, Math.floor(q.page));
  const start = (page - 1) * PLATFORM_AI_PAGE_SIZE;
  return {
    figure: economicsFigure(inputs, "platform_ai_cost", q.window, checkedAt),
    window: { key: q.window, ...range },
    counts: {
      total: rows.length, returned: rows.filter((r) => r.outcome === "RETURNED").length,
      failed: rows.filter((r) => r.outcome !== "RETURNED").length, unpriced: rows.filter((r) => r.pricing === "UNPRICED").length,
    },
    returnedCostUsd,
    latencyMs: lat.length ? { p50: pct(lat, 0.5), p95: pct(lat, 0.95), n: lat.length } : null,
    byModel: [...models.values()].sort((a, b) => b.calls - a.calls),
    page: { page, pageSize: PLATFORM_AI_PAGE_SIZE, total: rows.length, rows: rows.slice(start, start + PLATFORM_AI_PAGE_SIZE) },
    truncated,
    checkedAt,
  };
}

/** `window` (7d / 30d / 90d / cycle, default 30d), `until` (epoch ms ≤ now), `page` (≥ 1). */
export function parsePlatformAiQuery(p: URLSearchParams, nowMs: number): { window: EconomicsWindow; untilMs: number; page: number } | null {
  const w = (p.get("window") ?? "30d") as EconomicsWindow;
  if (!["cycle", "7d", "30d", "90d"].includes(w)) return null;
  const u = Number(p.get("until"));
  const page = Number(p.get("page") ?? "1");
  return { window: w, untilMs: Number.isFinite(u) && u > 0 && u <= nowMs ? Math.floor(u) : nowMs, page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1 };
}
