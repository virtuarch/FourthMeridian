/**
 * lib/investments/import-provenance-closure.test.ts
 *
 * A7-1 — the PositionObservation deletedAt read-path closure. Proves that once an
 * imported observation is soft-deleted (rolled back), it becomes invisible to
 * every consumer, while live rows behave exactly as before.
 *
 * The fake Prisma client here HONORS the `where` clause (deletedAt: null,
 * supersededById: null, date.lte, scalar equality, distinct, orderBy) — so each
 * assertion actually depends on the production query carrying `deletedAt: null`.
 * Drop the filter from any of the three hardened reads and the seeded deleted row
 * leaks through the fake and the matching assertion fails: the test exercises the
 * real filter seam, it does not bypass it.
 *
 * Fourth of the four investigation sites — brokerage-cash.ts — reads NO
 * PositionObservation rows at HEAD (its residual is derived purely from the
 * caller-supplied holdings payload; its only observation touch is a DERIVED-cash
 * upsert WRITE). So there is no read to filter; the guard below proves the
 * derivation path never reads observations, so soft-deleted rows cannot reach it.
 *
 *   npx tsx lib/investments/import-provenance-closure.test.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PositionOrigin } from "@prisma/client";
import { gatherReconstructionInputs } from "./reconstruction-runner";
import { getPositionQuantityAsOf, resolvePositionAsOf, type PositionRow } from "./reconstruction-read";
import { capturePositionObservations } from "./position-capture";
import { captureBrokerageCash } from "./brokerage-cash";
import { PLAID_PROVIDER } from "./instrument-resolver";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

// ── A where-honoring fake for positionObservation reads ──────────────────────
interface ObsRow { [k: string]: unknown }

function matchesWhere(row: ObsRow, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "date" && v && typeof v === "object" && "lte" in (v as object)) {
      const lte = (v as { lte: Date }).lte;
      if (!((row.date as Date) <= lte)) return false;
      continue;
    }
    if (v === null) { if (row[k] != null) return false; continue; } // deletedAt/supersededById: null
    if (row[k] !== v) return false;
  }
  return true;
}

function makeObsClient(rows: ObsRow[]) {
  const upserts: { create: ObsRow }[] = [];
  const client: Record<string, unknown> = {
    positionObservation: {
      findMany: async (args: { where?: Record<string, unknown>; distinct?: string[]; orderBy?: { date?: "asc" | "desc" } } = {}) => {
        let out = rows.filter((r) => matchesWhere(r, args.where ?? {}));
        if (args.orderBy?.date === "desc") out = [...out].sort((a, b) => (b.date as Date).getTime() - (a.date as Date).getTime());
        if (args.distinct?.includes("instrumentId")) {
          const seen = new Set<unknown>(); const dd: ObsRow[] = [];
          for (const r of out) if (!seen.has(r.instrumentId)) { seen.add(r.instrumentId); dd.push(r); }
          out = dd;
        }
        return out;
      },
      upsert: async ({ create }: { create: ObsRow }) => { upserts.push({ create }); return create; },
    },
    investmentEvent: { findMany: async () => [] },
    instrument: { findMany: async () => [] },
    positionReconstruction: { findMany: async () => [], upsert: async ({ create }: { create: ObsRow }) => create },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(client),
  };
  return { client, upserts };
}

async function main(): Promise<void> {
  // ── 1. Reconstruction input gathering ignores deleted observations ─────────
  console.log("reconstruction-runner.gatherReconstructionInputs");
  {
    const { client } = makeObsClient([
      { id: "o_aaa", financialAccountId: "fa1", instrumentId: "AAA", origin: PositionOrigin.OBSERVED, source: PLAID_PROVIDER, date: D("2026-07-10"), quantity: 10, isCash: false, currency: "USD", deletedAt: null },
      { id: "o_bbb", financialAccountId: "fa1", instrumentId: "BBB", origin: PositionOrigin.OBSERVED, source: PLAID_PROVIDER, date: D("2026-07-10"), quantity: 5,  isCash: false, currency: "USD", deletedAt: D("2026-07-12") },
    ]);
    const inputs = await gatherReconstructionInputs(client as never, "fa1", D("2026-07-12"));
    const ids = inputs.anchors.map((a) => a.instrumentId).sort();
    check("live anchor AAA gathered", ids.includes("AAA"));
    check("deleted anchor BBB excluded", !ids.includes("BBB"), `anchors=${ids.join(",")}`);
  }

  // ── 2 & 3. Quantity-as-of read + read-model resolution ignore deleted ──────
  console.log("reconstruction-read.getPositionQuantityAsOf (+ resolvePositionAsOf)");
  {
    const { client } = makeObsClient([
      { financialAccountId: "fa1", instrumentId: "AAA", origin: PositionOrigin.OBSERVED, date: D("2026-07-01"), quantity: 10, supersededById: null, completeness: null, deletedAt: null },
      // A newer IMPORTED row that has been rolled back — must NOT win the as-of read.
      { financialAccountId: "fa1", instrumentId: "AAA", origin: PositionOrigin.IMPORTED, date: D("2026-07-05"), quantity: 20, supersededById: null, completeness: null, deletedAt: D("2026-07-12") },
    ]);
    const asof = await getPositionQuantityAsOf("fa1", "AAA", "2026-07-10", client as never);
    check("resolves to the live OBSERVED row, not the deleted newer IMPORTED row", asof.quantity === 10 && asof.date === "2026-07-01" && asof.origin === PositionOrigin.OBSERVED, JSON.stringify(asof));
    check("tier reflects the live observed row", asof.tier === "observed");
  }

  // ── 4. Disappeared-instrument detection ignores deleted prior observations ──
  console.log("position-capture.capturePositionObservations (disappearance scan)");
  {
    const { client, upserts } = makeObsClient([
      { financialAccountId: "fa1", instrumentId: "AAA", origin: PositionOrigin.OBSERVED, source: PLAID_PROVIDER, date: D("2026-07-01"), quantity: 3, deletedAt: null },
      { financialAccountId: "fa1", instrumentId: "BBB", origin: PositionOrigin.OBSERVED, source: PLAID_PROVIDER, date: D("2026-07-01"), quantity: 7, deletedAt: D("2026-07-12") },
    ]);
    // No current holdings ⇒ every LIVE prior instrument "disappears" (zero row).
    const res = await capturePositionObservations({ financialAccountId: "fa1", plaidHoldings: [], securitiesById: {}, date: D("2026-07-12"), client: client as never });
    const zeroed = upserts.map((u) => u.create.instrumentId).sort();
    check("live prior instrument AAA is zeroed on disappearance", zeroed.includes("AAA"));
    check("deleted prior instrument BBB is NOT resurrected/zeroed", !zeroed.includes("BBB"), `zeroed=${zeroed.join(",")}`);
    check("disappeared count counts only the live prior", res.disappeared === 1);
  }

  // ── 5. Brokerage-cash derivation reads NO observations ─────────────────────
  console.log("brokerage-cash.captureBrokerageCash (derivation reads no observations)");
  {
    const upserts: ObsRow[] = [];
    const client: Record<string, unknown> = {
      // Any observation READ during derivation is a contract violation — throw.
      positionObservation: {
        findMany: async () => { throw new Error("brokerage-cash derivation must not read PositionObservation"); },
        upsert: async ({ create }: { create: ObsRow }) => { upserts.push(create); return create; },
      },
      instrumentAlias: { findUnique: async () => null },
      instrument: { create: async () => ({ id: "inst_cash_usd" }) },
    };
    const res = await captureBrokerageCash({
      financialAccountId: "fa1", date: D("2026-07-12"), client: client as never,
      input: {
        accountBalance: 1000, accountCurrency: "USD", balanceAsOf: D("2026-07-12"),
        holdings: [{ isCash: false, institutionValue: 600, quantity: null, institutionPrice: null, currency: "USD", priceAsOf: D("2026-07-12") }],
        payloadComplete: true, captureDate: D("2026-07-12"),
      },
    });
    check("derivation completes without reading observations (DERIVED)", res.status === "DERIVED" && res.written === true, JSON.stringify({ status: res.status, written: res.written }));
    check("derived cash equals the holdings-only residual (400)", Math.abs(res.derivedCash - 400) <= 1e-9);
  }

  // ── 6. Live observations remain byte-identical in behavior ─────────────────
  console.log("live-only observations behave exactly as before");
  {
    const { client } = makeObsClient([
      { id: "o1", financialAccountId: "fa1", instrumentId: "AAA", origin: PositionOrigin.OBSERVED, source: PLAID_PROVIDER, date: D("2026-07-10"), quantity: 10, isCash: false, currency: "USD", deletedAt: null },
      { id: "o2", financialAccountId: "fa1", instrumentId: "BBB", origin: PositionOrigin.OBSERVED, source: PLAID_PROVIDER, date: D("2026-07-10"), quantity: 5,  isCash: false, currency: "USD", deletedAt: null },
    ]);
    const inputs = await gatherReconstructionInputs(client as never, "fa1", D("2026-07-12"));
    check("both live anchors present (no live row dropped)", inputs.anchors.map((a) => a.instrumentId).sort().join(",") === "AAA,BBB");
    const asof = await getPositionQuantityAsOf("fa1", "AAA", "2026-07-11", client as never);
    check("live quantity-as-of unchanged", asof.quantity === 10 && asof.origin === PositionOrigin.OBSERVED);
  }

  // ── 7. Origin precedence unchanged (OBSERVED > IMPORTED > DERIVED > USER_ASSERTED) ─
  console.log("resolvePositionAsOf origin precedence unchanged");
  {
    const sameDate = (origin: PositionOrigin, quantity: number): PositionRow => ({ date: "2026-07-01", quantity, origin, completeness: null });
    const rows = [
      sameDate(PositionOrigin.USER_ASSERTED, 4),
      sameDate(PositionOrigin.DERIVED, 3),
      sameDate(PositionOrigin.IMPORTED, 2),
      sameDate(PositionOrigin.OBSERVED, 1),
    ];
    check("OBSERVED wins a same-date tie", resolvePositionAsOf(rows, "2026-07-05").origin === PositionOrigin.OBSERVED);
    check("IMPORTED beats DERIVED/USER_ASSERTED", resolvePositionAsOf([sameDate(PositionOrigin.USER_ASSERTED, 4), sameDate(PositionOrigin.DERIVED, 3), sameDate(PositionOrigin.IMPORTED, 2)], "2026-07-05").origin === PositionOrigin.IMPORTED);
    check("DERIVED beats USER_ASSERTED", resolvePositionAsOf([sameDate(PositionOrigin.USER_ASSERTED, 4), sameDate(PositionOrigin.DERIVED, 3)], "2026-07-05").origin === PositionOrigin.DERIVED);
  }

  // ── 8 & 9. No writer for the new import fields; banking ImportBatch unchanged ─
  console.log("no writer for the new import-provenance fields exists yet");
  {
    const tokens = ["importedRaw", "userDecisions", "INVESTMENT_HISTORY"];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".next") walk(full); continue; }
        if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
        // Strip comments so a doc mention of a field name isn't mistaken for a
        // writer — the guard flags actual CODE references (a Prisma create/update
        // setting the field), not prose. A7-2 leaves all three null and only
        // names importedRaw in comments; A7-4 is the first real writer.
        const code = readFileSync(full, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/[^\n]*/g, "");
        for (const t of tokens) if (code.includes(t)) offenders.push(`${path.relative(process.cwd(), full)}:${t}`);
      }
    };
    walk(path.join(process.cwd(), "lib"));
    walk(path.join(process.cwd(), "app"));
    check("no non-test source writes importedRaw / userDecisions / INVESTMENT_HISTORY", offenders.length === 0, offenders.join(", "));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
