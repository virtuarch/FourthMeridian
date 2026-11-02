/**
 * lib/platform/growth/beta-blocklist.ts  (owner P2-1 · hashed blocked identifiers — THE I/O)
 *
 * Everything that reads or writes BetaBlockedIdentifier, on fm_system
 * (docs/plans/BETA-BLOCKED-IDENTIFIER-DESIGN-2026-11-01.md). The pure rules —
 * the canonical mailbox, the keyring, the bounds — are beta-blocklist-core.ts.
 *
 * ── WHEN A BLOCK EXISTS (§3) ──────────────────────────────────────────────────
 * Only when a request BECOMES DENIED with a latest OPERATOR verdict of
 * SUSPICIOUS — inside the deny transaction or the risk-review transaction,
 * under that request's row lock — or through the audited backfill for denials
 * made before this shipped. An automated risk level, a PENDING+SUSPICIOUS
 * request and a plain DENIED never block (requirement 4).
 *
 * ── SERIALISATION (§8) ────────────────────────────────────────────────────────
 * A block's SOURCE request row lock does not cover an alias that lives on a
 * different request row. So every block write AND every in-transaction issuance
 * re-check first takes a transaction-scoped advisory lock on the identifier
 * (`pg_advisory_xact_lock(hashtextextended('beta-blocklist:<current hmac>', 0))`):
 * a block created while an approval of an alias is in flight is either seen by
 * that approval's re-check or waits for it. The partial unique index (one ACTIVE
 * row per identifier and version) is the last line.
 *
 * ── PRIVACY ───────────────────────────────────────────────────────────────────
 * The address is used only to compute the HMAC, in memory. No audit row and no
 * log line carries the address or a full HMAC — ids, key version and an 8-hex
 * prefix at most (the operator lookup records the usual auditEmailHash).
 */

import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { systemDb } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { auditEmailHash, isOperatorReasonCode, recordOperatorAction, type OperatorActionInput, type OperatorReason } from "@/lib/audit";
import {
  blockExpiryFor, blocklistMailbox, blocklistHmac, blocklistMode, checkCorrectedExpiry, hmacPrefix, mailboxLockKey, identifierPairs,
  type BlocklistKey, type EnvSource,
} from "./beta-blocklist-core";
import type { BetaRequestBlockState, BlocklistAvailability } from "./beta-risk-types";

type Db = typeof systemDb;
export type BlocklistReader = Pick<Prisma.TransactionClient, "betaBlockedIdentifier">;
export type BlocklistTx = Pick<Prisma.TransactionClient, "betaBlockedIdentifier" | "betaAccessRequest" | "betaAccessRequestReview" | "auditLog" | "$executeRaw">;

/** Thrown inside a transaction when a block must be written but cannot (Production, no usable key): the transaction rolls back. */
export class BlocklistUnavailableError extends Error {
  readonly code = "BLOCKLIST_UNAVAILABLE" as const;
  constructor() {
    super("The blocklist is unavailable (its key is not configured), so a block could not be recorded. Nothing was changed.");
    this.name = "BlocklistUnavailableError";
  }
}

export const BLOCKLIST_UNAVAILABLE_MESSAGE =
  "The blocklist is unavailable (its key is not configured), so this could not be checked or recorded. Nothing was changed.";

const warned = new Set<string>();
/** One line per distinct reason per process. Names variables only — never a value, an address or a hash. */
function warnOnce(kind: "skip" | "unavailable" | "read", problem: string): void {
  const k = `${kind}:${problem}`;
  if (warned.has(k)) return;
  warned.add(k);
  if (kind === "skip") console.warn(`[beta-blocklist] ${problem} — blocklist checks are SKIPPED outside Production`);
  else if (kind === "unavailable") console.error(`[beta-blocklist] ${problem} — Production: invitation issuance REFUSES (BLOCKLIST_UNAVAILABLE) and blocks cannot be written`);
  else console.error(`[beta-blocklist] blocklist read failed (${problem}) — treated as UNAVAILABLE`);
}

/** Test seam: forget which warnings were printed. */
export function resetBlocklistWarnings(): void { warned.clear(); }

export type BlockState =
  | { state: "BLOCKED"; blockId: string; keyVersion: string; expiresAt: Date }
  | { state: "CLEAR" }
  /** Outside Production with no usable key: not checked. */
  | { state: "SKIPPED" }
  /** Production with no usable key, or the read failed: fail closed where it matters. */
  | { state: "UNAVAILABLE" };

export interface BlocklistOpts { env?: EnvSource; now?: Date }

async function findActive(client: BlocklistReader, email: string, keys: readonly BlocklistKey[], now: Date) {
  return client.betaBlockedIdentifier.findFirst({
    where: { status: "ACTIVE", expiresAt: { gt: now }, OR: identifierPairs(email, keys) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, keyVersion: true, expiresAt: true, identifierHmac: true },
  });
}

/**
 * Is this address's canonical mailbox blocked? Matches every configured key
 * version. Never throws: a failed read is UNAVAILABLE (callers that issue fail
 * closed on it; the public intake stores the request).
 */
export async function lookupIdentifierBlock(client: BlocklistReader, email: string, opts: BlocklistOpts = {}): Promise<BlockState> {
  const mode = blocklistMode(opts.env);
  if (mode.mode === "SKIP") { warnOnce("skip", mode.problem); return { state: "SKIPPED" }; }
  if (mode.mode === "UNAVAILABLE") { warnOnce("unavailable", mode.problem); return { state: "UNAVAILABLE" }; }
  try {
    const hit = await findActive(client, email, mode.keys.all, opts.now ?? new Date());
    return hit ? { state: "BLOCKED", blockId: hit.id, keyVersion: hit.keyVersion, expiresAt: hit.expiresAt } : { state: "CLEAR" };
  } catch (err) {
    warnOnce("read", err instanceof Error ? err.name : "error");
    return { state: "UNAVAILABLE" };
  }
}

/**
 * PB-6 — what the blocklist can do in this environment, as a word the operator
 * UI can show. Derived from the key MODE only — never a key, a version or a problem string.
 */
export function blocklistAvailability(env?: EnvSource): BlocklistAvailability {
  const mode = blocklistMode(env).mode;
  return mode === "ENFORCE" ? "ENFORCED" : mode === "SKIP" ? "NOT_CONFIGURED" : "UNAVAILABLE";
}

/**
 * PB-6 — which of these requests currently CAUSE an enforced block: an ACTIVE,
 * unexpired row whose soft `sourceRequestId` is the request. Selects the link,
 * the creation instant and the expiry only — the HMAC, its key version and the
 * block id never leave this read. The earliest block per request wins.
 */
export async function loadSourceRequestBlocks(
  client: BlocklistReader, requestIds: readonly string[], opts: { now?: Date } = {},
): Promise<Map<string, BetaRequestBlockState>> {
  const ids = [...new Set(requestIds)];
  const out = new Map<string, BetaRequestBlockState>();
  if (ids.length === 0) return out;
  const rows = await client.betaBlockedIdentifier.findMany({
    where: { sourceRequestId: { in: ids }, status: "ACTIVE", expiresAt: { gt: opts.now ?? new Date() } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { sourceRequestId: true, createdAt: true, expiresAt: true },
  });
  for (const r of rows) {
    if (out.has(r.sourceRequestId)) continue;
    out.set(r.sourceRequestId, { state: "BLOCKED", since: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString() });
  }
  return out;
}

/**
 * The public intake's question (app/api/access-request): is this mailbox
 * blocked? Read on fm_system (the intake's own role holds nothing on the
 * table). Only a positive BLOCKED drops the submission: SKIPPED / UNAVAILABLE /
 * a failed read store it as before — a waitlist row, while issuance re-checks
 * and fails closed in Production. Never throws, never logs the address.
 */
export async function intakeMailboxBlocked(email: string, opts: BlocklistOpts & { client?: BlocklistReader } = {}): Promise<boolean> {
  const s = await lookupIdentifierBlock(opts.client ?? systemDb, email, opts);
  return s.state === "BLOCKED";
}

/**
 * THE LOCK ORDER (every blocklist-aware writer): this mailbox advisory lock FIRST, then
 * any row lock (`SELECT … FOR UPDATE` on BetaAccessRequest, or a row UPDATE). Deny,
 * risk review, backfill, approve, resend and direct all follow it, so no two of them can
 * wait on each other in opposite orders (live PG16 review: S1b, S1d, S4 deadlocks).
 * Re-entrant within a transaction (taking it twice is a no-op wait).
 */
export async function lockMailbox(tx: Pick<Prisma.TransactionClient, "$executeRaw">, email: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${mailboxLockKey(email)}, 0))`;
}

async function lockIdentifier(tx: Pick<Prisma.TransactionClient, "$executeRaw">, current: BlocklistKey, email: string): Promise<string> {
  await lockMailbox(tx, email);
  return blocklistHmac(blocklistMailbox(email), current.key);
}

/**
 * The IN-TRANSACTION re-check issuance makes just before it writes: take the
 * identifier's advisory lock, then read. A read failure THROWS (the issuance
 * transaction aborts — nothing minted).
 */
export async function lockAndLookupIdentifierBlock(
  tx: Pick<Prisma.TransactionClient, "betaBlockedIdentifier" | "$executeRaw">, email: string, opts: BlocklistOpts = {},
): Promise<BlockState> {
  // The mailbox lock is taken whatever the key state, so the lock order holds everywhere.
  await lockMailbox(tx, email);
  const mode = blocklistMode(opts.env);
  if (mode.mode === "SKIP") { warnOnce("skip", mode.problem); return { state: "SKIPPED" }; }
  if (mode.mode === "UNAVAILABLE") { warnOnce("unavailable", mode.problem); return { state: "UNAVAILABLE" }; }
  const hit = await findActive(tx, email, mode.keys.all, opts.now ?? new Date());
  return hit ? { state: "BLOCKED", blockId: hit.id, keyVersion: hit.keyVersion, expiresAt: hit.expiresAt } : { state: "CLEAR" };
}

/** The request's latest operator verdict (newest first, ties by id — as the risk-review history orders them). */
export async function latestVerdict(
  client: Pick<Prisma.TransactionClient, "betaAccessRequestReview">, requestId: string,
): Promise<{ status: string; reasonCode: string } | null> {
  return client.betaAccessRequestReview.findFirst({
    where: { requestId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { status: true, reasonCode: true },
  });
}

// ── Writes ────────────────────────────────────────────────────────────────────

interface Attribution {
  actor: OperatorActionInput["actor"];
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface BlockUpsertInput extends Attribution {
  email: string;
  sourceRequestId: string;
  /** The confirming SUSPICIOUS verdict's operator reason code. */
  reasonCode: string;
  now?: Date;
  env?: EnvSource;
}

export type BlockUpsertResult =
  | { outcome: "created" | "alreadyBlocked"; blockId: string; keyVersion: string; expiresAt: Date }
  /** Outside Production with no usable key: nothing written (warned once). */
  | { outcome: "skipped" };

const reasonOf = (code: string): OperatorReason | undefined => (isOperatorReasonCode(code) ? { code } : undefined);

/**
 * Block this address's canonical mailbox, INSIDE the caller's transaction (which
 * already holds the source request's row lock). An ACTIVE, unexpired block for
 * the identifier under any configured version stands as it is — nothing is
 * created or extended — and the audit says alreadyBlocked. Throws
 * BlocklistUnavailableError in Production without a usable key, so the deny /
 * verdict transaction rolls back.
 */
export async function upsertIdentifierBlock(tx: BlocklistTx, input: BlockUpsertInput): Promise<BlockUpsertResult> {
  const mode = blocklistMode(input.env);
  if (mode.mode === "SKIP") { warnOnce("skip", mode.problem); return { outcome: "skipped" }; }
  if (mode.mode === "UNAVAILABLE") { warnOnce("unavailable", mode.problem); throw new BlocklistUnavailableError(); }
  const now = input.now ?? new Date();
  const current = mode.keys.current;
  const hmac = await lockIdentifier(tx, current, input.email);

  const existing = await findActive(tx, input.email, mode.keys.all, now);
  let result: BlockUpsertResult;
  if (existing) {
    result = { outcome: "alreadyBlocked", blockId: existing.id, keyVersion: existing.keyVersion, expiresAt: existing.expiresAt };
  } else {
    // An ACTIVE row past its expiry (retention has not run yet) still holds the
    // partial-unique slot: retire it first, labelled, so the new block can exist.
    await tx.betaBlockedIdentifier.updateMany({
      where: { identifierHmac: hmac, keyVersion: current.version, status: "ACTIVE", expiresAt: { lte: now } },
      data: { status: "REMOVED", removedAt: now, removalReasonCode: "EXPIRED" },
    });
    const row = await tx.betaBlockedIdentifier.create({
      data: {
        identifierHmac: hmac, keyVersion: current.version, status: "ACTIVE",
        sourceRequestId: input.sourceRequestId, reasonCode: input.reasonCode,
        createdById: input.actor.userId, createdAt: now, expiresAt: blockExpiryFor(now),
      },
      select: { id: true, keyVersion: true, expiresAt: true },
    });
    result = { outcome: "created", blockId: row.id, keyVersion: row.keyVersion, expiresAt: row.expiresAt };
  }
  // A LIVE invitation already sent to an ALIAS of this mailbox (another row) would
  // still be redeemable — registration (fm_auth) never consults the blocklist. Revoke
  // each one here, in the same transaction, exactly as the operator Revoke does.
  const revokedAliasRequestIds = await revokeAliasInvitations(tx, input, result.blockId, now);

  const reason = reasonOf(input.reasonCode);
  await recordOperatorAction(tx, {
    actor: input.actor,
    action: AuditAction.BETA_IDENTIFIER_BLOCKED,
    target: { kind: "BETA_BLOCKED_IDENTIFIER", id: result.blockId },
    ...(reason ? { reason } : {}),
    result: "SUCCESS",
    detail: {
      blockId: result.blockId, keyVersion: result.keyVersion, expiresAt: result.expiresAt.toISOString(),
      sourceRequestId: input.sourceRequestId, betaRequestId: input.sourceRequestId,
      hmacPrefix: hmacPrefix(existing?.identifierHmac ?? hmac), alreadyBlocked: result.outcome === "alreadyBlocked",
      revokedAliasInvitations: revokedAliasRequestIds.length,
    },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });
  return result;
}

/**
 * Revoke every LIVE invitation (APPROVED with a token) whose address is an alias of
 * the blocked mailbox, other than the source request. Same effect as the operator
 * Revoke (status DENIED, token and expiry nulled), conditional on the token observed
 * so a concurrent change is never overwritten, one BETA_INVITATION_REVOKED audit row
 * each (email hash only). APPROVED rows are a small set; the match is in code because
 * the canonical mailbox is not a column. Returns the revoked request ids.
 */
async function revokeAliasInvitations(tx: BlocklistTx, input: BlockUpsertInput, blockId: string, now: Date): Promise<string[]> {
  const mailbox = blocklistMailbox(input.email);
  const live = await tx.betaAccessRequest.findMany({
    where: { status: "APPROVED", inviteTokenHash: { not: null }, id: { not: input.sourceRequestId } },
    select: { id: true, email: true, inviteTokenHash: true },
  });
  const revoked: string[] = [];
  const reason = reasonOf(input.reasonCode);
  for (const r of live) {
    if (blocklistMailbox(r.email) !== mailbox) continue;
    const { count } = await tx.betaAccessRequest.updateMany({
      where: { id: r.id, status: "APPROVED", inviteTokenHash: r.inviteTokenHash },
      data: { status: "DENIED", inviteTokenHash: null, inviteExpiresAt: null, decidedAt: now, decidedById: input.actor.userId },
    });
    if (count !== 1) continue;
    revoked.push(r.id);
    await recordOperatorAction(tx, {
      actor: input.actor,
      action: AuditAction.BETA_INVITATION_REVOKED,
      target: { kind: "BETA_REQUEST", id: r.id },
      ...(reason ? { reason } : {}),
      result: "SUCCESS",
      detail: { betaRequestId: r.id, emailHash: auditEmailHash(r.email), cause: "IDENTIFIER_BLOCKED", blockId },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });
  }
  return revoked;
}

/**
 * The DENIED + latest-SUSPICIOUS rule, inside the caller's transaction (which
 * holds the request's row lock): block when it holds, do nothing otherwise.
 */
export async function blockIfConfirmedSuspicious(
  tx: BlocklistTx,
  input: Omit<BlockUpsertInput, "reasonCode"> & { requestStatus: string },
): Promise<BlockUpsertResult | null> {
  if (input.requestStatus !== "DENIED") return null;
  const verdict = await latestVerdict(tx, input.sourceRequestId);
  if (verdict?.status !== "SUSPICIOUS") return null;
  return upsertIdentifierBlock(tx, { ...input, reasonCode: verdict.reasonCode });
}

/**
 * A newer LEGITIMATE / UNREVIEWED verdict on the source request: every ACTIVE
 * block it caused is REMOVED (reason = the verdict's), one audit row each.
 */
export async function removeBlocksForSourceRequest(
  tx: BlocklistTx,
  input: Attribution & { sourceRequestId: string; reason: OperatorReason; now?: Date },
): Promise<{ removed: string[] }> {
  const now = input.now ?? new Date();
  const active = await tx.betaBlockedIdentifier.findMany({
    where: { sourceRequestId: input.sourceRequestId, status: "ACTIVE" },
    select: { id: true, keyVersion: true, identifierHmac: true, expiresAt: true },
  });
  const removed: string[] = [];
  for (const b of active) {
    const { count } = await tx.betaBlockedIdentifier.updateMany({
      where: { id: b.id, status: "ACTIVE" },
      data: { status: "REMOVED", removedAt: now, removedById: input.actor.userId, removalReasonCode: input.reason.code, removalNote: input.reason.note ?? null },
    });
    if (count !== 1) continue;
    removed.push(b.id);
    await recordOperatorAction(tx, {
      actor: input.actor,
      action: AuditAction.BETA_IDENTIFIER_UNBLOCKED,
      target: { kind: "BETA_BLOCKED_IDENTIFIER", id: b.id },
      reason: input.reason,
      result: "SUCCESS",
      change: { before: { status: "ACTIVE" }, after: { status: "REMOVED" } },
      detail: { blockId: b.id, keyVersion: b.keyVersion, sourceRequestId: input.sourceRequestId, betaRequestId: input.sourceRequestId, hmacPrefix: hmacPrefix(b.identifierHmac), via: "VERDICT" },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });
  }
  return { removed };
}

// ── Operator routes (Growth & Revenue) ────────────────────────────────────────

export interface BlockedIdentifierView {
  id: string;
  hmacPrefix: string;
  keyVersion: string;
  status: "ACTIVE" | "REMOVED";
  createdAt: string;
  expiresAt: string;
  /** ACTIVE but past its expiry (retention has not deleted it yet): no longer enforced. */
  expired: boolean;
  reasonCode: string;
  sourceRequestId: string;
  sourceRequestExists: boolean;
  removedAt: string | null;
  removalReasonCode: string | null;
  removalNote: string | null;
}

export const BLOCKLIST_LIST_CAP = 200;

export async function listIdentifierBlocks(
  opts: { client?: Db; status?: "ACTIVE" | "REMOVED" | "ALL"; now?: Date } = {},
): Promise<{ blocks: BlockedIdentifierView[]; capped: boolean }> {
  const client = opts.client ?? systemDb;
  const now = opts.now ?? new Date();
  const status = opts.status ?? "ALL";
  const rows = await client.betaBlockedIdentifier.findMany({
    where: status === "ALL" ? {} : { status },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: BLOCKLIST_LIST_CAP + 1,
  });
  const kept = rows.slice(0, BLOCKLIST_LIST_CAP);
  const sources = [...new Set(kept.map((r) => r.sourceRequestId))];
  const existing = sources.length
    ? new Set((await client.betaAccessRequest.findMany({ where: { id: { in: sources } }, select: { id: true } })).map((r) => r.id))
    : new Set<string>();
  return {
    capped: rows.length > BLOCKLIST_LIST_CAP,
    blocks: kept.map((r) => ({
      id: r.id, hmacPrefix: hmacPrefix(r.identifierHmac), keyVersion: r.keyVersion, status: r.status,
      createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString(),
      expired: r.status === "ACTIVE" && r.expiresAt.getTime() <= now.getTime(),
      reasonCode: r.reasonCode, sourceRequestId: r.sourceRequestId, sourceRequestExists: existing.has(r.sourceRequestId),
      removedAt: r.removedAt?.toISOString() ?? null, removalReasonCode: r.removalReasonCode, removalNote: r.removalNote,
    })),
  };
}

export type BlockMutationResult =
  | { ok: true; blockId: string; status: "REMOVED" | "ACTIVE"; expiresAt: string }
  | { ok: false; code: "NOT_FOUND" | "NOT_ACTIVE" | "INVALID_EXPIRY" | "CONFLICT"; message: string; status: 400 | 404 | 409 };

interface MutationInput extends Attribution { blockId: string; reason: OperatorReason; client?: Db; now?: Date }

/** Manual removal (fresh CONTROL, reason required). A block retention already deleted is a 404 — never resurrected. */
export async function removeIdentifierBlock(input: MutationInput): Promise<BlockMutationResult> {
  const client = input.client ?? systemDb;
  const now = input.now ?? new Date();
  return client.$transaction(async (tx) => {
    const b = await tx.betaBlockedIdentifier.findUnique({ where: { id: input.blockId } });
    if (!b) return { ok: false, code: "NOT_FOUND", message: "Block not found (it may have expired and been deleted).", status: 404 } as const;
    if (b.status !== "ACTIVE") return { ok: false, code: "NOT_ACTIVE", message: "This block was already removed.", status: 409 } as const;
    const { count } = await tx.betaBlockedIdentifier.updateMany({
      where: { id: b.id, status: "ACTIVE" },
      data: { status: "REMOVED", removedAt: now, removedById: input.actor.userId, removalReasonCode: input.reason.code, removalNote: input.reason.note ?? null },
    });
    if (count !== 1) return { ok: false, code: "CONFLICT", message: "This block changed while you were removing it. Reload and try again.", status: 409 } as const;
    await recordOperatorAction(tx, {
      actor: input.actor,
      action: AuditAction.BETA_IDENTIFIER_UNBLOCKED,
      target: { kind: "BETA_BLOCKED_IDENTIFIER", id: b.id },
      reason: input.reason,
      result: "SUCCESS",
      change: { before: { status: "ACTIVE" }, after: { status: "REMOVED" } },
      detail: { blockId: b.id, keyVersion: b.keyVersion, sourceRequestId: b.sourceRequestId, hmacPrefix: hmacPrefix(b.identifierHmac), via: "MANUAL" },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });
    return { ok: true, blockId: b.id, status: "REMOVED", expiresAt: b.expiresAt.toISOString() } as const;
  });
}

/** Expiry correction (fresh CONTROL, reason required): within [now + 1 day, createdAt + BLOCKLIST_MAX_DAYS]. */
export async function correctIdentifierBlockExpiry(input: MutationInput & { expiresAt: unknown }): Promise<BlockMutationResult> {
  const client = input.client ?? systemDb;
  const now = input.now ?? new Date();
  return client.$transaction(async (tx) => {
    const b = await tx.betaBlockedIdentifier.findUnique({ where: { id: input.blockId } });
    if (!b) return { ok: false, code: "NOT_FOUND", message: "Block not found (it may have expired and been deleted).", status: 404 } as const;
    if (b.status !== "ACTIVE") return { ok: false, code: "NOT_ACTIVE", message: "Only an active block's expiry can be corrected.", status: 409 } as const;
    const c = checkCorrectedExpiry(input.expiresAt, b.createdAt, now);
    if (!c.ok) return { ok: false, code: "INVALID_EXPIRY", message: c.reason, status: 400 } as const;
    const { count } = await tx.betaBlockedIdentifier.updateMany({
      where: { id: b.id, status: "ACTIVE", expiresAt: b.expiresAt },
      data: { expiresAt: c.expiresAt },
    });
    if (count !== 1) return { ok: false, code: "CONFLICT", message: "This block changed while you were correcting it. Reload and try again.", status: 409 } as const;
    await recordOperatorAction(tx, {
      actor: input.actor,
      action: AuditAction.BETA_IDENTIFIER_BLOCK_CORRECTED,
      target: { kind: "BETA_BLOCKED_IDENTIFIER", id: b.id },
      reason: input.reason,
      result: "SUCCESS",
      change: { before: { expiresAt: b.expiresAt.toISOString() }, after: { expiresAt: c.expiresAt.toISOString() } },
      detail: { blockId: b.id, keyVersion: b.keyVersion, sourceRequestId: b.sourceRequestId, hmacPrefix: hmacPrefix(b.identifierHmac) },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });
    return { ok: true, blockId: b.id, status: "ACTIVE", expiresAt: c.expiresAt.toISOString() } as const;
  });
}

export type OperatorLookupResult =
  | { ok: true; blocked: false }
  | { ok: true; blocked: true; block: { id: string; keyVersion: string; expiresAt: string; hmacPrefix: string } }
  | { ok: false; code: "BLOCKLIST_UNAVAILABLE"; message: string };

/**
 * "Is this address blocked, and by which block?" — an appeal check. The address
 * is used ONLY to compute the HMACs; the audit row stores its auditEmailHash and
 * the answer. Needs a usable key in every environment (it cannot answer without).
 */
export async function operatorLookupIdentifier(
  input: Attribution & { email: string; reason: OperatorReason; client?: Db; now?: Date; env?: EnvSource },
): Promise<OperatorLookupResult> {
  const client = input.client ?? systemDb;
  const mode = blocklistMode(input.env);
  if (mode.mode !== "ENFORCE") return { ok: false, code: "BLOCKLIST_UNAVAILABLE", message: BLOCKLIST_UNAVAILABLE_MESSAGE };
  const hit = await findActive(client, input.email, mode.keys.all, input.now ?? new Date());
  await recordOperatorAction(client, {
    actor: input.actor,
    action: AuditAction.BETA_IDENTIFIER_LOOKUP,
    target: { kind: "BETA_BLOCKED_IDENTIFIER", id: hit?.id ?? "none" },
    reason: input.reason,
    result: "SUCCESS",
    detail: { emailHash: auditEmailHash(input.email), outcome: hit ? "BLOCKED" : "CLEAR", ...(hit ? { blockId: hit.id, keyVersion: hit.keyVersion } : {}) },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });
  if (!hit) return { ok: true, blocked: false };
  return { ok: true, blocked: true, block: { id: hit.id, keyVersion: hit.keyVersion, expiresAt: hit.expiresAt.toISOString(), hmacPrefix: hmacPrefix(hit.identifierHmac) } };
}

// ── Backfill (§10 — decisions made before B9) ─────────────────────────────────

/** Requests scanned per backfill run. */
export const BLOCKLIST_BACKFILL_CAP = 500;

export type BackfillOutcome = "created" | "alreadyBlocked" | "notSuspicious" | "notDenied" | "failed" | "wouldCreate";

export type BackfillResult =
  | {
      ok: true; dryRun: boolean; batchId: string | null; capped: boolean;
      counts: Record<BackfillOutcome, number> & { candidates: number };
      requests: { id: string; outcome: BackfillOutcome }[];
    }
  | { ok: false; code: "BLOCKLIST_UNAVAILABLE"; message: string };

/**
 * Block every DENIED request whose latest verdict is SUSPICIOUS and whose
 * identifier has no ACTIVE block. DRY RUN BY DEFAULT (counts, writes nothing).
 * Executed: each request in its own transaction under its row lock (the same
 * blockIfConfirmedSuspicious the deny path runs), one BETA_IDENTIFIER_BLOCKED
 * per block, then ONE counts-only BETA_IDENTIFIER_BACKFILL row. Idempotent.
 */
export async function backfillIdentifierBlocks(
  input: Attribution & { dryRun: boolean; reason: OperatorReason; client?: Db; now?: Date; env?: EnvSource; cap?: number },
): Promise<BackfillResult> {
  const client = input.client ?? systemDb;
  const now = input.now ?? new Date();
  const mode = blocklistMode(input.env);
  if (mode.mode !== "ENFORCE") return { ok: false, code: "BLOCKLIST_UNAVAILABLE", message: BLOCKLIST_UNAVAILABLE_MESSAGE };
  const cap = input.cap ?? BLOCKLIST_BACKFILL_CAP;
  const candidates = await client.betaAccessRequest.findMany({
    where: { status: "DENIED", riskReviews: { some: { status: "SUSPICIOUS" } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: cap + 1,
    select: { id: true, email: true },
  });
  const scanned = candidates.slice(0, cap);
  const counts: Record<BackfillOutcome, number> = { created: 0, alreadyBlocked: 0, notSuspicious: 0, notDenied: 0, failed: 0, wouldCreate: 0 };
  const requests: { id: string; outcome: BackfillOutcome }[] = [];
  const note = (id: string, outcome: BackfillOutcome) => { counts[outcome]++; requests.push({ id, outcome }); };

  for (const c of scanned) {
    if (input.dryRun) {
      const v = await latestVerdict(client, c.id);
      if (v?.status !== "SUSPICIOUS") { note(c.id, "notSuspicious"); continue; }
      note(c.id, (await findActive(client, c.email, mode.keys.all, now)) ? "alreadyBlocked" : "wouldCreate");
      continue;
    }
    try {
      const outcome = await client.$transaction(async (tx): Promise<BackfillOutcome> => {
        // Lock order: the mailbox advisory lock FIRST (email is immutable), then the row.
        await lockMailbox(tx, c.email);
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "BetaAccessRequest" WHERE "id" = ${c.id} FOR UPDATE`;
        if (locked.length === 0) return "notDenied";
        const row = await tx.betaAccessRequest.findUnique({ where: { id: c.id }, select: { email: true, status: true } });
        if (!row || row.status !== "DENIED") return "notDenied";
        const r = await blockIfConfirmedSuspicious(tx, {
          sourceRequestId: c.id, email: row.email, requestStatus: row.status, actor: input.actor, now, env: input.env,
          ipAddress: input.ipAddress, userAgent: input.userAgent,
        });
        if (!r) return "notSuspicious";
        return r.outcome === "skipped" ? "failed" : r.outcome;
      });
      note(c.id, outcome);
    } catch (err) {
      console.error("[beta-blocklist] backfill row failed:", err instanceof Error ? err.name : "error");
      note(c.id, "failed");
    }
  }

  let batchId: string | null = null;
  if (!input.dryRun) {
    batchId = randomUUID();
    await recordOperatorAction(client, {
      actor: input.actor,
      action: AuditAction.BETA_IDENTIFIER_BACKFILL,
      target: { kind: "BETA_BATCH", id: batchId },
      reason: input.reason,
      result: counts.failed > 0 ? "FAILURE" : "SUCCESS",
      detail: { batchId, candidates: scanned.length, capped: candidates.length > cap, counts },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });
  }
  return { ok: true, dryRun: input.dryRun, batchId, capped: candidates.length > cap, counts: { ...counts, candidates: scanned.length }, requests };
}
