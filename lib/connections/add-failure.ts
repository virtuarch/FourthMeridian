/**
 * lib/connections/add-failure.ts  (B12 PR-B — server-side link / exchange / wallet-add failure capture)
 *
 * THE GAP. A Plaid Link token that could not be minted, a public token that
 * could not be exchanged, or a wallet add that threw used to leave only a
 * Vercel log line. Platform Operations could see a customer LEAVE Link
 * (CONNECTION_LINK_EXITED, client beacon) but not the server failing them.
 *
 * THE RECORD. One `CONNECTION_ADD_FAILED` AuditLog row per failed request, on
 * the caller's own tenant phase (fm_app: AuditLog INSERT is WITH CHECK (true)),
 * shaped by the one audit shape authority (`buildAuditData`). Its metadata is
 * three closed-vocabulary codes and nothing else:
 *
 *   provider   PLAID | WALLET
 *   stage      LINK_TOKEN | EXCHANGE (PLAID) · WALLET_ADD (WALLET)
 *   errorCode  a Plaid error code from the Link vocabulary (LINK_EXIT_ERROR_CODES,
 *              unknown ⇒ "OTHER"), or one of the server classes below
 *
 * Never an institution, a provider message (error_message / display_message),
 * a token, an address, an account number, an e-mail or an amount: the writer has
 * no parameter to put one in, and the error itself is only CLASSIFIED here —
 * nothing read from it is stored except a code that passed the allowlist.
 * ipAddress / userAgent are null (not a security event).
 *
 * NOT A PRODUCT EVENT. PRODUCT_EVENT_ACTIONS is pinned to the DB-010 retention
 * policy (a migration); this row is a lifecycle fact like WALLET_ADD and is kept
 * with the account's audit history (userId SetNull on account purge).
 *
 * BEST-EFFORT. `recordConnectionAddFailure` never throws and never changes the
 * caller's response: a failed capture logs its error CLASS and resolves false.
 *
 * READ BY Customer Success "needs help" (`link_failed`,
 * lib/platform/customer/attention-core.ts) — the same surface as `link_exited`.
 */

import { AuditAction } from "@/lib/audit-actions";
import { buildAuditData } from "@/lib/audit";
import { LINK_EXIT_ERROR_CODES, linkExitErrorCode } from "@/lib/analytics/product-events";
import { withTenantDb } from "@/lib/db/tenant-context";
import type { Prisma } from "@prisma/client";

export const CONNECTION_ADD_FAILURE_PROVIDERS = ["PLAID", "WALLET"] as const;
export type ConnectionAddFailureProvider = (typeof CONNECTION_ADD_FAILURE_PROVIDERS)[number];

export const CONNECTION_ADD_FAILURE_STAGES = ["LINK_TOKEN", "EXCHANGE", "WALLET_ADD"] as const;
export type ConnectionAddFailureStage = (typeof CONNECTION_ADD_FAILURE_STAGES)[number];

/** Which stages belong to which provider (a mismatched pair is refused, not stored). */
const STAGE_PROVIDER: Readonly<Record<ConnectionAddFailureStage, ConnectionAddFailureProvider>> = {
  LINK_TOKEN: "PLAID",
  EXCHANGE: "PLAID",
  WALLET_ADD: "WALLET",
};

/**
 * Server-side failure classes for an error that carries no provider code:
 *   PROVIDER_HTTP_ERROR    a provider HTTP response with no error_code
 *   SERVER_CONFIGURATION   a missing / invalid server secret (env var, encryption key)
 *   INVALID_BODY           the request body was not JSON
 *   DATABASE_ERROR         a Prisma / Postgres error
 *   UNEXPECTED             anything else
 */
export const CONNECTION_ADD_FAILURE_SERVER_CODES = [
  "PROVIDER_HTTP_ERROR", "SERVER_CONFIGURATION", "INVALID_BODY", "DATABASE_ERROR", "UNEXPECTED",
] as const;

/** Every code the row may carry: the Plaid Link vocabulary (minus NONE — a failure always has a cause) plus the server classes. */
export const CONNECTION_ADD_FAILURE_CODES: readonly string[] = [
  ...LINK_EXIT_ERROR_CODES.filter((c) => c !== "NONE"),
  ...CONNECTION_ADD_FAILURE_SERVER_CODES,
];
const CODE_SET: ReadonlySet<string> = new Set(CONNECTION_ADD_FAILURE_CODES);

function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

/**
 * Classify a failure into ONE allowlisted code. `providerCode` is the Plaid
 * `error_code` the route already parsed (parsePlaidError); it is mapped through
 * the closed Link vocabulary (unknown ⇒ "OTHER"). Without one, the error's TYPE
 * decides the server class. The error's message is inspected only to recognise
 * a configuration failure and is never returned.
 */
export function connectionAddFailureCode(err: unknown, providerCode?: string | null): string {
  // parsePlaidError only returns the codes it has a user message for; the raw
  // `response.data.error_code` is read as a fallback — as an INPUT to the
  // allowlist only (an unknown value becomes "OTHER", never itself).
  const raw = typeof providerCode === "string" && providerCode.trim() !== "" ? providerCode : rawProviderCode(err);
  if (raw !== null) {
    const mapped = linkExitErrorCode(raw);
    return mapped === "NONE" ? "OTHER" : mapped;
  }
  if (err instanceof SyntaxError) return "INVALID_BODY";
  const name = err instanceof Error ? err.name : "";
  if (/^PrismaClient/.test(name)) return "DATABASE_ERROR";
  const message = err instanceof Error ? err.message : "";
  if (/ENCRYPTION_KEY|Missing env var/.test(message)) return "SERVER_CONFIGURATION";
  if (typeof err === "object" && err !== null && "response" in err) return "PROVIDER_HTTP_ERROR";
  return "UNEXPECTED";
}

function rawProviderCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null || !("response" in err)) return null;
  const data = (err as { response?: { data?: unknown } }).response?.data;
  const code = data && typeof data === "object" ? (data as Record<string, unknown>).error_code : undefined;
  return typeof code === "string" && code.trim() !== "" ? code : null;
}

/** The one capability the writer needs: create one AuditLog row. */
export interface AddFailureClient {
  auditLog: { create(args: { data: Prisma.AuditLogUncheckedCreateInput }): PromiseLike<unknown> };
}

export interface ConnectionAddFailureInput {
  userId: string;
  provider: ConnectionAddFailureProvider;
  stage: ConnectionAddFailureStage;
  errorCode: string;
}

/** PURE — the row, or null when the input is outside the vocabulary (nothing is written then). */
export function connectionAddFailureData(input: ConnectionAddFailureInput): Prisma.AuditLogUncheckedCreateInput | null {
  if (!input.userId) return null;
  if (!isOneOf(CONNECTION_ADD_FAILURE_PROVIDERS, input.provider)) return null;
  if (!isOneOf(CONNECTION_ADD_FAILURE_STAGES, input.stage) || STAGE_PROVIDER[input.stage] !== input.provider) return null;
  return buildAuditData({
    actorId: input.userId, actorType: "USER", action: AuditAction.CONNECTION_ADD_FAILED, result: "FAILURE",
    metadata: {
      provider: input.provider,
      stage: input.stage,
      errorCode: CODE_SET.has(input.errorCode) ? input.errorCode : "OTHER",
    },
    ipAddress: null, userAgent: null,
  });
}

export interface AddFailureDeps {
  /** Runs `fn` in the user's tenant phase (withTenantDb in production; a fake in tests). */
  withTenant<T>(userId: string, fn: (tx: AddFailureClient) => Promise<T>): Promise<T>;
}

const DEFAULT_DEPS: AddFailureDeps = {
  withTenant: (userId, fn) => withTenantDb(userId, (tx) => fn(tx)),
};

/**
 * Best-effort: write one CONNECTION_ADD_FAILED row. Resolves true when written;
 * false when the input is outside the vocabulary or the write failed. NEVER throws.
 */
export async function recordConnectionAddFailure(
  input: ConnectionAddFailureInput,
  deps: AddFailureDeps = DEFAULT_DEPS,
): Promise<boolean> {
  try {
    const data = connectionAddFailureData(input);
    if (!data) return false;
    await deps.withTenant(input.userId, (tx) => Promise.resolve(tx.auditLog.create({ data })));
    return true;
  } catch (err) {
    console.warn(`[connection-add-failure] ${input.stage} failure not recorded (${err instanceof Error ? err.name : "error"})`);
    return false;
  }
}
