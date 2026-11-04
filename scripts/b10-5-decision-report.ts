/**
 * scripts/b10-5-decision-report.ts — B10.5 OWNER-DECISION PREP (READ-ONLY)
 *
 * Counts for the four pending B10.5 data-repair decisions
 * (docs/plans/PRE-BETA-READINESS-AND-RELEASE-PLAN-2026-11-01.md § B10.5), as a
 * markdown table for the owner's report. It WRITES NOTHING: there is no apply
 * mode. Each report runs in its own transaction that opens with
 * `SET TRANSACTION READ ONLY` (never a session-level SET through a pooler).
 *
 *   coingecko   FM-AUDIT-025  CoinGecko closes in the archive filed one day late
 *   fin-a2      FIN-A2        Plaid accounts holding a $0 never observed since exchange
 *   fin-e       FIN-E         snapshot days a regeneration would give a restrictedCash
 *   audit-021   FM-AUDIT-021  frozen observed days that rested on a stale bank balance
 *   all         the four, in that order
 *
 * ── Who may run it ───────────────────────────────────────────────────────────
 *   Preview/clone: engineering; Production: owner-run or owner-approved.
 *   Reading Production is still an owner-approved action. The
 *   `--acknowledge-production-read` flag is a safety rail, NOT approval: a
 *   Production run needs the owner's explicit approval for that run.
 *
 * ── Gates (all before the first database contact) ──────────────────────────
 *   · --env=<local|preview|production> is REQUIRED; the connection must prove it
 *     (scripts/lib/repair-env-guard.ts, the same target proof as the repair tools:
 *     loopback for local; a Supabase project that is NOT FM_PRODUCTION_DB_REF for
 *     preview; that ref for production). FM_DB_GUARD=clone-only keeps its meaning.
 *   · --env=production also needs --acknowledge-production-read; the flag
 *     anywhere else is refused, so the environment is never ambiguous.
 *   · The connecting role must bypass RLS (a count under RLS silently misses rows).
 *
 * ── Output contract ──────────────────────────────────────────────────────────
 *   Counts and date ranges only. No ids, amounts, names, emails, institutions,
 *   hosts or URLs. A report whose columns are absent on the target prints
 *   UNAVAILABLE with the reason; nothing is guessed. Heuristics print beside
 *   their numbers. Logic: scripts/lib/b10-5-decision-report.core.ts.
 *
 *   npm run report:b10-5 -- <coingecko|fin-a2|fin-e|audit-021|all> --env=preview [--coingecko-fixed-from=YYYY-MM-DD]
 *
 * Exit: 0 printed · 2 refused (nothing read) · 1 could not run.
 */

import { decideRepairEnvGuard, redactConnectionDetails } from "./lib/repair-env-guard";
import { REPORTS, principalRefusal, renderDocument, runReport, type ReadOnlyClient, type ReportName } from "./lib/b10-5-decision-report.core";

const KNOWN_FLAGS = new Set(["env", "acknowledge-production-read", "coingecko-fixed-from"]);
const PRODUCTION_ACK_FLAG = "--acknowledge-production-read";

function flag(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1);
}

function refuse(reasons: string[], code = 2): never {
  console.error("\n  REFUSED — nothing was read.");
  for (const r of reasons) console.error(`    · ${r}`);
  console.error("");
  process.exit(code);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const unknownFlags = args.filter((a) => a.startsWith("--") && !KNOWN_FLAGS.has(a.replace(/^--/, "").split("=")[0]));
  if (unknownFlags.length) refuse([`unknown argument(s): ${unknownFlags.map((a) => a.split("=")[0]).join(", ")} — refusing rather than guessing.`]);
  if (positional.length !== 1 || !([...REPORTS, "all"] as string[]).includes(positional[0])) {
    refuse([`exactly one report is required: ${[...REPORTS, "all"].join(" | ")}.`]);
  }
  const which = positional[0];
  const reports: ReportName[] = which === "all" ? [...REPORTS] : [which as ReportName];

  const envFlag = flag("env");
  if (envFlag == null || envFlag === "") refuse(["--env=<local|preview|production> is required for every run."]);
  if (envFlag === "production" && !args.includes(PRODUCTION_ACK_FLAG)) {
    refuse([`--env=production requires ${PRODUCTION_ACK_FLAG}. Reading Production is OWNER-APPROVED: the flag is a safety rail, NOT approval — the owner must explicitly approve this run.`]);
  }
  if (envFlag !== "production" && args.includes(PRODUCTION_ACK_FLAG)) {
    refuse([`${PRODUCTION_ACK_FLAG} is only meaningful with --env=production; refusing so the environment is never ambiguous.`]);
  }
  const fixedFrom = flag("coingecko-fixed-from");
  if (fixedFrom !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(fixedFrom) || Number.isNaN(Date.parse(`${fixedFrom}T00:00:00Z`)))) {
    refuse(["--coingecko-fixed-from must be a date, YYYY-MM-DD."]);
  }
  if (fixedFrom !== null && !reports.includes("coingecko")) {
    refuse(["--coingecko-fixed-from applies only to the coingecko report."]);
  }

  const gate = decideRepairEnvGuard({
    apply: false,
    envFlag,
    databaseUrl: process.env.DATABASE_URL,
    directUrl: process.env.DIRECT_URL,
    productionRef: process.env.FM_PRODUCTION_DB_REF,
    vercelEnv: process.env.VERCEL_ENV,
    env: process.env,
  });
  if (!gate.ok) refuse(gate.reasons);

  // Imported only after the gates: constructing the client is the first contact with any database.
  const { db } = await import("@/lib/db");
  const client = db as unknown as ReadOnlyClient;
  try {
    const principal = await principalRefusal(client);
    if (principal) refuse([principal]);
    const outcomes = [];
    for (const r of reports) outcomes.push(await runReport(client, r, { coingeckoFixedFrom: fixedFrom }));
    console.log(`\n${renderDocument(gate.env ?? envFlag!, new Date().toISOString(), outcomes)}`);
  } finally {
    await db.$disconnect();
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(redactConnectionDetails(e instanceof Error ? e.message : String(e), [process.env.FM_PRODUCTION_DB_REF]));
  process.exit(1);
});
