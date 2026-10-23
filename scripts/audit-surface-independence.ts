/**
 * scripts/audit-surface-independence.ts
 *
 * v2.6-REVIEW-1 — WHICH PRODUCT SURFACES STILL ANSWER A FINANCIAL QUESTION
 * THEMSELVES? READ-ONLY, and it reads only source — no database at all.
 *
 * ── The question ────────────────────────────────────────────────────────────
 *
 * The arc's premise is that every financial judgment has exactly one authority
 * and every consumer reads it. Measuring compliance by reading module headers
 * does not work: 100+ modules under lib/ describe themselves as "THE" answer to
 * something, and a header is a claim, not a consumer census.
 *
 * So this measures the opposite direction — where a RENDERING surface performs
 * the arithmetic itself. Three shapes, each one a way a screen can state a
 * financial fact nothing else vouches for:
 *
 *   AGGREGATION  a component sums or reduces money into a total. The total then
 *                exists only there, and no audit can reach it.
 *   RATIO        a component divides one money quantity by another. This is the
 *                shape that produced v2.6-WINDOW-1 (a row count over a date) and
 *                v2.6-ASSESS-2 (two baselines, one label).
 *   VERDICT      a component compares money to a literal threshold and branches.
 *                A threshold in a component is a judgment nobody else can audit.
 *
 * ⚠️ This finds CANDIDATES, not defects. Formatting maths (`n / 1000`, `* 100`
 * for a percent), chart geometry and layout arithmetic all look like this and are
 * fine. The output is a worklist to read, not a list of bugs — every hit is
 * printed with its line so it can be judged rather than counted.
 *
 * Tier: INFORMATIONAL — a source census. It describes the repository, not an
 * invariant, and its number legitimately moves as surfaces are written.
 *
 * Run: npx tsx scripts/audit-surface-independence.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const SCAN_ROOTS = ["components", "app"];

/** Money-shaped identifiers — the nouns a financial answer is made of. */
const MONEY = String.raw`(?:\w+\.)*(?:amount|balance|netWorth|total\w*|cash\w*|liquid\w*|debt\w*|income\w*|expense\w*|savings|value|equity|principal|payment\w*)`;

const PATTERNS: { kind: string; re: RegExp; why: string }[] = [
  {
    kind: "AGGREGATION",
    re: new RegExp(String.raw`\.reduce\s*\(\s*\(?\s*\w+\s*,\s*\w+\s*\)?\s*=>[^)]*${MONEY}`, "i"),
    why: "a total that exists only in this component",
  },
  {
    kind: "RATIO",
    re: new RegExp(String.raw`${MONEY}\s*/\s*${MONEY}`, "i"),
    why: "one money quantity divided by another — the shape that produced WINDOW-1 and ASSESS-2",
  },
  {
    kind: "VERDICT",
    re: new RegExp(String.raw`${MONEY}\s*[<>]=?\s*[\d_]{3,}`, "i"),
    why: "a threshold comparison in a component — a judgment no audit can reach",
  },
];

function walk(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  let entries: string[];
  try { entries = readdirSync(abs); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const childRel = path.join(rel, e);
    if (statSync(path.join(ROOT, childRel)).isDirectory()) {
      if (childRel.includes("prototype")) continue;   // gitignored design harnesses
      out.push(...walk(childRel));
      continue;
    }
    if (!/\.tsx?$/.test(e) || /\.test\.tsx?$/.test(e)) continue;
    out.push(childRel);
  }
  return out;
}

/** Strip comments — this arc DOCUMENTS these shapes extensively in prose. */
function codeLines(rel: string): { n: number; text: string }[] {
  const raw = readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return raw.split("\n")
    .map((text, i) => ({ n: i + 1, text: text.replace(/\/\/.*$/, "") }))
    .filter((l) => l.text.trim().length > 0)
    // Imports and type positions mention money nouns beside a path separator
    // (`@/lib/debt/balance-semantics`) and are not arithmetic. Excluding them is
    // the difference between a worklist and noise.
    .filter((l) => !/^\s*(import|export)\b/.test(l.text))
    .filter((l) => !/\bfrom\s+["']/.test(l.text))
    .filter((l) => !/\bimport\(["']/.test(l.text));
}

function main(): void {
  console.log(`\n[AUDIT] surface independence — where does a SCREEN do the maths?\n`);

  const byKind: Record<string, { file: string; n: number; text: string }[]> = {};
  for (const p of PATTERNS) byKind[p.kind] = [];

  for (const root of SCAN_ROOTS) {
    for (const file of walk(root)) {
      for (const line of codeLines(file)) {
        for (const p of PATTERNS) {
          if (p.re.test(line.text)) {
            byKind[p.kind].push({ file, n: line.n, text: line.text.trim().slice(0, 96) });
            break;   // one classification per line, most specific first
          }
        }
      }
    }
  }

  for (const p of PATTERNS) {
    const hits = byKind[p.kind];
    console.log(`\n${"═".repeat(78)}\n${p.kind} — ${hits.length} site(s)\n  ${p.why}\n${"═".repeat(78)}`);
    const files = [...new Set(hits.map((h) => h.file))].sort();
    for (const f of files) {
      const inFile = hits.filter((h) => h.file === f);
      console.log(`\n  ${f}  (${inFile.length})`);
      for (const h of inFile.slice(0, 4)) console.log(`     ${String(h.n).padStart(5)}  ${h.text}`);
      if (inFile.length > 4) console.log(`           … ${inFile.length - 4} more`);
    }
  }

  const total = Object.values(byKind).reduce((s, h) => s + h.length, 0);
  const files = new Set(Object.values(byKind).flat().map((h) => h.file));
  console.log(`\n${"═".repeat(78)}\nVERDICT\n${"═".repeat(78)}`);
  console.log(`  candidate sites : ${total}`);
  console.log(`  files involved  : ${files.size}`);
  console.log(
    `\n  Candidates, not defects. The point is the WORKLIST: each site is a place a\n` +
    `  screen states a financial fact on its own authority, and each needs reading\n` +
    `  to decide whether that is formatting, geometry, or a judgment that belongs\n` +
    `  to an authority.\n`,
  );
}

main();
