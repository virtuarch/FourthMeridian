/**
 * lib/platform/cost-freeze.ts  (BETA LIFECYCLE L2 — the GLOBAL cost freeze read)
 *
 * The uncached read platform-wide jobs make BEFORE any vendor call (the FX and
 * security-price jobs, the sync-crypto global price steps, the history worker's
 * all-holder price pass, the on-read FX refresh). See cost-freeze.core.ts for
 * the flag's contract. fm_system: PlatformSetting is an operator table; the
 * read is a primary-key lookup. Never throws — an unreadable flag is FROZEN.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { PlatformSettingKey } from "@/lib/platform-settings";
import { judgeGlobalCostFreeze, type GlobalCostFreezeVerdict } from "./cost-freeze.core";

export { judgeGlobalCostFreeze, type GlobalCostFreezeVerdict, type GlobalCostFreezeState } from "./cost-freeze.core";

export interface GlobalCostFreezeReadClient {
  platformSetting: { findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null> };
}

export type GlobalCostFreezeReader = () => Promise<GlobalCostFreezeVerdict>;

export async function readGlobalCostFreeze(
  client: GlobalCostFreezeReadClient = systemDb as unknown as GlobalCostFreezeReadClient,
): Promise<GlobalCostFreezeVerdict> {
  try {
    const row = await client.platformSetting.findUnique({ where: { key: PlatformSettingKey.PLATFORM_COST_FROZEN }, select: { value: true } });
    return judgeGlobalCostFreeze(row?.value ?? null);
  } catch (e) {
    console.error("[cost-freeze] global cost-freeze flag unreadable; platform vendor work refused (fail closed) —",
      e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : "unknown error");
    return judgeGlobalCostFreeze(null, true);
  }
}
