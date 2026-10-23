/**
 * lib/time/basis.ts   (REVIEW-3 B-6 — the chronology doctrine)
 *
 * THE named answer to "which date is this fact on?". Nine date fields serve as
 * "the date of a fact" in this codebase, and they are legitimately DIFFERENT
 * questions — the failure mode B-6 closed was not their plurality but their
 * anonymity: nothing said which basis answered which question, and three
 * separate clocks decided "today". This module names each basis once; the clock
 * lives in ./clock.ts. Pure and zero-import beyond it.
 *
 * ── The basis table ─────────────────────────────────────────────────────────
 *
 * | Basis                       | Field / source                              | Question it answers                                      |
 * |-----------------------------|---------------------------------------------|----------------------------------------------------------|
 * | POSTING_DATE                | Transaction.date                            | When did the provider post/settle this row?               |
 * | ECONOMIC_DATE               | Transaction.economicDate                    | When did the activity actually happen? (resolveEconomicDate; for event-linked rows, materialized from the event — see below) |
 * | EVENT_ECONOMIC_DATE         | TransactionEvent.economicDate               | When did the logical EVENT happen? Decided once, at first observation, and never moved by posting. Agrees with ECONOMIC_DATE on the event's current row BY CONSTRUCTION (reprojectEvent materializes it). |
 * | SNAPSHOT_DATE               | SpaceSnapshot.date                          | Which UTC day does this stored aggregate describe?        |
 * | INVESTMENT_EVENT_DATETIME   | InvestmentEvent.datetime                    | The instant of an investment transaction (trade time).    |
 * | PROVIDER_OBSERVED_AT        | TransactionObservation.observedAt, FinancialAccount.lastUpdated | When did WE see the provider state? Provenance — an instant, never a calendar fact. |
 * | CURRENT_DAY                 | todayUTCISO() (lib/time/clock.ts)           | What day is it now? (UTC calendar day, one clock.)        |
 * | HISTORICAL_CUTOFF           | classifyAsOfDay(asOf, today)                | Is an as-of read PRESENT (observed balances) or HISTORICAL (reconstruction)? |
 * | ARCHIVE_CLOSE_DATE          | yesterdayUTCISO() (lib/time/clock.ts)       | The newest CLOSED day the append-only FX/price archives accept. |
 *
 * These are NOT flattened into one field on purpose: a coffee bought Friday and
 * posted Sunday is a Friday event that settled Sunday, and both facts are real.
 * What IS flattened is the clock (one), the switch (one, below), and the
 * economic-date resolver (one — lib/transactions/economic-date.ts).
 *
 * ── The today/history authority switch ──────────────────────────────────────
 *
 * RULE: an as-of day is HISTORICAL iff `asOf < today` on the UTC calendar, and
 * the classification is SERVER-AUTHORITATIVE — where a server read answers an
 * as-of question, the server's UTC day decides which side of the switch the
 * read lands on, and any client that also needs the classification takes it
 * from the server's response (`serverToday`), never from its own clock.
 * Before B-6, lib/history/account-series.ts classified against a server
 * `new Date()` while InvestmentsWorkspace classified the SAME asOf against a
 * client-supplied `today` prop — around midnight (or any client clock skew) one
 * calendar date landed on different sides of the switch on two surfaces.
 *
 * Client-only fast paths that deliberately skip the server on a present-day
 * read (the debt/liquidity workspaces' "no fetch when asOf >= today") gate the
 * FETCH on the client's UTC day — an optimization, not a truth claim: the data
 * they then render is the host's present-day read, so as-of equals the render's
 * own day by construction. Where a server response exists, the server's answer
 * wins on arrival.
 */

import { todayUTCISO } from "./clock";

/** Which side of the today/history switch an as-of day falls on. */
export type AsOfSide = "present" | "historical";

/**
 * THE today/history switch — the one comparison every surface must share.
 * `todayISO` is the classifier's own UTC day: the server's day on a server
 * read; on a client, the `serverToday` the response carried.
 */
export function classifyAsOfDay(asOfISO: string, todayISO: string = todayUTCISO()): AsOfSide {
  return asOfISO < todayISO ? "historical" : "present";
}

/** Convenience predicate for the common branch shape. */
export function isHistoricalDay(asOfISO: string, todayISO: string = todayUTCISO()): boolean {
  return classifyAsOfDay(asOfISO, todayISO) === "historical";
}
