/**
 * lib/platform/intelligence/ai/tools/packs/customers.server.ts  (Platform AI P5 — the customers pack's Production readers)
 *
 * The EXISTING Customer Success readers, unchanged, behind tools/packs/customers.ts:
 *   attention        lib/platform/customer/attention.ts loadAttention (the CS token from THIS call's fresh guard)
 *   recentlyJoined   lib/platform/customer/recently-joined.ts listRecentlyJoined
 *   profile          lib/platform/customer/customer-detail.ts getCustomerDetail
 * plus the keyed CUSTOMER rid (PACK-PR-CONDITIONS 6): rid = "u:" + the PRIV-ref token of the user
 * id (lib/platform/opaque-user-ref.ts — the SAME key and purpose, no new key material), resolved back
 * by the bounded digest scan the CS list already uses (customers.ts resolveOpaqueRef) and then
 * restricted to the customer population (CUSTOMER_WHERE). More than one match (a 32-bit digest
 * collision) or none ⇒ not visible (fail closed).
 *
 * Also here: the CUSTOMER record source the read-time renderer and replay re-authz use
 * (authz/record-render.ts PLATFORM_AI_RECORD_SOURCES) — T2 = the customer's name / email, read ONLY
 * by the renderer after its fresh CS check and the PLATFORM_AI_RECORD_VIEWED row — and the exact
 * subject lookups (authz/subject.server.ts).
 *
 * fm_system (an operator reaching a customer acts outside their own tenancy — the CS routes' reasoning).
 * Allowlisted selects; never logs.
 */

import "server-only";

import type { PlatformArea } from "@prisma/client";
import { systemDb } from "@/lib/db";
import { loadAttention } from "@/lib/platform/customer/attention";
import { getCustomerDetail } from "@/lib/platform/customer/customer-detail";
import { resolveOpaqueRef } from "@/lib/platform/customer/customers";
import { CUSTOMER_WHERE } from "@/lib/platform/customer/population";
import { listRecentlyJoined } from "@/lib/platform/customer/recently-joined";
import { opaqueUserRef } from "@/lib/platform/opaque-user-ref";
import { opaqueRefToken } from "@/lib/platform/opaque-user-ref-format";
import type { RecordRenderSource } from "../../authz/record-render";
import type { FreshGuard } from "../../authz/recheck";
import type { T2FieldName } from "../../evidence/record-envelope";
import type { ToolTier } from "../contract";
import { CUSTOMER_AREA, CUSTOMER_RID, customersPackTools, refOfRid, ridOfRefToken, type CustomersPackReaders, type CustomersToolContext } from "./customers";

type Client = typeof systemDb;

/** The keyed CUSTOMER rid of a user id ("u:" + PRIV-ref token), or null without the server key. */
export function customerRid(userId: string): string | null {
  const t = opaqueRefToken(opaqueUserRef(userId));
  return t ? ridOfRefToken(t) : null;
}

/** rid → the ONE customer (role USER) it names; a collision or no match ⇒ null. */
export async function resolveCustomerRid(rid: string, client: Client = systemDb): Promise<string | null> {
  if (!CUSTOMER_RID.test(rid)) return null;
  const { ids } = await resolveOpaqueRef(rid.slice(2), client);
  if (ids.length !== 1) return null;
  const rows = await client.user.findMany({ where: { AND: [CUSTOMER_WHERE, { id: { in: ids } }] }, select: { id: true }, take: 2 });
  return rows.length === 1 ? rows[0].id : null;
}

/** Exact email (case-insensitive EQUALITY, never contains) within the customer population; ambiguous ⇒ null. */
export async function findCustomerByEmail(email: string, client: Client = systemDb): Promise<string | null> {
  const rows = await client.user.findMany({ where: { AND: [CUSTOMER_WHERE, { email: { equals: email, mode: "insensitive" } }] }, select: { id: true }, take: 2 });
  return rows.length === 1 ? rows[0].id : null;
}

/** Exact user id within the customer population. */
export async function findCustomerById(id: string, client: Client = systemDb): Promise<string | null> {
  const row = await client.user.findFirst({ where: { AND: [CUSTOMER_WHERE, { id }] }, select: { id: true } });
  return row?.id ?? null;
}

/** An opaque reference token ("user #" + 8 hex) → the ONE customer it names. */
export async function findCustomerByRefToken(token: string, client: Client = systemDb): Promise<string | null> {
  const rid = ridOfRefToken(token);
  return rid ? resolveCustomerRid(rid, client) : null;
}

export const CUSTOMERS_PACK_READERS: CustomersPackReaders = {
  attention: (token, now) => loadAttention(token, now),
  recentlyJoined: (days, now) => listRecentlyJoined({ days, now }),
  profile: (userId, token, now) => getCustomerDetail(userId, token, systemDb, now),
  ridOf: customerRid,
  resolveRid: (rid) => resolveCustomerRid(rid),
  now: () => new Date(),
};

/** The Production customers-pack tools (tools/registry.ts). */
export const CUSTOMERS_PACK_TOOLS = customersPackTools<CustomersToolContext>(CUSTOMERS_PACK_READERS);

/** The CUSTOMER record kind's read-time source (authz/record-render.ts; boundary remint). Every method reads fresh. */
export function customerRecordSource(client: Client = systemDb): RecordRenderSource {
  const T2: readonly T2FieldName[] = ["name", "email"];
  return {
    t2Fields: T2,
    async revalidate(rid: string, area: PlatformArea, guard: FreshGuard): Promise<ToolTier | null> {
      if (area !== CUSTOMER_AREA || guard.csTier !== true) return null;
      return (await resolveCustomerRid(rid, client)) ? "CUSTOMER_SUCCESS" : null;
    },
    async t1(rid: string): Promise<string | null> { return refOfRid(rid); },
    async linkedUserIds(rid: string): Promise<readonly string[]> {
      const id = await resolveCustomerRid(rid, client);
      if (!id) throw new Error("customer not resolvable");
      return [id];
    },
    async t2(rid: string, _area: PlatformArea, field: T2FieldName): Promise<string | null> {
      const id = await resolveCustomerRid(rid, client);
      if (!id || !T2.includes(field)) return null;
      const u = await client.user.findUnique({ where: { id }, select: { name: true, email: true } });
      if (!u) return null;
      return field === "email" ? u.email : u.name;
    },
  };
}
