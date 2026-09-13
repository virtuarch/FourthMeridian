/**
 * lib/platform/refresh-policy.ts
 *
 * The one read behind refresh-policy.core.ts: both cadence settings, in one query.
 *
 * ⚠️ NEVER THROWS. Source health is a display of facts; an unreadable settings
 * table must not blank the Brief or the Connections page. It falls back to the
 * product defaults and logs — the same posture as getSetting()'s defaults.
 * (Admission is different on purpose: an unreadable PAUSE flag must deny.)
 *
 * ⚠️ PER ENVIRONMENT BY CONSTRUCTION. PlatformSetting lives in each environment's
 * own database, so a local 6h bank expectation never touches production.
 */

import 'server-only';
import type { PrismaClient } from '@prisma/client';
import {
  REFRESH_CADENCE_SETTING_KEY, resolveRefreshPolicy,
  type RefreshPolicy, type RefreshSourceKind,
} from './refresh-policy.core';

export type RefreshPolicies = Readonly<Record<RefreshSourceKind, RefreshPolicy>>;

type Client = Pick<PrismaClient, 'platformSetting'>;

export async function loadRefreshPolicies(client?: Client): Promise<RefreshPolicies> {
  let rows: { key: string; value: string; updatedAt: Date }[] = [];
  try {
    const c = client ?? (await import('@/lib/db')).db;
    rows = await c.platformSetting.findMany({
      where:  { key: { in: Object.values(REFRESH_CADENCE_SETTING_KEY) } },
      select: { key: true, value: true, updatedAt: true },
    });
  } catch (err) {
    console.error('[refresh-policy] settings unreadable; using the default cadences:', err);
  }
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const resolve = (sourceKind: RefreshSourceKind) =>
    resolveRefreshPolicy({ sourceKind }, byKey.get(REFRESH_CADENCE_SETTING_KEY[sourceKind]) ?? null);
  return { BANK: resolve('BANK'), WALLET: resolve('WALLET') };
}
