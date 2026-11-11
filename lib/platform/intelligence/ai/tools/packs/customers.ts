/**
 * lib/platform/intelligence/ai/tools/packs/customers.ts  (Platform AI P5 — the customers pack: contracts + mappers)
 *
 * The first customer-linkable RECORD pack (design v2 §2, §5, §6.5; MVP PA-1 item 1). Three
 * CUSTOMER_SUCCESS-tier RECORD tools over the EXISTING Customer Success readers
 * (lib/platform/customer/*, injected — tools/packs/customers.server.ts wires the Production ones):
 *
 *   list_customer_attention {reason?}   who needs help, and the primary reason (attention.ts — the
 *                                       ONE fold the CS overview and list use)   PLATFORM_AI_RECORD_VIEWED
 *   list_recently_joined {days?}        customers who registered in the window (recently-joined.ts)
 *                                                                                PLATFORM_AI_RECORD_VIEWED
 *   get_customer_profile {customer}     one customer by HANDLE (customer-detail.ts)  CUSTOMER_PROFILE_VIEWED
 *
 * WHAT A RECORD CARRIES (I-3, evidence/record-envelope.ts): closed codes (funnel stage, attention
 * reason, presence, last-active bucket, import health), counts, ISO times, booleans and the T1 opaque
 * reference ("user #" + 8 hex). The MAPPERS below read only those fields of the reader DTOs, never
 * spread a DTO, and never read: email, name, username, the user id (except as the audit linkage /
 * the keyed rid), connection labels / institution names / provider error text, incident account
 * labels, cohort / policy-group names, lifecycle text, operator-action metadata. T2 (name, email)
 * exists only as `t2Fields` NAMES; the value is rendered at read time by authz/record-render.ts
 * after a fresh CS check and a PLATFORM_AI_RECORD_VIEWED row (I-1).
 *
 * RECORD ID (PACK-PR-CONDITIONS 6, S2 09di): a CUSTOMER record's rid is the KEYED opaque ref
 * (`u:` + the PRIV-ref token, lib/platform/opaque-user-ref.ts) — never the raw user id. The source
 * resolves rid → customer under the fresh guard (exactly one match, else not visible) and supplies
 * linkedUserIds for the audit.
 *
 * PURE: no I/O, no clock, no env — every read is the injected `CustomersPackReaders`.
 */

import type { PlatformArea } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";
import { ATTENTION_KEYS } from "@/lib/platform/customer/attention-keys";
import { attentionOf, type AttentionFold } from "@/lib/platform/customer/attention-core";
import type { AttentionKey } from "@/lib/platform/customer/overview-types";
import type { CustomerDetail } from "@/lib/platform/customer/customer-detail";
import type { RecentlyJoined } from "@/lib/platform/customer/recently-joined-core";
import { FUNNEL_STAGE_LABELS, FUNNEL_STAGE_ORDER } from "@/lib/platform/growth/product-analytics-core";
import type { CsToken } from "@/lib/platform/incidents/intelligence";
import { OPAQUE_USER_REF_PREFIX, OPAQUE_USER_REF_TOKEN } from "@/lib/platform/opaque-user-ref-format";
import type { LastActiveBucket, PresenceState } from "@/lib/presence/definitions";
import type { FreshGuard } from "../../authz/recheck";
import {
  RECORD_LIST_MAX, boolFlag, code, count, isoTime, opaqueRef,
  type RawRecord, type RecordFields, type RecordRunResult, type RecordSchema,
} from "../../evidence/record-envelope";
import type { PlatformAiToolContract } from "../contract";

/** The record kind every customers-pack record (and subject handle) carries. */
export const CUSTOMER_RECORD_KIND = "CUSTOMER";
export const CUSTOMER_AREA: PlatformArea = "CUSTOMER_SUCCESS";

/** CUSTOMER rid: "u:" + the 8-hex PRIV-ref token (keyed; never the user id). */
export const CUSTOMER_RID = /^u:[0-9a-f]{8}$/;
export const ridOfRefToken = (token: string): string | null => (OPAQUE_USER_REF_TOKEN.test(token) ? `u:${token}` : null);
/** The T1 reference a CUSTOMER rid renders as ("user #3fa9c21b"). */
export const refOfRid = (rid: string): string | null => (CUSTOMER_RID.test(rid) ? `${OPAQUE_USER_REF_PREFIX}${rid.slice(2)}` : null);

/** The readers the pack runs over (Production: customers.server.ts; tests / E0: fixtures). */
export interface CustomersPackReaders {
  attention(token: CsToken, now: Date): Promise<{ fold: AttentionFold }>;
  recentlyJoined(days: number, now: Date): Promise<RecentlyJoined>;
  profile(userId: string, token: CsToken, now: Date): Promise<Pick<CustomerDetail, "identity" | "activity" | "connections" | "incidents" | "rollup"> | null>;
  /** The keyed rid of a customer (null when the server has no key — the record is then never returned). */
  ridOf(userId: string): string | null;
  /** rid → the ONE customer it names, within the customer population (a collision or none ⇒ null). */
  resolveRid(rid: string): Promise<string | null>;
  now(): Date;
}

/** What a pack tool's run receives (tools/registry.ts LegacyToolContext, the parts it reads). */
export interface CustomersToolContext { readonly fresh?: ReadonlyMap<PlatformArea, FreshGuard> }

// ── Closed vocabularies ──────────────────────────────────────────────────────

const STAGES = FUNNEL_STAGE_ORDER as readonly string[];
const PRESENCE: readonly PresenceState[] = ["ACTIVE", "IDLE", "OFFLINE", "UNKNOWN"];
const LAST_ACTIVE: readonly LastActiveBucket[] = ["WITHIN_5_MIN", "WITHIN_HOUR", "TODAY", "YESTERDAY", "THIS_WEEK", "THIS_MONTH", "OVER_30_DAYS", "NEVER"];
const IMPORT_HEALTH = ["green", "amber", "red", "none"] as const;
const REASONS = ATTENTION_KEYS as readonly string[];
const BROKEN_STATUS = new Set(["ERROR", "NEEDS_REAUTH"]);

/** "First connection" (the rollup's label) → "firstConnection" (the closed key); anything else ⇒ null. */
export const stageKeyOf = (label: string | null | undefined): string | null =>
  (Object.entries(FUNNEL_STAGE_LABELS) as [string, string][]).find(([, l]) => l === label)?.[0] ?? null;

const T2: RecordSchema["t2Fields"] = ["name", "email"];

export const ATTENTION_SCHEMA: RecordSchema = {
  kind: CUSTOMER_RECORD_KIND, t2Fields: T2,
  fields: {
    ref: { type: "opaqueRef" },
    reason: { type: "code", values: REASONS },
    reasons: { type: "count" },
    testAccount: { type: "bool" },
  },
};

export const RECENTLY_JOINED_SCHEMA: RecordSchema = {
  kind: CUSTOMER_RECORD_KIND, t2Fields: T2,
  fields: {
    ref: { type: "opaqueRef" },
    joinedAt: { type: "isoTime", nullable: true },
    stage: { type: "code", values: STAGES, nullable: true },
    importHealth: { type: "code", values: IMPORT_HEALTH },
    connections: { type: "count" },
    invited: { type: "bool" },
  },
};

export const PROFILE_SCHEMA: RecordSchema = {
  kind: CUSTOMER_RECORD_KIND, t2Fields: T2,
  fields: {
    ref: { type: "opaqueRef" },
    joinedAt: { type: "isoTime", nullable: true },
    verified: { type: "bool" },
    deactivated: { type: "bool" },
    stage: { type: "code", values: STAGES, nullable: true },
    presence: { type: "code", values: PRESENCE },
    lastActive: { type: "code", values: LAST_ACTIVE },
    connections: { type: "count" },
    brokenConnections: { type: "count" },
    openIncidents: { type: "count" },
    openIncidentsFloor: { type: "bool" },
    aiTurns30d: { type: "count", nullable: true },
    lastEngagedAt: { type: "isoTime", nullable: true },
  },
};

// ── Mappers (DTO → closed fields; read named fields only, never spread) ─────

const safeCount = (n: unknown) => (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? count(n) : null);
const safeTime = (s: unknown) => (typeof s === "string" && !Number.isNaN(Date.parse(s)) ? isoTime(new Date(s)) : null);

function customerRecord(userId: string, readers: CustomersPackReaders, fields: (ref: string) => RecordFields): RawRecord | null {
  const rid = readers.ridOf(userId);
  const ref = rid ? refOfRid(rid) : null;
  if (!rid || !ref) return null; // no key ⇒ no reference ⇒ never returned (fail closed)
  return { ref: { kind: CUSTOMER_RECORD_KIND, recordId: rid, area: CUSTOMER_AREA, tier: "CUSTOMER_SUCCESS", linkedUserIds: [userId] }, fields: fields(ref) };
}

export function mapAttention(fold: AttentionFold, reason: AttentionKey | null, readers: CustomersPackReaders): { records: RawRecord[]; total: number } {
  const ids = [...(reason ? (fold.sets[reason] ?? []) : fold.union)];
  const rows = ids.map((id) => ({ id, reasons: attentionOf(fold, id), rid: readers.ridOf(id) ?? "" }))
    .filter((r) => r.reasons.length > 0)
    .sort((a, b) => b.reasons.length - a.reasons.length || (a.rid < b.rid ? -1 : a.rid > b.rid ? 1 : 0));
  const records = rows.slice(0, RECORD_LIST_MAX).flatMap((r) => {
    const primary = reason ?? r.reasons[0];
    const rec = customerRecord(r.id, readers, (ref) => ({
      ref: opaqueRef(ref), reason: code(REASONS, primary), reasons: count(r.reasons.length), testAccount: boolFlag(fold.testAccounts.has(r.id)),
    }));
    return rec ? [rec] : [];
  });
  return { records, total: rows.length };
}

export function mapRecentlyJoined(rj: RecentlyJoined, readers: CustomersPackReaders): RawRecord[] {
  return rj.rows.slice(0, RECORD_LIST_MAX).flatMap((r) => {
    const rec = customerRecord(r.id, readers, (ref) => ({
      ref: opaqueRef(ref),
      joinedAt: safeTime(r.joinedAt),
      stage: (() => { const k = stageKeyOf(r.stage); return k ? code(STAGES, k) : null; })(),
      importHealth: code(IMPORT_HEALTH, (IMPORT_HEALTH as readonly string[]).includes(r.importHealth) ? r.importHealth : "none"),
      connections: safeCount(r.connections) ?? count(0),
      invited: boolFlag(r.invited === true),
    }));
    return rec ? [rec] : [];
  });
}

export function mapProfile(userId: string, p: NonNullable<Awaited<ReturnType<CustomersPackReaders["profile"]>>>, readers: CustomersPackReaders): RawRecord | null {
  const live = p.connections.filter((c) => c.status !== "REVOKED");
  return customerRecord(userId, readers, (ref) => ({
    ref: opaqueRef(ref),
    joinedAt: safeTime(p.identity.createdAt),
    verified: boolFlag(p.identity.emailVerifiedAt !== null),
    deactivated: boolFlag(p.identity.deactivatedAt !== null),
    stage: (() => { const k = stageKeyOf(p.rollup.funnelStage); return k ? code(STAGES, k) : null; })(),
    presence: code(PRESENCE, PRESENCE.includes(p.activity.presence) ? p.activity.presence : "UNKNOWN"),
    lastActive: code(LAST_ACTIVE, LAST_ACTIVE.includes(p.activity.lastActive.bucket) ? p.activity.lastActive.bucket : "NEVER"),
    connections: count(live.length),
    brokenConnections: count(live.filter((c) => BROKEN_STATUS.has(c.status)).length),
    openIncidents: count(p.incidents.open.length),
    openIncidentsFloor: boolFlag(p.incidents.openTruncated === true),
    aiTurns30d: safeCount(p.rollup.aiTurns30d),
    lastEngagedAt: safeTime(p.rollup.lastEngagedAt),
  }));
}

// ── The contracts ────────────────────────────────────────────────────────────

/** The CS-tier incident token of THIS call's fresh guard (authz/recheck.server.ts minted it), or a refusal. */
function csTokenOf(ctx: CustomersToolContext): CsToken {
  const g = ctx.fresh?.get(CUSTOMER_AREA);
  const t = g?.incidentToken;
  if (!g || g.csTier !== true || !t || t.audience !== "CUSTOMER_SUCCESS") throw new Error("customers pack: no fresh CUSTOMER_SUCCESS guard");
  return t as CsToken;
}

const result = (status: RecordRunResult["status"], now: Date, records: RawRecord[], truncated: boolean): RecordRunResult =>
  ({ status, asOf: isoTime(now), records, truncated });

const common = {
  pack: "customers", requires: { areas: [CUSTOMER_AREA], level: "READ", tier: "CUSTOMER_SUCCESS" },
  scope: "RECORD", customerLinkable: true, pii: 2, cost: { toolCalls: 1 },
} as const;

const viewed = { action: AuditAction.PLATFORM_AI_RECORD_VIEWED, detail: { surface: "platform-ai", recordKind: CUSTOMER_RECORD_KIND } } as const;

/** The three customers-pack tools over these readers (the registry uses the Production readers). */
export function customersPackTools<Ctx extends CustomersToolContext>(readers: CustomersPackReaders): PlatformAiToolContract<Ctx>[] {
  return [
    {
      ...common, name: "list_customer_attention", audit: viewed, recordSchema: ATTENTION_SCHEMA,
      description: "Customers who need help now (Customer Success), most reasons first, ≤10. Each record: handle, ref, reason (primary), reasons (count), testAccount. Optional reason filters to one reason.",
      args: { properties: { reason: { kind: "enum", values: REASONS, optional: true } } },
      run: async (args, ctx) => {
        const token = csTokenOf(ctx);
        const now = readers.now();
        const { fold } = await readers.attention(token, now);
        const { records, total } = mapAttention(fold, (args.reason as AttentionKey | undefined) ?? null, readers);
        return result(records.length === 0 ? "MISSING" : fold.floor ? "PARTIAL" : "CONFIRMED", now, records, total > records.length);
      },
    },
    {
      ...common, name: "list_recently_joined", audit: viewed, recordSchema: RECENTLY_JOINED_SCHEMA,
      description: "Customers who registered in the last `days` (default 14), newest first, ≤10. Each record: handle, ref, joinedAt, stage, importHealth, connections, invited.",
      args: { properties: { days: { kind: "int", min: 1, max: 30, offered: [7, 14, 30], optional: true } } },
      run: async (args, ctx) => {
        csTokenOf(ctx);
        const now = readers.now();
        const rj = await readers.recentlyJoined(typeof args.days === "number" ? args.days : 14, now);
        const records = mapRecentlyJoined(rj, readers);
        return result(records.length === 0 ? "MISSING" : rj.floor ? "PARTIAL" : "CONFIRMED", now, records, rj.total > records.length);
      },
    },
    {
      ...common, name: "get_customer_profile", recordSchema: PROFILE_SCHEMA,
      audit: { action: AuditAction.CUSTOMER_PROFILE_VIEWED, detail: { surface: "platform-ai", recordKind: CUSTOMER_RECORD_KIND } },
      description: "One customer's status by handle (from a customers tool result or a [customer h_…] in the question): joinedAt, stage, presence, lastActive, connections, brokenConnections, openIncidents, aiTurns30d, lastEngagedAt, deactivated.",
      args: { properties: { customer: { kind: "handle", recordKind: CUSTOMER_RECORD_KIND } } },
      // The boundary resolved the handle to the rid; it must still name exactly one visible customer.
      revalidate: async (rid) => CUSTOMER_RID.test(rid) && (await readers.resolveRid(rid)) !== null,
      run: async (args, ctx) => {
        const token = csTokenOf(ctx);
        const now = readers.now();
        const userId = await readers.resolveRid(String(args.customer));
        const p = userId ? await readers.profile(userId, token, now) : null;
        const rec = userId && p ? mapProfile(userId, p, readers) : null;
        return result(rec ? "CONFIRMED" : "MISSING", now, rec ? [rec] : [], false);
      },
    },
  ] as PlatformAiToolContract<Ctx>[];
}
