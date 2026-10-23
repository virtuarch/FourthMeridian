/**
 * lib/transactions/backfill-event-facts.test.ts
 *
 * The 2026-10-23 Production clone rehearsal found the event-identity backfill's
 * APPLY path dropped `authorizedAt`, pinning 2,783 events to their posting date.
 * Pinned here: the shared builder carries the authorization, the projection then
 * resolves the authorization date, and the script uses the builder on BOTH paths.
 *
 *   npx tsx lib/transactions/backfill-event-facts.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { factsOf } from "./backfill-event-facts";
import { projectEvent } from "./event-identity";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const day = (d: Date) => d.toISOString().slice(0, 10);

// The clone's real shape (event cmvk7g0ov…): posted 06-23, authorized 06-21.
const row = {
  id: "t1", createdAt: new Date("2026-07-22T19:24:00Z"), pending: false, amount: -17.06,
  date: new Date("2026-06-23T00:00:00Z"), economicDate: new Date("2026-06-21T00:00:00Z"),
  authorizedAt: new Date("2026-06-21T00:00:00Z"), deletedAt: null,
};

console.log("1. the builder carries every projection input");
{
  const f = factsOf(row);
  check("authorizedAt is carried", f.authorizedAt?.getTime() === row.authorizedAt.getTime());
  check("POSTED, live, posting date and economic date carried", f.lifecycle === "POSTED" && f.liveTransactionId === "t1"
    && day(f.postingDate) === "2026-06-23" && day(f.economicDate) === "2026-06-21");
  check("a tombstone is not live", factsOf({ ...row, deletedAt: new Date() }).liveTransactionId === null);
}

console.log("2. the projection resolves the AUTHORIZATION date, not the posting date");
{
  const p = projectEvent([factsOf(row)]);
  check("posted-only event with an authorization ⇒ economic date 2026-06-21", day(p.economicDate) === "2026-06-21", day(p.economicDate));
  const { authorizedAt: _drop, ...noAuth } = factsOf(row);
  const wrong = projectEvent([noAuth]);
  check("control: WITHOUT authorizedAt the same row projects to the posting date (the defect)", day(wrong.economicDate) === "2026-06-23", day(wrong.economicDate));
}

console.log("3. the backfill uses the ONE builder on both paths");
{
  const src = readFileSync(path.join(process.cwd(), "scripts/backfill-event-identity.ts"), "utf8");
  check("projectEvent(g.map(factsOf)) appears exactly twice (dry run + apply)", (src.match(/projectEvent\(g\.map\(factsOf\)\)/g) ?? []).length === 2);
  check("no inline ObservationFacts mapping remains", !/lifecycle: \(r\.pending \? "PENDING" : "POSTED"\)/.test(src));
}

if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
console.log("\nbackfill-event-facts: all checks passed");
