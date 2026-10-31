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
 * ACCURACY: the ledger write runs after the response (lib/notifications/
 * delivery/defer.ts), so a burst of sends in one instant can each read a count
 * that does not yet include its siblings. The limit is a storm brake, not an
 * exact quota; a burst is held from the next read on.
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
  | { send: true; exempt: boolean }
  | { send: false; reason: StormReason };

const TIMED_OUT = Symbol("storm-count-timeout");

/** Decide one send. Never throws. */
export async function decideStorm(args: {
  key: string;
  recipientUserId: string | null;
  recipientHash: string | null;
  counter: StormCounter;
  now: Date;
  timeoutMs?: number;
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
    return n >= EMAIL_STORM_LIMIT.maxPerRecipient ? { send: false, reason: "RATE_LIMITED" } : { send: true, exempt: false };
  } catch {
    return { send: false, reason: "RATE_LIMIT_UNVERIFIED" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
