/**
 * lib/notifications/create.ts  (OPS-3 S1)
 *
 * THE single user-notification chokepoint. Every producer — routes, EV-1
 * handlers, future jobs, future AI agents — calls createNotification();
 * nothing else in the codebase writes a Notification row (grep-enforced:
 * `.notification.create` appears only in this file, the lib/email/providers
 * single-import-site idiom).
 *
 * S1 PIPELINE (frozen — docs/initiatives/ops3/OPS3_IMPLEMENTATION_PLAN.md):
 *   1. Validate the type against the registry (unknown → THROW at the
 *      producer; the emitDomainEvent "no AuditAction mapped" idiom — a
 *      programmer error, not a runtime condition).
 *   2. Compute the dedupe key from the registry template (F3).
 *   3. Render title/body/href (pure registry render).
 *   4. Insert the Notification row, enforcing dedupe via the reserved
 *      @@unique([userId, dedupeKey]) constraint (race-safe by construction).
 *
 * NOT HERE (later slices, by frozen scope): preference resolution (S3),
 * external-channel delivery / NotificationDelivery writes (S4), digests and
 * cleanup (S6). No email is sent from this module.
 *
 * NON-THROWING at runtime: after input validation, every DB outcome resolves
 * to a CreateNotificationResult — a notification failure must never fail the
 * originating request (the EmailResult / dispatch-handler contract).
 *
 * DEDUPE SEMANTICS (F3 — suppress-while-open):
 *   none     → plain insert.
 *   suppress → if an UN-ARCHIVED row holds the same (userId, dedupeKey), the
 *              insert is a no-op ("suppressed"). If the holder is ARCHIVED,
 *              its key is released (set null) and the insert retried once —
 *              a resolved-then-recurred condition notifies again.
 *   refresh  → v1 falls back to suppress (frozen: "v1 implements suppress
 *              only"; Wave 3 implements refresh or keeps the fallback —
 *              plan S5, registry DUPLICATE_DETECTED note).
 *
 * CLIENT TYPING: the shared Prisma client gains the `notification` delegate
 * when `prisma generate` runs against the S1 migration. To keep this module
 * compile-independent of client regeneration (and to give tests a pure
 * injection seam — the house "no live DB in unit tests" rule), it is typed
 * against the narrow NotificationWriteClient interface below and the shared
 * client is cast to it once. The cast is structurally sound against the
 * generated client.
 */

import { db } from "@/lib/db";
import {
  isChannelEnabledForUser,
  type PreferenceClient,
} from "@/lib/notifications/preferences";
import {
  getNotificationDefinition,
  type NotificationTypeId,
} from "@/lib/notifications/registry";
import type {
  NotificationInput,
  NotificationRenderData,
} from "@/lib/notifications/types";

// ── Narrow write-client contract (injection seam for pure tests) ─────────────

/** The single row shape dedupe resolution needs to read back. */
export interface ExistingNotificationRow {
  id: string;
  archivedAt: Date | null;
}

/** Exactly the three operations the chokepoint performs — nothing more. */
export interface NotificationWriteClient {
  notification: {
    create(args: {
      data: {
        userId: string;
        spaceId: string | null;
        category: string;
        type: string;
        priority: string;
        title: string;
        body: string | null;
        href: string | null;
        metadata?: NotificationRenderData;
        auditLogId: string | null;
        dedupeKey: string | null;
        expiresAt: Date | null;
      };
      select: { id: true };
    }): Promise<{ id: string }>;
    findUnique(args: {
      where: { userId_dedupeKey: { userId: string; dedupeKey: string } };
      select: { id: true; archivedAt: true };
    }): Promise<ExistingNotificationRow | null>;
    update(args: {
      where: { id: string };
      data: { dedupeKey: null };
      select: { id: true };
    }): Promise<{ id: string }>;
  };
}

/**
 * The outcome of a createNotification call. Runtime-non-throwing contract.
 * "skipped" (OPS-3 S3) mirrors EmailResult's vocabulary: no row was written
 * BY DESIGN — the recipient disabled the type's category for IN_APP and the
 * category is not locked. Preference resolution: lib/notifications/preferences.ts.
 */
export interface CreateNotificationResult {
  status: "created" | "suppressed" | "skipped" | "error";
  /** The Notification row id when status === "created". */
  id?: string;
  /** Human-readable reason when status === "error". */
  error?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Prisma unique-constraint violation (P2002), duck-typed so injected test clients can simulate it. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/**
 * Fill a registry dedupe template ("SYNC_FAILED:item:{plaidItemId}:open").
 * Placeholders resolve from the input's data (contract keys) or userId.
 * A missing/non-string placeholder value is a producer bug → THROW (input
 * validation, same class as an unknown type).
 */
function fillDedupeTemplate(
  template: string,
  userId: string,
  data: NotificationRenderData,
): string {
  return template.replace(/\{([^}]+)\}/g, (_m, key: string) => {
    const value = key === "userId" ? userId : data[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `createNotification: dedupe template placeholder "{${key}}" has no string value in input data`,
      );
    }
    return value;
  });
}

// ── The chokepoint ────────────────────────────────────────────────────────────

/**
 * Create a user notification (in-app record; the Notification row IS the
 * in-app delivery). See the module header for the full contract.
 *
 * @param input  Producer input; `type` must be a registry id.
 * @param ctx    Optional injected client (tests). Defaults to the shared client.
 */
export async function createNotification(
  input: NotificationInput<NotificationTypeId>,
  ctx?: { client?: NotificationWriteClient; prefClient?: PreferenceClient },
): Promise<CreateNotificationResult> {
  // 1. Registry gate — unknown types throw at the producer (programmer error).
  const def = getNotificationDefinition(input.type);
  if (!def) {
    throw new Error(
      `createNotification: no registry entry for notification type "${input.type}"`,
    );
  }

  // Structural sanity only (F6): metadata must be a plain object when present;
  // pointer CONTENTS are the producer's contract, not validated here.
  const data: NotificationRenderData = input.data ?? {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error(
      `createNotification: input.data for "${input.type}" must be a plain object`,
    );
  }

  // 1b. Preference gate (OPS-3 S3, frozen F11): the Notification row IS the
  // in-app delivery, so an IN_APP-disabled category creates no row. Locked
  // categories short-circuit to enabled inside the resolver. A preference-
  // read failure is a runtime error → non-throwing error result.
  try {
    const inAppEnabled = await isChannelEnabledForUser(
      input.userId,
      input.type,
      "IN_APP",
      ctx?.prefClient ? { client: ctx.prefClient } : undefined,
    );
    if (!inAppEnabled) return { status: "skipped" };
  } catch (prefErr) {
    return {
      status: "error",
      error: prefErr instanceof Error ? prefErr.message : String(prefErr),
    };
  }

  // 2. Dedupe key (F3). "refresh" falls back to suppress in v1 (frozen).
  const dedupeKey =
    def.dedupe === "none" || def.dedupeKeyTemplate === null
      ? null
      : fillDedupeTemplate(def.dedupeKeyTemplate, input.userId, data);

  // 3. Pure render — title/body/href from the single definition site.
  const rendered = def.render(data);

  const client: NotificationWriteClient =
    ctx?.client ?? (db as unknown as NotificationWriteClient);

  const row = {
    userId: input.userId,
    spaceId: input.spaceId ?? null,
    category: def.category,
    type: def.id,
    priority: def.priority,
    title: rendered.title,
    body: rendered.body ?? null,
    href: rendered.href ?? null,
    // Persist metadata exactly as supplied; omit entirely when absent (NULL).
    ...(input.data !== undefined ? { metadata: input.data } : {}),
    auditLogId: input.auditLogId ?? null,
    dedupeKey,
    expiresAt: input.expiresAt ?? null,
  };

  // 4. Insert, race-safe against the reserved unique constraint.
  try {
    const created = await client.notification.create({
      data: row,
      select: { id: true },
    });
    return { status: "created", id: created.id };
  } catch (err) {
    if (!isUniqueViolation(err) || dedupeKey === null) {
      return {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Unique violation on (userId, dedupeKey): resolve suppress-while-open.
  try {
    const existing = await client.notification.findUnique({
      where: { userId_dedupeKey: { userId: input.userId, dedupeKey } },
      select: { id: true, archivedAt: true },
    });

    // Open holder → the condition is already surfaced. Suppress.
    if (existing && existing.archivedAt === null) {
      return { status: "suppressed" };
    }

    // Archived holder → release its key (":open" retired) so the recurred
    // condition can notify again.
    if (existing) {
      await client.notification.update({
        where: { id: existing.id },
        data: { dedupeKey: null },
        select: { id: true },
      });
    }
    // (existing === null: the holder vanished between insert and read — fall
    // through and retry once.)

    const created = await client.notification.create({
      data: row,
      select: { id: true },
    });
    return { status: "created", id: created.id };
  } catch (retryErr) {
    // A second unique violation means a concurrent producer won the retry
    // race — the condition IS surfaced, which is exactly suppression.
    if (isUniqueViolation(retryErr)) {
      return { status: "suppressed" };
    }
    return {
      status: "error",
      error: retryErr instanceof Error ? retryErr.message : String(retryErr),
    };
  }
}
