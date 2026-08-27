/**
 * scripts/audit-bounded-disclosure.ts   (CF-1)
 *
 * EVERY BOUNDED LIST IN THE RENDERED PROMPT, AND WHAT IT SAYS ABOUT ITSELF.
 *
 * Run: npm run audit:bounded-disclosure
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * CF-0 measured, on the live corpus, that the model was handed eight merchant
 * rows selected from a hundred and seventy-four and told to answer "who did I
 * spend the most with". Every figure was right. The superlative was not, and
 * nothing in twenty thousand tokens of context distinguished "the top eight"
 * from "the eight we chose to send".
 *
 * The fix is a contract (lib/ai/bounded-selection.ts). This is the measurement:
 * it builds the REAL context for every Space through the REAL production path
 * — buildContext → computeAssessment → buildSpaceSystemPrompt — and reports
 * what each bounded list discloses in the string the model actually receives.
 *
 * Nothing here reconstructs a payload by hand. A disclosure that is correct in
 * a fixture and absent from the rendered prompt is the exact defect class this
 * program has spent several slices removing, so the rendered prompt is the only
 * thing worth measuring.
 *
 * ── Tier ────────────────────────────────────────────────────────────────────
 * INFORMATIONAL. Whether any Space currently HAS more than eight merchants is a
 * fact about this database, not an invariant — a fresh corpus would make every
 * list complete and the audit would have nothing to report. The INVARIANT (a
 * bounded list states its denominator, and that denominator is never the length
 * of the array already truncated) is pinned on fixtures by
 * lib/ai/prompts/bounded-disclosure.test.ts, which runs in CI with no corpus.
 *
 * READ-ONLY. Builds contexts and renders strings; writes nothing.
 *
 * (Run via the npm script: this file transitively imports a module that declares
 *  `import "server-only"`, so bare `npx tsx` dies at module load.)
 */

import "@/lib/ai/assemblers";
import { buildContext } from "@/lib/ai/context-builder";
import { computeAssessment } from "@/lib/ai/intelligence";
import { fetchPerLiabilityDebtPayments } from "@/lib/ai/intelligence/debt-payments";
import { buildSpaceSystemPrompt } from "@/lib/ai/prompts/system-prompt";
import { routeForMessages } from "@/lib/ai/chat/message-analysis";
import { db } from "@/lib/db";

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);

/**
 * A disclosure found in the rendered prompt.
 *
 * `rendered` is the count of rows actually printed under the header; `total` is
 * the denominator the header claims. The audit's whole job is comparing the
 * second against the truth, so both are read from the STRING, never from the
 * objects that produced it.
 */
interface Disclosure {
  list:      string;
  rendered:  number | null;
  total:     number | null;
  complete:  boolean | null;
  header:    string;
}

/**
 * Read "showing all 7 X" / "showing 8 of 174 X" out of a header line.
 *
 * Deliberately string-level. If the phrasing drifts, this returns null and the
 * audit reports UNDISCLOSED — a bounded list whose disclosure this parser cannot
 * find is one the model may not be able to find either.
 */
function parseHeader(line: string): { rendered: number | null; total: number | null; complete: boolean } | null {
  const all = line.match(/showing all (\d+)/i);
  if (all) return { rendered: Number(all[1]), total: Number(all[1]), complete: true };
  const of = line.match(/showing (\d+) of (\d+)/i);
  if (of) return { rendered: Number(of[1]), total: Number(of[2]), complete: false };
  return null;
}

/** Find the header line for a list and read its disclosure. */
function disclosureFor(prompt: string, list: string, marker: RegExp): Disclosure {
  const line = prompt.split("\n").find((l) => marker.test(l));
  if (!line) return { list, rendered: null, total: null, complete: null, header: "(list absent from this prompt)" };
  const parsed = parseHeader(line);
  return {
    list,
    rendered: parsed?.rendered ?? null,
    total:    parsed?.total ?? null,
    complete: parsed?.complete ?? null,
    header:   line.trim().slice(0, 150),
  };
}

const LISTS: { list: string; marker: RegExp }[] = [
  { list: "merchants",             marker: /^\s*MERCHANT SUMMARY/ },
  { list: "income sources",        marker: /^\s*INCOME SOURCES/ },
  { list: "category averages",     marker: /^\s*AVERAGE MONTHLY CATEGORY SPENDING/ },
  { list: "window categories",     marker: /Category totals for this window/ },
  { list: "assessment categories", marker: /^\s*By category/ },
  { list: "assessment risks",      marker: /^\s*Top risks/ },
  { list: "assessment opps",       marker: /^\s*Top opportunities/ },
];

async function main(): Promise<void> {
  console.log(`\n[AUDIT] CF-1 bounded-list disclosure — READ-ONLY`);
  console.log(`  Renders the REAL system prompt per Space and reports what each bounded list says.`);

  const spaces = await db.space.findMany({
    where:  { archivedAt: null, deletedAt: null },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  let measured = 0;
  let truncatedLists = 0;
  let undisclosed = 0;
  // The property that matters: a truncated list must never claim to be complete,
  // and its denominator must never equal the number of rows printed.
  const collapses: string[] = [];

  for (const space of spaces) {
    const owner = await db.spaceMember.findFirst({
      where:  { spaceId: space.id, role: "OWNER", status: "ACTIVE" },
      select: { userId: true },
    });
    if (!owner) continue;

    let prompt: string;
    try {
      const ctx = await buildContext(space.id, owner.userId, { scopeHint: "full" });
      const [assessment, debtPayments] = await Promise.all([
        Promise.resolve(computeAssessment(ctx)),
        fetchPerLiabilityDebtPayments(ctx),
      ]);
      // The same call the chat route makes, with a message that would actually
      // ask for a superlative — the route the CF-0 failure travelled.
      const route = routeForMessages([{ role: "user", content: "who did I spend the most with?" }]);
      prompt = buildSpaceSystemPrompt(ctx, assessment, route, debtPayments);
    } catch (err) {
      console.log(`\n  ⚠ ${space.name} — context unavailable: ${(err as Error).message}`);
      continue;
    }
    measured++;

    bar(`${space.name}  (${space.id})`);
    console.log(`  prompt: ${prompt.length.toLocaleString()} chars`);

    for (const { list, marker } of LISTS) {
      const d = disclosureFor(prompt, list, marker);
      if (d.header.startsWith("(list absent")) {
        console.log(`    ${list.padEnd(24)} —  ${d.header}`);
        continue;
      }
      if (d.total === null) {
        undisclosed++;
        console.log(`    ${list.padEnd(24)} ✗  UNDISCLOSED — ${d.header}`);
        continue;
      }
      if (d.complete) {
        console.log(`    ${list.padEnd(24)} ✓  complete — all ${d.total}`);
      } else {
        truncatedLists++;
        console.log(`    ${list.padEnd(24)} ✓  bounded — ${d.rendered} of ${d.total} (${d.total! - d.rendered!} withheld, stated)`);
        if (d.rendered === d.total) collapses.push(`${space.name}/${list}`);
      }
    }

    // The holdings selection reaches the model inside the domains JSON, where
    // the shape is the disclosure. Report it from the rendered string too.
    const hold = prompt.match(/"topPositions":\{"items":\[.*?\],"returnedCount":(\d+),"totalCount":(\d+)/);
    if (hold) {
      const [, ret, tot] = hold;
      console.log(`    ${"holdings positions".padEnd(24)} ${ret === tot ? "✓  complete" : "✓  bounded"} — ${ret} of ${tot} (in domain JSON)`);
      if (Number(ret) > Number(tot)) collapses.push(`${space.name}/holdings`);
    }

    // Drilldown only appears when one was requested; report its shape when present.
    const drill = prompt.split("\n").find((l) => /Showing the \d+ largest of \d+|Showing all \d+ matching/.test(l));
    if (drill) console.log(`    ${"drilldown".padEnd(24)} ✓  ${drill.trim().slice(0, 110)}`);
  }

  bar("SUMMARY");
  console.log(`  Spaces measured:            ${measured}`);
  console.log(`  Bounded (truncated) lists:  ${truncatedLists}  — each states its denominator`);
  console.log(`  Undisclosed lists:          ${undisclosed}`);
  if (collapses.length > 0) {
    console.log(`\n  ✗ DENOMINATOR COLLAPSE — a truncated list whose total equals its rendered count:`);
    for (const c of collapses) console.log(`      ${c}`);
  } else {
    console.log(`  Denominator collapses:      0`);
  }
  console.log(
    `\n  INFORMATIONAL: a corpus with fewer than the render cap in every list would\n` +
    `  report zero bounded lists and prove nothing. The invariant is pinned on\n` +
    `  fixtures by lib/ai/prompts/bounded-disclosure.test.ts.\n`,
  );
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
