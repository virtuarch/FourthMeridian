/**
 * lib/platform/refresh/request-params.test.ts  (OPS-2C-1)
 *
 * Guards for the refresh read routes' shared parameter contract. Standalone tsx
 * (house pattern). Pure — no DB, no routes, no network.
 *
 * The load-bearing case is scope: a present-but-empty `plaidItemId` must fail
 * CLOSED (empty array ⇒ the projection reads nothing), while an ABSENT key means
 * platform-wide. Getting that backwards silently widens an operator's scope.
 */

import {
  parseProjectionParams,
  parseExecutionQueryParams,
  SCOPE_PARAM,
} from "@/lib/platform/refresh/request-params";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const q = (s: string) => new URLSearchParams(s);

function main() {
  // ── window ─────────────────────────────────────────────────────────────────────
  console.log("projection params · window");
  {
    const a = parseProjectionParams(q("from=2026-07-01&to=2026-07-10"));
    check("valid from/to pass through", a.from === "2026-07-01" && a.to === "2026-07-10");

    const bad = parseProjectionParams(q("from=yesterday&to=07/10/2026"));
    check("malformed dates are DROPPED, not 400 (degrade to default window)", bad.from === undefined && bad.to === undefined);

    const empty = parseProjectionParams(q(""));
    check("absent window ⇒ no keys (projection default applies)", empty.from === undefined && empty.to === undefined);

    check("a partial window is honoured", parseProjectionParams(q("to=2026-07-10")).to === "2026-07-10");
  }

  // ── scope: the fail-closed rule ────────────────────────────────────────────────
  console.log("projection params · scope fails closed");
  {
    const absent = parseProjectionParams(q("from=2026-07-01"));
    check("ABSENT scope key ⇒ undefined (platform-wide)", absent.plaidItemIds === undefined);

    const one = parseProjectionParams(q(`${SCOPE_PARAM}=item1`));
    check("one id ⇒ [item1]", one.plaidItemIds?.length === 1 && one.plaidItemIds[0] === "item1");

    const many = parseProjectionParams(q(`${SCOPE_PARAM}=a&${SCOPE_PARAM}=b`));
    check("repeatable key collects all ids", many.plaidItemIds?.join() === "a,b");

    const blank = parseProjectionParams(q(`${SCOPE_PARAM}=`));
    check(
      "PRESENT-but-empty scope ⇒ [] (fails CLOSED, never widens)",
      Array.isArray(blank.plaidItemIds) && blank.plaidItemIds.length === 0,
    );

    const whitespace = parseProjectionParams(q(`${SCOPE_PARAM}=%20%20`));
    check("whitespace-only id is not an id ⇒ [] (still closed)", whitespace.plaidItemIds?.length === 0);

    const mixed = parseProjectionParams(q(`${SCOPE_PARAM}=&${SCOPE_PARAM}=real`));
    check("blank entries dropped, real ones kept", mixed.plaidItemIds?.join() === "real");
  }

  // ── execution query ────────────────────────────────────────────────────────────
  console.log("execution query params");
  {
    const a = parseExecutionQueryParams(q("status=FAILED&status=PARTIAL&trigger=CRON"));
    check("repeatable status filter", a.filter?.overallStatus?.join() === "FAILED,PARTIAL");
    check("repeatable trigger filter", a.filter?.trigger?.join() === "CRON");

    const none = parseExecutionQueryParams(q(""));
    check("no filters ⇒ filter omitted entirely", none.filter === undefined);
    check("absent cursor ⇒ null", none.cursor === null);
    check("absent limit ⇒ undefined (the seam clamps)", none.limit === undefined);

    const t = parseExecutionQueryParams(q("since=2026-07-01T00:00:00.000Z&until=2026-07-10T00:00:00.000Z"));
    check("ISO instants parse", t.filter?.since instanceof Date && t.filter?.until instanceof Date);

    const badTime = parseExecutionQueryParams(q("since=not-a-date"));
    check("unparseable instant is dropped, never NaN-dated", badTime.filter === undefined);

    check("numeric limit passes through", parseExecutionQueryParams(q("limit=25")).limit === 25);
    check("non-numeric limit dropped (seam applies its default)", parseExecutionQueryParams(q("limit=abc")).limit === undefined);

    const scoped = parseExecutionQueryParams(q(`${SCOPE_PARAM}=`));
    check("seam scope obeys the SAME fail-closed rule", Array.isArray(scoped.plaidItemIds) && scoped.plaidItemIds.length === 0);
    check("seam absent scope ⇒ undefined", parseExecutionQueryParams(q("")).plaidItemIds === undefined);

    check("cursor is passed through opaquely", parseExecutionQueryParams(q("cursor=abc123")).cursor === "abc123");
  }

  // ── purity ─────────────────────────────────────────────────────────────────────
  console.log("purity");
  {
    const params = q(`from=2026-07-01&${SCOPE_PARAM}=x`);
    check(
      "parsing twice yields identical output",
      JSON.stringify(parseProjectionParams(params)) === JSON.stringify(parseProjectionParams(params)),
    );
    check("parsing does not mutate the input", params.getAll(SCOPE_PARAM).join() === "x");
  }

  if (failures > 0) {
    console.error(`\nrequest-params.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nrequest-params.test: all passed.");
}

main();
