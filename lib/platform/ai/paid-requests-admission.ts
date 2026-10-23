/**
 * lib/platform/ai/paid-requests-admission.ts  (AI COST CONTROLS — the kill switch)
 *
 * MAY A PAID AI REQUEST BEGIN? One PlatformSetting row, `ai_paid_requests_paused`,
 * judged with the admission-fact contract (lib/platform/admission/policy-core.ts):
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
import { PlatformSettingKey } from "@/lib/platform-settings";

/** The refusal code every surface answers with. */
export const AI_PAUSED_CODE = "AI_PAUSED" as const;

/** The sentence customers read while paused (KillSwitchView.customerMessage carries the same words). */
export const AI_PAUSED_CUSTOMER_MESSAGE =
  "AI features are paused for maintenance. Nothing was changed. Please try again later.";

/** The admission-fact states (the same five words as lib/platform/admission/types.ts; not imported — that module's consumer census is closed). */
export type PaidRequestsAdmissionState = "ON" | "OFF" | "MISSING" | "INVALID" | "UNAVAILABLE";

export interface PaidRequestsAdmission {
  paused: boolean;
  state: PaidRequestsAdmissionState;
  /** The row's raw value when one was read (never logged by callers). */
  raw: string | null;
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

export interface PaidRequestsReadClient {
  platformSetting: {
    findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null>;
  };
}

const DEFAULT_CLIENT = (): PaidRequestsReadClient => systemDb as unknown as PaidRequestsReadClient;

/** The reader. Never throws: an unreadable store is PAUSED (UNAVAILABLE). */
export async function readPaidRequestsAdmission(client: PaidRequestsReadClient = DEFAULT_CLIENT()): Promise<PaidRequestsAdmission> {
  try {
    const row = await client.platformSetting.findUnique({ where: { key: PlatformSettingKey.AI_PAID_REQUESTS_PAUSED }, select: { value: true } });
    return judgePaidRequests(row?.value ?? null);
  } catch (err) {
    console.error("[ai/paused] kill switch unreadable; refusing paid requests (fail closed):", err);
    return { paused: true, state: "UNAVAILABLE", raw: null };
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
