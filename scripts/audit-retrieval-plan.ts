/**
 * scripts/audit-retrieval-plan.ts   (CF-8)
 *
 * WHAT THE PLAN WOULD ASK FOR, AGAINST WHAT PRODUCTION ACTUALLY LOADS.
 *
 * Run: npm run audit:retrieval-plan
 *
 * SHADOW ONLY. This computes a plan, assembles the context exactly as
 * production does, and reports the DIFFERENCE. It changes no retrieval, no
 * prompt and no output — the difference is the entire deliverable.
 *
 * ── The four metrics that matter ────────────────────────────────────────────
 *   FALSE_NARROW        the plan omits evidence the question needs.
 *                       The only disqualifying error: a plan that saves tokens
 *                       and cannot answer is worse than today's broad prompt.
 *   FALSE_WIDEN         the plan asks for evidence the question does not need.
 *                       Tolerable in shadow; it costs tokens, not correctness.
 *   MISSING_AVAILABLE   the evidence exists and the plan did not ask for it.
 *   REQUIRED_UNAVAILABLE the plan correctly asked for something this Space
 *                       cannot supply.
 *
 * ── Tier ────────────────────────────────────────────────────────────────────
 * INFORMATIONAL. It reports a corpus — how much unnecessary context production
 * loads TODAY on THIS database — which is a measurement, not an invariant. The
 * plan's semantics are pinned in CI by lib/ai/retrieval-plan.test.ts.
 *
 * READ-ONLY: builds contexts, renders strings, writes nothing.
 */

import "@/lib/ai/assemblers";
import { getAssembler } from "@/lib/ai/assembler-registry";
import { buildContext } from "@/lib/ai/context-builder";
import { computeAssessment } from "@/lib/ai/intelligence";
import { fetchPerLiabilityDebtPayments } from "@/lib/ai/intelligence/debt-payments";
import { buildSpaceSystemPrompt } from "@/lib/ai/prompts/system-prompt";
import { loadCoverageEnvelope } from "@/lib/ai/coverage-envelope";
import {
  resolveTransactionWindow, routeForMessages,
} from "@/lib/ai/chat/message-analysis";
import {
  planRetrieval, NeedLevel, EvidenceDepth, type RetrievalPlan,
} from "@/lib/ai/retrieval-plan";
import { FinanceDomains, type ContextDomain } from "@/lib/ai/types";
import type { SpaceContext } from "@/lib/space";
import { db } from "@/lib/db";

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
const tok = (s: string) => Math.ceil(s.length / 4);

/** The corpus. Multi-turn entries exercise CF-4 inheritance. */
const SCENARIOS: { id: string; turns: string[] }[] = [
  { id: "A  spend in 2025",            turns: ["What did I spend in 2025?"] },
  { id: "B  biggest purchase (bare)",  turns: ["What was my most expensive purchase?"] },
  { id: "C  2025 → biggest purchase",  turns: ["What did I spend in 2025?", "What was my most expensive purchase?"] },
  { id: "D  top merchant",             turns: ["Who did I spend the most with?"] },
  { id: "E  investments (broad)",      turns: ["What are my investments?"] },
  { id: "F  stocks",                   turns: ["What stocks do I own?"] },
  { id: "G  crypto",                   turns: ["What crypto do I own?"] },
  { id: "H  traditional vs crypto",    turns: ["Traditional vs crypto?"] },
  { id: "I  overview",                 turns: ["How am I doing financially?"] },
  { id: "J  where is money going",     turns: ["Where is my money going?"] },
  { id: "K  how far back",             turns: ["How far back can you see my transactions?"] },
  { id: "L  anything from 2025",       turns: ["Do you have anything from 2025?"] },
  { id: "M  unresolved period",        turns: ["What did I spend during the summer before I moved?"] },
  { id: "N  conversation chain",       turns: [
      "What did I spend in 2025?", "What was my biggest purchase?",
      "Who was the merchant?", "What about 2024?", "And my biggest purchase?",
    ] },
];

const ALL: ContextDomain[] = [
  FinanceDomains.ACCOUNTS,
  FinanceDomains.TRANSACTIONS_SUMMARY,
  FinanceDomains.SNAPSHOT_HISTORY,
  FinanceDomains.HOLDINGS_SUMMARY,
];

interface Row {
  id: string; question: string;
  plan: RetrievalPlan;
  actual: ContextDomain[];
  promptTokens: number;
  domainTokens: Record<string, number>;
  plannedTokens: number;
  falseNarrow: ContextDomain[];
  falseWiden: ContextDomain[];
  missingAvailable: ContextDomain[];
  requiredUnavailable: ContextDomain[];
}

async function main(): Promise<void> {
  console.log(`\n[AUDIT] CF-8 retrieval plan — SHADOW, READ-ONLY`);
  console.log(`  Plans each question, assembles as production does, reports the difference.`);

  const name = process.argv.find((a) => a.startsWith("--space="))?.split("=")[1] ?? "Chris";
  const space = await db.space.findFirst({
    where: { name: { contains: name }, deletedAt: null, archivedAt: null },
    select: { id: true, name: true, type: true, category: true, isPublic: true, reportingCurrency: true },
  });
  if (!space) { console.error(`No Space matching "${name}".`); process.exitCode = 2; return; }
  const owner = await db.spaceMember.findFirst({
    where: { spaceId: space.id, role: "OWNER", status: "ACTIVE" }, select: { userId: true },
  });
  if (!owner) { console.error(`No active owner.`); process.exitCode = 2; return; }

  const envelope = await loadCoverageEnvelope(space.id);

  // ── Per-domain assembly cost, measured once ──────────────────────────────
  bar(`ASSEMBLY COST — ${space.name}`);
  const spaceCtx = {
    userId: owner.userId, spaceId: space.id, role: "OWNER",
    permissions: { canInvite: true, canManage: true, canWrite: true, canRead: true, isOwner: true },
    space: {
      id: space.id, name: space.name, type: space.type,
      category: space.category, isPublic: space.isPublic,
      reportingCurrency: space.reportingCurrency,
    },
  } as unknown as SpaceContext;

  const cost: Record<string, { ms: number; jsonTokens: number }> = {};
  for (const d of ALL) {
    const fn = getAssembler(d);
    if (!fn) { cost[d] = { ms: 0, jsonTokens: 0 }; continue; }
    const t0 = Date.now();
    const sec = await fn(spaceCtx, { scopeHint: "full" });
    cost[d] = { ms: Date.now() - t0, jsonTokens: sec ? tok(JSON.stringify(sec.data)) : 0 };
    console.log(`  ${d.padEnd(22)} ${String(cost[d].ms).padStart(5)} ms   ${String(cost[d].jsonTokens).padStart(6)} JSON tok${sec ? "" : "   (null)"}`);
  }

  // ── Scenarios ────────────────────────────────────────────────────────────
  const rows: Row[] = [];

  for (const s of SCENARIOS) {
    const messages: { role: "user" | "assistant"; content: string }[] = [];
    let last: Row | null = null;

    for (let i = 0; i < s.turns.length; i++) {
      messages.push({ role: "user", content: s.turns[i] });
      const now = new Date();

      // THE PLAN — computed before any assembler runs.
      const plan = planRetrieval({ messages, envelope, now });

      // PRODUCTION — exactly the route's path.
      const ctx = await buildContext(space.id, owner.userId, {
        scopeHint: "full",
        transactionWindow: resolveTransactionWindow(messages, now),
        evidence: envelope,
        question: s.turns[i],
      });
      const [assessment, debtPayments] = await Promise.all([
        Promise.resolve(computeAssessment(ctx)),
        fetchPerLiabilityDebtPayments(ctx),
      ]);
      const prompt = buildSpaceSystemPrompt(
        ctx, assessment, routeForMessages(messages), debtPayments, envelope, s.turns[i]);

      const actual = Object.keys(ctx.domains) as ContextDomain[];
      const need = (d: ContextDomain) => plan.domains.find((x) => x.domain === d)?.need;
      const required   = plan.domains.filter((x) => x.need === NeedLevel.REQUIRED).map((x) => x.domain);
      const supporting = plan.domains.filter((x) => x.need === NeedLevel.SUPPORTING).map((x) => x.domain);

      // Per-domain prompt contribution: the JSON dump is the measurable part.
      const domainTokens: Record<string, number> = {};
      for (const d of actual) domainTokens[d] = cost[d]?.jsonTokens ?? 0;

      // What the prompt would cost if only planned domains were serialized.
      // The doctrine, assessment, envelope and prose blocks are unchanged, so
      // this subtracts only the JSON of domains the plan does not want.
      const droppable = actual
        .filter((d) => need(d) === NeedLevel.NOT_NEEDED)
        .reduce((n, d) => n + (domainTokens[d] ?? 0), 0);

      const row: Row = {
        id: s.turns.length > 1 ? `${s.id} · T${i + 1}` : s.id,
        question: s.turns[i], plan, actual,
        promptTokens: tok(prompt), domainTokens,
        plannedTokens: tok(prompt) - droppable,
        // FALSE NARROW: production loaded it, the plan says NOT_NEEDED — and the
        // answer genuinely depended on it. Cannot be decided mechanically, so
        // the audit reports the CANDIDATES and the corpus test judges them.
        falseNarrow: [],
        falseWiden: actual.filter((d) => need(d) === NeedLevel.NOT_NEEDED),
        missingAvailable: [...required, ...supporting].filter((d) => !actual.includes(d)),
        requiredUnavailable: plan.unsatisfiable,
      };
      rows.push(row);
      last = row;
      messages.push({ role: "assistant", content: "(elided)" });
    }
    void last;
  }

  // ── Report ───────────────────────────────────────────────────────────────
  bar("SCENARIO RESULTS");
  for (const r of rows) {
    const p = r.plan;
    console.log(`\n  ${r.id}`);
    console.log(`     "${r.question}"`);
    console.log(`     PLANNED  concepts=${p.concepts.join("+")} breadth=${p.investmentBreadth} depth=${p.depth}`);
    console.log(`              scope=${p.temporal.provenance} ${p.temporal.startDate ?? "(default)"}..${p.temporal.endDate ?? ""}`);
    console.log(`              required=${p.domains.filter((d) => d.need === NeedLevel.REQUIRED).map((d) => d.domain).join(",") || "(none)"}`);
    console.log(`              supporting=${p.domains.filter((d) => d.need === NeedLevel.SUPPORTING).map((d) => d.domain).join(",") || "(none)"}`);
    console.log(`     ACTUAL   ${r.actual.join(", ")}   ${r.promptTokens.toLocaleString()} tok`);
    if (r.falseWiden.length) {
      const saved = r.falseWiden.reduce((n, d) => n + (r.domainTokens[d] ?? 0), 0);
      console.log(`     UNNEEDED ${r.falseWiden.join(", ")}  (${saved.toLocaleString()} JSON tok, would be ${r.plannedTokens.toLocaleString()})`);
    }
    if (r.missingAvailable.length)    console.log(`     ✗ MISSING  ${r.missingAvailable.join(", ")}`);
    if (r.requiredUnavailable.length) console.log(`     · UNAVAIL  ${r.requiredUnavailable.join(", ")} (correctly requested, not held)`);
  }

  // ── Unconditional-domain cost by scenario ────────────────────────────────
  bar("WHAT EACH QUESTION PAYS FOR TODAY");
  console.log(`  ${"scenario".padEnd(30)} ${"prompt".padStart(7)} ${"acct".padStart(6)} ${"txn".padStart(6)} ${"snap".padStart(6)} ${"hold".padStart(6)}  unneeded JSON`);
  for (const r of rows) {
    const need = (d: ContextDomain) => r.plan.domains.find((x) => x.domain === d)?.need;
    const cell = (d: ContextDomain) => {
      if (!r.actual.includes(d)) return "—";
      const t = r.domainTokens[d] ?? 0;
      return `${need(d) === NeedLevel.NOT_NEEDED ? "!" : " "}${t}`;
    };
    const unneeded = r.falseWiden.reduce((n, d) => n + (r.domainTokens[d] ?? 0), 0);
    console.log(
      `  ${r.id.padEnd(30)} ${r.promptTokens.toLocaleString().padStart(7)} ` +
      `${cell(FinanceDomains.ACCOUNTS).padStart(6)} ${cell(FinanceDomains.TRANSACTIONS_SUMMARY).padStart(6)} ` +
      `${cell(FinanceDomains.SNAPSHOT_HISTORY).padStart(6)} ${cell(FinanceDomains.HOLDINGS_SUMMARY).padStart(6)}  ` +
      `${unneeded ? `${unneeded.toLocaleString()} (−${((unneeded / r.promptTokens) * 100).toFixed(1)}%)` : "0"}`,
    );
  }
  console.log(`\n  "!" marks a domain the plan says this question does not need.`);

  // ── Assessment dependency ────────────────────────────────────────────────
  bar("ASSESSMENT COMPUTE vs MODEL CONTEXT");
  for (const d of ALL) {
    const anyPlan = rows[0].plan.domains.find((x) => x.domain === d);
    const neededByQuestions = rows.filter((r) =>
      r.plan.domains.find((x) => x.domain === d)?.need !== NeedLevel.NOT_NEEDED).length;
    console.log(
      `  ${d.padEnd(22)} assessment-compute=${anyPlan?.assessmentNeedsIt ? "YES" : "no "}   ` +
      `model-context needed by ${neededByQuestions}/${rows.length} questions   ` +
      `${cost[d].jsonTokens} JSON tok`,
    );
  }
  console.log(
    `\n  ⚠ A domain marked assessment-compute=YES must still be ASSEMBLED even when no\n` +
    `    question needs it. Only its raw JSON is a candidate for omission.`,
  );

  // ── Metrics ──────────────────────────────────────────────────────────────
  bar("SUMMARY");
  const totalWiden   = rows.filter((r) => r.falseWiden.length > 0).length;
  const totalMissing = rows.filter((r) => r.missingAvailable.length > 0).length;
  const totalUnavail = rows.filter((r) => r.requiredUnavailable.length > 0).length;
  const wastedTok    = rows.reduce((n, r) =>
    n + r.falseWiden.reduce((m, d) => m + (r.domainTokens[d] ?? 0), 0), 0);
  const envelopeOnly = rows.filter((r) => r.plan.depth === EvidenceDepth.ENVELOPE);

  console.log(`  turns planned:            ${rows.length}`);
  console.log(`  FALSE_WIDEN turns:        ${totalWiden}  (production loaded a domain the plan does not need)`);
  console.log(`  MISSING_AVAILABLE turns:  ${totalMissing}  (plan wanted something production did not load)`);
  console.log(`  REQUIRED_UNAVAILABLE:     ${totalUnavail}  (correctly requested, Space cannot supply)`);
  console.log(`  ENVELOPE-depth turns:     ${envelopeOnly.length}  ${envelopeOnly.map((r) => r.id.split(" ")[0]).join(",")}`);
  console.log(`  unnecessary JSON, total:  ${wastedTok.toLocaleString()} tok across ${rows.length} turns`);
  console.log(`  mean prompt:              ${Math.round(rows.reduce((n, r) => n + r.promptTokens, 0) / rows.length).toLocaleString()} tok`);
  console.log(`  mean if plan enforced:    ${Math.round(rows.reduce((n, r) => n + r.plannedTokens, 0) / rows.length).toLocaleString()} tok`);
  console.log(
    `\n  FALSE_NARROW is NOT decided here — it needs a judgement about whether an\n` +
    `  answer depended on a domain. lib/ai/retrieval-plan.test.ts asserts the\n` +
    `  required set per question shape; this reports the corpus.\n`,
  );
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
