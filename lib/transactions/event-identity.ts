/**
 * lib/transactions/event-identity.ts   (L8 — Part 3)
 *
 * THE canonical event-linking authority: which logical economic event does this
 * provider observation belong to, and what does an event's current state derive
 * to. Pure — no DB, no clock, no React. The caller supplies evidence; this
 * decides.
 *
 * ── The evidence hierarchy, and what it REFUSES ────────────────────────────
 *
 *   1. PROVIDER_PENDING_REF   the provider itself says this row succeeds another
 *   2. PERSISTED_LINK         an event link already established on the row
 *   3. PROVIDER_ROW_ID        the same provider row, re-observed
 *   4. — (deterministic fingerprint: DELIBERATELY NOT USED, see below)
 *   5. NEW_EVENT              nothing links it; a fresh identity, honestly
 *
 * ⚠️ Rung 4 of the briefed hierarchy — "existing deterministic fingerprint where
 * already proven safe" — is deliberately EMPTY. The only fingerprint this
 * repository has is `RelationshipResolver.resolveDuplicate`'s
 * (account + date + amount + pending + normalized merchant), and it was built to
 * flag SUSPECTED DUPLICATES for a human, not to establish identity. It is exactly
 * the amount/merchant/date coincidence the brief forbids, wearing a different
 * name. Two genuinely separate $4.03 pharmacy purchases on one day would be
 * fused into one event and one of them would vanish from the ledger. Identity
 * gets provider evidence or a new event; there is no third option.
 *
 * ⚠️ Nothing here joins on amount, merchant, proximity, account or cadence. Those
 * support diagnostics; they never support identity.
 */

import { sha256 } from "@noble/hashes/sha2.js";

/**
 * Providers whose deliveries have a pending↔posted lifecycle worth modelling.
 *
 * ⚠️ WALLET and EXCHANGE are absent DELIBERATELY. A wallet transaction has no
 * lifecycle of this shape — an on-chain transfer is confirmed or it is not —
 * and forcing it into the banking event tables would model a state no provider
 * attests. Crypto shares this abstraction later through its own domain
 * implementation. A standing probe asserts the crypto writers never reach here.
 */
const EVENT_ELIGIBLE_PROVIDERS: ReadonlySet<string> = new Set(["PLAID", "MANUAL", "CSV"]);

export function isEventEligibleProvider(p: string): boolean {
  return EVENT_ELIGIBLE_PROVIDERS.has(p);
}

/** How an observation was attached to its event. Recorded, never inferred later. */
export type EventLinkBasis =
  /** The provider's own pending→posted reference. Rank 1, and unambiguous. */
  | "PROVIDER_PENDING_REF"
  /** A link already persisted on the transaction row. */
  | "PERSISTED_LINK"
  /** The same provider row id, observed again. */
  | "PROVIDER_ROW_ID"
  /** Nothing linked it. A new logical event — the honest default. */
  | "NEW_EVENT";

/** Why a link that LOOKED possible was refused. Reported, never silently dropped. */
export type EventLinkRefusal =
  /** The referenced predecessor is not in the corpus (hard-deleted, or never
   *  stored). 23 live rows are in this state; their identity cannot be
   *  reconstructed, so they become single-observation events that RECORD the
   *  dangling claim rather than inventing a predecessor. */
  | "DANGLING_PENDING_REF"
  /** The candidate predecessor is on a different account. A provider reference
   *  that crosses accounts is a provider bug, not a movement. */
  | "CROSS_ACCOUNT_REF"
  /** Two observations claim the same predecessor. 1:1 identity cannot hold, so
   *  neither claim is honoured. */
  | "AMBIGUOUS_PREDECESSOR";

export interface ObservationEvidence {
  /** The transaction row this observation is read from. */
  transactionId: string;
  financialAccountId: string;
  /** The provider's own row id (Plaid `transaction_id` / import external id). */
  providerRowId: string | null;
  /** Plaid `pending_transaction_id` — the provider's succession claim. */
  providerPendingRef: string | null;
  /** An event id already persisted on this row. */
  persistedEventId: string | null;
}

/** What the corpus knows, supplied by the caller. Never queried here. */
export interface EventLinkContext {
  /** provider row id → the event id it already belongs to. */
  eventByProviderRowId: ReadonlyMap<string, string>;
  /** provider row id → the account that row sits on, for the cross-account veto. */
  accountByProviderRowId: ReadonlyMap<string, string>;
  /** provider pending ref → how many observations claim it. >1 is ambiguous. */
  claimsPerPendingRef: ReadonlyMap<string, number>;
}

export type EventLinkResolution =
  | { basis: Exclude<EventLinkBasis, "NEW_EVENT">; eventId: string; refusal: null }
  | { basis: "NEW_EVENT"; eventId: null; refusal: EventLinkRefusal | null };

/**
 * Resolve the event an observation belongs to. Total, deterministic, pure.
 *
 * Precedence is fixed: a provider's own succession claim outranks a link we
 * previously persisted, which outranks re-observing the same provider row.
 * Falling through means a NEW event — and where a link was possible but refused,
 * the refusal rides along so a backfill reports it instead of silently
 * manufacturing an identity.
 */
export function resolveEventLink(
  e: ObservationEvidence,
  ctx: EventLinkContext,
): EventLinkResolution {
  // ── 1. The provider says this row succeeds another. ──────────────────────
  if (e.providerPendingRef) {
    const claims = ctx.claimsPerPendingRef.get(e.providerPendingRef) ?? 0;
    if (claims > 1) return { basis: "NEW_EVENT", eventId: null, refusal: "AMBIGUOUS_PREDECESSOR" };
    const predecessorAccount = ctx.accountByProviderRowId.get(e.providerPendingRef);
    if (predecessorAccount === undefined) {
      // The predecessor is gone. Honest: a new event that remembers the claim.
      return { basis: "NEW_EVENT", eventId: null, refusal: "DANGLING_PENDING_REF" };
    }
    if (predecessorAccount !== e.financialAccountId) {
      return { basis: "NEW_EVENT", eventId: null, refusal: "CROSS_ACCOUNT_REF" };
    }
    const eventId = ctx.eventByProviderRowId.get(e.providerPendingRef);
    if (eventId) return { basis: "PROVIDER_PENDING_REF", eventId, refusal: null };
    // The predecessor exists but has no event yet — the caller creates the event
    // for the predecessor first, then this resolves. Ordering is the backfill's
    // job, not a reason to invent a link here.
    return { basis: "NEW_EVENT", eventId: null, refusal: null };
  }

  // ── 2. A link we already established. ────────────────────────────────────
  if (e.persistedEventId) return { basis: "PERSISTED_LINK", eventId: e.persistedEventId, refusal: null };

  // ── 3. The same provider row, seen again. ────────────────────────────────
  if (e.providerRowId) {
    const eventId = ctx.eventByProviderRowId.get(e.providerRowId);
    if (eventId) return { basis: "PROVIDER_ROW_ID", eventId, refusal: null };
  }

  // ── 4. Nothing linked it. Not a failure — most events are one observation. ─
  return { basis: "NEW_EVENT", eventId: null, refusal: null };
}

// ── The event's current state, derived from its observations ────────────────

export type EventLifecycle = "PENDING" | "POSTED" | "WITHDRAWN";
export type ObservationLifecycle = "PENDING" | "POSTED";

/** One observation, as the projection sees it. */
export interface ObservationFacts {
  observedAt: Date;
  lifecycle: ObservationLifecycle;
  amount: number;
  postingDate: Date;
  economicDate: Date;
  /** The transaction row, when it is still live. Null once tombstoned. */
  liveTransactionId: string | null;
}

export interface EventProjection {
  lifecycle: EventLifecycle;
  economicDate: Date;
  currentAmount: number;
  currentTransactionId: string | null;
  firstObservedAt: Date;
  lastObservedAt: Date;
  firstPendingObservedAt: Date | null;
  postedObservedAt: Date | null;
  observationCount: number;
}

/**
 * Derive an event's current state from its observations. Pure and total.
 *
 * ⚠️ **The economic date comes from the FIRST observation, not the latest.** That
 * is the invariant the whole slice exists to protect: posting must not move when
 * an event happened. The corpus already agrees — economicDate changed on 0 of 38
 * chains — and this makes it structural rather than incidental.
 *
 * ⚠️ The AMOUNT comes from the LATEST observation. A restatement is new
 * information about the same event, and the earlier observation stays on the
 * record beside it.
 *
 * ⚠️ WITHDRAWN is only reachable when every observation is PENDING and no live
 * transaction row remains. A pending authorization the provider took back is a
 * real outcome; calling it POSTED or deleting it would both be false.
 */
export function projectEvent(observations: readonly ObservationFacts[]): EventProjection {
  if (observations.length === 0) {
    throw new Error("projectEvent: an event must have at least one observation");
  }
  // Deterministic order: observation time, then lifecycle so a same-instant
  // pending/posted pair still resolves the same way on every replay.
  const sorted = [...observations].sort(
    (a, b) => a.observedAt.getTime() - b.observedAt.getTime() ||
      (a.lifecycle === b.lifecycle ? 0 : a.lifecycle === "PENDING" ? -1 : 1),
  );
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const posted = sorted.find((o) => o.lifecycle === "POSTED") ?? null;
  const firstPending = sorted.find((o) => o.lifecycle === "PENDING") ?? null;
  const live = [...sorted].reverse().find((o) => o.liveTransactionId != null) ?? null;

  const lifecycle: EventLifecycle =
    posted ? "POSTED"
      : live ? "PENDING"
      : "WITHDRAWN";

  return {
    lifecycle,
    // FIRST, deliberately. See the note above.
    economicDate: first.economicDate,
    currentAmount: last.amount,
    currentTransactionId: live?.liveTransactionId ?? null,
    firstObservedAt: first.observedAt,
    lastObservedAt: last.observedAt,
    firstPendingObservedAt: firstPending?.observedAt ?? null,
    postedObservedAt: posted?.observedAt ?? null,
    observationCount: sorted.length,
  };
}

/**
 * The IDEMPOTENCE key for one observation.
 *
 * Replaying an identical provider payload yields the same key and writes
 * nothing; a genuine restatement — a changed amount, a new posting date, a
 * lifecycle transition — yields a different key and appends a row.
 *
 * ⚠️ It deliberately covers only what the PROVIDER asserted about the event. A
 * merchant-string cleanup or a re-classification must NOT mint a new
 * observation: those are our derivations, not the provider's testimony, and the
 * corpus shows them changing on 15% and 24% of chains respectively.
 *
 * Hashing is the caller's (this module stays dependency-free); this returns the
 * canonical material.
 */
export function observationKey(o: Parameters<typeof observationKeyMaterial>[0]): string {
  const digest = sha256(new TextEncoder().encode(observationKeyMaterial(o)));
  let hex = "";
  for (let i = 0; i < 16; i++) hex += digest[i].toString(16).padStart(2, "0");
  return hex;
}

export function observationKeyMaterial(o: {
  provider: string;
  financialAccountId: string;
  providerRowId: string | null;
  transactionId: string;
  lifecycle: ObservationLifecycle;
  amount: number;
  postingDate: Date;
  economicDate: Date;
}): string {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  // The provider row id identifies the row across re-syncs; where the source has
  // none (manual/seed), the transaction id is the only stable anchor and is used
  // instead. Both are namespaced so they can never collide.
  const anchor = o.providerRowId ? `p:${o.providerRowId}` : `t:${o.transactionId}`;
  return [
    o.provider, o.financialAccountId, anchor, o.lifecycle,
    o.amount.toFixed(4), day(o.postingDate), day(o.economicDate),
  ].join("|");
}
