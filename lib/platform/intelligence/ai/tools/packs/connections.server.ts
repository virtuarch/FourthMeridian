/**
 * lib/platform/intelligence/ai/tools/packs/connections.server.ts  (Platform AI P7 — the connections pack's Production readers)
 *
 * Behind tools/packs/connections.ts:
 *   health               lib/connections/health.ts getConnectionHealth — THE fleet reader (identity-free), unchanged
 *   institutionIds       PlaidItem.id → institutionId for the listed unhealthy rows (the registry KEY; never the name)
 *   customerConnections  ONE customer's live connections: the same two tables and the same population rule as
 *                        health.ts (Plaid from PlaidItem; WALLET / EXCHANGE / BROKERAGE from Connection; MANUAL / CSV
 *                        excluded; REVOKED excluded), judged by health.ts's OWN derivation
 *                        (deriveConnectionHealthState under the resolved refresh policy — loadRefreshPolicies +
 *                        staleWindowMs, exactly its threshold selection). A wallet whose every account link is
 *                        soft-deleted is a REMOVED wallet (the customer hub's rule, as connection-diagnostics.ts
 *                        applies it) and is not listed.
 *   ridOf / resolveRid   the customers pack's keyed CUSTOMER rid (customers.server.ts — PRIV-ref, no new key)
 * ALLOWLISTED SELECTS: id, institutionId, provider, status, errorCode, lastSyncedAt, createdAt and the linked
 * accounts' walletChain. NEVER institutionName, externalConnectionId (a wallet address / its tail), encrypted
 * tokens, cursors, account names, masks or any balance.
 *
 * Also here: the CONNECTION record source the read-time renderer and replay re-authz use
 * (authz/record-render.ts PLATFORM_AI_RECORD_SOURCES): CUSTOMER_SUCCESS only (fresh CS tier); T1 = a CODE-DERIVED
 * label ("bank connection (<registry name>)" / "wallet connection (<registry network>)"); linkage = the owner; no T2
 * fields (the customer is named through their own CUSTOMER record).
 *
 * fm_system (an operator reaching a customer acts outside their own tenancy — the CS routes' reasoning). Never logs.
 */

import "server-only";

import type { PlatformArea } from "@prisma/client";
import { systemDb } from "@/lib/db";
import { deriveConnectionHealthState, getConnectionHealth, staleWindowMs } from "@/lib/connections/health";
import { CUSTOMER_WHERE } from "@/lib/platform/customer/population";
import { loadRefreshPolicies } from "@/lib/platform/refresh-policy";
import type { RecordRenderSource } from "../../authz/record-render";
import type { FreshGuard } from "../../authz/recheck";
import { institutionName, walletNetworkName } from "../../evidence/name-registry";
import { placeableUnion } from "../../evidence/record-envelope";
import { CUSTOMER_AREA } from "./customers";
import { customerRid, resolveCustomerRid } from "./customers.server";
import {
  CONNECTION_RID, CUSTOMER_CONNECTION_SCHEMA, connectionsPackTools, networkCodeOf,
  type ConnectionsPackReaders, type ConnectionsToolContext, type CustomerConnectionFacts,
} from "./connections";

type Client = typeof systemDb;

/** Unhealthy rows the aggregate lists (health.ts `cap`); counts and totals are unbounded either way. */
export const CONNECTIONS_LIST_CAP = 200;
/** Connections read per customer per table (a customer has a handful; the tool returns ≤ 10). */
export const CUSTOMER_CONNECTIONS_MAX = 50;

/** The providers health.ts takes from Connection: real external, syncing providers (never PLAID / MANUAL / CSV). */
const NOT_LIVE_PROVIDER = ["PLAID", "MANUAL", "CSV"] as const;

export async function customerConnections(userId: string, now: Date, client: Client = systemDb): Promise<{ rows: CustomerConnectionFacts[]; truncated: boolean }> {
  const [items, conns, policies] = await Promise.all([
    client.plaidItem.findMany({
      where: { userId, status: { not: "REVOKED" } },
      select: { id: true, institutionId: true, status: true, errorCode: true, lastSyncedAt: true, createdAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: CUSTOMER_CONNECTIONS_MAX,
    }),
    client.connection.findMany({
      where: { userId, status: { not: "REVOKED" }, provider: { notIn: [...NOT_LIVE_PROVIDER] } },
      select: {
        id: true, provider: true, status: true, errorCode: true, lastSyncedAt: true, createdAt: true,
        accountConnections: { where: { deletedAt: null }, select: { financialAccount: { select: { walletChain: true } } } },
        _count: { select: { accountConnections: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: CUSTOMER_CONNECTIONS_MAX,
    }),
    loadRefreshPolicies(client),
  ]);
  const bankMs = staleWindowMs(policies.BANK), walletMs = staleWindowMs(policies.WALLET);
  const t = now.getTime();
  const rows: CustomerConnectionFacts[] = [
    ...items.map((i) => ({
      source: "PLAID", id: i.id, institutionId: i.institutionId, status: String(i.status), errorCode: i.errorCode,
      healthState: deriveConnectionHealthState(String(i.status), i.errorCode, i.lastSyncedAt, bankMs, t),
      lastSyncedAt: i.lastSyncedAt, createdAt: i.createdAt, chains: [],
    })),
    ...conns
      // A wallet whose every link is soft-deleted is a REMOVED wallet (the hub's rule) — not a live connection.
      .filter((c) => !(c.accountConnections.length === 0 && c._count.accountConnections > 0))
      .map((c) => ({
        source: String(c.provider), id: c.id, institutionId: null, status: String(c.status), errorCode: c.errorCode,
        healthState: deriveConnectionHealthState(String(c.status), c.errorCode, c.lastSyncedAt, walletMs, t),
        lastSyncedAt: c.lastSyncedAt, createdAt: c.createdAt,
        chains: c.accountConnections.flatMap((a) => (a.financialAccount.walletChain ? [a.financialAccount.walletChain] : [])),
      })),
  ];
  return { rows, truncated: items.length >= CUSTOMER_CONNECTIONS_MAX || conns.length >= CUSTOMER_CONNECTIONS_MAX };
}

export async function plaidInstitutionIds(ids: readonly string[], client: Client = systemDb): Promise<ReadonlyMap<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await client.plaidItem.findMany({ where: { id: { in: [...ids].slice(0, CONNECTIONS_LIST_CAP) } }, select: { id: true, institutionId: true } });
  return new Map(rows.map((r) => [r.id, r.institutionId] as const));
}

export const CONNECTIONS_PACK_READERS: ConnectionsPackReaders = {
  health: () => getConnectionHealth(CONNECTIONS_LIST_CAP),
  institutionIds: (ids) => plaidInstitutionIds(ids),
  customerConnections: (userId, now) => customerConnections(userId, now),
  ridOf: customerRid,
  resolveRid: (rid) => resolveCustomerRid(rid),
  now: () => new Date(),
};

/** The Production connections-pack tools (tools/registry.ts). */
export const CONNECTIONS_PACK_TOOLS = connectionsPackTools<ConnectionsToolContext>(CONNECTIONS_PACK_READERS);

/** The live connection a CONNECTION rid names, owned by a customer (CUSTOMER_WHERE) — or null. Allowlisted select. */
async function ownedConnection(rid: string, client: Client): Promise<{ userId: string; label: string } | null> {
  if (typeof rid !== "string" || !CONNECTION_RID.test(rid)) return null;
  const id = rid.slice(2);
  if (rid.startsWith("p:")) {
    const r = await client.plaidItem.findFirst({ where: { id, status: { not: "REVOKED" }, user: CUSTOMER_WHERE }, select: { userId: true, institutionId: true } });
    return r ? { userId: r.userId, label: `bank connection (${institutionName(r.institutionId)})` } : null;
  }
  const c = await client.connection.findFirst({
    where: { id, status: { not: "REVOKED" }, provider: { notIn: [...NOT_LIVE_PROVIDER] }, user: CUSTOMER_WHERE },
    select: { userId: true, accountConnections: { where: { deletedAt: null }, select: { financialAccount: { select: { walletChain: true } } } } },
  });
  if (!c?.userId) return null;
  const net = networkCodeOf(c.accountConnections.map((a) => a.financialAccount.walletChain));
  return { userId: c.userId, label: net === "OTHER" || net === "MULTIPLE" ? "wallet connection" : `wallet connection (${walletNetworkName(net)})` };
}

/** The CONNECTION record kind's read-time source (authz/record-render.ts; boundary remint). Every method reads fresh. */
export function connectionRecordSource(client: Client = systemDb): RecordRenderSource {
  return {
    t2Fields: [],
    // S2 09io A1: the CONNECTION schema's placeable closed fields.
    placeable: placeableUnion(CUSTOMER_CONNECTION_SCHEMA),
    async revalidate(rid: string, area: PlatformArea, guard: FreshGuard) {
      if (area !== CUSTOMER_AREA || guard.csTier !== true) return null;
      return (await ownedConnection(rid, client)) ? "CUSTOMER_SUCCESS" : null;
    },
    async t1(rid: string) { return (await ownedConnection(rid, client))?.label ?? null; },
    async linkedUserIds(rid: string) {
      const c = await ownedConnection(rid, client);
      if (!c) throw new Error("connection not resolvable");
      return [c.userId];
    },
    async t2() { return null; },
  };
}
