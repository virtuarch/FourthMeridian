/**
 * lib/transactions/economic-date-write.test.ts   (L8-A)
 *
 * The persisted chronology's write authority, and the probes that keep it the
 * ONLY one. Pure and DB-free.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { economicDateWriteFields, economicDateFor } from "./economic-date-write";
import { resolveEconomicDate, ECONOMIC_DATE_MAX_LAG_DAYS } from "./economic-date";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

test("the write value IS the read authority's value — never a second derivation", () => {
  const cases: [string, string | null][] = [
    ["2026-08-03", "2026-08-01"],   // ordinary authorization lag
    ["2026-08-03", "2026-08-03"],   // same day
    ["2026-08-03", null],           // no authorization at all
    ["2025-05-22", "2025-04-14"],   // the lag-38 CONTRADICTORY pair
    ["2026-08-03", "2026-08-10"],   // negative lag — also CONTRADICTORY
    ["2026-08-15", "2026-08-01"],   // exactly at the bound (14)
  ];
  for (const [posting, auth] of cases) {
    const authority = resolveEconomicDate({ postingDate: D(posting), authorizedAt: auth ? D(auth) : null });
    const written = economicDateWriteFields({ postingDate: D(posting), authorizedAt: auth ? D(auth) : null });
    assert.equal(iso(written.economicDate), authority.economicDate,
      `posting=${posting} auth=${auth}: the column must carry exactly what the read path resolves`);
  }
});

test("a CONTRADICTORY resolution persists the POSTING date, not the disputed one", () => {
  // 38-day lag — beyond the credibility bound. The authority falls back to
  // posting and reports the disagreement; the column must carry the fallback,
  // never the value the authority refused.
  const w = economicDateWriteFields({ postingDate: D("2025-05-22"), authorizedAt: D("2025-04-14") });
  assert.equal(iso(w.economicDate), "2025-05-22");
  // ...and the explanation is still available at read time, unpersisted.
  const r = resolveEconomicDate({ postingDate: D("2025-05-22"), authorizedAt: D("2025-04-14") });
  assert.equal(r.state, "CONTRADICTORY");
  assert.ok(r.reason);
});

test("the bound is the authority's, not a copy", () => {
  const atBound = economicDateWriteFields({
    postingDate: D("2026-08-15"),
    authorizedAt: D("2026-08-15").getTime() - ECONOMIC_DATE_MAX_LAG_DAYS * 86_400_000 ? D("2026-08-01") : null,
  });
  assert.equal(iso(atBound.economicDate), "2026-08-01", "exactly at the bound is still credible");
  const past = economicDateWriteFields({ postingDate: D("2026-08-16"), authorizedAt: D("2026-08-01") });
  assert.equal(iso(past.economicDate), "2026-08-16", "one day past the bound falls back to posting");
});

test("the value is UTC midnight, matching the @db.Date encoding of `date`", () => {
  const w = economicDateWriteFields({ postingDate: D("2026-08-03"), authorizedAt: D("2026-08-01") });
  assert.equal(w.economicDate.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(w.economicDate.getUTCHours(), 0);
});

test("both entry points agree", () => {
  const a = economicDateWriteFields({ postingDate: D("2026-08-03"), authorizedAt: D("2026-08-01") }).economicDate;
  const b = economicDateFor({ postingDate: D("2026-08-03"), authorizedAt: D("2026-08-01") });
  assert.equal(a.getTime(), b.getTime());
});

test("it is a pure function — lifecycle changes cannot move it", () => {
  // The whole point of the column: posting flips `pending` and `settlementState`
  // and mints a new row id, but changes neither input, so the answer is stable.
  const pendingRow = economicDateFor({ postingDate: D("2026-08-01"), authorizedAt: D("2026-08-01") });
  const postedRow  = economicDateFor({ postingDate: D("2026-08-03"), authorizedAt: D("2026-08-01") });
  assert.equal(iso(pendingRow), iso(postedRow),
    "the economic date must not move when a pending row posts");
});

// ── The probes that keep this the ONLY writer ──────────────────────────────

test("every Transaction writer persists economicDate through the authority", () => {
  // If a writer sets `date` without `economicDate`, that row enters the corpus
  // with no chronology and the persistence audit fails — but only AFTER it has
  // shipped. This catches it at build time instead.
  const WRITERS = [
    "lib/plaid/syncTransactions.ts",
    "lib/crypto/btc-sync.ts",
    "app/api/accounts/[id]/import/route.ts",
    "prisma/seed.ts",
  ];
  for (const f of WRITERS) {
    const src = read(f);
    assert.ok(
      /economicDateWriteFields|economicDateFor/.test(src),
      `${f} writes Transaction rows but never sets economicDate through the write authority`,
    );
  }
});

test("no writer re-derives the chronology itself", () => {
  // A writer calling `resolveEconomicDate` directly would be a second derivation
  // path — the exact shape this column exists to collapse.
  const WRITERS = [
    "lib/plaid/syncTransactions.ts",
    "lib/crypto/btc-sync.ts",
    "app/api/accounts/[id]/import/route.ts",
    "prisma/seed.ts",
  ];
  for (const f of WRITERS) {
    const logic = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    assert.ok(
      !/resolveEconomicDate\s*\(/.test(logic),
      `${f} calls resolveEconomicDate directly; it must go through economic-date-write.ts`,
    );
    assert.ok(
      !/ECONOMIC_DATE_MAX_LAG_DAYS/.test(logic),
      `${f} references the credibility bound; only the authority may`,
    );
  }
});

test("the write authority itself holds no date logic", () => {
  const logic = read("lib/transactions/economic-date-write.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  // It may convert an ISO string to a Date; it may not compare, bound or branch.
  assert.ok(!/86_?400_?000/.test(logic), "no day arithmetic may live in the write authority");
  assert.ok(!/ECONOMIC_DATE_MAX_LAG_DAYS/.test(logic), "the bound belongs to the resolver alone");
  assert.match(logic, /resolveEconomicDate\(/, "it must delegate to the resolver");
});

// ── L8-B — the reader cutover landed. The guard changes shape. ─────────────
//
// L8-A carried a probe asserting NOTHING read the column, so the cutover could
// not land piecemeal. It fired when this slice moved the readers, which is what
// it was for. The successor invariant is the inverse and stronger: every
// chronology reader must be ON the economic column, and none may fall back to
// posting.

test("L8-B: ordering, cursor and date filter all use economicDate", () => {
  const core = read("lib/data/transaction-query-core.ts");
  const logic = core.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

  // The three that must never diverge — a cursor minted on one column and
  // applied against an ordering on another duplicates and skips rows silently.
  const orderBy = logic.slice(logic.indexOf("export function orderByForSort"));
  assert.match(orderBy.slice(0, 400), /economicDate/, "ordering must be economic");
  const keyset = logic.slice(logic.indexOf("export function keysetWhere"));
  assert.match(keyset.slice(0, 500), /economicDate/, "the keyset must be economic");
  const filter = logic.slice(logic.indexOf("export function buildFilterWhere"));
  assert.match(filter.slice(0, 700), /economicDate:/, "the date filter must be economic");

  // ...and none of them may still reach for the posting column.
  for (const [name, frag] of [["orderBy", orderBy.slice(0, 400)], ["keyset", keyset.slice(0, 500)]] as const) {
    assert.ok(!/\bdate:\s*"(asc|desc)"/.test(frag) && !/\{\s*date:\s*\{/.test(frag),
      `${name} still references the posting column`);
  }
});

test("L8-B: the count shares the filter, so it cannot describe a different population", () => {
  // `transaction-count.ts` imports `buildFilterWhere` verbatim. That is what
  // makes "1,284 results" and the scrolling list the same set by construction —
  // and it is why the count moved to the economic chronology for free.
  const countSrc = read("lib/data/transaction-count.ts");
  assert.match(countSrc, /buildFilterWhere/,
    "the count must share the list's filter fragments, never restate them");
});

test("L8-B: transfer matching runs on the economic chronology and refuses a fallback", () => {
  const logic = read("lib/transactions/RelationshipResolver.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  assert.match(logic, /economicMs\(r\)/, "the leg timestamp must come from the economic chronology");
  // ⚠️ It must THROW on a null, not substitute `date`. One leg on economic and
  // another on posting makes mutual uniqueness undefined, not merely wrong.
  const fn = logic.slice(logic.indexOf("function economicMs"));
  assert.match(fn.slice(0, 400), /throw new Error/);
  assert.ok(!/economicDate\s*\?\?\s*r?\.?date/.test(fn.slice(0, 400)),
    "the leg timestamp must never fall back to the posting date");
});

test("L8-B: the transfer gather window is widened by the lag bound", () => {
  // The gather filters the STORED POSTING column while the matcher compares
  // ECONOMIC dates. A leg whose economic date is inside the window can have a
  // posting date outside it, so a window sized for the economic distance alone
  // would starve the matcher — silently, and invisibly to any probe that only
  // inspects matcher output. This was the calibration's R1.
  const src = read("lib/transactions/transfer-resolution.ts");
  assert.match(src, /ECONOMIC_DATE_MAX_LAG_DAYS/,
    "the gather window must account for the authorization lag");
  assert.match(src, /GATHER_WINDOW_MS\s*=\s*\(TRANSFER_WINDOW_DAYS \+ 1 \+ ECONOMIC_DATE_MAX_LAG_DAYS\)/,
    "the gather window must be widened by exactly the lag bound");
  const drawer = read("lib/data/transactions.ts");
  assert.match(drawer, /RELATIONSHIP_WINDOW_MS\s*=\s*\(7 \+ ECONOMIC_DATE_MAX_LAG_DAYS\)/,
    "the drawer's relationship window must be widened too");
});

test("L8-B: the calibrated bounds are UNCHANGED", () => {
  // Phase 2 re-derived these on economic dates and they landed in the same
  // place. The cutover must not quietly retune them.
  const mat = read("lib/transactions/transfer-maturation.ts");
  assert.match(mat, /export const TRANSFER_MATCH_WINDOW_DAYS = 5;/);
  assert.match(mat, /STRATIFIED_MATCH_TIERS: readonly number\[\] = \[0, TRANSFER_MATCH_WINDOW_DAYS\]/);
  assert.match(read("lib/transactions/transfer-chain.ts"), /CHAIN_CONTINUATION_WINDOW_DAYS = 14/);
});

test("L8-B: the DTO's `date` is economic and `postingDate` is provenance", () => {
  const src = read("lib/transactions/serialize.ts");
  assert.match(src, /function financialDate\(/, "one helper decides the DTO's canonical date");
  assert.match(src, /date:\s*financialDate\(r\)/, "the DTO date must be the economic one");
  assert.match(src, /postingDate:\s*econ\.postingDate/, "posting must still ship, as provenance");
  // Every serializer, not just the banking one — an investment row's trade date
  // is its economic date too, or the two lists disagree about a day.
  //
  // Matches DTO ASSIGNMENTS (a rendered `date:` that formats a value), never the
  // interface DECLARATIONS (`date: Date;`) that share the prefix.
  const emitted = [...src.matchAll(/^\s*date:\s*(.*toISOString.*)$/gm)].map((m) => m[1]);
  // Two serializers emit a date: the banking row and the investment row.
  assert.equal(emitted.length, 2, `expected both serializers' date emissions, saw ${emitted.length}`);
  for (const a of emitted) {
    assert.ok(/financialDate/.test(a), `a serializer still emits the raw posting date: ${a.trim()}`);
  }
});
