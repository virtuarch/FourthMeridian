/**
 * lib/connections/connection-cap.ts  (BETA C7′ — the connection-count entitlement)
 *
 * HOW MANY PROVIDER CONNECTIONS A CUSTOMER MAY HOLD AT ONCE, AND WHERE THAT IS
 * ASKED. Before this there was no bound at all (AI-PLAID-COST-ECONOMICS-
 * ASSESSMENT §6.2, growth vector 6): every fresh Plaid link mints a billable
 * Item-month, and nothing stopped a single account from minting fifty.
 *
 *   PURE VERDICT   `connectionCapVerdict`  — counts in, verdict out; no clock,
 *                  no client, pinned directly by connection-cap.test.ts.
 *   LOADER         `loadConnectionCount`   — the two tenant-phase counts.
 *   RESOLVED LIMIT the customer's EFFECTIVE `maxConnections` entitlement
 *                  (lib/entitlements: policy BETA 10, founder overlay 25,
 *                  platform ceiling 25), read the way every other quota reads
 *                  its dimension — `entitlementsForUser` + `countLimit`.
 *   REFUSAL        `connectionLimitResponse` — ONE 403 body shape for both
 *                  surfaces: `{ error, code: "CONNECTION_LIMIT", current, limit }`.
 *
 * ══ WHAT COUNTS ═════════════════════════════════════════════════════════════
 *   · Plaid: every PlaidItem whose PRODUCT status is not REVOKED. NEEDS_REAUTH
 *     and ERROR count — they are live, billed subscriptions, and the repair is
 *     Reconnect (update mode), which this cap never blocks.
 *   · Wallets: every WALLET Connection not REVOKED that still has a live
 *     AccountConnection — the same population the Connections hub lists
 *     (lib/sync/wallet-connections.ts), so a wallet the customer deleted does
 *     not keep a slot.
 *   · Manual accounts are not provider connections and are not counted.
 *
 * ══ WHERE IT IS ENFORCED, AND WHERE IT DELIBERATELY IS NOT ═════════════════
 *   · app/api/plaid/link-token — FRESH links only. Update mode (reconnect,
 *     Investments consent) heals an Item the customer already holds; refusing
 *     it would strand a broken connection at the cap.
 *   · app/api/accounts/wallet — creation of a NEW wallet only; re-sharing an
 *     already-active wallet into another Space creates nothing.
 *
 * ══ AUTHORITY ═══════════════════════════════════════════════════════════════
 * The counts run on the TENANT role: `PlaidItem` and `Connection` are
 * user-scoped tables (`"userId" = me`), and `AccountConnection` is reachable
 * through the owner arm. Short phase, no network inside.
 */

import { NextResponse } from "next/server";
import { ConnectionStatus, PlaidItemStatus, ProviderType } from "@prisma/client";
import { withTenantDb } from "@/lib/db/tenant-context";
import { countLimit, entitlementsForUser, type EntitlementLoader } from "@/lib/entitlements/consume";

export interface ConnectionCapInputs {
  nonRevokedPlaidItems: number;
  walletConnections: number;
  limit: number;
}

export interface ConnectionCapVerdict {
  allowed: boolean;
  /** Connections held now (Plaid Items + wallet connections). */
  current: number;
  limit: number;
  reason: "UNDER_LIMIT" | "AT_LIMIT" | "OVER_LIMIT";
}

/** PURE. `allowed` means ONE more connection may be created. A limit below 1 refuses everything (fail closed). */
export function connectionCapVerdict(inputs: ConnectionCapInputs): ConnectionCapVerdict {
  const plaid = Math.max(0, Math.floor(inputs.nonRevokedPlaidItems));
  const wallets = Math.max(0, Math.floor(inputs.walletConnections));
  const limit = Math.floor(inputs.limit);
  const current = plaid + wallets;
  if (!Number.isFinite(limit) || limit < 1) return { allowed: false, current, limit: Math.max(0, limit || 0), reason: "OVER_LIMIT" };
  if (current < limit) return { allowed: true, current, limit, reason: "UNDER_LIMIT" };
  return { allowed: false, current, limit, reason: current === limit ? "AT_LIMIT" : "OVER_LIMIT" };
}

/** The two counts, as a tenant read client answers them. */
export interface ConnectionCountClient {
  plaidItem: { count(args: { where: { userId: string; status: { not: PlaidItemStatus } } }): Promise<number> };
  connection: {
    count(args: {
      where: {
        userId: string;
        provider: ProviderType;
        status: { not: ConnectionStatus };
        accountConnections: { some: { deletedAt: null } };
      };
    }): Promise<number>;
  };
}

export async function countConnections(
  client: ConnectionCountClient,
  userId: string,
): Promise<Pick<ConnectionCapInputs, "nonRevokedPlaidItems" | "walletConnections">> {
  const [nonRevokedPlaidItems, walletConnections] = await Promise.all([
    client.plaidItem.count({ where: { userId, status: { not: PlaidItemStatus.REVOKED } } }),
    client.connection.count({
      where: {
        userId,
        provider: ProviderType.WALLET,
        status: { not: ConnectionStatus.REVOKED },
        accountConnections: { some: { deletedAt: null } },
      },
    }),
  ]);
  return { nonRevokedPlaidItems, walletConnections };
}

/** The default loader: one tenant phase for the two counts. */
export function loadConnectionCount(userId: string) {
  return withTenantDb(userId, (tx) => countConnections(tx as unknown as ConnectionCountClient, userId));
}

export interface ConnectionCapDeps {
  counts?: (userId: string) => Promise<Pick<ConnectionCapInputs, "nonRevokedPlaidItems" | "walletConnections">>;
  entitlements?: EntitlementLoader;
}

/** The verdict for ONE customer: their counts against their effective `maxConnections`. */
export async function connectionCapForUser(userId: string, deps: ConnectionCapDeps = {}): Promise<ConnectionCapVerdict> {
  const [counts, entitlements] = await Promise.all([
    (deps.counts ?? loadConnectionCount)(userId),
    entitlementsForUser(userId, deps.entitlements),
  ]);
  return connectionCapVerdict({ ...counts, limit: countLimit(entitlements, "maxConnections") });
}

export const CONNECTION_LIMIT_CODE = "CONNECTION_LIMIT" as const;

/** The customer-facing sentence — what the Connect button shows from the 403 body. */
export function connectionLimitMessage(v: Pick<ConnectionCapVerdict, "current" | "limit">): string {
  return `Connection limit reached (${v.current} of ${v.limit}). Remove a connection to add another.`;
}

/** The ONE refusal shape, shared by the Plaid link-token and wallet routes. */
export function connectionLimitResponse(v: ConnectionCapVerdict): NextResponse {
  return NextResponse.json(
    { error: connectionLimitMessage(v), code: CONNECTION_LIMIT_CODE, current: v.current, limit: v.limit },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}
