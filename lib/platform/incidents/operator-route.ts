/**
 * lib/platform/incidents/operator-route.ts  (PB-1 S6 — the acknowledge / resolve route body)
 *
 * The two Platform Ops lifecycle routes (app/api/platform/platform-ops/
 * incidents/[id]/acknowledge | resolve) authorize, rate-limit and mint the Ops
 * token themselves — the guard, the limiter and the mint stay IN the route file
 * where the census pins read them. Everything after that is this one function:
 *
 *   1. parse the body (reason REQUIRED; resolve also needs a registered
 *      resolutionReasonCode and a note) — 400 on anything else;
 *   2. TOKEN-FIRST: read the incident through the intelligence module at the
 *      Ops tier and ask ITS rule (`availableActions`) whether the action is
 *      offered — derived closures, events and stale/derived states are decided
 *      there, never re-derived here;
 *   3. hand the write to lifecycle.ts applyOperatorTransition (CAS + event +
 *      audit, one transaction) and map its typed outcome to a status.
 *
 * Every response is no-store. Nothing here touches a SyncIssue row.
 */

import "server-only";
import { NextResponse } from "next/server";
import { OperatorActionValidationError, parseOperatorReason, type OperatorActionInput, type OperatorReason } from "@/lib/audit";
import { incidentAccessors } from "./intelligence";
import type { OpsToken } from "./intelligence/audience";
import { lifecycleActionsFor, type LifecycleActionDTO } from "./investigation-dto";
import { applyOperatorTransition, type OperatorTransition, type OperatorTransitionOutcome } from "./lifecycle";
import { isOperatorResolutionReasonCode, OPERATOR_RESOLUTION_REASON_CODES } from "./codes";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export const RESOLVE_NOTE_REQUIRED = "A note is required to resolve an incident (what was checked, and why it is closed).";

export type IncidentOperatorActionResponse =
  | { ok: true; changed: true; fromState: string; toState: string }
  | { ok: true; changed: false; toState: string };

type ParsedBody = { ok: true; reason: OperatorReason; transition: OperatorTransition } | { ok: false; error: string };

/** PURE — the body for one action. Reason always required; resolve needs a code + a note. */
export function parseIncidentActionBody(action: LifecycleActionDTO, body: unknown): ParsedBody {
  if (!body || typeof body !== "object") {
    return { ok: false, error: action === "resolve" ? "Body must be { resolutionReasonCode, reason: { code, note } }." : "Body must be { reason: { code, note? } }." };
  }
  const b = body as { reason?: unknown; resolutionReasonCode?: unknown };
  let reason: OperatorReason;
  try { reason = parseOperatorReason(b.reason); }
  catch (e) { return { ok: false, error: e instanceof OperatorActionValidationError ? e.message : "A reason is required." }; }
  if (action === "acknowledge") return { ok: true, reason, transition: { action: "acknowledge" } };
  if (!isOperatorResolutionReasonCode(b.resolutionReasonCode)) {
    return { ok: false, error: `resolutionReasonCode must be one of ${OPERATOR_RESOLUTION_REASON_CODES.join(", ")}.` };
  }
  if (!reason.note) return { ok: false, error: RESOLVE_NOTE_REQUIRED };
  return { ok: true, reason, transition: { action: "resolve", resolutionReasonCode: b.resolutionReasonCode } };
}

/** PURE — the status for a lifecycle refusal. */
export function refusalStatus(code: Extract<OperatorTransitionOutcome, { ok: false }>["code"]): { status: number; error: string } {
  switch (code) {
    case "NOT_FOUND": return { status: 404, error: "Incident not found." };
    case "INVALID": return { status: 400, error: "Invalid resolution reason." };
    case "NOT_A_CONDITION": return { status: 409, error: "This incident is an evidence event; it has no lifecycle." };
    case "ALREADY_RESOLVED": return { status: 409, error: "This incident is already resolved." };
    case "CONFLICT": return { status: 409, error: "The incident changed while you were acting on it. Reload and try again." };
  }
}

export interface IncidentOperatorActionInput {
  action: LifecycleActionDTO;
  incidentId: string;
  body: unknown;
  /** Minted IN THE ROUTE from its guard result, downgraded to the Ops tier. */
  token: OpsToken | null;
  actor: OperatorActionInput["actor"];
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface IncidentOperatorActionDeps {
  investigate: (token: OpsToken, id: string) => Promise<Awaited<ReturnType<typeof incidentAccessors.investigate<OpsToken>>>>;
  apply: typeof applyOperatorTransition;
}

const productionDeps: IncidentOperatorActionDeps = {
  investigate: (token, id) => incidentAccessors.investigate(token, id, { now: new Date() }),
  apply: (input) => applyOperatorTransition(input),
};

export async function runIncidentOperatorAction(
  input: IncidentOperatorActionInput,
  deps: IncidentOperatorActionDeps = productionDeps,
): Promise<NextResponse> {
  const parsed = parseIncidentActionBody(input.action, input.body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  if (!input.token) return NextResponse.json({ error: "Not authorized to act on incidents." }, { status: 403, headers: NO_STORE });

  let inv: Awaited<ReturnType<IncidentOperatorActionDeps["investigate"]>>;
  try { inv = await deps.investigate(input.token, input.incidentId); }
  catch { return NextResponse.json({ error: "Incident read failed." }, { status: 500, headers: NO_STORE }); }
  if (!inv) return NextResponse.json({ error: "Incident not found.", code: "NOT_FOUND" }, { status: 404, headers: NO_STORE });

  // Idempotent acknowledge: the module already reads it as acknowledged — nothing to write.
  if (input.action === "acknowledge" && inv.verdict.state === "acknowledged") {
    return NextResponse.json({ ok: true, changed: false, toState: "ACKNOWLEDGED" } satisfies IncidentOperatorActionResponse, { headers: NO_STORE });
  }
  if (!lifecycleActionsFor(inv.verdict, "ops").includes(input.action)) {
    return NextResponse.json({ error: `"${input.action}" is not available for an incident in state ${inv.verdict.state}.`, code: "NOT_AVAILABLE", state: inv.verdict.state },
      { status: 409, headers: NO_STORE });
  }

  let outcome: OperatorTransitionOutcome;
  try {
    outcome = await deps.apply({
      incidentId: input.incidentId, transition: parsed.transition, actor: input.actor, reason: parsed.reason,
      ipAddress: input.ipAddress ?? null, userAgent: input.userAgent ?? null,
    });
  } catch (e) {
    if (e instanceof OperatorActionValidationError) return NextResponse.json({ error: e.message }, { status: 400, headers: NO_STORE });
    console.error(`[incidents] operator ${input.action} failed`, e instanceof Error ? e.name : "error");
    return NextResponse.json({ error: "The action failed; nothing was changed." }, { status: 500, headers: NO_STORE });
  }
  if (!outcome.ok) {
    const r = refusalStatus(outcome.code);
    return NextResponse.json({ error: r.error, code: outcome.code }, { status: r.status, headers: NO_STORE });
  }
  const res: IncidentOperatorActionResponse = outcome.changed
    ? { ok: true, changed: true, fromState: outcome.fromState, toState: outcome.toState }
    : { ok: true, changed: false, toState: "ACKNOWLEDGED" };
  return NextResponse.json(res, { headers: NO_STORE });
}
