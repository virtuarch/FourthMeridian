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
 *      (multi-area, 2026-11-08: after the limiter, every OTHER held area is guarded
 *      the same way, on its own; a refused area is left out of the binding)
 *   4. the #352 per-operator limiter (limitPlatformMutation)  → 429
 *   5. handlePlatformAiAsk: body → kill switch → global cost freeze → the
 *      per-operator daily turn cap → the bare-username guard (authz/people.ts, on the RAW
 *      question; 422 USE_PEOPLE_PICKER, no turn) → the $ caps → the turn → 400 / 503 / 429 / 422
 *   6. P2 — EVERY tool call of the turn through the turn boundary
 *      (authz/boundary.ts invokeTool): pack flag, strict args, the held areas, a FRESH
 *      requireFreshPlatformAccess per call (authz/recheck.server.ts — a mid-turn
 *      revocation refuses the next call and drops the area), per-turn handles, tier,
 *      envelope; any refusal is the one NOT_FOUND the model sees
 *   7. P5 — customer-linkable RECORD tools write their audit rows FIRST (authz/audit.ts
 *      platformAiToolAudit; a failure ⇒ UNAVAILABLE); a T2 field renders only after its
 *      PLATFORM_AI_RECORD_VIEWED row (platformAiRenderAudit); with the customers pack flag ON,
 *      exact customer identifiers in the question are resolved before the scrub
 *      (authz/subject.ts: limiter, fresh CS tier, exact lookup, audit, uniform literal + floor)
 *
 * THE SURFACE comes from the guard result, never from the request: P1b —
 * authz/scope.ts `scopeFromGuard` admits only a real grant for exactly the guarded
 * area and this operator (I-7: break-glass is never in scope), and its `bindArea`
 * calls retrieveMetric / listNavigationTargets / resolveNavigationTarget with a
 * STRING-LITERAL surface per area (pinned by the metric and navigation source
 * scans). The tokens are minted here from this function's own guard result
 * (metricAccessFor / incidentAudienceFor — the guard-provenance pins).
 *
 * NO PERSISTENCE: nothing about the question or the answer is stored; the
 * AiInvocation ledger keeps metadata only (surface platform_ai, overhead). One
 * log line per answered turn carries the METADATA-ONLY tool trace (traceLine:
 * tool names, outcome codes, server-returned registry ids, placeholder counts —
 * never text, never a value).
 */

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { limitPlatformMutation } from "@/lib/platform/mutation-rate-limit";
import { loadPlatformDirectory } from "@/lib/platform/directory.server";
import { env } from "@/lib/env";
import { metricAccessFor } from "@/lib/platform/intelligence/metrics/access";
import { bindArea, scopeFromGuard } from "@/lib/platform/intelligence/ai/authz/scope";
import { createTurnBoundary, type ScopedArea } from "@/lib/platform/intelligence/ai/authz/boundary";
import { platformAiFreshRecheck } from "@/lib/platform/intelligence/ai/authz/recheck.server";
import { platformAiRenderRecheck } from "@/lib/platform/intelligence/ai/authz/record-render.server";
import { recordTextRenderer } from "@/lib/platform/intelligence/ai/authz/record-render";
import { platformAiRenderAudit, platformAiToolAudit } from "@/lib/platform/intelligence/ai/authz/audit";
import { resolveSubjects } from "@/lib/platform/intelligence/ai/authz/subject";
import { isSubjectResolutionEnabled, platformAiSubjectDeps } from "@/lib/platform/intelligence/ai/authz/subject.server";
import { platformAiPickerGuard } from "@/lib/platform/intelligence/ai/authz/people.server";
import { platformAiPackEnabled, platformAiTurnRouter, routePlatformAiPacks } from "@/lib/platform/intelligence/ai/engine/router";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import { readPaidRequestsAdmission } from "@/lib/platform/ai/paid-requests-admission";
import { readGlobalCostFreeze } from "@/lib/platform/cost-freeze";
import { readPlatformAiTurns } from "@/lib/platform/ai/platform-ai-turns";
import { reservePlatformAiSpend } from "@/lib/platform/ai/platform-ai-spend";
import {
  composePlatformAiBindings, handlePlatformAiAsk, NOT_AVAILABLE_BODY, PLATFORM_AI_ROUTE_KEY, platformAiAreaFor, platformAiAreasFor,
  type PlatformAiAreaBinding,
} from "@/lib/platform/intelligence/ai/core";
import { classifyPlatformAiFailure, makePlatformAiGenerate, platformAiModel } from "@/lib/platform/intelligence/ai/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

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

  // P1b (I-7): the ONE scope rule (authz/scope.ts) — a real grant for exactly this area, this
  // operator; break-glass (grant null) is never in scope. The tokens are minted HERE from this
  // function's own guard result; scope.ts binds them with a literal surface per area.
  const primaryScope = scopeFromGuard(auth, area, auth.user.id);
  const metricToken = primaryScope ? metricAccessFor(auth) : null;
  const incidentToken = incidentAudienceFor(auth);
  const primary = primaryScope ? bindArea(primaryScope, { metricToken, incidentToken }) : null;

  // MULTI-AREA (owner 2026-11-08): every OTHER area the operator holds, each behind ITS OWN
  // fresh guard (grant, operator 2FA, live revocation). A refused / revoked area is skipped —
  // never bound. Tokens are minted from that area's own guard result; the surface is still a
  // literal per case in authz/scope.ts bindArea. Composition is pure (core.ts composePlatformAiBindings).
  const parts: PlatformAiAreaBinding[] = primary && primaryScope ? [{ area: primaryScope.area, binding: primary }] : [];
  // P2: each bound area keeps its route-issued scope — the turn boundary rechecks exactly these.
  const scoped: { scope: ScopedArea; binding: NonNullable<typeof primary> }[] = primary && primaryScope ? [{ scope: primaryScope, binding: primary }] : [];
  if (primary) {
    for (const other of platformAiAreasFor(rows)) {
      if (other === area) continue;
      const [otherAuth, otherErr] = await requireFreshPlatformAccess(other, "READ", { probe: true });
      if (otherErr) continue;
      const otherScope = scopeFromGuard(otherAuth, other, auth.user.id);
      if (!otherScope) continue;
      const otherBinding = bindArea(otherScope, { metricToken: metricAccessFor(otherAuth), incidentToken: incidentAudienceFor(otherAuth) });
      if (otherBinding) { parts.push({ area: other, binding: otherBinding }); scoped.push({ scope: otherScope, binding: otherBinding }); }
    }
  }
  const binding = composePlatformAiBindings(parts);

  let body: unknown;
  try { body = await req.json(); } catch { body = null; }

  // P2 — THE turn boundary (authz/boundary.ts invokeTool): every tool call of this turn is
  // re-authorized — pack flag, strict args, scope, a FRESH requireFreshPlatformAccess per call
  // (non-probe), handles bound to this operator + this turn's correlation id. Denial rows: codes only.
  const correlationId = randomUUID();
  const boundary = binding ? createTurnBoundary({
    operatorId: auth.user.id, correlationId, areas: scoped, binding,
    recheck: platformAiFreshRecheck,
    // P3: core packs until the turn routes its scrubbed question (engine/router.ts); more_tools within the bounds.
    packs: routePlatformAiPacks({ question: null, areas: scoped.map((s) => s.scope.area), memory: false }),
    router: platformAiTurnRouter({ memory: false }),
    packEnabled: (p) => platformAiPackEnabled(p),
    onDenial: (r) => console.warn(`[platform-ai] tool refused: tool=${r.tool} pack=${r.pack} reason=${r.reason} (${PLATFORM_AI_ROUTE_KEY})`),
    // P5 — THE fail-closed audit writer for customer-linkable RECORD tools (actor = this call's fresh guard).
    audit: platformAiToolAudit(),
  }) : null;
  // P5 — subject resolution only while the customers pack flag is ON (OFF ⇒ the question is handled exactly as before).
  const subjects = boundary && isSubjectResolutionEnabled()
    ? { resolve: (ids: Parameters<typeof resolveSubjects>[0]) => resolveSubjects(ids, platformAiSubjectDeps({ operatorId: auth.user.id, primaryArea: area, boundary })) }
    : null;

  const { model, reasoning } = platformAiModel();
  const res = await handlePlatformAiAsk(body, {
    enabled: env.isPlatformAiEnabled,
    operatorId: auth.user.id,
    binding,
    admission: () => readPaidRequestsAdmission(),
    freeze: () => readGlobalCostFreeze(),
    turns: (id, now) => readPlatformAiTurns(id, now),
    spend: (id, now) => reservePlatformAiSpend(id, now, { model }),
    generate: makePlatformAiGenerate({ operatorId: auth.user.id, turnId: correlationId }),
    ...(boundary ? { invoke: boundary.invoke, records: boundary.recordRef, ...(boundary.tools ? { tools: boundary.tools } : {}) } : {}),
    // P4 — a placed record renders at READ time for this viewer (fresh probe check per area, revalidate;
    // T2 only with a fresh CS tier AND the PLATFORM_AI_RECORD_VIEWED row written first — P5 writer, fail closed ⇒ masked).
    renderRecords: recordTextRenderer({ operatorId: auth.user.id, mode: "live", recheck: platformAiRenderRecheck, audit: platformAiRenderAudit() }),
    ...(subjects ? { subjects } : {}),
    // S2 09fc — the bare-username guard on the RAW question (P5 callers: exact username lookup; others: emails refused).
    guard: platformAiPickerGuard({ operatorId: auth.user.id, primaryArea: area }),
    model,
    reasoningModel: reasoning,
    now: () => new Date(),
    classify: classifyPlatformAiFailure,
    // Codes and counts only (never a value, key or text): the fallback-rate counter.
    countUngrounded: (verdict, unresolved) => console.warn(`[platform-ai] answer replaced: verdict=${verdict} unresolved=${unresolved} (${PLATFORM_AI_ROUTE_KEY})`),
    // Metadata only (tool codes + registry ids): what the turn read, for acceptance / incident review.
    traceTurn: (line) => console.info(`[platform-ai] turn ${line} (${PLATFORM_AI_ROUTE_KEY})`),
  });
  return NextResponse.json(res.body, { status: res.status, headers: { ...NO_STORE, ...(res.headers ?? {}) } });
}
