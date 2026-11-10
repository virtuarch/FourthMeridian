/**
 * lib/platform/intelligence/ai/engine/router.ts  (Platform AI P2 — pack flags + the router hook STUB)
 *
 * PACK FLAGS (design v2 §11, I-8). Which server flag governs each declared pack:
 *   metrics, navigation   PLATFORM_AI_ENABLED (env.isPlatformAiEnabled) — the packs Platform AI
 *                         has always had; ON wherever Platform AI itself is ON, so today's
 *                         behaviour is unchanged (no new flag to set).
 *   memory                the existing memory flag (memory/gate.ts isMemoryEffective: Platform AI
 *                         + conversations + purge + memory + memory purge, 7-day retention).
 *   future packs (P5+)    their own PLATFORM_AI_PACK_<P>_ENABLED getter in lib/env.ts (strict,
 *                         implies the master flag, default OFF) — added to PACK_FLAG with the
 *                         pack's PR, never ahead of it.
 * A pack with no entry is OFF. invokeTool (authz/boundary.ts step 1) re-checks this on EVERY call.
 *
 * ROUTER (stub, P2): `routePlatformAiPacks` returns every declared, flag-ON pack the turn
 * can serve (memory only when the turn carries memory hooks). P3 replaces it with the
 * deterministic keyword router (≤ 3 packs + previous turn's packs + held handles); the
 * boundary already refuses a tool whose pack is not in the routed set.
 */

import { env as liveEnv } from "@/lib/env";
import { isMemoryEffective } from "../memory/gate";
import { TOOL_PACKS, type ToolPack } from "../tools/contract";

/** The env getters the pack flags read (a test passes its own). */
export type PackFlagEnv = Pick<typeof liveEnv, "isPlatformAiEnabled" | "isPlatformAiMemoryEnabled">;

const PACK_FLAG: Readonly<Record<ToolPack, (e: PackFlagEnv) => boolean>> = {
  metrics: (e) => e.isPlatformAiEnabled === true,
  navigation: (e) => e.isPlatformAiEnabled === true,
  memory: (e) => e.isPlatformAiEnabled === true && isMemoryEffective(e),
};

/** Is this pack's server flag ON? Unknown pack ⇒ false. */
export function platformAiPackEnabled(pack: ToolPack, e: PackFlagEnv = liveEnv): boolean {
  const f = (PACK_FLAG as Record<string, ((x: PackFlagEnv) => boolean) | undefined>)[pack];
  return typeof f === "function" && f(e) === true;
}

/**
 * THE ROUTER HOOK (stub until P3): the packs this turn offers — every declared pack whose
 * flag is ON, memory only when the turn has memory hooks. Order = TOOL_PACKS.
 */
export function routePlatformAiPacks(turn: { memory: boolean }, e: PackFlagEnv = liveEnv): ToolPack[] {
  return TOOL_PACKS.filter((p) => (p !== "memory" || turn.memory) && platformAiPackEnabled(p, e));
}
