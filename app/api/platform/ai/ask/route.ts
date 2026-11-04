/**
 * POST /api/platform/ai/ask  (Platform AI v0 — read-only operational Q&A, OFF by default)
 *
 * One operator question → one bounded, read-only tool turn over the permissioned
 * metric layer and the navigation registry → a sanitised, grounded answer.
 * The design and every defence: lib/platform/intelligence/ai/core.ts.
 *
 * GATE CHAIN (in this order; every refusal before any provider call):
 *   0. PLATFORM_AI_ENABLED !== "true"          → 404 NOT_AVAILABLE (nothing else runs)
 *   1. a session                               → 401
 *   2. the AI page's viewers: ≥ 1 ACTIVE PlatformGrant with a Platform Space
 *      (loadPlatformDirectory, the page's own read) → 403
 *   3. requireFreshPlatformAccess(area, "READ") on the operator's FIRST area in
 *      registry order — the grant, operator 2FA when enforced, the live
 *      session-revocation re-check and the break-glass rules, re-read fresh → 401 / 403
 *   4. the #352 per-operator limiter (limitPlatformMutation)  → 429
 *   5. handlePlatformAiAsk: body → kill switch → global cost freeze → the
 *      per-operator daily turn cap → the turn                 → 400 / 503 / 429
 *
 * THE SURFACE comes from the guard result, never from the request: `bindingFor`
 * switches on `auth.grant.area` and every case calls retrieveMetric /
 * listNavigationTargets / resolveNavigationTarget with a STRING-LITERAL surface
 * (pinned by the metric and navigation source scans). The tokens are minted
 * here from this function's own guard result (metricAccessFor /
 * incidentAudienceFor — the guard-provenance pins).
 *
 * NO PERSISTENCE: nothing about the question or the answer is stored; the
 * AiInvocation ledger keeps metadata only (surface platform_ai, overhead).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { limitPlatformMutation } from "@/lib/platform/mutation-rate-limit";
import { loadPlatformDirectory } from "@/lib/platform/directory.server";
import { PLATFORM_AREAS } from "@/lib/platform/policy";
import { env } from "@/lib/env";
import { metricAccessFor, describeMetric, listMetrics, type MetricAccessToken } from "@/lib/platform/intelligence/metrics/access";
import { retrieveMetric, type RetrievalContext } from "@/lib/platform/intelligence/metrics/retrieve";
import { listNavigationTargets, resolveNavigationTarget } from "@/lib/platform/intelligence/navigation/access";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import { readPaidRequestsAdmission } from "@/lib/platform/ai/paid-requests-admission";
import { readGlobalCostFreeze } from "@/lib/platform/cost-freeze";
import { readPlatformAiTurns } from "@/lib/platform/ai/platform-ai-turns";
import { handlePlatformAiAsk, NOT_AVAILABLE_BODY, PLATFORM_AI_ROUTE_KEY, platformAiAreaFor, type PlatformAiBinding } from "@/lib/platform/intelligence/ai/core";
import { classifyPlatformAiFailure, makePlatformAiGenerate, platformAiModel } from "@/lib/platform/intelligence/ai/ledger";
import type { PlatformArea } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** The binding for the guard's area: every accessor call takes a string-literal surface (pinned). */
function bindingFor(area: PlatformArea, ctx: RetrievalContext): PlatformAiBinding | null {
  const t: MetricAccessToken = ctx.metricToken;
  const common = (label: string) => ({
    surfaceLabel: label,
    describeMetric: (id: string) => describeMetric(t, id),
  });
  switch (area) {
    case "PLATFORM_OPS": return {
      ...common(PLATFORM_AREAS.PLATFORM_OPS.label),
      listMetrics: (f) => listMetrics(t, { ...f, area: "PLATFORM_OPS" }),
      readMetric: (id, p) => retrieveMetric("PLATFORM_OPS", ctx, id, p),
      listPages: (f) => listNavigationTargets("PLATFORM_OPS", t, f),
      resolvePage: (id, p) => resolveNavigationTarget("PLATFORM_OPS", t, id, p),
    };
    case "SECURITY_OPS": return {
      ...common(PLATFORM_AREAS.SECURITY_OPS.label),
      listMetrics: (f) => listMetrics(t, { ...f, area: "SECURITY_OPS" }),
      readMetric: (id, p) => retrieveMetric("SECURITY_OPS", ctx, id, p),
      listPages: (f) => listNavigationTargets("SECURITY_OPS", t, f),
      resolvePage: (id, p) => resolveNavigationTarget("SECURITY_OPS", t, id, p),
    };
    case "GROWTH_REVENUE": return {
      ...common(PLATFORM_AREAS.GROWTH_REVENUE.label),
      listMetrics: (f) => listMetrics(t, { ...f, area: "GROWTH_REVENUE" }),
      readMetric: (id, p) => retrieveMetric("GROWTH_REVENUE", ctx, id, p),
      listPages: (f) => listNavigationTargets("GROWTH_REVENUE", t, f),
      resolvePage: (id, p) => resolveNavigationTarget("GROWTH_REVENUE", t, id, p),
    };
    case "CUSTOMER_SUCCESS": return {
      ...common(PLATFORM_AREAS.CUSTOMER_SUCCESS.label),
      listMetrics: (f) => listMetrics(t, { ...f, area: "CUSTOMER_SUCCESS" }),
      readMetric: (id, p) => retrieveMetric("CUSTOMER_SUCCESS", ctx, id, p),
      listPages: (f) => listNavigationTargets("CUSTOMER_SUCCESS", t, f),
      resolvePage: (id, p) => resolveNavigationTarget("CUSTOMER_SUCCESS", t, id, p),
    };
    case "MERCHANT_OPS": return {
      ...common(PLATFORM_AREAS.MERCHANT_OPS.label),
      listMetrics: (f) => listMetrics(t, { ...f, area: "MERCHANT_OPS" }),
      readMetric: (id, p) => retrieveMetric("MERCHANT_OPS", ctx, id, p),
      listPages: (f) => listNavigationTargets("MERCHANT_OPS", t, f),
      resolvePage: (id, p) => resolveNavigationTarget("MERCHANT_OPS", t, id, p),
    };
    default: return null;
  }
}

export async function POST(req: NextRequest) {
  // 0. The kill switch: OFF ⇒ nothing else runs (no session read, no ledger read, no provider).
  if (!env.isPlatformAiEnabled) return NextResponse.json(NOT_AVAILABLE_BODY, { status: 404, headers: NO_STORE });

  // 1–2. The AI page's viewers: a session and at least one ACTIVE grant with a Platform Space.
  const [user, uerr] = await requireUser();
  if (uerr) return uerr;
  const rows = await loadPlatformDirectory(user.id);
  const area = platformAiAreaFor(rows);
  if (!area) return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });

  // 3. The area's own guard, FRESH (grant, operator 2FA, live revocation) — the scope's only source.
  const [auth, err] = await requireFreshPlatformAccess(area, "READ");
  if (err) return err;

  // 4. #352 — the per-operator mutation limiter (it is a POST).
  const limited = await limitPlatformMutation(auth.user.id, "platform-ai-ask");
  if (limited) return limited;

  const metricToken = metricAccessFor(auth);
  const incidentToken = incidentAudienceFor(auth);
  const binding = metricToken && auth.grant ? bindingFor(auth.grant.area, { metricToken, incidentToken }) : null;

  let body: unknown;
  try { body = await req.json(); } catch { body = null; }

  const { model, reasoning } = platformAiModel();
  const res = await handlePlatformAiAsk(body, {
    enabled: env.isPlatformAiEnabled,
    operatorId: auth.user.id,
    binding,
    admission: () => readPaidRequestsAdmission(),
    freeze: () => readGlobalCostFreeze(),
    turns: (id, now) => readPlatformAiTurns(id, now),
    generate: makePlatformAiGenerate({ operatorId: auth.user.id }),
    model,
    reasoningModel: reasoning,
    now: () => new Date(),
    classify: classifyPlatformAiFailure,
    countUngrounded: (n) => console.warn(`[platform-ai] answer replaced: ${n} ungrounded figure(s) (${PLATFORM_AI_ROUTE_KEY})`),
  });
  return NextResponse.json(res.body, { status: res.status, headers: { ...NO_STORE, ...(res.headers ?? {}) } });
}
