/**
 * lib/transactions/flow-classifier-authority.test.ts — V25-CLOSE-3 Part 2
 *
 * INVARIANT: lib/transactions/flow-classifier.ts is the sole authority for
 * PERSISTED transaction flow classification, with exactly ONE sanctioned
 * exception — lib/crypto/btc-sync.ts.
 *
 *     npx tsx lib/transactions/flow-classifier-authority.test.ts
 *
 * WHY THIS EXISTS. The V25 architecture-closure investigation classified
 * btc-sync as a *second* classification writer: it hand-authors flowType /
 * category / classificationReason and writes NULL classifierVersion, never
 * calling classifyFlow. That is deliberate and correct (on-chain movements lack
 * PFC / descriptors / counterparty names — the classifier's evidence ladder has
 * nothing to stand on). But the exception lived only in prose, and v2.5 doctrine
 * is "exceptions become executable policy." This guard is that policy:
 *
 *   - the btc-sync exception must stay DOCUMENTED (its sentinel marker present);
 *   - no OTHER file may hand-write persisted flowType off the classifier.
 *
 * It does NOT force btc-sync through the classifier, and it does not remove the
 * special path — it fences it, so a future writer that quietly copies the
 * pattern fails CI instead of silently forking classification authority.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = process.cwd();

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}
/** Strip comments so prose describing the rule never satisfies (or trips) it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}

/**
 * The classifier authority — anything that references one of these is deriving
 * flow facts THROUGH the classifier (which stamps classifierVersion). A file
 * writing flowType while referencing one of these is a canonical writer, not a
 * rogue one.
 */
const AUTHORITY_MARKERS = [
  "buildFlowWriteFields",
  "recomputeFlowFields",
  "computeFlowFields",
  "classifyFlow",
];

/**
 * The sole sanctioned off-classifier writer. Its `why` is the executable record
 * of the exception; its `sentinel` must appear in the file (comments included),
 * so deleting the documentation fails this guard.
 */
const APPROVED_EXCEPTIONS: { file: string; sentinel: string }[] = [
  {
    file: "lib/crypto/btc-sync.ts",
    sentinel: "FLOW-CLASSIFIER-EXCEPTION (btc-sync)",
  },
];
const APPROVED_FILES = new Set(APPROVED_EXCEPTIONS.map((e) => e.file));

// ── Collect candidate persisted-flowType writers under lib/ and app/ ──────────
function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "prototype") continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, acc);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) acc.push(rel);
  }
  return acc;
}

/**
 * A file PERSISTS flow classification when (comments stripped) it both mentions
 * `flowType` as a written field AND writes a Transaction row / builds flow write
 * fields. This is intentionally broad on the write side and narrow on the field
 * side, so it errs toward flagging a would-be writer for review.
 */
function persistsFlowType(codeSrc: string): boolean {
  const writesTransaction =
    /\btransaction\.(create|createMany|update|updateMany|upsert)\b/.test(codeSrc) ||
    /buildFlowWriteFields\s*\(/.test(codeSrc) ||
    /recomputeFlowFields\s*\(/.test(codeSrc);
  // `flowType:` as an object-literal key being assigned (not merely read).
  const assignsFlowType = /\bflowType\s*:/.test(codeSrc);
  return writesTransaction && assignsFlowType;
}

const files = [...walk("lib"), ...walk("app")];
const writers: string[] = [];
for (const f of files) {
  const c = stripComments(read(f));
  if (persistsFlowType(c)) writers.push(f);
}

// ── Anti-vacuity ──────────────────────────────────────────────────────────────
// The detector flags files that assign a LITERAL `flowType:` next to a
// transaction write. Canonical writers that spread buildFlowWriteFields() do not
// carry a literal key and are correctly NOT flagged (they delegate, not
// hand-write) — so the floor is the literal-writer set, not every flow writer.
check(
  "detector finds the known literal-flowType writers (>= 3)",
  writers.length >= 3,
  `found ${writers.length}: ${writers.join(", ")} — the scan or matcher is broken, do not lower this floor`,
);
check(
  "detector sees the btc-sync exception as a writer (else the fence guards nothing)",
  writers.includes("lib/crypto/btc-sync.ts"),
  `writers: ${writers.join(", ")}`,
);
check(
  "detector sees at least one CANONICAL writer (proves it distinguishes pass from fail)",
  writers.some((f) => f !== "lib/crypto/btc-sync.ts" && AUTHORITY_MARKERS.some((m) => stripComments(read(f)).includes(m))),
  `writers: ${writers.join(", ")}`,
);

// ── Every writer is either canonical (uses the authority) or an approved exception ──
for (const f of writers) {
  const c = stripComments(read(f));
  const usesAuthority = AUTHORITY_MARKERS.some((m) => c.includes(m));
  const isApproved = APPROVED_FILES.has(f);
  check(
    `${f} routes flow classification through the classifier authority, or is an approved exception`,
    usesAuthority || isApproved,
    isApproved
      ? undefined
      : `${f} hand-writes flowType without ${AUTHORITY_MARKERS.join("/")} and is not an approved exception. ` +
        `Route it through the classifier, or (only if it genuinely cannot be classified) add it to ` +
        `APPROVED_EXCEPTIONS with a documented sentinel.`,
  );
}

// ── Each approved exception must exist, be genuinely off-classifier, and stay documented ──
for (const { file, sentinel } of APPROVED_EXCEPTIONS) {
  let raw = "";
  try { raw = read(file); } catch { /* missing */ }
  check(
    `approved exception ${file} still exists`,
    raw.length > 0,
    "the exception file is gone — remove it from APPROVED_EXCEPTIONS",
  );
  check(
    `approved exception ${file} carries its documented sentinel "${sentinel}"`,
    raw.includes(sentinel),
    "the exception must stay self-documenting — restore the sentinel or the exception is no longer sanctioned",
  );
  check(
    `approved exception ${file} is genuinely OFF the classifier (writes no classifierVersion)`,
    !stripComments(raw).includes("classifierVersion") && !AUTHORITY_MARKERS.some((m) => stripComments(raw).includes(m)),
    `${file} now references the classifier authority — if it was converted to canonical classification, ` +
      "remove it from APPROVED_EXCEPTIONS (it no longer needs the exception).",
  );
}

console.log(`\nflow-classifier-authority: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
