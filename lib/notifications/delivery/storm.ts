/**
 * lib/notifications/delivery/storm.ts  (Comms Center A-2b — owner decision O-10)
 *
 * The per-recipient email STORM LIMIT's decision, pure over an injected
 * counter. lib/email/send.ts asks it once per send, AFTER the non-production
 * recipient guard admitted the address and BEFORE the provider is called —
 * the single chokepoint every email path goes through.
 *
 * POLICY (lib/notifications/catalog/definitions.ts EMAIL_STORM_LIMIT):
 *   - at most 5 ACCEPTED customer emails per recipient per rolling 60 minutes,
 *     counted across every LIMITED catalog key (consent SERVICE / AWARENESS /
 *     MARKETING) from the delivery ledger (CommsDelivery);
 *   - the recipient is the account (recipientUserId) or, only when there is
 *     none, the ledger's salted recipient hash;
 *   - over the limit ⇒ SUPPRESSED, reason RATE_LIMITED, never sent;
 *   - EXEMPT and never counted: SECURITY_CRITICAL and CEREMONY (password reset,
 *     verification, email change, beta invitation), OPERATOR inboxes, and sends
 *     under no catalog key (tooling). Exempt mail always sends: it FAILS OPEN.
 *   - a limited send whose count cannot be read (no recipient identity to
 *     count by, a counter error, or a counter slower than STORM_COUNT_TIMEOUT_MS)
 *     ⇒ SUPPRESSED, reason RATE_LIMIT_UNVERIFIED: it FAILS CLOSED.
 *
 * IN-REQUEST BURSTS: the ledger write runs after the response (lib/notifications/
 * delivery/defer.ts), so one cron run or route invocation fanning out to one
 * recipient would read a ledger count that does not yet include its own
 * earlier sends. PendingSends closes that gap: every admitted limited send
 * RESERVES a slot in a module-level, per-recipient in-memory list, checked and
 * taken synchronously after the ledger count resolves (no await between check
 * and reserve, so concurrent sends in one process cannot both take the last
 * slot). The reservation is released when the send is not accepted, or when
 * its ACCEPTED ledger row is written (from then on the DB count holds it); a
 * reservation whose ledger write failed stays until it ages out of the window,
 * so an unrecorded send still counts. Bounded: entries older than the window
 * are pruned on every access, a recipient never holds more than the limit, and
 * the map holds at most PENDING_MAX_RECIPIENTS recipients (oldest evicted).
 * Across instances the DB count is the authority, after each row is written.
 */

import { EMAIL_STORM_LIMIT, isStormLimitedKey, stormLimitedKeys } from "@/lib/notifications/catalog/definitions";

/** The longest the count may hold a send before it is treated as unreadable (fail closed for limited mail). */
export const STORM_COUNT_TIMEOUT_MS = 1_500;

export type StormReason = "RATE_LIMITED" | "RATE_LIMIT_UNVERIFIED";

/** What the counter is asked: ACCEPTED EMAIL rows for this recipient, under these keys, since this instant. */
export interface StormCountQuery {
  recipientUserId: string | null;
  /** Used only when recipientUserId is null. */
  recipientHash: string | null;
  keys: readonly string[];
  since: Date;
}

/** Counts ledger rows. Throws (or never resolves) when it cannot read: the decision handles both. */
export type StormCounter = (q: StormCountQuery) => Promise<number>;

export type StormDecision =
  | { send: true; exempt: true }
  | { send: true; exempt: false; reservation: Reservation }
  | { send: false; reason: StormReason };

/** The most recipients the in-memory reservation map holds (oldest evicted first). */
export const PENDING_MAX_RECIPIENTS = 5_000;

export interface Reservation { recipient: string; at: number; id: number }

/**
 * Admitted-but-not-yet-recorded limited sends, per recipient. Bounded and
 * pruned (see the header). One module-level instance backs production sendEmail.
 */
export class PendingSends {
  private readonly byRecipient = new Map<string, Reservation[]>();
  private nextId = 1;
  constructor(
    private readonly windowMs = EMAIL_STORM_LIMIT.windowMinutes * 60_000,
    private readonly maxRecipients = PENDING_MAX_RECIPIENTS,
  ) {}

  private live(recipient: string, nowMs: number): Reservation[] {
    const list = (this.byRecipient.get(recipient) ?? []).filter((r) => nowMs - r.at < this.windowMs);
    if (list.length === 0) this.byRecipient.delete(recipient);
    else this.byRecipient.set(recipient, list);
    return list;
  }

  /** Live reservations for this recipient. */
  count(recipient: string, nowMs: number): number {
    return this.live(recipient, nowMs).length;
  }

  /** Take a slot. Synchronous by design: call it with no await after the check. */
  reserve(recipient: string, nowMs: number): Reservation {
    const list = this.live(recipient, nowMs);
    const r: Reservation = { recipient, at: nowMs, id: this.nextId++ };
    // Re-insert so Map order is recency order; evict the stalest recipients past the cap.
    this.byRecipient.delete(recipient);
    this.byRecipient.set(recipient, [...list, r].slice(-EMAIL_STORM_LIMIT.maxPerRecipient));
    while (this.byRecipient.size > this.maxRecipients) {
      const oldest = this.byRecipient.keys().next().value;
      if (oldest === undefined) break;
      this.byRecipient.delete(oldest);
    }
    return r;
  }

  /** Drop a reservation: the send was not accepted, or its ledger row is now written. */
  release(r: Reservation): void {
    const list = this.byRecipient.get(r.recipient);
    if (!list) return;
    const rest = list.filter((x) => x.id !== r.id);
    if (rest.length === 0) this.byRecipient.delete(r.recipient);
    else this.byRecipient.set(r.recipient, rest);
  }

  /** Recipients currently tracked (tests: the memory bound). */
  get size(): number {
    return this.byRecipient.size;
  }
}

/** The production instance (module-level: shared by every send in this process). */
export const pendingSends = new PendingSends();

/** The reservation identity: the account, or the ledger's salted hash. Never the address. */
function recipientIdentity(userId: string | null, hash: string | null): string {
  return userId ? `u:${userId}` : `h:${hash}`;
}

const TIMED_OUT = Symbol("storm-count-timeout");

/** Decide one send. Never throws. */
export async function decideStorm(args: {
  key: string;
  recipientUserId: string | null;
  recipientHash: string | null;
  counter: StormCounter;
  now: Date;
  timeoutMs?: number;
  /** In-process reservations (default: the module-level instance). */
  pending?: PendingSends;
}): Promise<StormDecision> {
  if (!isStormLimitedKey(args.key)) return { send: true, exempt: true };
  if (!args.recipientUserId && !args.recipientHash) return { send: false, reason: "RATE_LIMIT_UNVERIFIED" };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const count = Promise.resolve().then(() => args.counter({
      recipientUserId: args.recipientUserId,
      recipientHash: args.recipientUserId ? null : args.recipientHash,
      keys: stormLimitedKeys(),
      since: new Date(args.now.getTime() - EMAIL_STORM_LIMIT.windowMinutes * 60_000),
    }));
    // A count that loses the race must not surface later as an unhandled rejection.
    count.catch(() => undefined);
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), args.timeoutMs ?? STORM_COUNT_TIMEOUT_MS);
    });
    const n = await Promise.race([count, timeout]);
    if (n === TIMED_OUT || typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      return { send: false, reason: "RATE_LIMIT_UNVERIFIED" };
    }
    // Synchronous from here: check DB count + in-process reservations, then reserve.
    const pending = args.pending ?? pendingSends;
    const who = recipientIdentity(args.recipientUserId, args.recipientHash);
    const nowMs = args.now.getTime();
    if (n + pending.count(who, nowMs) >= EMAIL_STORM_LIMIT.maxPerRecipient) return { send: false, reason: "RATE_LIMITED" };
    return { send: true, exempt: false, reservation: pending.reserve(who, nowMs) };
  } catch {
    return { send: false, reason: "RATE_LIMIT_UNVERIFIED" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
