/**
 * lib/analytics/product-events.ts  (BETA A1–A8 — the product-event writer)
 *
 * ONE TYPED FUNCTION PER EVENT. The parameters of each function are exactly the
 * metadata keys the event is allowed to carry (`day`, `spaceType`, `briefDay`,
 * `cached`, `accountId`, `connectionId`, `chain`, `currency`), so a caller cannot
 * pass a name, an amount, an address, a prompt or a description by construction
 * — there is no parameter to put it in. lib/analytics/product-events.test.ts
 * scans every call site for the same reason.
 *
 * WHAT THESE ROWS ARE. First-party presence / engagement facts, written SERVER
 * SIDE only (route handlers and server components; never from the client, never
 * from a job, a webhook, a cron or an operator path), onto the existing
 * append-only `AuditLog` through the one shape authority (`buildAuditData`,
 * lib/audit.ts). `ipAddress` and `userAgent` are always null: a product event is
 * not a security event and carries no request forensics. `actorType` is always
 * USER and `result` SUCCESS — the shape helper's envelope, so the admin audit
 * view renders them like every other row.
 *
 * DEDUPE, CONCURRENCY-SAFE AND READ-BACK-FREE. "Once per (user, Space, UTC day)"
 * is enforced by the WRITER with one statement:
 *
 *     INSERT INTO "AuditLog" (…) SELECT … WHERE NOT EXISTS (same user, action,
 *     Space and key already present)
 *
 * so a reload, a double render or two concurrent first pages cannot double-count
 * through a read-then-write race, and nothing is read back after the insert
 * (`auditInsert`'s lesson: a RETURNING needs a SELECT grant the writer may not
 * hold). There is deliberately no unique index behind it (a migration this
 * slice does not make), so two statements racing in the same millisecond can
 * still both pass the check; every READER therefore counts DISTINCT (user, day)
 * — the owner's "dedupe AND count distinct" rule, applied on both sides.
 *
 * AUTHORITY. The client is whatever phase the caller is already in: the tenant
 * transaction of a route or server page (fm_app: INSERT is `WITH CHECK (true)`
 * and the NOT EXISTS reads the user's OWN rows, which `fm_app_sel` admits), or a
 * transaction client in a test. SESSION_ACTIVE_DAY is NOT written here — it runs
 * on the pre-identity role inside the session-activity statement, where the
 * dedupe cannot read AuditLog at all (lib/auth/session-activity.ts).
 *
 * NEVER THROWS INTO THE REQUEST PATH. Analytics must not break a page: every
 * writer catches, logs the failure class and resolves `false`. A caller that
 * wants the write to be part of its transaction's outcome should not use this.
 */

import { randomUUID } from "crypto";
import { AuditAction, type AuditActionType } from "@/lib/audit-actions";
import { buildAuditData } from "@/lib/audit";
import { toISODateUTC } from "@/lib/time/clock";

/** The one capability a writer needs: run a single parameterised statement. */
export interface ProductEventClient {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<number>;
}

/** The only metadata keys a product event may carry. Pinned by the test. */
export const PRODUCT_EVENT_METADATA_KEYS = [
  "day", "spaceType", "briefDay", "cached", "accountId", "connectionId", "chain", "currency",
] as const;
export type ProductEventMetadataKey = (typeof PRODUCT_EVENT_METADATA_KEYS)[number];

type ProductMetadata = Partial<Record<ProductEventMetadataKey, string | boolean>>;

/** `YYYY-MM-DD` of an instant, UTC — the day grain every dedupe key uses. */
export function productEventDay(now: Date = new Date()): string {
  return toISODateUTC(now);
}

interface WriteInput {
  userId: string;
  spaceId: string | null;
  action: AuditActionType;
  metadata: ProductMetadata;
  /** The metadata key that, with (userId, action, spaceId), identifies the one row allowed. */
  dedupeKey: "day" | "briefDay" | null;
}

function failSoft(action: string, err: unknown): false {
  const name = err instanceof Error ? `${err.name}: ${err.message.split("\n")[0].slice(0, 120)}` : String(err).slice(0, 120);
  console.warn(`[product-events] ${action} not recorded (${name})`);
  return false;
}

/**
 * The shared writer. One statement; a deduped event inserts only when no row with
 * the same (userId, action, spaceId, metadata->>key) exists; an undeduped event
 * inserts unconditionally. Resolves `true` when a row was written.
 */
async function writeProductEvent(client: ProductEventClient, input: WriteInput): Promise<boolean> {
  const data = buildAuditData({
    actorId: input.userId, actorType: "USER", action: input.action, result: "SUCCESS",
    spaceId: input.spaceId, metadata: input.metadata, ipAddress: null, userAgent: null,
  });
  const id = randomUUID();
  const metadataJson = JSON.stringify(data.metadata);
  try {
    let written: number;
    if (input.dedupeKey) {
      const keyValue = String(input.metadata[input.dedupeKey]);
      written = await client.$executeRaw`
        INSERT INTO "AuditLog" ("id", "userId", "spaceId", "action", "metadata", "ipAddress", "userAgent")
        SELECT ${id}::text, ${input.userId}::text, ${input.spaceId}::text, ${input.action}::text, ${metadataJson}::jsonb, NULL, NULL
         WHERE NOT EXISTS (
           SELECT 1 FROM "AuditLog"
            WHERE "userId" = ${input.userId}::text
              AND "action" = ${input.action}::text
              AND "spaceId" IS NOT DISTINCT FROM ${input.spaceId}::text
              AND "metadata"->>(${input.dedupeKey}::text) = ${keyValue}::text
         )`;
    } else {
      written = await client.$executeRaw`
        INSERT INTO "AuditLog" ("id", "userId", "spaceId", "action", "metadata", "ipAddress", "userAgent")
        VALUES (${id}::text, ${input.userId}::text, ${input.spaceId}::text, ${input.action}::text, ${metadataJson}::jsonb, NULL, NULL)`;
    }
    return written > 0;
  } catch (err) {
    return failSoft(input.action, err);
  }
}

// ── The events ───────────────────────────────────────────────────────────────

/**
 * SPACE_VIEWED — a Space's server page rendered for one of its members. Once per
 * (user, Space, UTC day). `spaceType` is the Space's kind (PERSONAL / SHARED),
 * never its name. Platform Spaces are never recorded (the caller decides; the
 * platform page does not call this).
 */
export function recordSpaceViewed(
  client: ProductEventClient,
  input: { userId: string; spaceId: string; spaceType: string; now?: Date },
): Promise<boolean> {
  const day = productEventDay(input.now);
  return writeProductEvent(client, {
    userId: input.userId, spaceId: input.spaceId, action: AuditAction.SPACE_VIEWED,
    metadata: { day, spaceType: input.spaceType }, dedupeKey: "day",
  });
}

/**
 * BRIEF_VIEWED — a Daily Brief was SHOWN to its reader (not generated, not
 * polled for, not prefetched). Once per (user, Space, briefDay): the key is the
 * Brief's own day, so a Brief read again on a later calendar day is still one
 * view of that Brief. `cached` says whether the Brief shown already existed
 * (true: a read path) or was generated in the same request (false).
 */
export function recordBriefViewed(
  client: ProductEventClient,
  input: { userId: string; spaceId: string; briefDay: string; cached: boolean },
): Promise<boolean> {
  return writeProductEvent(client, {
    userId: input.userId, spaceId: input.spaceId, action: AuditAction.BRIEF_VIEWED,
    metadata: { briefDay: input.briefDay, cached: input.cached }, dedupeKey: "briefDay",
  });
}

/**
 * TRANSACTIONS_VIEWED — the Transactions workspace loaded its FIRST page for a
 * Space (never a cursor continuation). Once per (user, Space, UTC day).
 */
export function recordTransactionsViewed(
  client: ProductEventClient,
  input: { userId: string; spaceId: string; now?: Date },
): Promise<boolean> {
  const day = productEventDay(input.now);
  return writeProductEvent(client, {
    userId: input.userId, spaceId: input.spaceId, action: AuditAction.TRANSACTIONS_VIEWED,
    metadata: { day }, dedupeKey: "day",
  });
}

/**
 * MANUAL_ASSET_VALUE_UPDATED — `PATCH /api/accounts/manual/[id]` succeeded. One
 * row per update (frequency is the figure), carrying the account id and NEVER
 * the value, the name or the kind of asset.
 */
export function recordManualAssetValueUpdated(
  client: ProductEventClient,
  input: { userId: string; accountId: string },
): Promise<boolean> {
  return writeProductEvent(client, {
    userId: input.userId, spaceId: null, action: AuditAction.MANUAL_ASSET_VALUE_UPDATED,
    metadata: { accountId: input.accountId }, dedupeKey: null,
  });
}

/**
 * Metadata for the two NORMALISED lifecycle writers (they keep their own
 * `auditLog.create` inside the tenant phase that creates the account; this only
 * fixes what they are allowed to say). Pure, so the test can pin the keys.
 */
export function walletAddMetadata(input: { connectionId: string | null; chain: string }): { connectionId: string | null; chain: string } {
  return { connectionId: input.connectionId, chain: input.chain };
}
export function manualAssetAddMetadata(input: { accountId: string; currency: string }): { accountId: string; currency: string } {
  return { accountId: input.accountId, currency: input.currency };
}
