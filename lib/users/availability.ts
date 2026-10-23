/**
 * lib/users/availability.ts  (RLS-13)
 *
 * "IS THIS USERNAME / EMAIL ALREADY TAKEN?" — AND NOTHING ELSE.
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
 * Uniqueness is a DEPLOYMENT-WIDE question and it cannot be answered by the
 * tenant role. fm_app's `User` SELECT policy is `id = current_fm_user_id()`, so
 * asking it whether a username is taken returns nothing and every name reads as
 * free — the check would silently become a no-op and the unique index would
 * start rejecting saves the UI had just promised would work.
 *
 * The naive fix is to let the two routes that need it keep a deployment-wide
 * client. That is how a general lookup escape hatch gets built: once an
 * authenticated route holds a client that can read every User row, the next
 * person with a reason to read one more column has a precedent rather than a
 * decision. So the capability is narrowed to its actual shape instead.
 *
 * ── THE SHAPE OF THE NARROWING ───────────────────────────────────────────────
 * Each function takes exactly the value being tested, runs ONE `count` behind
 * a unique index, and returns a BOOLEAN. No row, no id, no column, nothing a
 * caller could accumulate into a directory. The widest authority in the system
 * is reached through the narrowest possible opening.
 *
 * The audit (scripts/audit-db-authority.ts) confines `systemDb` by path, so
 * this file is listed there explicitly — the exception is reviewable rather
 * than ambient.
 *
 * ── ANTI-ENUMERATION IS A PROPERTY OF THE CALLER, NOT OF THIS MODULE ─────────
 * A boolean here is still an oracle if a route hands it to an unauthenticated
 * stranger. Both current callers are authenticated and already return the same
 * 409 the unique index would force, so they disclose nothing new. Any FUTURE
 * caller on an unauthenticated surface — a signup form, a "check availability"
 * endpoint — must rate-limit and must not vary its response by existence;
 * `lib/auth.ts` and the password-reset routes already take that care, and the
 * reason it is written here is that this module is where someone will come
 * looking for a shortcut.
 */

import "server-only";

import { systemDb } from "@/lib/db";

/**
 * True when no OTHER user holds this username.
 *
 * `exceptUserId` is the caller renaming themselves: their own row must not
 * make their current name look taken.
 */
export async function isUsernameAvailable(
  username: string,
  exceptUserId?: string,
): Promise<boolean> {
  const normalized = username.trim().toLowerCase();
  if (!normalized) return false;
  const n = await systemDb.user.count({
    where: exceptUserId
      ? { username: normalized, NOT: { id: exceptUserId } }
      : { username: normalized },
  });
  return n === 0;
}

/** True when no OTHER user holds this email address. */
export async function isEmailAvailable(
  email: string,
  exceptUserId?: string,
): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  const n = await systemDb.user.count({
    where: exceptUserId
      ? { email: normalized, NOT: { id: exceptUserId } }
      : { email: normalized },
  });
  return n === 0;
}
