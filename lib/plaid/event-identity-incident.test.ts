/**
 * lib/plaid/event-identity-incident.test.ts  (RLS-P-2 × EVENT-WRITE-1)
 *
 * A SWALLOWED EVENT-IDENTITY WRITE NOW LEAVES A ROW, AND THE ROW SAYS THE RIGHT
 * THING TO THE RIGHT AUDIENCE.
 *
 * EVENT-WRITE-1 found a measured, active corruption: the observation unit's
 * first statement claimed `TransactionEvent.currentTransactionId` while another
 * event still held it, so the unit rolled back AFTER the transaction row had
 * already committed. It gave that failure a type — `EventWriteIntegrityFailure`,
 * carrying `canonicalStatePersisted: false` — and named the integration point it
 * deliberately did not edit: this module's `recordObservation` catch, which
 * reported the whole thing to `console.warn`.
 *
 * A warn in a serverless log window is not a record. So the branch is wired, and
 * what needs proving is not that a row appears — it is the three DECISIONS the
 * branch makes, each of which is wrong in an obvious-looking way:
 *
 *   1. IT MUST NOT NAME THE BANK TRANSACTION. Passing `plaidTransactionId` is
 *      the natural thing to do and it makes `classifySyncIssue` set
 *      `customerActionable`, which tells the member to reconnect their bank. No
 *      member action helps here and NO FINANCIAL RECORD IS MISSING — the
 *      transaction row committed. Only the derived identity layer is absent.
 *   2. IT MUST NOT HOLD THE CURSOR. Event identity is additive and nothing reads
 *      it yet. A held page stops delivering real transactions over a gap that
 *      cost the member nothing, and `cursorBlocking` is also what licenses
 *      AUTO-RESOLUTION — so a row that claimed it would be closed by the next
 *      clean sync, which proves nothing about this event.
 *   3. IT MUST NOT INHERIT THE EVENT WRITER'S OWN `stage`.
 *      `EventWriteIntegrityDetail.stage` is an internal phase
 *      ("OBSERVATION_WRITE" | "REPLAY_HEAL" | "TERMINAL_STATE_CHECK") and
 *      `detail.stage` is the INCIDENT IDENTITY DISCRIMINATOR. Spread the detail
 *      after assigning the stage and one operational problem splits into three
 *      episodes — silently, and only visibly months later as three open
 *      incidents nobody can merge.
 *
 * ⚠️ EVERY ABSENCE CLAIM CARRIES ITS DENOMINATOR, and §4 re-runs each scan
 * against deliberately violating text. Decisions 1 and 2 are asserted as PAIRS:
 * the row we build must be quiet, and the row we deliberately did not build must
 * be loud. A test that only showed the quiet half would also pass if everything
 * were quiet.
 *
 * Run: npx tsx --require ./scripts/lib/server-only-preload.cjs <this>
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { resolveOperationKey, UNREGISTERED_PREFIX } from "@/lib/platform/incidents/operation-key";
import { classifySyncIssue } from "@/lib/platform/sync-issue-semantics";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();
const PRODUCER = "lib/plaid/syncTransactions.ts";
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The `recordObservation` catch block, isolated so a scan cannot drift onto one
 *  of this file's three other `recordSyncIssue` call sites. */
function observationCatch(src: string): string {
  const code = stripComments(src);
  const at = code.indexOf("const recordObservation");
  if (at < 0) return "";
  // The branch ends where the helper does — at the next top-level `try {` the
  // write paths open.
  const end = code.indexOf("\n      try {", at);
  return end < 0 ? code.slice(at) : code.slice(at, end);
}

// ── The scans, pure so §4 can mutation-test them ─────────────────────────────

/** DECISION 1 + the branch itself: it discriminates on the TYPE, not on a code
 *  or a message, and it does not name the bank transaction. */
function scanBranchShape(src: string): { examined: number; bad: string[] } {
  const body = observationCatch(src);
  const bad: string[] = [];
  if (body === "") return { examined: 0, bad: ["recordObservation not found — the scan has no region"] };
  let examined = 0;

  examined++;
  if (!/isEventWriteIntegrityFailure\(\s*e\s*\)/.test(body)) {
    bad.push("the catch does not branch on isEventWriteIntegrityFailure(e)");
  }
  examined++;
  if (!/recordSyncIssue\(/.test(body)) bad.push("the branch records no SyncIssue");
  examined++;
  if (!/\.\.\.e\.detail/.test(body)) bad.push("the branch does not forward e.detail");
  examined++;
  // DECISION 1. `plaidTransactionId` anywhere in this branch is the defect.
  if (/plaidTransactionId\s*:/.test(body)) {
    bad.push("the branch names plaidTransactionId, which makes the incident customer-actionable");
  }
  examined++;
  // It must not rethrow or register a page failure: the cursor still advances.
  if (/\bthrow\b/.test(body) || /pageFailures\.push/.test(body)) {
    bad.push("the branch blocks the page — event identity must stay non-blocking");
  }
  return { examined, bad };
}

/** DECISION 3 — ORDERING. `...e.detail` must appear BEFORE `stage:`, or the
 *  event writer's internal phase becomes the incident's identity. */
function scanDetailSpreadPrecedesStage(src: string): { examined: number; bad: string[] } {
  const body = observationCatch(src);
  if (body === "") return { examined: 0, bad: ["recordObservation not found"] };
  const spread = body.indexOf("...e.detail");
  const stage = body.indexOf('stage: "event-identity-persist"');
  const bad: string[] = [];
  if (spread < 0) bad.push("no `...e.detail` spread found");
  if (stage < 0) bad.push("no `stage: \"event-identity-persist\"` assignment found");
  if (spread >= 0 && stage >= 0 && spread > stage) {
    bad.push("the spread comes AFTER the stage assignment, so e.detail.stage overwrites the identity discriminator");
  }
  return { examined: 2, bad };
}

/** DECISION 2 — the cursor is explicitly NOT held, stated rather than omitted. */
function scanCursorNotHeld(src: string): { examined: number; bad: string[] } {
  const body = observationCatch(src);
  if (body === "") return { examined: 0, bad: ["recordObservation not found"] };
  const bad: string[] = [];
  if (!/cursorBlocking:\s*false/.test(body)) {
    bad.push("cursorBlocking is not stated as false");
  }
  if (/cursorBlocking:\s*true/.test(body)) bad.push("the branch claims cursorBlocking");
  return { examined: 1, bad };
}

function main(): void {
  const src = read(PRODUCER);

  // ══ 1. THE BRANCH EXISTS AND HAS THE RIGHT SHAPE ═════════════════════════
  console.log("1. the catch branches on the TYPE and records, without naming the bank transaction");
  {
    const s = scanBranchShape(src);
    check(`the branch is wired and narrow (${s.examined} propert(ies) examined)`,
      s.bad.length === 0 && s.examined === 5, s.bad.join("; ") || `only ${s.examined} examined`);

    const o = scanDetailSpreadPrecedesStage(src);
    check("`...e.detail` is spread BEFORE the stage is assigned, so the identity discriminator survives",
      o.bad.length === 0, o.bad.join("; "));

    const c = scanCursorNotHeld(src);
    check("the cursor is explicitly NOT held", c.bad.length === 0, c.bad.join("; "));
  }

  // ══ 2. THE ROW CLASSIFIES HONESTLY — AND THE PAIR PROVES IT ══════════════
  console.log("2. the row the branch builds is loud to an operator and silent to the member");
  {
    // Exactly the row the branch constructs, minus the ids that do not affect
    // classification.
    const built = {
      kind: "UPSERT_ERROR" as const,
      plaidTransactionId: null,
      detail: {
        stage: "event-identity-persist",
        eventWriteStage: "OBSERVATION_WRITE",
        cursorBlocking: false,
        canonicalStatePersisted: false,
      },
    };
    const c = classifySyncIssue(built);

    check("it is a CONDITION, not an event — the gap persists until something fixes it",
      c.nature === "condition", c.nature);
    check("it is NOT customer-actionable: no member action helps and no financial record is missing",
      c.customerActionable === false, String(c.customerActionable));
    check("it does NOT hold the cursor, so a page is never stalled by a derived-layer gap",
      c.cursorBlocking === false, String(c.cursorBlocking));
    check("it is LOUD to an operator (the conservative fallback is the safe direction here)",
      c.severity === "critical" && c.domain === "transactions",
      `${c.domain}/${c.severity}`);

    // ⚠️ THE DENOMINATOR, and the half that makes the claim above mean anything.
    // The SAME row WITH `plaidTransactionId` becomes customer-actionable, so the
    // omission is load-bearing rather than tidy. Without this, "not
    // customer-actionable" could just mean the classifier never says so.
    const named = classifySyncIssue({ ...built, plaidTransactionId: "txn_abc" });
    check("the SAME row WITH plaidTransactionId DOES become customer-actionable — the omission is what buys the silence",
      named.customerActionable === true, String(named.customerActionable));

    // And a row that claimed cursorBlocking would become auto-resolvable, which
    // is the second thing decision 2 is protecting.
    const claiming = classifySyncIssue({ ...built, detail: { ...built.detail, cursorBlocking: true } });
    check("a row that CLAIMED cursorBlocking would be auto-resolvable by the next clean sync — which proves nothing about this event",
      claiming.cursorBlocking === true && c.cursorBlocking === false);
  }

  // ══ 3. IDENTITY IS ITS OWN, AND DOES NOT COLLIDE ═════════════════════════
  console.log("3. the operation key is distinct, and is now REGISTERED");
  {
    const key = resolveOperationKey("event-identity-persist");
    check("the stage resolves to a key, not to null", key !== null, String(key));
    // ⚠️ THIS ASSERTION WAS INVERTED BY DESIGN, AND HAS NOW INVERTED.
    //
    // It shipped asserting the key was UNREGISTERED — true at the time, and
    // deliberately so: OPERATION_PHRASE is `Record<OperationKey, string>` in
    // lib/platform/sync-issue-semantics.ts, so adding the key alone makes that
    // file fail to compile, and it was outside this slice's ownership. The stage
    // therefore shipped namespaced as `unregistered:event-identity-persist` —
    // safe, distinct, honest — with the registration REQUESTED rather than
    // smuggled, and pinned here and in operation-key.test.ts so it could not be
    // forgotten.
    //
    // INTEGRATE-1 landed the registration. Both pins went red, exactly as
    // intended, and both now assert the registered state. That is the mechanism
    // working, not a test being repaired: an assertion that cannot tell you the
    // world changed is not holding anything.
    check("it is REGISTERED — the key is its own name, not namespaced away",
      key === "event-identity-persist", String(key));
    check("…and the unregistered namespace is genuinely vacated, not merely unused",
      key !== `${UNREGISTERED_PREFIX}event-identity-persist`, String(key));
    check("it does NOT collide with the bank-transaction operation that holds the cursor",
      key !== resolveOperationKey("transaction-persist"));
    const phases = ["OBSERVATION_WRITE", "REPLAY_HEAL", "TERMINAL_STATE_CHECK"];
    check(`it does NOT collide with any of the event writer's ${phases.length} internal phases`,
      phases.every((p) => resolveOperationKey(p) !== key),
      phases.map((p) => String(resolveOperationKey(p))).join(","));
    check("…and those three phases would each have produced a DIFFERENT key, which is the split decision 3 prevents",
      new Set(phases.map((p) => resolveOperationKey(p))).size === 3);
  }

  // ══ 4. THE SCANS GO RED ON A REAL VIOLATION ══════════════════════════════
  console.log("4. mutation self-check — each scan rejects the violation it owns");
  {
    const mutations: Array<[string, string, (s: string) => { examined: number; bad: string[] }]> = [
      [
        "the branch names the bank transaction (customer-actionable again)",
        src.replace("              financialAccountId,\n", "              financialAccountId,\n              plaidTransactionId: txn.transaction_id,\n"),
        scanBranchShape,
      ],
      [
        "the catch stops discriminating on the type",
        src.replace("if (isEventWriteIntegrityFailure(e)) {", "if (e) {"),
        scanBranchShape,
      ],
      [
        "the branch rethrows, holding the page over a derived-layer gap",
        src.replace("            return;\n          }\n          console.warn(`[l8] observation skipped",
                    "            throw e;\n          }\n          console.warn(`[l8] observation skipped"),
        scanBranchShape,
      ],
      [
        "e.detail is spread AFTER the stage, so the event writer's phase becomes the identity",
        src.replace(
          '                ...e.detail,\n                eventWriteStage: e.detail.stage,\n                stage: "event-identity-persist",',
          '                eventWriteStage: e.detail.stage,\n                stage: "event-identity-persist",\n                ...e.detail,',
        ),
        scanDetailSpreadPrecedesStage,
      ],
      [
        "the branch claims the cursor is held",
        src.replace("                cursorBlocking: false,", "                cursorBlocking: true,"),
        scanCursorNotHeld,
      ],
    ];
    for (const [label, mutated, scan] of mutations) {
      const onReal = scan(src);
      const onMutant = scan(mutated);
      check(`mutation "${label}": the text really changed`, mutated !== src);
      check(`mutation "${label}": green on the real file (${onReal.examined} examined)`,
        onReal.bad.length === 0 && onReal.examined > 0, JSON.stringify(onReal));
      check(`mutation "${label}": RED on the mutant`, onMutant.bad.length > 0, JSON.stringify(onMutant));
    }
  }

  console.log(failures === 0 ? "\nAll event-identity incident guards passed." : `\n${failures} guard(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
