/**
 * lib/platform/ai/spend-thresholds.ts  (BETA C7 — the two spend-alert thresholds)
 *
 * The `ai-spend-fleet-high` and `ai-spend-user-high` rules judge estimated USD against two PlatformSetting
 * keys the coordinator froze on the base: `ai_spend_alert_fleet_usd_24h`
 * (default 10) and `ai_spend_alert_user_usd_24h` (default 3). Both are
 * OPERATOR_CONFIGURABLE integers written only through the validated setting
 * path; this module READS them and says where each value came from.
 *
 * The resolution is the job-cadence idiom: the row is read so MISSING can be
 * told from INVALID, the descriptor validates the stored string, and an
 * unreadable row falls back to the DEFAULT while reporting `INVALID_SETTING` —
 * a threshold never silently becomes "no threshold".
 *
 * PURE CORE (`resolveAiSpendThreshold`) + NARROW LOADER (`loadAiSpendThresholds`,
 * fm_system — PlatformSetting is an operator table).
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { PlatformSettingKey, getSettingDescriptor, validateSetting, type PlatformSettingKeyType } from "@/lib/platform-settings";
import { FLEET_CEILING_SETTING_KEY, resolveFleetCeiling, type FleetCeiling } from "@/lib/platform/ai/fleet-ceiling.core";

export type ThresholdOrigin = "DEFAULT" | "SETTING" | "INVALID_SETTING";

export interface AiSpendThreshold {
  key: PlatformSettingKeyType;
  label: string;
  /** The threshold in force, whole USD. */
  usd: number;
  defaultUsd: number;
  origin: ThresholdOrigin;
  /** The row's version (ISO) when one exists; null when the default is in force by absence. */
  updatedAt: string | null;
}

export interface AiSpendThresholds {
  fleet: AiSpendThreshold;
  user: AiSpendThreshold;
  /**
   * SEC-AI-001 — the OPTIONAL fleet ceiling (ABSENT_MEANS_OFF), read in the same
   * query as the two thresholds. Optional on the type so a caller that supplies
   * only the thresholds means "no ceiling".
   */
  fleetCeiling?: FleetCeiling;
}

export const AI_SPEND_THRESHOLD_KEYS = {
  fleet: PlatformSettingKey.AI_SPEND_ALERT_FLEET_USD,
  user: PlatformSettingKey.AI_SPEND_ALERT_USER_USD,
} as const;

/** PURE — one key's effective threshold from its stored row (null = no row). */
export function resolveAiSpendThreshold(
  key: PlatformSettingKeyType,
  row: { value: string; updatedAt: Date } | null,
): AiSpendThreshold {
  const d = getSettingDescriptor(key);
  const defaultUsd = Number.parseInt(d.default, 10);
  if (!row) return { key, label: d.label, usd: defaultUsd, defaultUsd, origin: "DEFAULT", updatedAt: null };
  const v = validateSetting(key, row.value);
  if (!v.ok) return { key, label: d.label, usd: defaultUsd, defaultUsd, origin: "INVALID_SETTING", updatedAt: row.updatedAt.toISOString() };
  return { key, label: d.label, usd: Number.parseInt(v.value, 10), defaultUsd, origin: "SETTING", updatedAt: row.updatedAt.toISOString() };
}

export interface ThresholdReadClient {
  platformSetting: {
    findMany(args: { where: { key: { in: string[] } }; select: { key: true; value: true; updatedAt: true } }):
      Promise<{ key: string; value: string; updatedAt: Date }[]>;
  };
}

/** The one read: the three rows in one query, resolved through the descriptors. */
export async function loadAiSpendThresholds(client: ThresholdReadClient = systemDb): Promise<AiSpendThresholds> {
  const keys: string[] = [AI_SPEND_THRESHOLD_KEYS.fleet, AI_SPEND_THRESHOLD_KEYS.user, FLEET_CEILING_SETTING_KEY];
  const rows = await client.platformSetting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true, updatedAt: true } });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return {
    fleet: resolveAiSpendThreshold(AI_SPEND_THRESHOLD_KEYS.fleet, byKey.get(AI_SPEND_THRESHOLD_KEYS.fleet) ?? null),
    user: resolveAiSpendThreshold(AI_SPEND_THRESHOLD_KEYS.user, byKey.get(AI_SPEND_THRESHOLD_KEYS.user) ?? null),
    fleetCeiling: resolveFleetCeiling(byKey.get(FLEET_CEILING_SETTING_KEY)?.value ?? null),
  };
}
