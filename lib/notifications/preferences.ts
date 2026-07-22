/**
 * lib/notifications/preferences.ts  (OPS-3 S3)
 *
 * The preference layer: resolution policy (pure) + the isolated reads/writes
 * over NotificationPreference. Nothing else touches that table (grep-enforced
 * single site, the chokepoint idiom).
 *
 * RESOLUTION (frozen F11 — default-by-absence):
 *   1. locked category (ACCOUNT_SECURITY) → forced ON, always.
 *   2. override row present               → the row wins.
 *   3. otherwise                          → the registry default
 *      (defaultChannels includes the channel).
 * A row exists ONLY when the user deviates from the default: no per-user
 * seeding, and a new category ships with sane defaults for every existing
 * user instantly.
 *
 * MATRIX SURFACE: category × channel for the Settings page. Channels shown =
 * the OPS-3 pair (IN_APP, EMAIL) — PUSH/SMS/WEBHOOK are vocabulary with no
 * adapter and no preference surface. The DIGEST category is excluded from the
 * matrix by doctrine (registry DIGEST_SENT note): its preference surface is
 * the digest-frequency setting (S6), not a category row.
 *
 * ENFORCEMENT: lib/notifications/create.ts consults isChannelEnabledForUser
 * for IN_APP from this slice on. EMAIL enforcement activates when the S4
 * adapter exists — the preference itself is already writable here.
 */

import { db } from "@/lib/db";
import {
  NOTIFICATION_REGISTRY,
  type NotificationTypeId,
} from "@/lib/notifications/registry";
import type {
  NotificationCategory,
  NotificationChannel,
  NotificationTypeDefinition,
} from "@/lib/notifications/types";

// ── Surface vocabulary ────────────────────────────────────────────────────────

/** The channels with a preference surface in OPS-3. */
export const PREFERENCE_CHANNELS = ["IN_APP", "EMAIL"] as const satisfies readonly NotificationChannel[];
export type PreferenceChannel = (typeof PREFERENCE_CHANNELS)[number];

/** Matrix categories: every registry category except DIGEST (doctrine above). */
export const PREFERENCE_CATEGORIES: NotificationCategory[] = [
  ...new Set(Object.values(NOTIFICATION_REGISTRY).map((e) => e.category)),
].filter((c) => c !== "DIGEST");

/** True when the category is locked (uniform per category — registry-tested). */
export function isLockedCategory(category: string): boolean {
  return Object.values(NOTIFICATION_REGISTRY).some(
    (e) => e.category === category && e.locked,
  );
}

/**
 * The registry DEFAULT for (category, channel): enabled when ANY type in the
 * category defaults to that channel. (Categories are channel-uniform today
 * except deliberate per-type outliers like SYNC_COMPLETED-off and
 * invite-email-on; "any" makes the category toggle mean "the category's
 * channel-using types", which is the least surprising reading.)
 */
export function categoryDefault(category: string, channel: PreferenceChannel): boolean {
  return Object.values(NOTIFICATION_REGISTRY).some(
    // Widened: each registry entry's defaultChannels is a narrow as-const
    // tuple, so their union's .includes() parameter collapses to never.
    (e) => e.category === category && (e.defaultChannels as readonly string[]).includes(channel),
  );
}

// ── Pure resolution ───────────────────────────────────────────────────────────

/** An override row's shape (structural subset of the Prisma model). */
export interface PreferenceOverride {
  category: string;
  channel: string;
  enabled: boolean;
}

/**
 * Resolve whether `channel` is enabled for a notification TYPE given the
 * caller's override rows. Pure — the policy in one testable place.
 */
export function resolveChannelEnabled(
  def: NotificationTypeDefinition,
  channel: PreferenceChannel,
  overrides: readonly PreferenceOverride[],
): boolean {
  // Locked = the user cannot OVERRIDE — registry defaults are authoritative
  // (S5 amendment; the S4 freeze's own words). Not "all channels on": the
  // security EMAIL guarantee lives in the OPS-2 security-alert flow, and
  // forcing the notification email too would double-email every event.
  if (def.locked) return def.defaultChannels.includes(channel);
  const row = overrides.find(
    (o) => o.category === def.category && o.channel === channel,
  );
  if (row) return row.enabled;
  return def.defaultChannels.includes(channel);
}

// ── Narrow preference-client contract (injection seam for pure tests) ────────

export interface PreferenceClient {
  notificationPreference: {
    findMany(args: {
      where: { userId: string };
      select: { category: true; channel: true; enabled: true };
    }): Promise<PreferenceOverride[]>;
    upsert(args: {
      where: {
        userId_category_channel: { userId: string; category: string; channel: string };
      };
      create: { userId: string; category: string; channel: string; enabled: boolean };
      update: { enabled: boolean };
      select: { id: true };
    }): Promise<{ id: string }>;
  };
}

function client(ctx?: { client?: PreferenceClient }): PreferenceClient {
  return ctx?.client ?? (db as unknown as PreferenceClient);
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** One matrix row for the Settings page. */
export interface PreferenceMatrixRow {
  category: NotificationCategory;
  locked: boolean;
  channels: Record<PreferenceChannel, boolean>; // EFFECTIVE values (default ⊕ override)
}

/** The full effective matrix for the caller (registry-driven, no seeding). */
export async function getPreferenceMatrix(
  userId: string,
  ctx?: { client?: PreferenceClient },
): Promise<PreferenceMatrixRow[]> {
  const overrides = await client(ctx).notificationPreference.findMany({
    where: { userId },
    select: { category: true, channel: true, enabled: true },
  });

  return PREFERENCE_CATEGORIES.map((category) => {
    const locked = isLockedCategory(category);
    const channels = {} as Record<PreferenceChannel, boolean>;
    for (const ch of PREFERENCE_CHANNELS) {
      if (locked) {
        // Locked rows render the authoritative registry defaults (disabled in
        // the UI) — not all-on (S5 amendment).
        channels[ch] = categoryDefault(category, ch);
      } else {
        const row = overrides.find((o) => o.category === category && o.channel === ch);
        channels[ch] = row ? row.enabled : categoryDefault(category, ch);
      }
    }
    return { category, locked, channels };
  });
}

/**
 * Effective per-TYPE check for the chokepoint: one findMany, then the pure
 * resolver. Best-effort callers (create.ts) treat a thrown DB error as their
 * own error path.
 */
export async function isChannelEnabledForUser(
  userId: string,
  type: NotificationTypeId,
  channel: PreferenceChannel,
  ctx?: { client?: PreferenceClient },
): Promise<boolean> {
  const def = NOTIFICATION_REGISTRY[type];
  // Locked: registry defaults authoritative, no read needed (S5 amendment).
  if (def.locked) return (def.defaultChannels as readonly string[]).includes(channel);
  const overrides = await client(ctx).notificationPreference.findMany({
    where: { userId },
    select: { category: true, channel: true, enabled: true },
  });
  return resolveChannelEnabled(def, channel, overrides);
}

// ── Writes ────────────────────────────────────────────────────────────────────

export type SetPreferenceResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Upsert one override cell. Validates against the registry vocabulary and
 * REJECTS locked categories (the API's 4xx; the UI renders them
 * checked-disabled so this is defense in depth, not the primary UX).
 */
export async function setNotificationPreference(
  userId: string,
  category: string,
  channel: string,
  enabled: boolean,
  ctx?: { client?: PreferenceClient },
): Promise<SetPreferenceResult> {
  if (!PREFERENCE_CATEGORIES.includes(category as NotificationCategory)) {
    return { ok: false, error: `Unknown notification category "${category}".` };
  }
  if (!(PREFERENCE_CHANNELS as readonly string[]).includes(channel)) {
    return { ok: false, error: `Unknown notification channel "${channel}".` };
  }
  if (isLockedCategory(category)) {
    return { ok: false, error: "Security notifications can't be turned off." };
  }

  await client(ctx).notificationPreference.upsert({
    where: { userId_category_channel: { userId, category, channel } },
    create: { userId, category, channel, enabled },
    update: { enabled },
    select: { id: true },
  });
  return { ok: true };
}
