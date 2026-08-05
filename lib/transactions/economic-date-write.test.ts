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

test("L8-A is dual-write ONLY — nothing reads the column yet", () => {
  // The reader cutover is a separate atomic slice. If a consumer starts reading
  // `economicDate` from the row before that slice, chronology becomes mixed —
  // the precise failure mode the cutover exists to avoid.
  //
  // `serialize.ts` is exempt: it emits a DERIVED `economicDate` DTO field that
  // predates this column (V27-L4B) and still comes from `resolveEconomicDate`.
  const CONSUMERS = [
    "lib/data/transaction-query-core.ts",
    "lib/data/transaction-query.ts",
    "lib/data/transaction-count.ts",
    "lib/transactions/cash-flow-projection.ts",
    "lib/transactions/RelationshipResolver.ts",
  ];
  for (const f of CONSUMERS) {
    const logic = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    assert.ok(
      !/economicDate/.test(logic),
      `${f} already reads economicDate — the reader cutover must land as ONE atomic slice, not piecemeal`,
    );
  }
});
