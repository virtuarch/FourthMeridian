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
 * S3 added preference resolution (one read, both channels); S4 added the
 * EMAIL leg: after a successful insert, the pre-rendered message goes to the
 * EMAIL channel adapter (a thin mapping over the OPS-1 sendEmail chokepoint)
 * and ONE NotificationDelivery row is written from its result, verbatim —
 * bookkeeping is single-sited HERE so no path can deliver without recording
 * (the OPS-5 invariant). Delivery runs post-response via next/server after()
 * when a request scope exists, inline otherwise (unit tests, scripts).
 * NOT HERE (by frozen scope): digests (S6, deferred) · cleanup (S6 — a
 * dispatcher job since OPS-4 S3) · retries (OPS-4 S4 —
 * jobs/retry-notifications.ts consumes the outbox; attempts starts at 1
 * HERE and is incremented only there).
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
import { emailNotificationAdapter } from "@/lib/notifications/channels/email";
import {
  resolveChannelEnabled,
  type PreferenceClient,
  type PreferenceOverride,
} from "@/lib/notifications/preferences";
import {
  getNotificationDefinition,
  type NotificationTypeId,
} from "@/lib/notifications/registry";
import type {
  ChannelAdapter,
  NotificationInput,
  NotificationRenderData,
} from "@/lib/notifications/types";

// ── Narrow write-client contract (injection seam for pure tests) ─────────────

/** The single row shape dedupe resolution needs to read back. */
export interface ExistingNotificationRow {
  id: string;
  archivedAt: Date | null;
}

/** Exactly the operations the chokepoint performs — nothing more. */
export interface NotificationWriteClient {
  /** Recipient email resolution for the EMAIL channel (S4). */
  user: {
    findUnique(args: {
      where: { id: string };
      select: { email: true };
    }): Promise<{ email: string } | null>;
  };
  /** Delivery bookkeeping (S4) — one row per external-channel attempt. */
  notificationDelivery: {
    create(args: {
      data: {
        notificationId: string;
        channel: string;
        status: string;
        provider: string | null;
        providerMessageId: string | null;
        error: string | null;
        attempts: number;
        deliveredAt: Date | null;
      };
      select: { id: true };
    }): Promise<{ id: string }>;
  };
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
export function fillDedupeTemplate(
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

// ── Deferred execution (S4) ───────────────────────────────────────────────────

/**
 * Run delivery work post-response when a request scope exists (next/server
 * after() — the D2.x deferred-history precedent), inline otherwise (unit
 * tests, scripts, any non-request context, where after() throws).
 */
async function runAfterResponse(task: () => Promise<void>): Promise<void> {
  try {
    const { after } = await import("next/server");
    after(task);
  } catch {
    await task();
  }
}

/**
 * S4: deliver ONE email attempt through the channel adapter and record ONE
 * NotificationDelivery row from its result, verbatim (frozen: status /
 * provider / providerMessageId / error field-for-field; deliveredAt only on
 * "sent"; attempts starts at 1 and is never incremented here — retries are
 * OPS-4). Best-effort end to end: a failure here is logged and swallowed —
 * the Notification row already exists and the originating request must never
 * feel delivery problems.
 */
async function deliverEmailAndRecord(args: {
  notificationId: string;
  userId: string;
  type: string;
  category: import("@/lib/notifications/types").NotificationCategory;
  priority: import("@/lib/notifications/types").NotificationPriorityValue;
  title: string;
  body?: string;
  href?: string;
  client: NotificationWriteClient;
  adapter: ChannelAdapter;
}): Promise<void> {
  try {
    const recipient = await args.client.user.findUnique({
      where: { id: args.userId },
      select: { email: true },
    });

    const result = await args.adapter.deliver({
      userId: args.userId,
      ...(recipient?.email ? { email: recipient.email } : {}),
      type: args.type,
      category: args.category,
      priority: args.priority,
      title: args.title,
      ...(args.body ? { body: args.body } : {}),
      ...(args.href ? { href: args.href } : {}),
    });

    await args.client.notificationDelivery.create({
      data: {
        notificationId: args.notificationId,
        channel: "EMAIL",
        status: result.status,
        provider: result.provider ?? null,
        providerMessageId: result.id ?? null,
        error: result.error ?? null,
        attempts: 1,
        deliveredAt: result.status === "sent" ? new Date() : null,
      },
      select: { id: true },
    });
  } catch (err) {
    console.warn(
      "[createNotification] email delivery bookkeeping failed (non-fatal):",
      err,
    );
  }
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
  ctx?: {
    client?: NotificationWriteClient;
    prefClient?: PreferenceClient;
    /** Injected EMAIL transport for tests; defaults to the OPS-1-backed adapter. */
    emailAdapter?: ChannelAdapter;
  },
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

  // 1b. Preference gate (OPS-3 S3, frozen F11) — S4: BOTH channels resolved
  // from one override read (locked categories short-circuit, no read). The
  // Notification row IS the in-app delivery, so an IN_APP-disabled category
  // creates no row — and since the row anchors NotificationDelivery (FK),
  // no email ships either; the row is the delivery anchor by design (S3
  // semantics stand). A preference-read failure → non-throwing error result.
  let overrides: PreferenceOverride[] = [];
  if (!def.locked) {
    // Locked categories never read overrides — registry defaults are
    // authoritative for them (S5 amendment); resolveChannelEnabled handles it.
    try {
      const prefDb: PreferenceClient =
        ctx?.prefClient ?? (db as unknown as PreferenceClient);
      overrides = await prefDb.notificationPreference.findMany({
        where: { userId: input.userId },
        select: { category: true, channel: true, enabled: true },
      });
    } catch (prefErr) {
      return {
        status: "error",
        error: prefErr instanceof Error ? prefErr.message : String(prefErr),
      };
    }
  }
  if (!resolveChannelEnabled(def, "IN_APP", overrides)) {
    return { status: "skipped" };
  }
  const emailEnabled = resolveChannelEnabled(def, "EMAIL", overrides);

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

  // S4: on a successful insert, ship the EMAIL leg (preference-gated above)
  // and record its NotificationDelivery row. Post-response in request scope.
  const finishCreated = async (id: string): Promise<CreateNotificationResult> => {
    if (emailEnabled) {
      const adapter = ctx?.emailAdapter ?? emailNotificationAdapter;
      await runAfterResponse(() =>
        deliverEmailAndRecord({
          notificationId: id,
          userId: input.userId,
          type: def.id,
          category: def.category,
          priority: def.priority,
          title: rendered.title,
          ...(rendered.body ? { body: rendered.body } : {}),
          ...(rendered.href ? { href: rendered.href } : {}),
          client,
          adapter,
        }),
      );
    }
    return { status: "created", id };
  };

  // 4. Insert, race-safe against the reserved unique constraint.
  try {
    const created = await client.notification.create({
      data: row,
      select: { id: true },
    });
    return finishCreated(created.id);
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
    return finishCreated(created.id);
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
