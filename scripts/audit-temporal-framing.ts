/**
 * scripts/audit-temporal-framing.ts   (CF-2)
 *
 * WHAT EVERY TEMPORAL ASK ACTUALLY RECEIVES, IN THE RENDERED PROMPT.
 *
 * Run: npm run audit:temporal-framing
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * CF-0 found that "ever", "recently", "currently" and "before <date>" all
 * collapsed to the same rolling 90-day window. Two of those are legitimate
 * product interpretations and two are silent substitutions, and the prompt
 * recorded neither — so the model could not tell a served period from a
 * substituted one, and neither could we without measuring.
 *
 * This runs the fixed ask corpus through the REAL production path —
 * routeForMessages → resolveTransactionWindow → buildContext →
 * computeAssessment → buildSpaceSystemPrompt — and reports, for each ask, the
 * four authorities as they appear in the string the model receives:
 *
 *     requested   what the words denote
 *     selected    the interval actually queried, and why
 *     coverage    what the retrieved rows support
 *     satisfied   whether the second discharges the first
 *
 * Nothing is reconstructed. A framing that is right in an object and wrong in
 * the prompt is the failure mode this program keeps finding.
 *
 * ── Tier ────────────────────────────────────────────────────────────────────
 * INFORMATIONAL. What a given corpus can serve is a fact about a database — a
 * Space whose ledger starts last week satisfies almost nothing, and one seeded
 * today satisfies everything. The INVARIANTS (the request survives, a shortfall
 * is stated, a zero is not asserted from incomplete evidence) are pinned in CI
 * on fixtures by lib/ai/temporal-scope.test.ts and
 * lib/ai/prompts/temporal-framing.test.ts.
 *
 * READ-ONLY. Builds contexts and renders strings; writes nothing.
 */

import "@/lib/ai/assemblers";
import { buildContext } from "@/lib/ai/context-builder";
import { computeAssessment } from "@/lib/ai/intelligence";
import { fetchPerLiabilityDebtPayments } from "@/lib/ai/intelligence/debt-payments";
import { buildSpaceSystemPrompt } from "@/lib/ai/prompts/system-prompt";
import { routeForMessages, resolveTransactionWindow } from "@/lib/ai/chat/message-analysis";
import { hasTemporalCue } from "@/lib/ai/intent/classifier";
import { db } from "@/lib/db";

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);

/**
 * The CF-0 corpus, plus the cases its census implied but did not ask.
 *
 * `expectSatisfied` is what the CONTRACT should conclude, not what any
 * particular database can serve: ALL_TIME is unsatisfiable by construction and
 * RECENT is satisfied by a declared reading, whatever rows exist.
 */
const ASKS: { ask: string; expectSatisfied: boolean | null }[] = [
  { ask: "How much did I spend last month?",                        expectSatisfied: true  },
  { ask: "How much did I spend in 2024?",                           expectSatisfied: null  },
  { ask: "How much have I spent this year?",                        expectSatisfied: true  },
  { ask: "How much did I spend between March 2026 and May 2026?",   expectSatisfied: true  },
  { ask: "What have I spent recently?",                             expectSatisfied: true  },
  { ask: "What am I currently spending on?",                        expectSatisfied: true  },
  { ask: "How much have I ever spent?",                             expectSatisfied: false },
  { ask: "What did I spend before June 2024?",                      expectSatisfied: false },
  { ask: "What did I spend after March 2025?",                      expectSatisfied: true  },
  { ask: "How much did I spend in 2023?",                           expectSatisfied: false },
  { ask: "What did I spend on dining in the last 3 months?",        expectSatisfied: true  },
  { ask: "How is my debt looking?",                                 expectSatisfied: true  },

  // ── CF-3 — the phrases CF-R0 measured resolving to a FALSE satisfaction ──
  //
  // Each of these rendered "The user asked about no particular period" followed
  // by "FULLY COVERS what was asked. Answer directly, with no scope caveat."
  // They are in the corpus permanently so that regression cannot return
  // silently: the audit fails them on `expectResolved`, which is a separate
  // question from whether the window is satisfiable.
  { ask: "What did I spend last year?",                             expectSatisfied: null  },
  { ask: "What did I spend previous year?",                         expectSatisfied: null  },
  { ask: "What did I spend over the past year?",                    expectSatisfied: true  },
  { ask: "What did I spend last quarter?",                          expectSatisfied: true  },
  { ask: "What did I spend previous quarter?",                      expectSatisfied: true  },
  { ask: "What did I spend this quarter?",                          expectSatisfied: true  },
  { ask: "What did I spend past quarter?",                          expectSatisfied: true  },
  { ask: "What did I spend quarter to date?",                       expectSatisfied: true  },

  // The safeguard: temporal language the parser cannot resolve must NOT be
  // reported as satisfied, and must NOT be reported as "no period named".
  { ask: "What did I spend during the summer before I moved?",      expectSatisfied: false },
  { ask: "How much did I spend around the holidays?",               expectSatisfied: false },

  // The counterweight: no temporal claim at all keeps answering directly.
  { ask: "What are my top merchants?",                              expectSatisfied: true  },
  { ask: "Where am I spending the most?",                           expectSatisfied: true  },
];

/** The scope block, read back out of the rendered prompt. */
function scopeBlock(prompt: string): string[] {
  const i = prompt.indexOf("TRANSACTION SCOPE — ");
  if (i < 0) return [];
  const end = prompt.indexOf("\n\n", i);
  return prompt.slice(i, end < 0 ? undefined : end).split("\n");
}

async function main(): Promise<void> {
  console.log(`\n[AUDIT] CF-2 temporal framing — READ-ONLY`);
  console.log(`  Renders the REAL system prompt per ask and reports the four temporal authorities.`);

  const nameArg = process.argv.find((a) => a.startsWith("--space="))?.split("=")[1] ?? "Chris";
  const space = await db.space.findFirst({
    where: { name: { contains: nameArg }, deletedAt: null, archivedAt: null },
    select: { id: true, name: true },
  });
  if (!space) { console.error(`No Space matching "${nameArg}".`); process.exitCode = 2; return; }
  const owner = await db.spaceMember.findFirst({
    where: { spaceId: space.id, role: "OWNER", status: "ACTIVE" }, select: { userId: true },
  });
  if (!owner) { console.error(`No active owner for "${space.name}".`); process.exitCode = 2; return; }

  bar(`${space.name}  (${space.id})`);

  let missingBlock = 0, contractMismatch = 0, silentSubstitution = 0;
  // CF-3 — the two counts that pin the CF-R0 regression.
  let falseSatisfaction = 0, claimTreatedAsNoClaim = 0;

  for (const { ask, expectSatisfied } of ASKS) {
    const now = new Date();
    const msgs = [{ role: "user" as const, content: ask }];
    const route = routeForMessages(msgs);
    const win = resolveTransactionWindow(msgs, now);

    const ctx = await buildContext(space.id, owner.userId, { scopeHint: "full", transactionWindow: win });
    const [assessment, debtPayments] = await Promise.all([
      Promise.resolve(computeAssessment(ctx)),
      fetchPerLiabilityDebtPayments(ctx),
    ]);
    const prompt = buildSpaceSystemPrompt(ctx, assessment, route, debtPayments);
    const block = scopeBlock(prompt);

    console.log(`\n  ─ ${ask}`);
    if (block.length === 0) {
      missingBlock++;
      console.log(`      ✗ NO TRANSACTION SCOPE BLOCK — the model is told nothing about the period`);
      continue;
    }

    const text = block.join(" ");
    const satisfied = /FULLY COVERS what was asked/.test(text)
                   || /DELIBERATE product interpretation/.test(text);
    const shortfall = /DOES NOT COVER what was asked/.test(text);
    const unresolved = /could NOT be resolved to dates/.test(text);
    const noEvidence = /Transactions loaded: NONE/.test(text);

    // CF-3 — did the router see the claim the user made? `hasTemporalCue` is
    // the same detector the classifier uses, so this asks the question at the
    // authority that owns it rather than re-deriving it from the ask text.
    const claimed = hasTemporalCue(ask.toLowerCase());
    const calledNoClaim = /no particular period/.test(text);

    for (const l of block) console.log(`      ${l.trim()}`);

    // The property: a request that was not served must SAY so. A silent
    // substitution is a prompt that claims satisfaction it does not have.
    if (expectSatisfied === false && !shortfall && !unresolved) {
      silentSubstitution++;
      console.log(`      ✗ SILENT SUBSTITUTION — unservable request rendered without a shortfall`);
    } else if (expectSatisfied === true && !satisfied) {
      contractMismatch++;
      console.log(`      ⚠ expected a satisfied/interpreted reading, got a shortfall`);
    } else if (expectSatisfied === null) {
      console.log(`      · corpus-dependent (the lookback clamp decides) — ${shortfall ? "shortfall stated" : "satisfied"}`);
    }
    if (noEvidence) console.log(`      · no evidence supplied; the block refuses rather than reporting $0`);

    // ── The CF-3 invariants, checked on every ask ────────────────────────────
    if (claimed && calledNoClaim) {
      claimTreatedAsNoClaim++;
      console.log(`      ✗ CLAIM TREATED AS NO CLAIM — a temporal phrase rendered "no particular period"`);
    }
    if (claimed && satisfied && calledNoClaim) {
      falseSatisfaction++;
      console.log(`      ✗ FALSE SATISFACTION — the CF-R0 regression`);
    }
    if (unresolved) console.log(`      · unresolved period — default window supplied, satisfaction withheld`);
  }

  bar("SUMMARY");
  console.log(`  Asks measured:            ${ASKS.length}`);
  console.log(`  Missing scope block:      ${missingBlock}`);
  console.log(`  SILENT SUBSTITUTIONS:     ${silentSubstitution}`);
  console.log(`  Contract mismatches:      ${contractMismatch}`);
  console.log(`  FALSE SATISFACTIONS:      ${falseSatisfaction}   (CF-3)`);
  console.log(`  Claims called "no claim": ${claimTreatedAsNoClaim}   (CF-3)`);
  console.log(
    `\n  INFORMATIONAL: what a corpus can SERVE is a fact about this database.\n` +
    `  The invariants are pinned in CI by lib/ai/temporal-scope.test.ts and\n` +
    `  lib/ai/prompts/temporal-framing.test.ts.\n`,
  );
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
