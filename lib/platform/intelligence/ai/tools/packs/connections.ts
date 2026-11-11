/**
 * lib/platform/intelligence/ai/tools/packs/connections.ts  (Platform AI P7 — the connections pack, incl. wallets: contracts + mappers)
 *
 * Design v2 §2, §5, §6.5; MVP PA-1 item 3. Tools over the EXISTING connection-health readers — injected;
 * tools/packs/connections.server.ts wires the Production ones:
 *
 *   connection_health_overview  AGGREGATE  PLATFORM_OPS | CUSTOMER_SUCCESS  OPS tier  counts only, from
 *                               lib/connections/health.ts getConnectionHealth (THE fleet reader behind the Platform
 *                               Ops widget; its health verdicts, its population, its per-source fault tallies):
 *                               total, by health state, retired, per source {active, revoked, faults by state +
 *                               ALLOWLISTED error code}, and over the listed unhealthy rows: by institution (the
 *                               static name registry, keyed by the Plaid institution id) and by wallet network CODE.
 *   get_customer_connections    RECORD  CUSTOMER_SUCCESS  CS tier  one customer (CUSTOMER handle) ⇒ one CONNECTION
 *                               record per live connection: provider, kind, institution (registry), network (chain
 *                               code), status, healthState (health.ts's derivation), allowlisted errorCode,
 *                               needsReauth, lastSyncedAt (last success), neverSynced, connectedAt, the customer's keyed
 *                               ref. PLATFORM_AI_RECORD_VIEWED per customer, written first (I-5).
 * The OPS aggregate carries NO customer linkage (counts; health.ts selects no owner). Only the CS tool links a
 * customer, and audits it.
 *
 * FREE TEXT (I-3, S2 09dx):
 *   · institutions ONLY via evidence/name-registry.ts keyed by PlaidItem.institutionId (verified static mappings;
 *     unlisted ⇒ the generic word "institution"). PlaidItem.institutionName / the health row's `label` /
 *     `institution` are NEVER read;
 *   · error codes ONLY when allowlisted: Plaid ⇒ incidents/explanations.ts allowlistedProviderCode; wallets ⇒ the
 *     generic wallet sync codes (lib/crypto/wallet-sync-dispatch.ts WalletSyncErrorCode) + NO_USED_ADDRESSES, as
 *     fixed codes only (S2 09dy(1)); anything else ⇒ "OTHER". Never a provider message;
 *   · WALLETS: never the address, any fragment of it (the health row's `label` / customer-core's label carry the
 *     externalConnectionId tail — never read), the wallet name, a balance, or anything describing the address
 *     format. The network is a chain CODE from the registry's closed list (several ⇒ MULTIPLE, else OTHER);
 *   · no account label, no mask digits, no balance, no connection nickname, no connection id (the rid stays
 *     server-side; the model sees a handle).
 * The mappers read NAMED fields only and never spread a DTO.
 *
 * PURE: no I/O, no clock, no env — every read is the injected `ConnectionsPackReaders`.
 */

import type { PlatformArea } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";
import type { ConnectionHealthResult, HealthState } from "@/lib/connections/health";
import type { WalletSyncErrorCode } from "@/lib/crypto/wallet-sync-dispatch";
import type { CsToken } from "@/lib/platform/incidents/intelligence";
import { KNOWN_PROVIDER_ERROR_CODES, allowlistedProviderCode } from "@/lib/platform/incidents/explanations";
import type { FreshGuard } from "../../authz/recheck";
import { INSTITUTION_NAMES, WALLET_NETWORKS, institutionName } from "../../evidence/name-registry";
import {
  RECORD_LIST_MAX, boolFlag, code, isoTime, opaqueRef, registryName,
  type RawRecord, type RecordRunResult, type RecordSchema,
} from "../../evidence/record-envelope";
import type { PlatformAiToolContract } from "../contract";
import { CUSTOMER_AREA, CUSTOMER_RECORD_KIND, CUSTOMER_RID, refOfRid } from "./customers";

/** The record kind every connections-pack record carries. */
export const CONNECTION_RECORD_KIND = "CONNECTION";
export const CONNECTIONS_OPS_AREA: PlatformArea = "PLATFORM_OPS";

/** A CONNECTION rid: "p:" + PlaidItem.id or "c:" + Connection.id (server-side only; the model sees a handle). */
export const CONNECTION_RID = /^[pc]:[A-Za-z0-9_-]{1,64}$/;
export const connectionRid = (source: string, id: string): string | null => {
  const rid = `${source === "PLAID" ? "p" : "c"}:${id}`;
  return CONNECTION_RID.test(rid) ? rid : null;
};

/** One live connection of one customer, as the server reader projects it (closed facts + health.ts's verdict). */
export interface CustomerConnectionFacts {
  readonly source: string;
  readonly id: string;
  /** PlaidItem.institutionId (the registry key) — never the institution name. null for wallets. */
  readonly institutionId: string | null;
  readonly status: string;
  readonly errorCode: string | null;
  /** health.ts deriveConnectionHealthState under the resolved refresh policy. */
  readonly healthState: HealthState;
  readonly lastSyncedAt: Date | null;
  readonly createdAt: Date;
  /** FinancialAccount.walletChain of the wallet's live links (chain symbols only). */
  readonly chains: readonly string[];
}

/** The readers the pack runs over (Production: connections.server.ts; tests / E0: fixtures). */
export interface ConnectionsPackReaders {
  /** THE fleet reader (health.ts getConnectionHealth) — identity-free. */
  health(): Promise<ConnectionHealthResult>;
  /** PlaidItem.id → institutionId (the registry key) for listed unhealthy rows. Never the name. */
  institutionIds(plaidItemIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** One customer's live connections (bounded). */
  customerConnections(userId: string, now: Date): Promise<{ rows: readonly CustomerConnectionFacts[]; truncated: boolean }>;
  /** The keyed CUSTOMER rid of a customer (null without the server key). */
  ridOf(userId: string): string | null;
  /** rid → the ONE customer it names (customers.server.ts resolveCustomerRid), else null. */
  resolveRid(rid: string): Promise<string | null>;
  now(): Date;
}

export interface ConnectionsToolContext {
  readonly fresh?: ReadonlyMap<PlatformArea, FreshGuard>;
  readonly ev?: { readonly trace: { tool: string; outcome: string; refs: string[]; count?: number }[] };
}

// ── Closed vocabularies ──────────────────────────────────────────────────────

const PROVIDERS = ["PLAID", "WALLET", "EXCHANGE", "BROKERAGE", "OTHER"] as const;
const KINDS = ["BANK", "WALLET"] as const;
const STATUSES = ["ACTIVE", "NEEDS_REAUTH", "ERROR", "OTHER"] as const;
export const HEALTH_STATES = ["HEALTHY", "STALE", "DEGRADED", "NEEDS_REAUTH", "ERROR", "REVOKED"] as const satisfies readonly HealthState[];

/**
 * The wallet codes the model may see: the generic wallet sync codes (wallet-sync-dispatch.ts WalletSyncErrorCode) plus
 * BTC's NO_USED_ADDRESSES (btc-sync.ts). S2 09dy(1): INVALID_WALLET_ADDRESS and NO_USED_ADDRESSES are ALLOWED as fixed
 * codes — the code alone, never with an address, a fragment of one, a wallet name or a format hint (none is ever
 * selected or mapped; connections.test.ts + E0 p7.* pin it). Any other stored code reads "OTHER".
 */
export const WALLET_ERROR_CODES = [
  ...(["PROVIDER_NOT_CONFIGURED", "INVALID_WALLET_ADDRESS", "BALANCE_UNAVAILABLE", "POSITION_CAPTURE_UNAVAILABLE", "CHAIN_UNSUPPORTED", "ADAPTER_ERROR"] as const satisfies readonly WalletSyncErrorCode[]),
  "NO_USED_ADDRESSES",
] as const;
/** Every errorCode value a record / tally may carry: allowlisted Plaid codes ∪ the wallet codes ∪ OTHER. */
export const CONNECTION_ERROR_CODES: readonly string[] = [...new Set<string>([...[...KNOWN_PROVIDER_ERROR_CODES].sort(), ...WALLET_ERROR_CODES, "OTHER"])];
/** Chain codes (the registry's closed list) + MULTIPLE (several chains) + OTHER (unrecorded / unknown). */
export const NETWORK_CODES: readonly string[] = [...Object.keys(WALLET_NETWORKS), "MULTIPLE", "OTHER"];

const oneOf = <E extends string>(values: readonly E[], v: unknown, fallback: E): E => (typeof v === "string" && (values as readonly string[]).includes(v) ? v as E : fallback);

/** The allowlisted error code for a source, "OTHER" for anything else stored, null when none is stored. */
export function errorCodeOf(source: string, raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (source === "PLAID") return allowlistedProviderCode(raw) ?? "OTHER";
  return typeof raw === "string" && (WALLET_ERROR_CODES as readonly string[]).includes(raw) ? raw : "OTHER";
}

/** A wallet's chain symbols → ONE network code (never a label, never an address). */
export function networkCodeOf(chains: readonly (string | null | undefined)[]): string {
  const distinct = [...new Set(chains.filter((c): c is string => typeof c === "string" && c.trim() !== "").map((c) => c.trim().toUpperCase()))];
  if (distinct.length === 0) return "OTHER";
  if (distinct.length > 1) return "MULTIPLE";
  return Object.prototype.hasOwnProperty.call(WALLET_NETWORKS, distinct[0]) ? distinct[0] : "OTHER";
}

/** The health row's chain label ("BTC · ETH") → its symbols (the label is code-built from walletChain; never an address). */
const chainsOfLabel = (network: unknown): string[] => (typeof network === "string" ? network.split("·").map((s) => s.trim()) : []);

// ── Schemas ──────────────────────────────────────────────────────────────────

export const CUSTOMER_CONNECTION_SCHEMA: RecordSchema = {
  kind: CONNECTION_RECORD_KIND,
  fields: {
    customer: { type: "opaqueRef" },
    provider: { type: "code", values: PROVIDERS },
    kind: { type: "code", values: KINDS },
    institution: { type: "registryName", names: INSTITUTION_NAMES, nullable: true },
    network: { type: "code", values: NETWORK_CODES, nullable: true },
    status: { type: "code", values: STATUSES },
    healthState: { type: "code", values: HEALTH_STATES },
    errorCode: { type: "code", values: CONNECTION_ERROR_CODES, nullable: true },
    needsReauth: { type: "bool" },
    lastSyncedAt: { type: "isoTime", nullable: true },
    neverSynced: { type: "bool" },
    connectedAt: { type: "isoTime", nullable: true },
  },
};

// ── Mappers (named fields only; never a spread) ──────────────────────────────

const safeTime = (d: unknown) => (d instanceof Date && !Number.isNaN(d.getTime()) ? isoTime(d) : null);

export function mapCustomerConnections(userId: string, rows: readonly CustomerConnectionFacts[], readers: ConnectionsPackReaders): RawRecord[] {
  const crid = readers.ridOf(userId);
  const ref = crid ? refOfRid(crid) : null;
  if (!ref) return []; // no key ⇒ no reference ⇒ nothing returned (fail closed)
  return rows.slice(0, RECORD_LIST_MAX).flatMap((r) => {
    const rid = connectionRid(r.source, r.id);
    if (!rid) return [];
    const bank = r.source === "PLAID";
    const health = oneOf(HEALTH_STATES, r.healthState, "ERROR");
    if (health === "REVOKED") return []; // a former connection is not a live one (health.ts's population rule)
    return [{
      ref: { kind: CONNECTION_RECORD_KIND, recordId: rid, area: CUSTOMER_AREA, tier: "CUSTOMER_SUCCESS", linkedUserIds: [userId] },
      fields: {
        customer: opaqueRef(ref),
        provider: code(PROVIDERS, oneOf(PROVIDERS, r.source, "OTHER")),
        kind: code(KINDS, bank ? "BANK" : "WALLET"),
        institution: bank ? registryName(INSTITUTION_NAMES, institutionName(r.institutionId)) : null,
        network: bank ? null : code(NETWORK_CODES, networkCodeOf(r.chains)),
        status: code(STATUSES, oneOf(STATUSES, r.status, "OTHER")),
        healthState: code(HEALTH_STATES, health),
        errorCode: (() => { const c = errorCodeOf(r.source, r.errorCode); return c ? code(CONNECTION_ERROR_CODES, c) : null; })(),
        needsReauth: boolFlag(health === "NEEDS_REAUTH"),
        lastSyncedAt: safeTime(r.lastSyncedAt),
        neverSynced: boolFlag(r.lastSyncedAt === null),
        connectedAt: safeTime(r.createdAt),
      },
    } satisfies RawRecord];
  });
}

// ── The aggregate (counts only; every key a code or a registry name) ─────────

export interface ConnectionHealthOverview {
  readonly status: "CONFIRMED" | "PARTIAL" | "UNAVAILABLE";
  readonly asOf: string;
  readonly total?: number;
  readonly byHealth?: Readonly<Record<string, number>>;
  readonly retired?: { readonly revoked: number; readonly ownerInactive: number };
  readonly bySource?: Readonly<Record<string, { readonly active: number; readonly revoked: number; readonly faults: readonly { readonly healthState: string; readonly errorCode: string | null; readonly count: number }[] }>>;
  /** Over the LISTED unhealthy rows (≤ the reader's cap): Plaid rows by registry institution name. */
  readonly unhealthyByInstitution?: readonly { readonly institution: string; readonly count: number }[];
  /** Over the listed unhealthy rows: wallet rows by network code. */
  readonly unhealthyByNetwork?: readonly { readonly network: string; readonly count: number }[];
  readonly neverSyncedListed?: number;
  /** The listed rows are a floor (fewer than every non-healthy connection). */
  readonly listFloor?: boolean;
}

const n = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);

export function overviewOfHealth(h: ConnectionHealthResult, institutionIds: ReadonlyMap<string, string>): ConnectionHealthOverview {
  const byHealth: Record<string, number> = {};
  for (const s of HEALTH_STATES) byHealth[s] = n(h.counts?.[s]);
  const bySource: Record<string, { active: number; revoked: number; faults: { healthState: string; errorCode: string | null; count: number }[] }> = {};
  for (const [src, t] of Object.entries(h.bySource ?? {})) {
    const key = oneOf(PROVIDERS, src, "OTHER");
    const out = (bySource[key] ??= { active: 0, revoked: 0, faults: [] });
    out.active += n(t.active);
    out.revoked += n(t.revoked);
    for (const f of t.faults ?? []) {
      const healthState = oneOf(HEALTH_STATES, f.healthState, "ERROR");
      const errorCode = errorCodeOf(src, f.errorCode);
      const hit = out.faults.find((x) => x.healthState === healthState && x.errorCode === errorCode);
      if (hit) hit.count += n(f.count); else out.faults.push({ healthState, errorCode, count: n(f.count) });
    }
  }
  const listed = h.unhealthy ?? [];
  const inst = new Map<string, number>(), net = new Map<string, number>();
  for (const r of listed) {
    if (r.source === "PLAID") {
      const name = institutionName(institutionIds.get(r.id) ?? null);
      inst.set(name, (inst.get(name) ?? 0) + 1);
    } else {
      const code_ = networkCodeOf(chainsOfLabel(r.network));
      net.set(code_, (net.get(code_) ?? 0) + 1);
    }
  }
  const nonHealthy = n(h.total) - n(h.counts?.HEALTHY);
  const listFloor = listed.length < nonHealthy;
  return {
    status: listFloor ? "PARTIAL" : "CONFIRMED",
    asOf: typeof h.checkedAt === "string" && !Number.isNaN(Date.parse(h.checkedAt)) ? new Date(h.checkedAt).toISOString() : new Date(0).toISOString(),
    total: n(h.total), byHealth,
    retired: { revoked: n(h.retired?.revoked), ownerInactive: n(h.retired?.ownerInactive) },
    bySource,
    unhealthyByInstitution: [...inst].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([institution, count]) => ({ institution, count })),
    unhealthyByNetwork: [...net].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([network, count]) => ({ network, count })),
    neverSyncedListed: listed.filter((r) => r.neverSynced === true).length,
    listFloor,
  };
}

// ── The contracts ────────────────────────────────────────────────────────────

function csToken(ctx: ConnectionsToolContext): CsToken {
  const g = ctx.fresh?.get(CUSTOMER_AREA);
  const t = g?.incidentToken;
  if (!g || g.csTier !== true || !t || t.audience !== "CUSTOMER_SUCCESS") throw new Error("connections pack: no fresh CUSTOMER_SUCCESS guard");
  return t as CsToken;
}

const result = (status: RecordRunResult["status"], now: Date, records: RawRecord[], truncated: boolean): RecordRunResult =>
  ({ status, asOf: isoTime(now), records, truncated });

const viewed = { action: AuditAction.PLATFORM_AI_RECORD_VIEWED, detail: { surface: "platform-ai", recordKind: CONNECTION_RECORD_KIND } } as const;

/** The connections-pack tools over these readers (the registry uses the Production readers). */
export function connectionsPackTools<Ctx extends ConnectionsToolContext>(readers: ConnectionsPackReaders): PlatformAiToolContract<Ctx>[] {
  return [
    {
      name: "connection_health_overview", pack: "connections", scope: "AGGREGATE", customerLinkable: false, pii: 0, cost: { toolCalls: 1 },
      requires: { areas: [CONNECTIONS_OPS_AREA, CUSTOMER_AREA], level: "READ", tier: "OPS" },
      description: "Connection health counts (banks + wallets): total, byHealth, retired, bySource faults by healthState + errorCode, unhealthy by institution / wallet network code. No records, no customers.",
      args: { properties: {} },
      run: async (_args, ctx) => {
        const c = ctx as ConnectionsToolContext;
        const now = readers.now();
        try {
          const h = await readers.health();
          const plaidIds = (h.unhealthy ?? []).filter((r) => r.source === "PLAID").map((r) => r.id);
          const ids = plaidIds.length ? await readers.institutionIds(plaidIds) : new Map<string, string>();
          const out = overviewOfHealth(h, ids);
          c.ev?.trace.push({ tool: "connection_health_overview", outcome: "OK", refs: [], count: out.total });
          return out;
        } catch {
          c.ev?.trace.push({ tool: "connection_health_overview", outcome: "UNAVAILABLE", refs: [] });
          return { status: "UNAVAILABLE", asOf: now.toISOString() } satisfies ConnectionHealthOverview;
        }
      },
    },
    {
      name: "get_customer_connections", pack: "connections", scope: "RECORD", customerLinkable: true, audit: viewed, pii: 2, cost: { toolCalls: 1 },
      requires: { areas: [CUSTOMER_AREA], level: "READ", tier: "CUSTOMER_SUCCESS" }, recordSchema: CUSTOMER_CONNECTION_SCHEMA,
      description: "One customer's live connections by customer handle, ≤10: provider, kind, institution, network (wallet chain code), status, healthState, errorCode, needsReauth, lastSyncedAt, neverSynced, connectedAt.",
      args: { properties: { customer: { kind: "handle", recordKind: CUSTOMER_RECORD_KIND } } },
      revalidate: async (rid) => CUSTOMER_RID.test(rid) && (await readers.resolveRid(rid)) !== null,
      run: async (args, ctx) => {
        csToken(ctx);
        const now = readers.now();
        const userId = await readers.resolveRid(String(args.customer));
        if (!userId) return result("MISSING", now, [], false);
        const { rows, truncated } = await readers.customerConnections(userId, now);
        const records = mapCustomerConnections(userId, rows, readers);
        return result(records.length === 0 ? "MISSING" : "CONFIRMED", now, records, truncated || rows.length > records.length);
      },
    },
  ] as PlatformAiToolContract<Ctx>[];
}

/** The connections-pack tool names. */
export const CONNECTION_TOOL_NAMES: readonly string[] = ["connection_health_overview", "get_customer_connections"];
