/**
 * lib/transactions/event-economic-date-rule.test.ts   (REVIEW-3 B-6)
 *
 * THE written rule for TransactionEvent.economicDate vs Transaction.economicDate,
 * pinned in executable form.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 *   1. An economic event's date is decided by ONE resolver
 *      (`resolveEconomicDate`), with precedence: credible FIRST-PENDING
 *      resolution → credible bounded AUTHORIZATION → POSTING. First resolution
 *      wins: once an event was seen pending, no later delivery (including a
 *      late-arriving authorizedAt) can move its date. A closed period is closed.
 *   2. `TransactionEvent.economicDate` is derived through that resolver by
 *      `projectEvent` (the pin: the first PENDING observation's own resolved
 *      economic date, bounded by the same 14-day credibility rule).
 *   3. `Transaction.economicDate` on the event's CURRENT row is the event's
 *      answer, MATERIALIZED by `reprojectEvent` (and re-pinned on the
 *      idempotent replay path) — so row and event agree BY CONSTRUCTION.
 *      Rows outside the event domain resolve from their own evidence.
 *   4. The DTO discloses the pin honestly: a column that differs from the
 *      row's own evidence is basis FIRST_PENDING_OBSERVATION (serialize.ts) —
 *      the previously-unreachable basis the REVIEW-3 audit flagged, now the
 *      wired reconciliation path rather than dead code.
 *
 * House convention: standalone tsx script, no framework, no DB.
 *     npx tsx lib/transactions/event-economic-date-rule.test.ts
 */

import { readFileSync } from "fs";
import { join } from "path";

import { resolveEconomicDate } from "./economic-date";
import { projectEvent, type ObservationFacts } from "./event-identity";
import { economicDateWriteFields } from "./economic-date-write";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

const obs = (o: Partial<ObservationFacts> & Pick<ObservationFacts, "observedAt" | "lifecycle">): ObservationFacts => ({
  amount: -12.05,
  postingDate: D("2026-07-17"),
  economicDate: D("2026-07-17"),
  authorizedAt: null,
  liveTransactionId: "t1",
  ...o,
});

// ---------------------------------------------------------------------------
// 1. The resolver's precedence — first resolution wins
// ---------------------------------------------------------------------------

console.log("1. resolveEconomicDate precedence");
{
  const pinBeatsAuth = resolveEconomicDate({
    postingDate: "2026-07-19", authorizedAt: "2026-07-18", firstPendingDate: "2026-07-17",
  });
  check("a credible first-pending resolution outranks a later authorization",
    pinBeatsAuth.economicDate === "2026-07-17" && pinBeatsAuth.basis === "FIRST_PENDING_OBSERVATION",
    `got ${pinBeatsAuth.economicDate} / ${pinBeatsAuth.basis}`);

  const authWhenNoPin = resolveEconomicDate({ postingDate: "2026-07-19", authorizedAt: "2026-07-17" });
  check("with no pin, a credible authorization outranks posting",
    authWhenNoPin.economicDate === "2026-07-17" && authWhenNoPin.basis === "AUTHORIZATION");

  const stalePin = resolveEconomicDate({
    postingDate: "2026-07-19", authorizedAt: "2026-07-18", firstPendingDate: "2026-06-01",
  });
  check("a NON-credible pin (beyond the 14-day bound) falls through to the authorization",
    stalePin.economicDate === "2026-07-18" && stalePin.basis === "AUTHORIZATION");

  const stalePinNoAuth = resolveEconomicDate({ postingDate: "2026-07-19", firstPendingDate: "2026-06-01" });
  check("a NON-credible pin with no other evidence is CONTRADICTORY on posting",
    stalePinNoAuth.economicDate === "2026-07-19" && stalePinNoAuth.state === "CONTRADICTORY");
}

// ---------------------------------------------------------------------------
// 2. The event derives through the resolver — and the pin holds
// ---------------------------------------------------------------------------

console.log("2. projectEvent — the pin");
{
  // THE divergence the audit found: pending seen at P1 with NO authorization;
  // the posting arrives at P2 carrying an authorizedAt. Pre-B-6 the ROW moved
  // to the auth date while the EVENT kept P1 — two truths. Now both are P1.
  const chain = [
    obs({ observedAt: new Date("2026-07-17T10:00:00Z"), lifecycle: "PENDING",
          postingDate: D("2026-07-17"), economicDate: D("2026-07-17"), liveTransactionId: null }),
    obs({ observedAt: new Date("2026-07-19T10:00:00Z"), lifecycle: "POSTED",
          postingDate: D("2026-07-19"), economicDate: D("2026-07-18"), authorizedAt: D("2026-07-18") }),
  ];
  const p = projectEvent(chain);
  check("a pending→posted chain keeps the FIRST resolution even when authorizedAt arrives at posting",
    iso(p.economicDate) === "2026-07-17", `got ${iso(p.economicDate)}`);

  // Row/event agreement is a property of ONE function over the SAME evidence:
  // re-deriving through the resolver with the event's evidence gives the same
  // answer the projection stored.
  const rederived = resolveEconomicDate({
    postingDate: "2026-07-19", authorizedAt: "2026-07-18", firstPendingDate: "2026-07-17",
  });
  check("the event's date IS the resolver's answer over the event's evidence (agreement by construction)",
    rederived.economicDate === iso(p.economicDate));

  // A posted-only event agrees with the ingest writer's row derivation exactly.
  const single = projectEvent([
    obs({ observedAt: new Date("2026-07-19T10:00:00Z"), lifecycle: "POSTED",
          postingDate: D("2026-07-19"), economicDate: D("2026-07-18"), authorizedAt: D("2026-07-18") }),
  ]);
  const writer = economicDateWriteFields({ postingDate: D("2026-07-19"), authorizedAt: D("2026-07-18") });
  check("a posted-only event derives exactly what the row writer derives (no pin, same evidence)",
    single.economicDate.getTime() === writer.economicDate.getTime());

  // The credibility bound governs the pin too: a pending observation stranded
  // 40 days before its posting is refused, and the event falls back to the
  // posting-time evidence rather than trusting a stale pin.
  const stale = projectEvent([
    obs({ observedAt: new Date("2026-06-01T10:00:00Z"), lifecycle: "PENDING",
          postingDate: D("2026-06-01"), economicDate: D("2026-06-01"), liveTransactionId: null }),
    obs({ observedAt: new Date("2026-07-19T10:00:00Z"), lifecycle: "POSTED",
          postingDate: D("2026-07-19"), economicDate: D("2026-07-19") }),
  ]);
  check("the 14-day credibility bound applies to the event pin as well",
    iso(stale.economicDate) === "2026-07-19", `got ${iso(stale.economicDate)}`);
}

// ---------------------------------------------------------------------------
// 3. Source tripwires — the materialization is real, end to end
// ---------------------------------------------------------------------------

console.log("3. Source scan — materialization and disclosure");
{
  const ROOT = process.cwd();
  const eventWrite = readFileSync(join(ROOT, "lib", "transactions", "event-write.ts"), "utf8");
  const eventIdentity = readFileSync(join(ROOT, "lib", "transactions", "event-identity.ts"), "utf8");
  const serialize = readFileSync(join(ROOT, "lib", "transactions", "serialize.ts"), "utf8");
  const backfill = readFileSync(join(ROOT, "scripts", "backfill-economic-date.ts"), "utf8");
  const sync = readFileSync(join(ROOT, "lib", "plaid", "syncTransactions.ts"), "utf8");

  check("projectEvent derives the event date THROUGH resolveEconomicDate (one resolver, no second rule)",
    /resolveEconomicDate\(\{/.test(eventIdentity) &&
    /firstPendingDate:\s*firstPending\?\.economicDate/.test(eventIdentity));

  check("reprojectEvent MATERIALIZES the event's economicDate into its current row",
    /updateMany\(\{\s*\n?\s*where:\s*\{\s*id:\s*p\.currentTransactionId,\s*NOT:\s*\{\s*economicDate:\s*p\.economicDate\s*\}\s*\}/.test(eventWrite));

  check("the idempotent replay path re-pins the row (pinRowToEvent)",
    /pinRowToEvent\(db,\s*existing\.eventId\)/.test(eventWrite) &&
    /function pinRowToEvent/.test(eventWrite));

  check("reprojectEvent feeds authorizedAt into the projection facts",
    /authorizedAt:\s*o\.authorizedAt/.test(eventWrite));

  check("the DTO discloses a pinned column as FIRST_PENDING_OBSERVATION (the basis is reachable)",
    /pinnedByEvent\s*\?\s*"FIRST_PENDING_OBSERVATION"/.test(serialize));

  check("backfill-economic-date SKIPS event-linked rows (the event pin governs them)",
    /transactionEventId\s*==\s*null/.test(backfill));

  check("the ingest writer still derives the row's write-time value from the ONE write authority",
    /economicDateWriteFields\(\{/.test(sync));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
