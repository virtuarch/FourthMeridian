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

// RLS-7 — SYSTEM authority, whoever triggers it. This module writes
// NotificationDelivery, which fm_app is explicitly denied (it is operational
// delivery telemetry, not tenant content), and it is reached from the auth path
// (reactivation), from ~12 tenant routes, and from cron alike. Every one of its
// writes is inside a non-throwing try/catch, so under the tenant role the whole
// notification subsystem would have degraded SILENTLY — bells simply never
// appearing. One explicit authority is the honest answer; widening fm_app or
// fm_auth to reach delivery telemetry would not be.
import { systemDb as db } from "@/lib/db";
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
  NotificationTypeDefinition,
} from "@/lib/notifications/types";
import { notificationLedgerRow, recordDelivery } from "@/lib/notifications/delivery/record";
import { writeDeliveryRow } from "@/lib/notifications/delivery/store";
import { runAfterResponse } from "@/lib/notifications/delivery/defer";
import { EMAIL_ANCHOR_MARKER, isEmailAnchorMetadata } from "@/lib/notifications/email-anchor";
import { liveRenderFor, type LiveContentResolver } from "@/lib/notifications/content/send";
import { defaultLiveContentResolver, liveContentResolver } from "@/lib/notifications/content/store";
import type { CommsDeliveryRow, LedgerWriter } from "@/lib/notifications/delivery/types";

// ── Delivery ledger (Comms Center A-2a) ──────────────────────────────────────
//
// Every createNotification OUTCOME is one IN_APP CommsDelivery row: ACCEPTED
// (the Notification row — the in-app inbox — was written), SUPPRESSED with
// PREFERENCE_OFF / DEDUPE_OPEN, or FAILED (STORE). The email leg's own row is
// written by sendEmail itself (lib/email/send.ts); here only the email legs
// that never reach sendEmail are recorded: SUPPRESSED PREFERENCE_OFF (the
// user's EMAIL override, or the IN_APP-off coupling that drops the email too)
// and NO_RECIPIENT. Metadata only. Best-effort: a ledger failure is one
// redacted log line (recordDelivery) and never changes the result.

/** The ledger writer: injected (tests), the injected client's own delegate, or the production writer. */
function ledgerWriterFor(ctx: { client?: NotificationWriteClient; ledger?: LedgerWriter } | undefined): LedgerWriter | null {
  if (ctx?.ledger) return ctx.ledger;
  if (ctx?.client) {
    // A test-injected client records only if it models the ledger; it never falls through to a real DB.
    const c = ctx.client as unknown as { commsDelivery?: { createMany(args: { data: CommsDeliveryRow[] }): Promise<unknown> } };
    const delegate = c.commsDelivery;
    return delegate ? (row) => delegate.createMany({ data: [row] }) : null;
  }
  return writeDeliveryRow;
}

/**
 * Comms Center B1 — the live-content resolver: injected (tests), the injected
 * client's own content delegates when it models them, or the production
 * resolver. A test-injected client that does not model the content tables
 * renders the code default and never falls through to a real database.
 */
function contentResolverFor(ctx: { client?: NotificationWriteClient; content?: LiveContentResolver | null } | undefined): LiveContentResolver | null {
  if (ctx?.content !== undefined) return ctx.content;
  if (ctx?.client) {
    const c = ctx.client as unknown as { commsTemplate?: unknown; commsTemplateVersion?: unknown };
    return c.commsTemplate && c.commsTemplateVersion ? liveContentResolver(c as never) : null;
  }
  return defaultLiveContentResolver;
}

/** Comms Center B2 — what a caller stamps on the ledger rows of one createNotification call. */
export interface LedgerTag {
  /** The message the row belongs to (an automation item id), instead of the Notification id. */
  messageKey?: string;
  automationRunItemId?: string;
  mode?: "LIVE" | "TEST";
  attempt?: number;
}

/** Apply a ledger tag to one built row. Pure. */
export function tagLedgerRow(row: CommsDeliveryRow, tag: LedgerTag | undefined): CommsDeliveryRow {
  if (!tag) return row;
  return {
    ...row,
    ...(tag.messageKey ? { messageKey: tag.messageKey } : {}),
    ...(tag.automationRunItemId ? { automationRunItemId: tag.automationRunItemId } : {}),
    ...(tag.mode ? { mode: tag.mode } : {}),
    ...(tag.attempt && tag.attempt > 0 ? { attempt: Math.floor(tag.attempt) } : {}),
  };
}

/** One outcome createNotification records (the key, recipient, env and clock are filled in by `note`). */
type LedgerNote = Omit<Parameters<typeof notificationLedgerRow>[0], "key" | "recipientUserId" | "env" | "now">;

/** True when the type has an EMAIL leg that is on by default but the user's override turned off. */
function emailOffByPreference(def: NotificationTypeDefinition, emailEnabled: boolean): boolean {
  return !emailEnabled && !def.excludedChannels?.includes("EMAIL") && resolveChannelEnabled(def, "EMAIL", []);
}

// ── Narrow write-client contract (injection seam for pure tests) ─────────────

/** The single row shape dedupe resolution needs to read back. */
export interface ExistingNotificationRow {
  id: string;
  archivedAt: Date | null;
  /** Read to recognise an email anchor (EMAIL_ANCHOR_MARKER). Absent in narrow test fakes ⇒ not an anchor. */
  metadata?: unknown;
}

// A-2b email-anchor marker: lib/notifications/email-anchor.ts (pure; shared with the retry job).
export { EMAIL_ANCHOR_MARKER, isEmailAnchorMetadata };

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
        /** Set at birth ONLY for an email anchor (in-app off, email on — A-2b). */
        archivedAt?: Date;
      };
      select: { id: true };
    }): Promise<{ id: string }>;
    findUnique(args: {
      where: { userId_dedupeKey: { userId: string; dedupeKey: string } };
      select: { id: true; archivedAt: true; metadata: true };
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

/** The producer's data with the chokepoint-owned anchor marker removed. */
function withoutAnchorMarker(data: NotificationRenderData): NotificationRenderData {
  if (!(EMAIL_ANCHOR_MARKER in data)) return data;
  return Object.fromEntries(Object.entries(data).filter(([k]) => k !== EMAIL_ANCHOR_MARKER));
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
// runAfterResponse (post-response via next/server after() in a request scope,
// inline otherwise) lives in lib/notifications/delivery/defer.ts, shared with
// the sendEmail ledger write.

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
  actionLabel?: string;
  /** Comms Center B1 — the published EMAIL content, when the stream has one. */
  emailContent?: import("@/lib/notifications/types").ChannelMessage["emailContent"];
  client: NotificationWriteClient;
  adapter: ChannelAdapter;
  /** A-2a: the ledger writer, for the leg that never reaches sendEmail (no recipient). */
  writer?: LedgerWriter | null;
}): Promise<void> {
  try {
    let recipient: { email: string } | null;
    try {
      recipient = await args.client.user.findUnique({
        where: { id: args.userId },
        select: { email: true },
      });
    } catch (lookupErr) {
      // The address could not be read: the email leg is never attempted. Recorded, then
      // re-thrown into the existing best-effort catch below (unchanged behaviour).
      if (args.writer) {
        await recordDelivery(args.writer, notificationLedgerRow({
          key: args.type, channel: "EMAIL", status: "FAILED", errorCode: "RECIPIENT_LOOKUP",
          recipientUserId: args.userId, notificationId: args.notificationId, env: process.env, now: new Date(),
        }));
      }
      throw lookupErr;
    }

    const result = await args.adapter.deliver({
      userId: args.userId,
      notificationId: args.notificationId,
      ...(recipient?.email ? { email: recipient.email } : {}),
      type: args.type,
      category: args.category,
      priority: args.priority,
      title: args.title,
      ...(args.body ? { body: args.body } : {}),
      ...(args.href ? { href: args.href } : {}),
      ...(args.actionLabel ? { actionLabel: args.actionLabel } : {}),
      ...(args.emailContent ? { emailContent: args.emailContent } : {}),
    });

    if (!recipient?.email && result.status === "skipped" && args.writer) {
      // The adapter skipped before sendEmail (which records every send it makes).
      await recordDelivery(args.writer, notificationLedgerRow({
        key: args.type, channel: "EMAIL", status: "SUPPRESSED", reason: "NO_RECIPIENT",
        recipientUserId: args.userId, notificationId: args.notificationId, env: process.env, now: new Date(),
      }));
    }

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
    /** Injected delivery-ledger writer for tests (A-2a). */
    ledger?: LedgerWriter;
    /** Comms Center B1 — injected live-content resolver (tests); null = always the code default. */
    content?: LiveContentResolver | null;
    /**
     * Comms Center B2 — the IN-APP leg only: the type's EMAIL leg is neither
     * sent nor recorded here. An automation's in-app item and an operator's
     * in-app test send are ONE channel each; their email (if any) is its own
     * item with its own guards (lib/notifications/automations/engine.ts).
     */
    inAppOnly?: true;
    /** Comms Center B2 — stamped on every ledger row this call writes (automation item / TEST mode). */
    ledgerTag?: LedgerTag;
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

  // 1b. Preference gate (OPS-3 S3, F11) — S4: BOTH channels resolved from one
  // override read (locked types short-circuit, no read). The Notification row
  // IS the in-app delivery, so an IN_APP-disabled category creates no visible
  // row — and since the row anchors NotificationDelivery (FK) and the dedupe
  // key, by default no email ships either (S3 semantics).
  //
  // OWNER RULING 2026-10-31 (Comms Center A-2b, O-7) amends F11 for types
  // flagged `emailIndependentOfInApp` (SYNC_FAILED): their EMAIL leg follows
  // ONLY the category's EMAIL preference. With IN_APP off and EMAIL on, the row
  // is still written as an EMAIL ANCHOR — born ARCHIVED, so no inbox, unread
  // count or bell ever shows it (lib/notifications/read.ts activeWhere) — and
  // the email ships from it exactly as before: same NotificationDelivery row,
  // same suppress-while-open dedupe on the same key (an anchor counts as open
  // while the in-app channel is off), same retirement (resolve.ts releases
  // archived holders too). The ledger records IN_APP SUPPRESSED PREFERENCE_OFF
  // plus the email's own outcome. Every other type keeps the S3 coupling.
  // A preference-read failure → non-throwing error result.
  const writer = ledgerWriterFor(ctx);
  const ledgerNow = new Date();
  /** Record ledger rows post-response (inline outside a request); never throws, never blocks the result. */
  const note = async (...rows: LedgerNote[]) => {
    if (!writer || rows.length === 0) return;
    const kept = ctx?.inAppOnly ? rows.filter((r) => r.channel === "IN_APP") : rows;
    const built = kept.map((r) => tagLedgerRow(notificationLedgerRow({ ...r, key: def.id, recipientUserId: input.userId, env: process.env, now: ledgerNow }), ctx?.ledgerTag));
    await runAfterResponse(async () => {
      for (const row of built) await recordDelivery(writer, row);
    });
  };

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
      // Nothing is sent: the in-app row is not written, and its email leg (when the
      // type has one by default) is lost with it. Both are FAILED PREFERENCE_READ.
      await note(
        { channel: "IN_APP", status: "FAILED", errorCode: "PREFERENCE_READ" },
        ...(!def.excludedChannels?.includes("EMAIL") && resolveChannelEnabled(def, "EMAIL", [])
          ? [{ channel: "EMAIL" as const, status: "FAILED" as const, errorCode: "PREFERENCE_READ" as const }]
          : []),
      );
      return {
        status: "error",
        error: prefErr instanceof Error ? prefErr.message : String(prefErr),
      };
    }
  }
  // PB-5 — a type whose email is SHIPPED OFF in code (registry emailShippedOff)
  // never sends it: the leg that the preferences would have sent is recorded
  // SUPPRESSED / SHIPPED_OFF below instead of being silently dropped.
  const emailWanted = ctx?.inAppOnly ? false : resolveChannelEnabled(def, "EMAIL", overrides);
  const emailShippedOff = emailWanted && def.emailShippedOff === true;
  const emailEnabled = emailWanted && !emailShippedOff;
  const inAppEnabled = resolveChannelEnabled(def, "IN_APP", overrides);
  /** A-2b: in-app is off but this type's email follows its own preference, which is on. */
  const emailAnchorOnly = !inAppEnabled && def.emailIndependentOfInApp === true && emailEnabled;
  if (!inAppEnabled && !emailAnchorOnly) {
    // Coupled types: the row anchors the email leg, so an enabled email is lost
    // with it. Independent types reach here only when their EMAIL is off too.
    // Either way nothing is sent: record both legs.
    await note(
      { channel: "IN_APP", status: "SUPPRESSED", reason: "PREFERENCE_OFF" },
      ...(emailEnabled || emailOffByPreference(def, emailEnabled)
        ? [{ channel: "EMAIL" as const, status: "SUPPRESSED" as const, reason: "PREFERENCE_OFF" as const }]
        : []),
    );
    return { status: "skipped" };
  }

  // 2. Dedupe key (F3). "refresh" falls back to suppress in v1 (frozen).
  const dedupeKey =
    def.dedupe === "none" || def.dedupeKeyTemplate === null
      ? null
      : fillDedupeTemplate(def.dedupeKeyTemplate, input.userId, data);

  // 3. Pure render — title/body/href from the single definition site.
  // Comms Center B1: when an operator PUBLISHED content for this type's in-app
  // or email stream (the variant the data selects), that content is rendered
  // instead, inside the locked frame; otherwise this render, exactly as before.
  // The email leg uses its OWN stream — never the in-app copy.
  const codeRendered = def.render(data);
  const live = await liveRenderFor({
    type: def.id, data, codeRendered, resolver: contentResolverFor(ctx), appBaseUrl: process.env.NEXT_PUBLIC_APP_URL,
  });
  const rendered = live.inApp.rendered;
  const inAppContentVersionId = live.inApp.contentVersionId;

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
    // A-2b: the anchor marker is chokepoint-owned — set on an email anchor,
    // stripped from anything a producer supplied.
    ...(emailAnchorOnly
      ? { metadata: { ...withoutAnchorMarker(data), [EMAIL_ANCHOR_MARKER]: true } }
      : input.data !== undefined ? { metadata: withoutAnchorMarker(input.data) } : {}),
    auditLogId: input.auditLogId ?? null,
    dedupeKey,
    expiresAt: input.expiresAt ?? null,
    // A-2b email anchor: archived at birth, so it is never visible in-app.
    ...(emailAnchorOnly ? { archivedAt: ledgerNow } : {}),
  };

  // S4: on a successful insert, ship the EMAIL leg (preference-gated above)
  // and record its NotificationDelivery row. Post-response in request scope.
  const finishCreated = async (id: string): Promise<CreateNotificationResult> => {
    await note(
      emailAnchorOnly
        // The row is an email anchor only: the in-app leg was not delivered.
        ? { channel: "IN_APP", status: "SUPPRESSED", reason: "PREFERENCE_OFF", notificationId: id }
        : { channel: "IN_APP", status: "ACCEPTED", notificationId: id, ...(inAppContentVersionId ? { contentVersionId: inAppContentVersionId } : {}) },
      ...(emailOffByPreference(def, emailEnabled) && !emailShippedOff
        ? [{ channel: "EMAIL" as const, status: "SUPPRESSED" as const, reason: "PREFERENCE_OFF" as const, notificationId: id }]
        : []),
      ...(emailShippedOff
        ? [{ channel: "EMAIL" as const, status: "SUPPRESSED" as const, reason: "SHIPPED_OFF" as const, notificationId: id }]
        : []),
    );
    if (emailEnabled) {
      const adapter = ctx?.emailAdapter ?? emailNotificationAdapter;
      await runAfterResponse(() =>
        deliverEmailAndRecord({
          notificationId: id,
          userId: input.userId,
          type: def.id,
          category: def.category,
          priority: def.priority,
          // The email's code rendering is the REGISTRY render, never the in-app version.
          title: codeRendered.title,
          ...(codeRendered.body ? { body: codeRendered.body } : {}),
          ...(codeRendered.href ? { href: codeRendered.href } : {}),
          ...(codeRendered.actionLabel ? { actionLabel: codeRendered.actionLabel } : {}),
          ...(live.email ? { emailContent: live.email } : {}),
          client,
          adapter,
          writer,
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
      await note({ channel: "IN_APP", status: "FAILED", errorCode: "STORE" });
      return {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Dedupe suppression drops the email leg with the in-app one. For an email
  // anchor the in-app leg was off by preference, whatever the dedupe said.
  const noteDedupe = () => note(
    emailAnchorOnly
      ? { channel: "IN_APP", status: "SUPPRESSED", reason: "PREFERENCE_OFF" }
      : { channel: "IN_APP", status: "SUPPRESSED", reason: "DEDUPE_OPEN" },
    ...(emailEnabled ? [{ channel: "EMAIL" as const, status: "SUPPRESSED" as const, reason: "DEDUPE_OPEN" as const }] : []),
  );

  // Unique violation on (userId, dedupeKey): resolve suppress-while-open.
  try {
    const existing = await client.notification.findUnique({
      where: { userId_dedupeKey: { userId: input.userId, dedupeKey } },
      select: { id: true, archivedAt: true, metadata: true },
    });

    // Open holder → the condition is already surfaced. Suppress. A-2b: an
    // ARCHIVED holder still holding the key is open too when
    //   - it is an email anchor (the email for this outage already went out —
    //     including after the user turned in-app back ON mid-outage), or
    //   - the in-app channel is off now (a bell dismissed before in-app was
    //     turned off: its email went out with it).
    // Releasing either would re-email the same outage. Their key is released by
    // retirement (resolve.ts), when the condition really ends.
    // A ONE-TIME type (dedupeNeverReleases — ACCOUNT_WELCOME) is open for good:
    // an archived holder (the user dismissed it) still suppresses.
    if (existing && (existing.archivedAt === null || emailAnchorOnly || def.dedupeNeverReleases === true || isEmailAnchorMetadata(existing.metadata))) {
      await noteDedupe();
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
      await noteDedupe();
      return { status: "suppressed" };
    }
    await note({ channel: "IN_APP", status: "FAILED", errorCode: "STORE" });
    return {
      status: "error",
      error: retryErr instanceof Error ? retryErr.message : String(retryErr),
    };
  }
}
