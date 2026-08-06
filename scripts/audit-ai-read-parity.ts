/**
 * scripts/audit-ai-read-parity.ts
 *
 * v2.6-PARITY-0 — the AI read boundary, measured against the UI's. READ-ONLY.
 *
 *   npx tsx --env-file=.env.local scripts/audit-ai-read-parity.ts
 *
 * ── Why this exists before any fix ──────────────────────────────────────────
 *
 * Every surface in the product reads transactions through ONE fragment —
 * `bankingTransactionWhere` (lib/data/banking-population.ts). The AI does not.
 * `lib/ai/assemblers/transactions.ts` builds its own (`aiTransactionWhere`), and
 * the two are known to disagree on three axes. The model has been quoting
 * numbers derived from the second one.
 *
 * Closing the gap MOVES AI TOTALS. That is not a reason to leave it open, but it
 * is a reason to measure it first: a cutover whose effect nobody sized is
 * indistinguishable from a regression. This audit is that measurement, and it
 * stays afterwards as the standing guard that the two boundaries agree.
 *
 * ── The three axes ──────────────────────────────────────────────────────────
 *
 *   AXIS 1 — EVENT PROJECTION.
 *     A pending charge and the posted row that supersedes it are ONE economic
 *     event observed twice. The UI applies `eventProjectionWhere()` and sees one
 *     row per event. The AI applies nothing, so both observations can reach it —
 *     the posted row into `settled`, its superseded predecessor into `pending`,
 *     and the same money is reported twice under two labels.
 *
 *   AXIS 2 — CHRONOLOGY BASIS.
 *     The AI's window filters on `date` (POSTING) while every bucket downstream
 *     keys on `econOf` (ECONOMIC). A row can be admitted by one basis and counted
 *     under the other: money that happened in June is admitted because it posted
 *     in July, then bucketed into June — inside a window that was never June's.
 *     TIME_MODEL §8.6 records this; here it gets a number.
 *
 *   AXIS 3 — THE VISIBILITY GATE, RE-SPELLED.
 *     KD-15 is stated once in `bankingTransactionWhere` and again, by hand, in
 *     `aiTransactionWhere`. Two statements of one rule drift. This axis is
 *     measured as a RESIDUAL: whatever the two populations disagree about that
 *     axes 1 and 2 do not explain is gate drift, and it must be zero.
 *
 * ── What the measurement found, before the cutover ──────────────────────────
 *
 *   axis 1  0 rows.  No live row is superseded on this corpus — the ingest path
 *                    tombstones a pending predecessor when its posting arrives,
 *                    so `deletedAt: null` was already achieving what the event
 *                    projection GUARANTEES. The risk was structural, not live.
 *   axis 3  0 rows.  The two statements of the KD-15 gate happened to agree.
 *   axis 2  2 rows / $102.71 over 30d, 6 / $445.89 over 90d, 7 / $240.15 over
 *           the full span — all at the window FLOOR. `economicDate <= date` on
 *           all 4,405 live rows, so the basis can only ever move the floor edge.
 *   axis 4  0 rows.  Nothing INVESTMENT-flagged carries a banking category, so
 *                    the drilldown's missing population was not leaking rows.
 *
 * Three of four axes were latent. That is the answer a measurement is for: the
 * cutover was worth doing for the guarantees, not because the numbers were wrong.
 *
 * ── What it asserts, now that the cutover has landed ────────────────────────
 *
 *   INV-A1  No logical EVENT is represented more than once, and no superseded
 *           observation reaches the AI at all.
 *   INV-A2  The AI population IS the banking population windowed on
 *           `economicDate` — same set, proven by id, and by fingerprint.
 *   INV-A3  Everything the AI and the list disagree about is explained by the
 *           BASIS. Any other residual is gate / population / projection drift.
 *   INV-A4  Every row a drilldown can cite is a row the product can show.
 *
 * Corpus-independent: every check is a relationship between two definitions,
 * not a count. It holds on an empty corpus, a seeded one, and production.
 */

import { createHash } from "node:crypto";

import { db } from "@/lib/db";
import { bankingTransactionWhere, BANKING_POPULATION as BANKING_POPULATION_FRAGMENT } from "@/lib/data/banking-population";
import { eventProjectionWhere, findDuplicateEvents } from "@/lib/transactions/event-projection";
// ⚠️ The REAL seams, never a reconstruction of them. A probe that rebuilds the
// window or the where-clause measures its own copy and always agrees with it.
import { aiTransactionWhere, aiDrilldownWhere, resolveWindow } from "@/lib/ai/assemblers/transactions";
import { TransactionCategory, FlowType } from "@prisma/client";

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
const money = (n: number) =>
  `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fp = (parts: readonly string[]) =>
  createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
const iso = (d: Date) => d.toISOString().slice(0, 10);

const breaches: string[] = [];
function invariant(held: boolean, statement: string): boolean {
  if (!held) breaches.push(statement);
  return held;
}

interface Row {
  id: string;
  amount: number;
  date: Date;
  economicDate: Date | null;
  pending: boolean;
  flowType: string | null;
  merchant: string | null;
  transactionEventId: string | null;
  currentOfEvent: { id: string } | null;
}

const SELECT = {
  id: true, amount: true, date: true, economicDate: true, pending: true,
  flowType: true, merchant: true, transactionEventId: true,
  currentOfEvent: { select: { id: true } },
} as const;

const sum = (rows: readonly Row[]) => rows.reduce((s, r) => s + Math.abs(r.amount), 0);

/** One window's worth of comparison. */
async function compareWindow(
  spaceId: string,
  label: string,
  win: { start: Date; end: Date | null },
): Promise<void> {
  const dateFilter = win.end ? { gte: win.start, lte: win.end } : { gte: win.start };

  // What the AI reads — the assembler's OWN fragment.
  const aiRows = (await db.transaction.findMany({
    where: aiTransactionWhere(spaceId, win), select: SELECT,
  })) as Row[];

  // What the UI reads, over the same posting window. The ONLY intended
  // difference from the AI's is the event projection and the gate statement.
  const uiRows = (await db.transaction.findMany({
    where: { AND: [bankingTransactionWhere(spaceId), { date: dateFilter }] }, select: SELECT,
  })) as Row[];

  const aiIds = new Set(aiRows.map((r) => r.id));
  const uiIds = new Set(uiRows.map((r) => r.id));

  bar(`WINDOW: ${label}   ${iso(win.start)} → ${win.end ? iso(win.end) : "(open)"}`);
  console.log(`  rows the AI reads : ${String(aiRows.length).padStart(6)}   ${money(sum(aiRows)).padStart(16)}`);
  console.log(`  rows the UI reads : ${String(uiRows.length).padStart(6)}   ${money(sum(uiRows)).padStart(16)}`);

  // ── AXIS 1 — event projection ────────────────────────────────────────────
  // A row is a non-projection when it HAS an event and is not that event's
  // current row. Rows with no event at all are legitimately kept by both sides.
  const superseded = aiRows.filter((r) => r.transactionEventId !== null && r.currentOfEvent === null);
  console.log(`\n  AXIS 1 — event projection`);
  console.log(`    superseded observations the AI sees : ${superseded.length}   ${money(sum(superseded))}`);
  if (superseded.length > 0) {
    const p = superseded.filter((r) => r.pending);
    console.log(`      ...of which PENDING (land in the AI's pendingTotal) : ${p.length}   ${money(sum(p))}`);
    for (const r of superseded.slice(0, 8)) {
      console.log(`      ${iso(r.date)} ${money(r.amount).padStart(12)}  ${(r.merchant ?? "").slice(0, 44)}`);
    }
    if (superseded.length > 8) console.log(`      …and ${superseded.length - 8} more`);
  }
  invariant(
    superseded.length === 0,
    `[${label}] the AI sees no superseded observation (${superseded.length}, ${money(sum(superseded))}) — ` +
    `the event projection is part of bankingTransactionWhere and must reach the AI with it`,
  );

  // THE double-count — the same logical event present twice in one payload.
  const violations = findDuplicateEvents(aiRows);
  const dupMoney = violations.reduce((s, v) => {
    const rows = aiRows.filter((r) => v.transactionIds.includes(r.id));
    // The excess: everything beyond the one row that should have been there.
    return s + sum(rows) - Math.abs(rows[0]?.amount ?? 0);
  }, 0);
  console.log(`    INV-A1 — events represented MORE THAN ONCE : ${violations.length}` +
    (violations.length > 0 ? `   excess ${money(dupMoney)}` : ""));
  for (const v of violations.slice(0, 5)) {
    console.log(`      event ${v.eventId}: ${v.transactionIds.join(", ")}`);
  }
  invariant(
    violations.length === 0,
    `[${label}] no logical event reaches the AI twice (${violations.length} events double-counted, ${money(dupMoney)})`,
  );

  // ── AXIS 2 — chronology basis ────────────────────────────────────────────
  // Measured on the UI population, so the projection axis cannot contaminate it.
  // `admittedByPosting` is what the window returns today; `admittedByEconomic` is
  // what it would return on the basis every downstream bucket already uses.
  const inWindow = (d: Date) => d >= win.start && (win.end === null || d <= win.end);
  const econOf = (r: Row) => r.economicDate ?? r.date;

  const wrongBasisIn = uiRows.filter((r) => !inWindow(econOf(r)));
  // Rows the window MISSES: economically inside, posted outside. Needs a second
  // read — they are absent from `uiRows` by construction.
  const projected = { AND: [bankingTransactionWhere(spaceId), { economicDate: dateFilter }] };
  const econRows = (await db.transaction.findMany({ where: projected, select: SELECT })) as Row[];
  const wrongBasisOut = econRows.filter((r) => !uiIds.has(r.id));

  console.log(`\n  AXIS 2 — chronology basis (rule B1: a flow read windows on \`economicDate\`)`);
  console.log(`    the UI's posting window admits, economically OUTSIDE : ${wrongBasisIn.length}   ${money(sum(wrongBasisIn))}`);
  console.log(`    economically INSIDE, posted outside                  : ${wrongBasisOut.length}   ${money(sum(wrongBasisOut))}`);
  for (const r of [...wrongBasisIn, ...wrongBasisOut].slice(0, 6)) {
    console.log(`      posted ${iso(r.date)}  economic ${iso(econOf(r))}  ${money(r.amount).padStart(12)}  ${(r.merchant ?? "").slice(0, 34)}`);
  }
  console.log(`    ⚠️ These are the rows the two BASES disagree about — they are why`);
  console.log(`       the AI's window must be economic, not a defect in it.`);

  // THE assertion: the AI's own population is exactly the banking population
  // windowed on the ECONOMIC date. Both sides are re-derived here from the
  // canonical fragments, so this holds or the cutover regressed.
  const econIds = new Set(econRows.map((r) => r.id));
  const aiMissing = [...econIds].filter((id) => !aiIds.has(id));
  const aiExtra = [...aiIds].filter((id) => !econIds.has(id));
  console.log(`    INV-A2 — AI population === banking population on the economic window:` +
    ` ${aiMissing.length} missing, ${aiExtra.length} extra`);
  invariant(
    aiMissing.length === 0 && aiExtra.length === 0,
    `[${label}] the AI reads exactly the banking population windowed on economicDate ` +
    `(${aiMissing.length} missing, ${aiExtra.length} extra)`,
  );

  // ── AXIS 3 — the residual: anything the BASIS does not explain ───────────
  //
  // The AI now windows on `economicDate` and the list on `date`, so the two
  // populations legitimately differ — by exactly the rows whose two dates fall
  // on opposite sides of a boundary, and by nothing else. Subtract those and the
  // remainder must be empty. A non-empty remainder means the gate, the
  // population or the projection has drifted apart again.
  const explainedIn = new Set(wrongBasisIn.map((r) => r.id));   // in UI, not in AI
  const explainedOut = new Set(wrongBasisOut.map((r) => r.id)); // in AI, not in UI
  const aiOnly = [...aiIds].filter((id) => !uiIds.has(id) && !explainedOut.has(id));
  const uiOnly = [...uiIds].filter((id) => !aiIds.has(id) && !explainedIn.has(id));

  console.log(`\n  AXIS 3 — residual after the basis (any of this is GATE / POPULATION DRIFT)`);
  console.log(`    in AI only, unexplained : ${aiOnly.length}`);
  console.log(`    in UI only, unexplained : ${uiOnly.length}`);
  for (const id of [...aiOnly, ...uiOnly].slice(0, 8)) {
    const r = aiRows.find((x) => x.id === id) ?? uiRows.find((x) => x.id === id)!;
    console.log(`      ${id}  posted ${iso(r.date)} economic ${iso(econOf(r))}  ${money(r.amount)}  flowType=${r.flowType ?? "(null)"}`);
  }
  invariant(
    aiOnly.length === 0 && uiOnly.length === 0,
    `[${label}] the AI and UI populations differ ONLY by the chronology basis ` +
    `(${aiOnly.length} unexplained in AI, ${uiOnly.length} unexplained in UI) — ` +
    `the visibility gate / banking population / event projection have drifted apart`,
  );
}

async function main(): Promise<void> {
  console.log("\n[AUDIT] AI read parity — the model's population vs the product's. READ-ONLY\n");

  const spaces = await db.space.findMany({ select: { id: true, name: true } });
  const counts = await Promise.all(spaces.map(async (s) => ({
    ...s, n: await db.transaction.count({ where: bankingTransactionWhere(s.id) }),
  })));
  const space = counts.sort((a, b) => b.n - a.n)[0];
  if (!space || space.n === 0) {
    console.log("  (no Space carries banking rows — nothing to compare)");
    return;
  }
  console.log(`  Space: ${space.name}  (${space.n} banking rows)`);

  // The two ROLLING windows the assembler actually uses, resolved by its own
  // resolver. These are relative to today, so their counts move with the corpus.
  await compareWindow(space.id, "brief (30d)", resolveWindow("brief", undefined));
  await compareWindow(space.id, "full (90d)", resolveWindow("full", undefined));

  // …and one EXPLICIT window (the D6 drilldown shape), pinned to fixed dates so
  // the fingerprint below is stable across runs. A rolling window's fingerprint
  // would change daily and prove nothing.
  const span = await db.transaction.aggregate({
    where: bankingTransactionWhere(space.id), _min: { date: true }, _max: { date: true },
  });
  const explicit = resolveWindow("full", {
    startDate: iso(span._min.date ?? new Date(0)),
    endDate:   iso(span._max.date ?? new Date()),
  });
  await compareWindow(space.id, "explicit (full corpus span)", explicit);

  // ── AXIS 4 — the DRILLDOWN population ─────────────────────────────────────
  //
  // The drilldown is the AI's EVIDENCE path: "what is this made of?" It answers
  // by re-reading real rows, so a row it can reach that the product cannot show
  // is a row the model can quote and the user cannot find.
  //
  // Two shapes, and they do not apply the same rule. `includeNonSpending` uses
  // BANKING_POPULATION; a resolved CATEGORY uses `{ category: X }` and no
  // population at all.
  bar("AXIS 4 — the drilldown's population vs the product's");
  const dwin = { start: explicit.start, end: explicit.end! };
  const uiAll = new Set(
    (await db.transaction.findMany({
      where: { AND: [bankingTransactionWhere(space.id), { date: { gte: dwin.start, lte: dwin.end } }] },
      select: { id: true },
    })).map((r) => r.id),
  );

  for (const [label, categoryWhere, amountWhere] of [
    ["category drill (Shopping)", { category: TransactionCategory.Shopping }, { amount: { lt: 0 } }],
    ["category drill (Other)", { category: TransactionCategory.Other }, { amount: { lt: 0 } }],
    ["includeNonSpending drill", BANKING_POPULATION_FRAGMENT, {}],
  ] as const) {
    const rows = (await db.transaction.findMany({
      where: aiDrilldownWhere(space.id, dwin, {
        categoryWhere, amountWhere, merchantQuery: undefined,
      }),
      select: SELECT,
    })) as Row[];
    const unreachable = rows.filter((r) => !uiAll.has(r.id));
    console.log(`  ${label.padEnd(28)} rows=${String(rows.length).padStart(5)}   ` +
      `reachable by the AI but NOT by the product: ${unreachable.length}` +
      (unreachable.length > 0 ? `   ${money(sum(unreachable))}` : ""));
    const byFlow = new Map<string, number>();
    for (const r of unreachable) byFlow.set(r.flowType ?? "(null)", (byFlow.get(r.flowType ?? "(null)") ?? 0) + 1);
    for (const [k, n] of [...byFlow].sort((a, b) => b[1] - a[1])) {
      console.log(`      flowType=${k}: ${n}`);
    }
    invariant(
      unreachable.length === 0,
      `[drilldown/${label}] every row the AI can cite is a row the product can show ` +
      `(${unreachable.length} unreachable, ${money(sum(unreachable))})`,
    );
  }

  // ── Fingerprints ──────────────────────────────────────────────────────────
  bar("FINGERPRINTS — the two populations, over the fixed explicit window");
  const aiIds = (await db.transaction.findMany({
    where: aiTransactionWhere(space.id, explicit), select: { id: true },
  })).map((r) => r.id).sort();
  // The acceptance test: the AI's population, and the product's population
  // windowed on the same basis, are the SAME SET — not merely the same size.
  const canonIds = (await db.transaction.findMany({
    where: { AND: [bankingTransactionWhere(space.id), { economicDate: { gte: explicit.start, lte: explicit.end! } }] },
    select: { id: true },
  })).map((r) => r.id).sort();
  const postingIds = (await db.transaction.findMany({
    where: { AND: [bankingTransactionWhere(space.id), { date: { gte: explicit.start, lte: explicit.end! } }] },
    select: { id: true },
  })).map((r) => r.id).sort();
  console.log(`  AI population                        ${fp(aiIds)}  (${aiIds.length} rows)`);
  console.log(`  banking population · ECONOMIC window ${fp(canonIds)}  (${canonIds.length} rows)`);
  console.log(`  banking population · POSTING window  ${fp(postingIds)}  (${postingIds.length} rows)`);
  console.log(`  ⚠️ The first two MUST match — that is the parity. The third is shown`);
  console.log(`     because it is what a BALANCE read would return (rule B2); it is`);
  console.log(`     expected to differ, and differing is the point of the basis axis.`);
  invariant(
    fp(aiIds) === fp(canonIds),
    `the AI population is byte-identical to the banking population on the economic window ` +
    `(${fp(aiIds)} vs ${fp(canonIds)})`,
  );

  // ── Verdict ───────────────────────────────────────────────────────────────
  bar("VERDICT");
  if (breaches.length > 0) {
    console.error(`  ✗ ${breaches.length} invariant(s) breached:`);
    for (const b of breaches) console.error(`      · ${b}`);
    console.error(
      "\n[AUDIT] FAILED — the AI is reading a population the product does not.\n" +
      "INV-A1 (an event reaching the model twice) is a double-count, not a divergence.\n" +
      "INV-A3 (unexplained residual) means the KD-15 gate has been stated twice and the\n" +
      "statements no longer agree. Fix lib/ai/assemblers/transactions.ts — never the audit.\n",
    );
    process.exitCode = 1;
    return;
  }
  console.log("\n[AUDIT] PASSED — the AI reads the product's population, on the flow basis.");
  console.log("        Nothing was written.\n");
}

main()
  .catch((err) => { console.error("audit-ai-read-parity failed:", err); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); });
