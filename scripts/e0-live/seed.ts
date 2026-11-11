/**
 * scripts/e0-live/seed.ts — seeds the E0-LIVE fixture on PREVIEW (design §3; S2 rulings 09ec).
 * DRAFT for S2 line review (L2). Nothing here has been run against any database.
 *
 * Modes:
 *   --plan      OFFLINE: builds the plan in memory (deterministic ids) and prints counts, the
 *               plan refusals (must be none) and the expected-fact counts. No guard, no env
 *               file, no Prisma client, no connection.
 *   (default)   DRY RUN: guards → ONE transaction that performs every write and the self-check,
 *               prints counts, then ROLLS BACK. Nothing persists. No manifest.
 *   --apply     the same transaction, COMMITTED only when the self-check passes; then
 *               manifest-<tag>.json (ids + drift hashes; opened `wx`, 0600 in 0700).
 *
 * Run from a CLEAN worktree at the Preview deployment SHA:
 *   FM_E0_LIVE_ENV_FILE=<0600 Preview env file> FM_PREVIEW_DB_REF=<ref> FM_PRODUCTION_DB_REF=<ref> \
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/e0-live/seed.ts \
 *     --expect-sha=<Preview deployment githubCommitSha> [--apply]
 *
 * Refuses (exit 2, nothing written) when: the guard fails (fixture-common.decideE0LiveGuard:
 * Preview ref required, Production ref refused, no exported DB URL, VERCEL_ENV=production,
 * env file 0600, session port); HEAD ≠ --expect-sha or the worktree is dirty; the target's
 * newest applied migration ≠ the worktree's; any row already carries an e0-live tag of TODAY;
 * the plan holds an ACTIVE PlaidItem / WALLET Connection or any other planRefusals() hit;
 * it is past 20:00Z (the run-day hard stop, design §5.5).
 *
 * SELF-CHECK (design §3.5, under R-3): inside the transaction, EXISTING token-free readers run
 * over the transaction client — loadFunnelFacts, loadImportsForItemIds, listRecentlyJoined,
 * customerConnections, findCustomerByEmail — and the attention facts are folded by the app's
 * own foldAttention (facts assembled with loadAttention's own predicates; the CS-token
 * incident read is NOT made). Facts that need an audience token (incident tiers, the `incident`
 * reason, getCustomerDetail, subject exclusion via the tool route) are LISTED as live-only
 * (fixture-spec LIVE_ONLY_FACTS) and checked by the live run as the synthetic operator.
 * A failing fact rolls the transaction back and prints the fact ids (codes only).
 *
 * Never: an ACTIVE PlaidItem / WALLET Connection; a decryptable token or credential; a
 * notification / e-mail / product-event module; a SyncIssueEvent write; an AiInvocation row;
 * a session-level SET. Logs and stdout carry counts and codes only.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import { MANIFEST_TABLES, dayPrefix, migrationBasisRefusal, nonceFromBytes, parseTag, utcDay, type E0LiveManifest } from "./fixture-common";
import { buildFixturePlan, failingFacts, manifestFromPlan, planCounts, planRefusals, safetyReport, safetyReportLines, type FixturePlan, type ObservedFacts } from "./fixture-spec";
import {
  assertRepoBasis, die, ensurePrivateDir, loadPrisma, localNewestMigration, logLine, printCounts, privateFixtureDir, runGuards, stamp, writePrivateNew,
} from "./fixture-io";

const FLAGS = new Set(["--plan", "--apply"]);
const argv = process.argv.slice(2);
for (const a of argv) if (!FLAGS.has(a) && !a.startsWith("--expect-sha=")) die(`unknown argument ${a.split("=")[0]}`);
if (argv.includes("--plan") && argv.includes("--apply")) die("--plan and --apply are exclusive");
const MODE: "plan" | "dry-run" | "apply" = argv.includes("--plan") ? "plan" : argv.includes("--apply") ? "apply" : "dry-run";
const expectSha = argv.find((a) => a.startsWith("--expect-sha="))?.slice("--expect-sha=".length) ?? null;

/** The run-day hard stop (design §5.5): no fixture is seeded at or after 20:00Z. */
const HARD_STOP_HOUR_UTC = 20;

function deterministicIds(): () => string {
  let n = 0;
  return () => `cplan${String(++n).padStart(19, "0")}`;
}

async function main(): Promise<void> {
  // ── --plan: offline ──
  if (MODE === "plan") {
    const plan = buildFixturePlan({
      now: new Date(), nonce: "00000000", newId: deterministicIds(), passwordHash: "<unusable bcrypt hash>",
      defaultPolicyGroup: "<catalogue default>", sessionTokenHex: (n) => String(n).padStart(32, "0"),
    });
    printCounts("PLAN (offline; nothing contacted). Rows by table:", planCounts(plan));
    const refusals = planRefusals(plan);
    console.log(refusals.length ? `PLAN REFUSALS:\n  - ${refusals.join("\n  - ")}` : "plan refusals: none");
    const safety = safetyReport(plan, new Date());
    for (const line of safetyReportLines(safety)) console.log(line);
    console.log(`live-only facts: ${plan.liveOnly.map((f) => f.id).join(", ")}`);
    process.exit(refusals.length || safety.refusals.length ? 2 : 0);
  }

  // ── Guards FIRST (nothing that can reach a database is loaded before this) ──
  const guard = runGuards();
  const { sha } = assertRepoBasis(expectSha);
  const now = new Date();
  if (now.getUTCHours() >= HARD_STOP_HOUR_UTC) die(`it is past ${HARD_STOP_HOUR_UTC}:00Z — the run-day hard stop; seed on a new UTC day.`);
  const nonce = nonceFromBytes(randomBytes(4));
  const day = utcDay(now);
  const dir = privateFixtureDir(day);
  ensurePrivateDir(dir);
  const LOG = path.join(dir, `seed-${MODE}-${stamp()}.log`);
  logLine(LOG, `mode=${MODE} repoSha=${sha}`);

  // ── Repo modules (AFTER the guard) ──
  const bcrypt = (await import("bcryptjs")).default;
  const { AuditAction } = await import("@/lib/audit-actions");
  const { loadPolicyGroupCatalogue } = await import("@/lib/platform/policies/policy-group-catalogue");
  const { OPEN_CUSTOMER_WHERE, RESERVED_TEST_EMAIL_WHERE } = await import("@/lib/platform/customer/population");
  const { loadFunnelFacts } = await import("@/lib/platform/growth/product-analytics");
  const { loadImportsForItemIds } = await import("@/lib/platform/onboarding/import-facts");
  const { listRecentlyJoined } = await import("@/lib/platform/customer/recently-joined");
  const { foldAttention, linkExitFactOf, linkFailureFactOf, IMPORT_ATTENTION_DAYS, LINK_EXIT_WINDOW_DAYS } = await import("@/lib/platform/customer/attention-core");
  const { customerConnections } = await import("@/lib/platform/intelligence/ai/tools/packs/connections.server");
  const { findCustomerByEmail } = await import("@/lib/platform/intelligence/ai/tools/packs/customers.server");
  const { readDriftHashes } = await import("./fixture-db");

  const unusable = await bcrypt.hash(randomBytes(32).toString("hex"), 12); // nobody keeps the input
  const defaultPolicyGroup = (await loadPolicyGroupCatalogue()).defaultKey;
  const plan: FixturePlan = buildFixturePlan({
    now, nonce, newId: () => `c${randomBytes(12).toString("hex").slice(0, 24)}`, passwordHash: unusable, defaultPolicyGroup,
    sessionTokenHex: () => randomBytes(16).toString("hex"),
  });
  const refusals = planRefusals(plan);
  if (refusals.length) die(`plan refused: ${refusals.join(" · ")}`);
  if (parseTag(plan.tag)?.day !== day) die("the plan's tag day is not today (UTC).");
  // S2 09eo — the safety report, printed and enforced BEFORE the transaction (dry run and apply alike).
  const safety = safetyReport(plan, new Date());
  for (const line of safetyReportLines(safety)) console.log(line);
  if (safety.refusals.length) die(`safety report refused: ${safety.refusals.join(" · ")}`);
  logLine(LOG, `safety report: refusals=0 markerRows=${safety.auditLogs.markerRows}`);

  class DryRunRollback extends Error { constructor() { super("dry-run rollback"); } }
  class SelfCheckFailed extends Error { constructor(readonly facts: string[]) { super("self-check failed"); } }

  const prisma = await loadPrisma(guard.directUrl);
  let manifest: E0LiveManifest | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '60s'`);
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '10s'`);
      await tx.$executeRawUnsafe(`SET LOCAL idle_in_transaction_session_timeout = '60s'`);

      // Migration basis: the target's newest applied migration = the worktree's newest.
      const led = await tx.$queryRawUnsafe<Array<{ m: string }>>(
        `SELECT migration_name AS m FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1`,
      );
      const mig = migrationBasisRefusal(localNewestMigration(), led[0]?.m ?? null);
      if (mig) throw new Error(mig);

      // Refuse to stack: any e0-live row of TODAY (any nonce) already present.
      const p = dayPrefix(day);
      const today = (await tx.user.count({ where: { username: { startsWith: p } } }))
        + (await tx.plaidItem.count({ where: { externalItemId: { startsWith: p } } }))
        + (await tx.connection.count({ where: { externalConnectionId: { startsWith: p } } }))
        + (await tx.betaAccessRequest.count({ where: { email: { contains: `@${p}` } } }));
      if (today > 0) throw new Error("rows carrying today's e0-live tag already exist — tear them down first");

      // ── Writes (children after parents) ──
      await tx.user.createMany({ data: plan.users });
      await tx.customerPolicyAssignment.createMany({ data: plan.policies });
      await tx.userSession.createMany({ data: plan.sessions });
      await tx.plaidItem.createMany({ data: plan.plaidItems });
      await tx.connection.createMany({ data: plan.connections });
      await tx.financialAccount.createMany({ data: plan.financialAccounts });
      await tx.accountConnection.createMany({ data: plan.accountConnections });
      await tx.syncIssue.createMany({ data: plan.syncIssues });
      await tx.betaAccessRequest.createMany({ data: plan.betaRequests });
      await tx.auditLog.createMany({
        data: plan.auditLogs.map((a) => ({
          id: a.id, userId: a.userId, createdAt: a.createdAt, metadata: a.metadata,
          action: a.action === "CONNECTION_LINK_EXITED" ? AuditAction.CONNECTION_LINK_EXITED : AuditAction.CONNECTION_ADD_FAILED,
        })),
      });

      // ── Self-check: existing token-free readers over THIS transaction ──
      const client = tx as never;
      const DAY = 86_400_000;
      const exitFrom = new Date(now.getTime() - LINK_EXIT_WINDOW_DAYS * DAY);
      const [customers, funnel, plaidBroken, connBroken, exits, failures, testAccounts] = await Promise.all([
        tx.user.findMany({ where: OPEN_CUSTOMER_WHERE, select: { id: true } }),
        loadFunnelFacts(client),
        tx.plaidItem.findMany({ where: { status: { in: ["NEEDS_REAUTH", "ERROR"] } }, select: { userId: true } }),
        tx.connection.findMany({ where: { status: { in: ["NEEDS_REAUTH", "ERROR"] }, provider: { notIn: ["PLAID", "MANUAL", "CSV"] } }, select: { userId: true } }),
        tx.auditLog.findMany({ where: { action: AuditAction.CONNECTION_LINK_EXITED, createdAt: { gte: exitFrom } }, select: { userId: true, createdAt: true, metadata: true } }),
        tx.auditLog.findMany({ where: { action: AuditAction.CONNECTION_ADD_FAILED, createdAt: { gte: exitFrom } }, select: { userId: true, createdAt: true, metadata: true } }),
        tx.user.findMany({ where: { AND: [OPEN_CUSTOMER_WHERE, RESERVED_TEST_EMAIL_WHERE] }, select: { id: true } }),
      ]);
      const importFrom = now.getTime() - IMPORT_ATTENTION_DAYS * DAY;
      const recentItemIds = funnel.plaidItems.filter((i) => new Date(i.createdAt).getTime() >= importFrom && i.status !== "REVOKED").map((i) => i.id);
      const recent = await loadImportsForItemIds(recentItemIds, now, client);
      const fold = foldAttention({
        activeCustomerIds: new Set(customers.map((c) => c.id)),
        funnel,
        reconnectOwners: [...plaidBroken.map((r) => r.userId), ...connBroken.map((r) => r.userId)],
        incidentOwners: [], // LIVE-ONLY (CS audience token — R-3)
        policyIssueOwners: [],
        recentImports: recent.items.flatMap((i) => (i.userId ? [{ userId: i.userId, verdict: i.verdict }] : [])),
        linkExits: exits.flatMap((r) => { const f = linkExitFactOf(r); return f ? [f] : []; }),
        linkFailures: failures.flatMap((r) => { const f = linkFailureFactOf(r); return f ? [f] : []; }),
        testAccountIds: testAccounts.map((u) => u.id),
        floor: false,
      }, now);

      const fixtureItemIds = Object.values(plan.itemIds);
      const allImports = await loadImportsForItemIds(fixtureItemIds, now, client);
      const recentlyJoined: Record<number, Set<string>> = {};
      for (const days of [7, 14, 30, 90]) {
        const rj = await listRecentlyJoined({ days, now }, client);
        recentlyJoined[days] = new Set(rj.rows.map((r) => r.id));
      }
      const connections = new Map<string, Array<{ source: string; healthState: string; chains: readonly string[] }>>();
      const subjectMatched = new Map<string, boolean>();
      for (const [key, userId] of Object.entries(plan.customerIds)) {
        const c = await customerConnections(userId, now, client);
        connections.set(userId, c.rows.map((r) => ({ source: r.source, healthState: r.healthState, chains: r.chains })));
        if (plan.expected.some((f) => f.kind === "subject-match" && f.customer === key)) {
          const email = plan.users.find((u) => u.id === userId)!.email;
          subjectMatched.set(userId, (await findCustomerByEmail(email, client)) === userId);
        }
      }
      const observed: ObservedFacts = {
        attention: { ...fold.sets, test: fold.testAccounts },
        openPopulation: new Set(customers.map((c) => c.id)),
        recentlyJoined,
        firstSession: new Set(funnel.firstSessions.map((s) => s.userId)),
        imports: new Map(allImports.items.map((i) => [i.id, { status: i.verdict.status, reason: i.verdict.reason }])),
        connections,
        subjectMatched,
      };
      const bad = failingFacts(plan, observed);
      if (bad.length) throw new SelfCheckFailed(bad);

      // ── Manifest (ids + drift hashes; no column value of any row — no session token) ──
      const base = manifestFromPlan(plan, { createdAt: now, repoSha: sha, targetHash: guard.targetHash }, {});
      manifest = { ...base, hashes: await readDriftHashes(tx, base.ids) };
      if (MODE === "dry-run") throw new DryRunRollback();
    }, { timeout: 240_000, maxWait: 20_000 });
  } catch (e) {
    await prisma.$disconnect();
    if (e instanceof DryRunRollback) {
      printCounts("DRY RUN — every write performed, self-check PASSED, then ROLLED BACK (nothing persisted). Rows by table:", planCounts(plan));
      console.log(`self-check: ${plan.expected.length} facts PASS; live-only: ${plan.liveOnly.length}`);
      logLine(LOG, `dry-run PASS facts=${plan.expected.length}`);
      process.exit(0);
    }
    if (e instanceof SelfCheckFailed) {
      logLine(LOG, `self-check FAILED (rolled back) facts=${e.facts.join(",")}`);
      console.error(`FAILED — self-check (rolled back; nothing persisted). Failing facts: ${e.facts.join(", ")}`);
      process.exit(3);
    }
    const msg = (e as Error).message.replace(/postgres(?:ql)?:\/\/\S+/gi, "<redacted-url>");
    logLine(LOG, `FAILED (rolled back): ${msg}`);
    console.error(`FAILED — transaction rolled back: ${msg}`);
    process.exit(1);
  }
  await prisma.$disconnect();

  // ── Committed (--apply): manifest FIRST (wx, 0600) ──
  const m = manifest as unknown as E0LiveManifest;
  const file = path.join(dir, `manifest-${m.tag}.json`);
  writePrivateNew(file, `${JSON.stringify(m, null, 2)}\n`);
  logLine(LOG, `apply committed; manifest written; rows ${JSON.stringify(Object.fromEntries(MANIFEST_TABLES.map((t) => [t, m.ids[t].length])))}`);
  printCounts("APPLIED — committed. Rows by table:", planCounts(plan));
  console.log(`self-check: ${plan.expected.length} facts PASS; live-only: ${plan.liveOnly.length}`);
  console.log(`tag: ${m.tag}`);
  console.log(`manifest: ${file}`);
  console.log(`teardown deadline: ${m.teardownDeadline}  (same UTC day — scripts/e0-live/teardown.ts --tag=${m.tag})`);
}

main().catch((e) => {
  console.error(`could not run: ${(e as Error).message.replace(/postgres(?:ql)?:\/\/\S+/gi, "<redacted-url>")}`);
  process.exit(1);
});
