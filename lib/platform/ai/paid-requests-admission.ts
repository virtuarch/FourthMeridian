/**
 * lib/platform/ai/paid-requests-admission.ts  (AI COST CONTROLS — the kill switch)
 *
 * MAY A PAID AI REQUEST BEGIN? TWO PlatformSetting rows, read together, each
 * judged with the admission-fact contract (lib/platform/admission/policy-core.ts):
 *
 *   `ai_paid_requests_paused` — the AI kill switch (AI-specific pause), and
 *   `maintenance_mode`        — the platform is not operating.
 *
 * EITHER ONE denies. Maintenance used to stop refresh and new connections only,
 * so a Daily Brief made a paid OpenAI call during the 2026-10-23 cutover while
 * maintenance was on. The admission policy now declares a PAID_AI_REQUEST work
 * class that maintenance applies to (policy-core APPLIES_TO), and THIS reader —
 * which every paid path already consults (both routes + the provider
 * chokepoint) — is its one consumer (censused in admission-boundary.test.ts).
 * The control-plane facts are judged by the admission module, never re-parsed
 * here; only the kill switch, which is not a control-plane fact, is judged
 * below. One query serves both (the adapter passed to admitOperationalWork).
 *
 * The kill switch row, judged as:
 *
 *   ON           "true"             → PAUSED
 *   OFF          "false"            → admitted
 *   MISSING      no row             → admitted (ABSENT_MEANS_OFF — the switch
 *                                     ships absent; absence denying would halt
 *                                     every customer on deploy)
 *   INVALID      any other string   → PAUSED (an unreadable pause is a pause;
 *                                     the only writer is the validated setter,
 *                                     so this means a direct database edit)
 *   UNAVAILABLE  the read threw     → PAUSED (fail closed: unknown is never
 *                                     silently healthy)
 *
 * Consulted in TWO places, deliberately: the Conversations and Daily Brief
 * routes BEFORE the allowance (after authentication, entitlement and pacing),
 * so a paused platform costs no lock and no ledger read; and the provider
 * chokepoint (lib/ai/provider.ts) before `assertPricedModel` on every entry
 * point, so harness and script traffic is refused too. No override — no
 * overlay, no per-customer allowance, no SYSTEM_ADMIN — lifts it.
 *
 * NO CACHE. Every decision reads the row (a primary-key lookup on fm_system);
 * a change is visible to the very next request. The chat turn loop asks once
 * per model call, so a pause lands mid-turn at the next hop.
 *
 * fm_system: PlatformSetting is an operator table. The read is a key lookup;
 * nothing about a customer is selected.
 */

import "server-only";
import { NextResponse } from "next/server";
import { systemDb } from "@/lib/db";
import { AI_PAUSED_SENTENCE } from "@/lib/ai/conversation/refusal-sentences";
import { PlatformSettingKey } from "@/lib/platform-settings";
import { admitOperationalWork, type ControlPlaneReader } from "@/lib/platform/admission/facts";
import type { AdmissionDecision } from "@/lib/platform/admission/types";

/** The refusal code every surface answers with. */
export const AI_PAUSED_CODE = "AI_PAUSED" as const;

/** The sentence customers read while paused (KillSwitchView.customerMessage carries the same words). */
export const AI_PAUSED_CUSTOMER_MESSAGE = AI_PAUSED_SENTENCE;

/** The admission-fact states (the same five words as lib/platform/admission/types.ts; not imported — that module's consumer census is closed). */
export type PaidRequestsAdmissionState = "ON" | "OFF" | "MISSING" | "INVALID" | "UNAVAILABLE";

/**
 * WHY a paid request is refused — a reason CODE for logs and the ledger detail,
 * never content. Null when admitted.
 *   KILL_SWITCH   ai_paid_requests_paused is on
 *   MAINTENANCE   the platform's maintenance declaration is on
 *   BOTH          both are on
 *   UNREADABLE    a row holds a value the typed setter could not have written
 *   UNAVAILABLE   the store could not be read
 */
export type PaidRequestsDenialCause = "KILL_SWITCH" | "MAINTENANCE" | "BOTH" | "UNREADABLE" | "UNAVAILABLE";

export interface PaidRequestsAdmission {
  paused: boolean;
  /** The kill switch's own state (kept for compatibility with its callers). */
  state: PaidRequestsAdmissionState;
  /** The kill switch row's raw value when one was read (never logged by callers). */
  raw: string | null;
  /** The control plane's own decision for PAID_AI_REQUEST. Absent on a single-row judgement. */
  controlPlane?: AdmissionDecision;
  /** Why it is refused; null when admitted. */
  cause?: PaidRequestsDenialCause | null;
}

/**
 * PURE — the verdict for one read outcome (null = no row). The rule is the
 * admission parser's, restated: only the two literal strings the typed setter
 * writes are accepted — no coercion, no truthiness, no case-folding — because a
 * pause flag that guesses at its own value is how a pause silently becomes a
 * non-pause.
 */
export function judgePaidRequests(raw: string | null | undefined): PaidRequestsAdmission {
  if (raw === null || raw === undefined) return { paused: false, state: "MISSING", raw: null };
  if (raw === "true")  return { paused: true,  state: "ON", raw };
  if (raw === "false") return { paused: false, state: "OFF", raw };
  return { paused: true, state: "INVALID", raw };
}

/**
 * PURE — combine the kill switch's judgement with the control plane's verdict
 * for PAID_AI_REQUEST. Either denies; an unknown on either side denies (the
 * admission module already turns an unreadable control-plane row into DENY);
 * only both clear admits. `controlState` is the denying fact's state word when
 * the control plane denied, else null.
 */
export function combinePaidRequests(
  killSwitch: PaidRequestsAdmission,
  control: { decision: AdmissionDecision; factState: string | null },
): PaidRequestsAdmission {
  const base = { state: killSwitch.state, raw: killSwitch.raw, controlPlane: control.decision };
  let cause: PaidRequestsDenialCause | null = null;
  const controlUnknown = control.decision === "DENY" && control.factState !== "ON";
  if (killSwitch.state === "UNAVAILABLE" || (controlUnknown && control.factState === "UNAVAILABLE")) cause = "UNAVAILABLE";
  else if (killSwitch.state === "INVALID" || controlUnknown) cause = "UNREADABLE";
  else if (killSwitch.state === "ON" && control.decision === "DENY") cause = "BOTH";
  else if (killSwitch.state === "ON") cause = "KILL_SWITCH";
  else if (control.decision === "DENY") cause = "MAINTENANCE";
  return { ...base, paused: cause !== null, cause };
}

export interface PaidRequestsReadClient {
  platformSetting: {
    findMany(args: { where: { key: { in: string[] } }; select: { key: true; value: true } }): Promise<{ key: string; value: string }[]>;
  };
}

const DEFAULT_CLIENT = (): PaidRequestsReadClient => systemDb as unknown as PaidRequestsReadClient;

/**
 * The reader. ONE query: the admission module asks its adapter for the
 * control-plane keys, and this adapter adds the kill switch to the same
 * findMany, so both decisions describe the same instant. Never throws: an
 * unreadable store is PAUSED (UNAVAILABLE) on both sides.
 */
export async function readPaidRequestsAdmission(client: PaidRequestsReadClient = DEFAULT_CLIENT()): Promise<PaidRequestsAdmission> {
  const KILL = PlatformSettingKey.AI_PAID_REQUESTS_PAUSED;
  let killRead: { ok: true; value: string | null } | { ok: false } = { ok: false };
  const adapter: ControlPlaneReader = {
    async read(keys) {
      const rows = await client.platformSetting.findMany({ where: { key: { in: [KILL, ...keys] } }, select: { key: true, value: true } });
      killRead = { ok: true, value: rows.find((r) => r.key === KILL)?.value ?? null };
      return Object.fromEntries(rows.filter((r) => r.key !== KILL).map((r) => [r.key, r.value]));
    },
  };
  try {
    const verdict = await admitOperationalWork({ work: "PAID_AI_REQUEST" }, adapter);
    const read = killRead as { ok: true; value: string | null } | { ok: false };
    const killSwitch: PaidRequestsAdmission = read.ok ? judgePaidRequests(read.value) : { paused: true, state: "UNAVAILABLE", raw: null };
    if (!read.ok) console.error("[ai/paused] paid-request gate unreadable; refusing paid requests (fail closed)");
    return combinePaidRequests(killSwitch, { decision: verdict.decision, factState: verdict.evidence?.state ?? null });
  } catch (err) {
    console.error("[ai/paused] paid-request gate unreadable; refusing paid requests (fail closed):", err);
    return { paused: true, state: "UNAVAILABLE", raw: null, controlPlane: "DENY", cause: "UNAVAILABLE" };
  }
}

/** The injectable shape the provider chokepoint takes (UsageSinks.paidRequestsAdmission). */
export type PaidRequestsAdmissionReader = () => Promise<PaidRequestsAdmission>;

/** The one refusal body — `{ error, code: "AI_PAUSED" }`, 503, no-store. */
export function paidRequestsPausedResponse(): NextResponse {
  return NextResponse.json(
    { error: AI_PAUSED_CUSTOMER_MESSAGE, code: AI_PAUSED_CODE },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
