/**
 * scripts/rls-plaid-acceptance.ts  (RLS-P-2 / RLS-P-3a)
 *
 * THE OPERATIONAL LEDGER, AGAINST REAL fm_app AND fm_system PRINCIPALS.
 *
 * lib/plaid/refresh-ledger-failure-matrix.test.ts proves the door's SEMANTICS
 * over an in-memory client: what a swallowed write means, what is reported, what
 * the caller is allowed to conclude. It cannot prove one word about AUTHORITY. A
 * fake client answers whatever it was written to answer, so "fm_app cannot write
 * this table" is, to a fake, a sentence about the fake.
 *
 * So every claim below that is a claim about a DATABASE ROLE is issued as that
 * role: fm_app and fm_system, authenticated, against a throwaway Postgres
 * carrying the committed migration history, with lib/db.ts wiring its clients
 * from the environment exactly as production does.
 *
 * ⚠️ CLAIM ONLY WHAT IS PROVEN. Cases are labelled by what they exercise:
 *   [role]     a role's grant / policy surface, issued as SQL by that role
 *   [service]  a real production function, through real role clients
 *   [channel]  a database-level mechanism (transactions, identity)
 *   [source]   a repository-wide scan, with its denominator
 * A [service] pass is not evidence that a route adopted anything.
 *
 * ⚠️ AND EVERY ABSENCE CLAIM HAS A DENOMINATOR. Case 2 proves the six tables
 * actually hold rows BEFORE anything asks what a role cannot read, because "fm_app
 * sees nothing" is vacuous over an empty table and this programme has shipped
 * that bug. Case 17's transaction check uses `txid_current()` and NOT
 * `pg_stat_database.xact_commit`, which measured a delta of ZERO across five real
 * transactions on PG16 and read as clean.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/rls-plaid-acceptance.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  prepareHarness, assertTenantClientBound, teardownHarness, psql, deniedByGrant,
  makeRecorder, APP_FIXTURES,
} from "./lib/rls-harness";

const KEEP = process.argv.includes("--keep");
const { check, report } = makeRecorder();

const ROOT = process.cwd();
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = (rel: string) => stripComments(readFileSync(path.join(ROOT, rel), "utf8"));
function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === "prototype") continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** The (B) family — the six tables fm_app is revoked from outright (migration §4). */
const OPERATIONAL_TABLES = [
  "RefreshExecution",
  "RefreshEndpointResult",
  "RefreshEndpointAccountCoverage",
  "ProviderCall",
  "SyncIssue",
  "SyncIssueOccurrence",
] as const;

/**
 * Rows for all six tables, seeded by the OWNER so that every refusal below has
 * something real to be refused.
 *
 * ⚠️ SEEDED HERE AND NOT IN scripts/lib/rls-harness.ts. That file is shared and
 * parent-owned, and cases 4/13/53 in the app suite pin exact counts over
 * `SyncIssue` — a row added to the shared fixtures would silently move a number
 * another suite asserts. These ids are prefixed `p2_` so they cannot collide.
 */
const LEDGER_FIXTURES = `
insert into "RefreshExecution"
  (id,"runId","plaidItemId","sourceKind",trigger,profile,"startedAt","overallStatus")
values
  ('p2_exec_seed','p2-run-seed','pi_alice','PLAID_ITEM','MANUAL','FULL_REFRESH',now(),'SUCCEEDED');

insert into "RefreshEndpointResult"
  (id,"refreshExecutionId",endpoint,"stageKind",status,"startedAt","coveredAccountIds")
values
  ('p2_stage_seed','p2_exec_seed','BALANCES','PROVIDER','SUCCEEDED',now(),ARRAY['acct_alice']);

insert into "RefreshEndpointAccountCoverage"
  (id,"refreshExecutionId",endpoint,"financialAccountId",status,"freshnessAdvanced")
values
  ('p2_cov_seed','p2_exec_seed','BALANCES','acct_alice','COVERED',true);

insert into "ProviderCall"
  (id,"refreshExecutionId",provider,operation,status,"startedAt","completedAt","durationMs")
values
  ('p2_pc_seed','p2_exec_seed','PLAID','accountsGet','SUCCEEDED',now(),now(),12);

insert into "SyncIssue" (id,kind,"plaidItemId","financialAccountId",resolved,"updatedAt")
values ('p2_si_seed','UPSERT_ERROR','pi_alice','acct_alice',false,now());

insert into "SyncIssueOccurrence" (id,"syncIssueId","observedAt")
values ('p2_occ_seed','p2_si_seed',now());
`;

async function main(): Promise<void> {
  console.log("\n=== RLS PLAID OPERATIONAL-LEDGER SUITE (P-2 semantics / P-3a authority) ===\n");

  const h = prepareHarness("rlsplaid");
  // RLS-HARNESS-1 — the URL was checked above; this checks the BINDING.
  await assertTenantClientBound();
  const seed = psql(h.ownerUrl, APP_FIXTURES);
  if (!seed.ok) throw new Error(`fixture seed failed: ${seed.err}`);
  const ledgerSeed = psql(h.ownerUrl, LEDGER_FIXTURES);
  if (!ledgerSeed.ok) throw new Error(`ledger fixture seed failed: ${ledgerSeed.err}`);
  console.log("[rls] Alice / Bob fixtures + one row in each of the six operational tables seeded.\n");

  // Imported ONLY now: lib/db.ts binds its clients at MODULE LOAD from the
  // environment prepareHarness() just set. A static import would have captured
  // the ambient DATABASE_URL and tested the wrong principal entirely.
  const dbMod   = await import("@/lib/db");
  const strict  = await import("@/lib/db/strict-mode");
  const tenant  = await import("@/lib/db/tenant-context");
  const ledger  = await import("@/lib/plaid/refresh-ledger");
  const exec    = await import("@/lib/plaid/refresh-execution");
  const issues  = await import("@/lib/plaid/syncIssues");
  const query   = await import("@/lib/platform/refresh/execution-query");
  const provider = await import("@/lib/plaid/provider-call");

  type LedgerWriteClient = import("@/lib/plaid/refresh-ledger").LedgerWriteClient;
  type IncidentClient = import("@/lib/platform/incidents/lifecycle").IncidentClient;
  type RefreshStageRecorder = import("@/lib/plaid/refresh-execution-types").RefreshStageRecorder;

  const APP_LEDGER = dbMod.tenantDb as unknown as LedgerWriteClient;
  const SYS_LEDGER = dbMod.systemDb as unknown as LedgerWriteClient;

  /** A runner that records one SUCCEEDED provider stage covering one real account. */
  const oneStage = async ({ recorder }: { recorder: RefreshStageRecorder }) => {
    recorder.begin("BALANCES", "PROVIDER");
    recorder.succeed("BALANCES", {
      recordsChanged: 1,
      coveredAccountIds: ["acct_alice"],
      accounts: [{ financialAccountId: "acct_alice", status: "COVERED", freshnessAdvanced: true }],
    });
    return "ran" as const;
  };

  const ownerCount = (table: string, where = "true") =>
    Number(psql(h.ownerUrl, `select count(*) from "${table}" where ${where};`).out.trim());

  // ── 1. [role] the wiring the application actually got ─────────────────────
  const roles = dbMod.activeDbRoles();
  const verdicts = await strict.verifyDbAuthorities(dbMod.configuredRoleClients());
  const bad = verdicts.filter((v) => !v.ok);
  check(1, "[role] three DISTINCT role clients, each IS the principal it claims, none a superuser, none with BYPASSRLS, none owning a protected table",
    roles.app && roles.auth && roles.system && verdicts.length === 3 && bad.length === 0
    && strict.strictRlsEnabled() && dbMod.tenantDb !== dbMod.db && dbMod.systemDb !== dbMod.db,
    `${JSON.stringify(roles)} ${bad.map((v) => `${v.variable}: ${v.problems.join("; ")}`).join(" | ")}`);

  // ── 2. [role] THE DENOMINATOR FOR EVERY REFUSAL BELOW ─────────────────────
  // "fm_app cannot read it" over an EMPTY table passes for the wrong reason, and
  // that is a bug this programme has already shipped once. Nothing below means
  // anything unless all six tables genuinely hold a row first.
  const seededCounts = OPERATIONAL_TABLES.map((t) => [t, ownerCount(t)] as const);
  check(2, "[role] THE PREMISE: all six operational tables hold at least one owner-visible row before any refusal is measured",
    seededCounts.every(([, n]) => n >= 1),
    seededCounts.map(([t, n]) => `${t}=${n}`).join(" "));

  // ── 3. [role] fm_app CANNOT WRITE ANY OF THE SIX, AND CANNOT READ FIVE ────
  // Eighteen write statements and five selects, every one of which must come
  // back `permission denied`. Issued as real SQL under a real identity, because
  // the identity is irrelevant and that is itself the point: the family is
  // revoked at the GRANT layer, so a refusal RAISES rather than returning the
  // silent empty set / zero count a policy would.
  //
  // ⚠️ `SyncIssue` IS EXCLUDED FROM THE SELECT SWEEP, NOT FORGOTTEN. RLS-16
  // granted fm_app a COLUMN-LEVEL select on six of its columns so the activity
  // timeline can render "a sync problem happened on this account" without
  // reaching `detail`. That exception is a shipped decision, this slice must not
  // have widened or broken it, and case 20 asserts it in both directions.
  {
    const results: string[] = [];
    const SELECT_DENIED = OPERATIONAL_TABLES.filter((t) => t !== "SyncIssue");
    let statements = 0;
    for (const t of OPERATIONAL_TABLES) {
      const stmts: Array<[string, string]> = [
        ["insert", `insert into "${t}" (id) values ('p2_app_probe')`],
        ["update", `update "${t}" set id = id`],
        ["delete", `delete from "${t}"`],
        ...(SELECT_DENIED.includes(t as never) ? [["select", `select count(*) from "${t}"`] as [string, string]] : []),
      ];
      for (const [verb, sql] of stmts) {
        statements++;
        const r = psql(h.appUrl, `begin; set local app.user_id='alice'; ${sql}; commit;`, false);
        if (!deniedByGrant(r)) results.push(`${t}.${verb}: ${r.err.split("\n")[0] || `ALLOWED (out=${r.out.trim()})`}`);
      }
    }
    check(3, `[role] fm_app is refused by GRANT on every WRITE to all 6 operational tables and on every READ of the 5 with no read grant (${statements} statements, ${statements} refusals)`,
      results.length === 0 && statements === 23, results.join(" | ") || `only ${statements} statements`);
  }

  // ── 4. [role] fm_system HOLDS EXACTLY THE FOUR VERBS AND NO MORE ──────────
  // The flip must not have handed the system role more than the ledger needs.
  // TRUNCATE is the one that matters: an append-only forensic ledger whose
  // writer can empty it is not append-only.
  {
    const priv = psql(h.systemUrl, `
      select string_agg(t || ':' || p, ' ' order by t, p) from (
        select c.relname t, x.p,
               has_table_privilege('fm_system', c.oid, x.p) g
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) x(p)
         where n.nspname='public' and c.relname in (${OPERATIONAL_TABLES.map((t) => `'${t}'`).join(",")})
      ) q where q.g;`);
    const granted = new Set(priv.out.trim().split(/\s+/).filter(Boolean));
    const expected = new Set(OPERATIONAL_TABLES.flatMap((t) => ["SELECT", "INSERT", "UPDATE", "DELETE"].map((p) => `${t}:${p}`)));
    const extra = [...granted].filter((g) => !expected.has(g));
    const missing = [...expected].filter((e) => !granted.has(e));
    check(4, "[role] fm_system holds exactly SELECT/INSERT/UPDATE/DELETE on the six — and NOT TRUNCATE, REFERENCES or TRIGGER on any of them",
      extra.length === 0 && missing.length === 0 && granted.size === 24,
      `granted=${granted.size} extra=[${extra.join(",")}] missing=[${missing.join(",")}]`);
  }

  // ── 5. [role] REACH COMES FROM A POLICY, NOT FROM AN ATTRIBUTE ────────────
  // fm_system is NOBYPASSRLS on purpose: every grant of cross-tenant reach must
  // appear in pg_policies and be reviewable in source control. If the reach came
  // from BYPASSRLS instead, the authority flip would be invisible to inspection.
  {
    const attr = psql(h.systemUrl, `select rolbypassrls::text || '|' || rolsuper::text from pg_roles where rolname='fm_system';`).out.trim();
    const pol = psql(h.ownerUrl, `
      select count(*) from pg_policies
       where schemaname='public' and policyname='fm_system_all' and 'fm_system' = any(roles)
         and tablename in (${OPERATIONAL_TABLES.map((t) => `'${t}'`).join(",")});`).out.trim();
    const forced = psql(h.ownerUrl, `
      select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relrowsecurity and c.relforcerowsecurity
         and c.relname in (${OPERATIONAL_TABLES.map((t) => `'${t}'`).join(",")});`).out.trim();
    check(5, "[role] fm_system carries NEITHER BYPASSRLS NOR superuser; its reach on all six is a role-scoped policy, and all six have RLS ENABLED and FORCED",
      attr === "false|false" && pol === "6" && forced === "6",
      `attrs=${attr} fm_system_all policies=${pol} forced=${forced}`);
  }

  // ── 6. [service] THE DOOR ON A REAL fm_app CLIENT: TOTAL BLACKOUT ─────────
  // The P-2 matrix injects the ERROR SHAPE of a refusal. This is the refusal.
  {
    const before = OPERATIONAL_TABLES.map((t) => ownerCount(t));
    const recorder = ledger.ledgerRecorderFor(APP_LEDGER);
    const out = await exec.runFullRefresh<"ran">(
      { itemId: "pi_alice", trigger: "MANUAL", profile: "FULL_REFRESH" },
      { client: recorder, refresh: oneStage },
    );
    await new Promise((r) => setTimeout(r, 150)); // the provider-call emit is void-dispatched
    const after = OPERATIONAL_TABLES.map((t) => ownerCount(t));
    const d = recorder.degradations;
    check(6, "[service] the ledger door bound to a REAL fm_app client is a TOTAL BLACKOUT: the refresh returns its own result, ZERO rows are written to any of the six, and the blackout is ONE named degradation",
      out === "ran"
      && before.every((n, i) => n === after[i])
      && ledger.ledgerCompleteness(d) === "BLACKOUT"
      && ledger.isTotalBlackout(d)
      && d.length === 1 && d[0].ledger === "RefreshExecution" && d[0].phase === "start",
      `out=${out} before=[${before}] after=[${after}] degradations=${JSON.stringify(d)}`);
  }

  // ── 7. [service] THE SAME DOOR ON A REAL fm_system CLIENT: EVERYTHING LANDS ─
  {
    const recorder = ledger.ledgerRecorderFor(SYS_LEDGER);
    const handle = await recorder.open({
      runId: "p2-run-system", plaidItemId: "pi_alice", sourceKind: "PLAID_ITEM",
      sourceRef: null, network: null, trigger: "MANUAL", profile: "FULL_REFRESH",
      parentJobRunId: null, startedAt: new Date(), overallStatus: "RUNNING", deploymentSha: null,
    });
    const id = handle?.executionId ?? "(none)";
    await handle?.recordStages([{
      endpoint: "BALANCES", stageKind: "PROVIDER", status: "SUCCEEDED",
      startedAt: new Date(), completedAt: new Date(), durationMs: 5, coveredAccountIds: ["acct_alice"],
    }]);
    await handle?.recordCoverage([{
      endpoint: "BALANCES", financialAccountId: "acct_alice", status: "COVERED", freshnessAdvanced: true,
    }]);
    handle?.recordProviderCall({
      provider: "PLAID", operation: "accountsGet", status: "SUCCEEDED", attempt: 1,
      startedAt: new Date(), completedAt: new Date(), durationMs: 7,
    });
    // The INCREMENTAL historical stage, twice — which also exercises the
    // attempt-numbering probe now that it runs on the WRITE client (RLS-P-2).
    await handle?.settleHistoricalStage({ stage: "COVERAGE", status: "SUCCEEDED", startedAt: new Date() });
    await handle?.settleHistoricalStage({ stage: "COVERAGE", status: "SUCCEEDED", startedAt: new Date() });
    await handle?.close({ completedAt: new Date(), durationMs: 20, overallStatus: "SUCCEEDED" });
    await new Promise((r) => setTimeout(r, 150));

    const attempts = psql(h.ownerUrl,
      `select coalesce(string_agg(attempt::text,',' order by attempt),'(none)') from "RefreshEndpointResult"
        where "refreshExecutionId"='${id}' and endpoint='COVERAGE';`).out.trim();
    const status = psql(h.ownerUrl, `select "overallStatus" from "RefreshExecution" where id='${id}';`).out.trim();
    check(7, "[service] the SAME door on a REAL fm_system client writes all four refresh tables, attributes every child to the MINTED id, completes the row, and numbers the two historical attempts 1 then 2",
      handle !== null
      && recorder.degradations.length === 0
      && ownerCount("RefreshEndpointResult", `"refreshExecutionId"='${id}' and endpoint='BALANCES'`) === 1
      && ownerCount("RefreshEndpointAccountCoverage", `"refreshExecutionId"='${id}'`) === 1
      && ownerCount("ProviderCall", `"refreshExecutionId"='${id}'`) === 1
      && status === "SUCCEEDED"
      && attempts === "1,2",
      `id=${id} status=${status} attempts=${attempts} degradations=${JSON.stringify(recorder.degradations)}`);
  }

  // ── 8. [service] THE PRODUCTION BINDING ITSELF IS fm_system ──────────────
  //
  // ⚠️ THE OBVIOUS VERSION OF THIS CASE IS VACUOUS, AND IT WAS WRITTEN FIRST.
  // "call runFullRefresh with no injected client and assert a row appeared" is
  // satisfied by fm_system, by the migration principal, and by any superuser:
  // Postgres records no writer identity on a row, so the assertion cannot tell
  // the authority it is supposed to be testing from the one it replaced. It
  // would have gone green over an unreverted flip.
  //
  // So the discriminator is a GRANT, applied to the throwaway database and
  // restored immediately. Revoke INSERT on RefreshExecution from fm_system ONLY:
  //
  //     bound to fm_system  → the start write is refused → TOTAL BLACKOUT
  //     bound to the owner  → unaffected by the revoke → the row appears
  //     bound to fm_app     → blackout BEFORE and AFTER the re-grant
  //
  // Three-way discrimination, which is the only shape that actually names the
  // principal. No repository policy or grant is weakened — this is a disposable
  // container, and the grant is put back before the next case runs.
  {
    const revoke = psql(h.ownerUrl, `revoke insert on table public."RefreshExecution" from fm_system;`);
    if (!revoke.ok) throw new Error(`could not stage the P-3a discriminator: ${revoke.err}`);
    const beforeDenied = ownerCount("RefreshExecution");
    const deniedOut = await exec.runFullRefresh<"ran">(
      { itemId: "pi_alice", trigger: "MANUAL", profile: "FULL_REFRESH" },
      { refresh: oneStage },
    );
    const afterDenied = ownerCount("RefreshExecution");

    const regrant = psql(h.ownerUrl, `grant insert on table public."RefreshExecution" to fm_system;`);
    if (!regrant.ok) throw new Error(`could not restore the discriminator grant: ${regrant.err}`);
    const grantedOut = await exec.runFullRefresh<"ran">(
      { itemId: "pi_alice", trigger: "MANUAL", profile: "FULL_REFRESH" },
      { refresh: oneStage },
    );
    const afterGranted = ownerCount("RefreshExecution");

    const sysReadable = await dbMod.systemDb.refreshExecution.count({ where: { plaidItemId: "pi_alice" } });
    let appRead = "no error";
    try { await dbMod.tenantDb.refreshExecution.count({ where: { plaidItemId: "pi_alice" } }); }
    catch (e) { appRead = e instanceof Error ? e.message : String(e); }

    check(8, "[service] runFullRefresh with NO injected client is SILENCED by revoking INSERT from fm_system alone and WRITES again the moment it is restored — so the production constant is fm_system and not the migration principal; and the tenant role cannot even COUNT what it wrote",
      deniedOut === "ran" && afterDenied === beforeDenied
      && grantedOut === "ran" && afterGranted === beforeDenied + 1
      && sysReadable >= 1 && /permission denied/i.test(appRead),
      `whileRevoked=${beforeDenied}->${afterDenied} afterRegrant=${afterGranted} systemSees=${sysReadable} appRead=${appRead.split("\n")[0]}`);
  }

  // ── 9. [service] A REFUSED LEDGER DOES NOT TOUCH THE CALLER'S OUTCOME ─────
  // The pinned property, under a real refusal rather than a thrown fake:
  // `reportItemRefreshFailure` classifies by IDENTITY, so a wrapped error would
  // silently reclassify every Plaid failure in the product.
  {
    const boom = Object.assign(new Error("provider down"), { error_code: "ITEM_LOGIN_REQUIRED" });
    const recorder = ledger.ledgerRecorderFor(APP_LEDGER);
    let rethrew: unknown;
    try {
      await exec.runFullRefresh<never>(
        { itemId: "pi_alice", trigger: "MANUAL", profile: "FULL_REFRESH" },
        { client: recorder, refresh: async () => { throw boom; } },
      );
    } catch (e) { rethrew = e; }
    check(9, "[service] with the ledger refused at the GRANT layer, the ORIGINAL error object is still rethrown by identity and no ledger error reaches the caller",
      rethrew === boom && ledger.isTotalBlackout(recorder.degradations),
      `same=${rethrew === boom} blackout=${ledger.isTotalBlackout(recorder.degradations)}`);
  }

  // ── 10. [service] THE INCIDENT FACADE'S NEW DEFAULT IS fm_system ─────────
  // Same discriminator as case 8, and for the same reason: "a row appeared" does
  // not name a principal. Revoking INSERT on SyncIssue from fm_system alone must
  // silence the facade's default path, and restoring it must bring the episode
  // back. The owner would be indifferent to both.
  {
    const revoke = psql(h.ownerUrl, `revoke insert on table public."SyncIssue" from fm_system;`);
    if (!revoke.ok) throw new Error(`could not stage the incident discriminator: ${revoke.err}`);
    const before = ownerCount("SyncIssue");
    await issues.recordSyncIssue({
      kind: "UPSERT_ERROR", plaidItemId: "pi_alice",
      detail: { stage: "transaction-persist", cursorBlocking: true, runId: "p2-run-denied" },
    });
    const whileRevoked = ownerCount("SyncIssue");

    const regrant = psql(h.ownerUrl, `grant insert on table public."SyncIssue" to fm_system;`);
    if (!regrant.ok) throw new Error(`could not restore the incident grant: ${regrant.err}`);
    const beforeOcc = ownerCount("SyncIssueOccurrence");
    await issues.recordSyncIssue({
      kind: "UPSERT_ERROR", plaidItemId: "pi_alice",
      detail: { stage: "transaction-persist", cursorBlocking: true, runId: "p2-run-system" },
    });
    check(10, "[service] recordSyncIssue with NO client is silenced by revoking INSERT from fm_system and writes a real episode AND its occurrence once it is restored — the facade default is fm_system, which is the only role that can",
      whileRevoked === before
      && ownerCount("SyncIssue") === before + 1
      && ownerCount("SyncIssueOccurrence") === beforeOcc + 1,
      `whileRevoked=${before}->${whileRevoked} afterRegrant=${ownerCount("SyncIssue")} occurrences ${beforeOcc}->${ownerCount("SyncIssueOccurrence")}`);
  }

  // ── 11. [service] A REFUSED INCIDENT WRITE IS FINALLY AUDIBLE ─────────────
  // THE P-2 CENTREPIECE, with a real refusal. The facade NEVER THROWS, so before
  // this slice a refused incident write was indistinguishable from a recorded
  // one at every one of its fourteen call sites, and the refresh ledger's
  // degradation list reported a COMPLETE ledger over an episode that does not
  // exist.
  {
    const before = ownerCount("SyncIssue");
    const announced: Array<[string, string]> = [];
    let threw = "no error";
    try {
      await issues.recordSyncIssue(
        { kind: "UPSERT_ERROR", plaidItemId: "pi_alice", detail: { stage: "transaction-persist" } },
        dbMod.tenantDb as unknown as IncidentClient,
        { onWriteFailure: (l, p) => announced.push([l, p]) },
      );
    } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    check(11, "[service] recordSyncIssue through a REAL fm_app client writes NOTHING, throws NOTHING, and ANNOUNCES SyncIssue/incident — the swallow is kept and the silence is not",
      threw === "no error"
      && ownerCount("SyncIssue") === before
      && announced.length === 1 && announced[0][0] === "SyncIssue" && announced[0][1] === "incident",
      `threw=${threw.split("\n")[0]} delta=${ownerCount("SyncIssue") - before} announced=${JSON.stringify(announced)}`);
  }

  // ── 12. [service] THE PAIR THAT SEPARATES THE FIX FROM THE BUG ────────────
  // `{resolved: 0}` meant "no open episode" (healthy, common) and "the write was
  // refused" (the episode stays open for ever, nobody is told). Both halves must
  // run, as real roles, or the case proves nothing: a suite that only showed the
  // refusal announcing would also pass if EVERYTHING announced.
  {
    const announcedRefused: Array<[string, string]> = [];
    const refusedCount = await issues.resolveCursorBlockingIssues(
      "pi_alice",
      dbMod.tenantDb as unknown as IncidentClient,
      "p2-run-system",
      { onWriteFailure: (l, p) => announcedRefused.push([l, p]) },
    );

    const announcedClean: Array<[string, string]> = [];
    const cleanCount = await issues.resolveCursorBlockingIssues(
      "pi_bob", // a real item with no open cursor-blocking episode at all
      undefined,
      "p2-run-system",
      { onWriteFailure: (l, p) => announcedClean.push([l, p]) },
    );
    check(12, "[service] a REFUSED resolution reports 0 and announces SyncIssue/RESOLUTION; an item with genuinely nothing to resolve reports 0 and announces NOTHING — the two zeroes are finally distinguishable",
      refusedCount === 0 && announcedRefused.length === 1
      && announcedRefused[0][0] === "SyncIssue" && announcedRefused[0][1] === "resolution"
      && cleanCount === 0 && announcedClean.length === 0,
      `refused=${refusedCount}/${JSON.stringify(announcedRefused)} clean=${cleanCount}/${JSON.stringify(announcedClean)}`);
  }

  // ── 13. [service] THE CORRELATION READ MOVED WITH THE WRITE ───────────────
  // `getExecutionIdByRunId` swallowed every read failure into `return null`, and
  // null is ALSO the honest answer for a producer with no envelope — so a refused
  // read published itself as the fact "this run named no execution" and the
  // occurrence was stored permanently unlinked. The read now runs on the same
  // authority as the write, and this proves the FK actually lands.
  {
    const resolvedId = await query.getExecutionIdByRunId("p2-run-system");
    const fk = psql(h.ownerUrl, `
      select coalesce(max(o."refreshExecutionId"),'(null)') from "SyncIssueOccurrence" o
        join "SyncIssue" s on s.id = o."syncIssueId"
       where o."runId" = 'p2-run-system';`).out.trim();
    const unknown = await query.getExecutionIdByRunId("p2-run-does-not-exist");
    check(13, "[service] the run correlator resolves to a real execution id under fm_system, that id is what the occurrence's FK holds, and an unknown correlator still answers null rather than throwing",
      resolvedId !== null && fk === resolvedId && unknown === null,
      `resolved=${resolvedId} occurrenceFk=${fk} unknown=${String(unknown)}`);
  }

  // ── 14. [channel] ORDINARY TENANT FINANCIAL WRITES ARE STILL fm_app ───────
  // The flip must not have dragged financial persistence onto the system role.
  {
    const written = await tenant.withTenantDb("alice", async (tx) =>
      tx.transaction.updateMany({ where: { id: "tx_alice_1" }, data: { merchant: "Coffee P2" } }));
    const crossTenant = await tenant.withTenantDb("alice", async (tx) =>
      tx.transaction.updateMany({ where: { id: "tx_bob_1" }, data: { amount: -999 } }));
    const bobIntact = psql(h.ownerUrl, `select amount::text from "Transaction" where id='tx_bob_1';`).out.trim();
    check(14, "[channel] a tenant financial write still succeeds on fm_app AND is still policy-scoped — Alice writes her own row and zero of Bob's, and his data is untouched",
      written.count === 1 && crossTenant.count === 0 && /^-50(\.0+)?$/.test(bobIntact),
      `own=${written.count} cross=${crossTenant.count} bobAmount=${bobIntact}`);
  }

  // ── 15. [role] THE FLIP TOOK NOTHING AWAY FROM fm_app ─────────────────────
  // The failure mode in the other direction: a slice that routes an operational
  // write to fm_system and, in passing, removes a grant the request path needs.
  {
    const financial = ["Transaction", "FinancialAccount", "SpaceAccountLink", "PlaidItem", "Connection"];
    const missing = financial.filter((t) => {
      const r = psql(h.systemUrl, `select bool_and(has_table_privilege('fm_app','public."${t}"', p))::text
        from (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) x(p);`);
      return r.out.trim() !== "true";
    });
    check(15, "[role] fm_app RETAINS SELECT/INSERT/UPDATE/DELETE on every ordinary financial table — the operational flip widened nothing and narrowed nothing here",
      missing.length === 0, `missing=[${missing.join(",")}]`);
  }

  // ── 16. [channel] EACH LEDGER WRITE IS ITS OWN TRANSACTION ────────────────
  // ⚠️ MEASURED WITH txid_current(), NOT WITH A STATISTICS COUNTER.
  // `pg_stat_database.xact_commit` showed a delta of ZERO across five real
  // transactions on PG16 (the snapshot is cached) and read as perfectly clean.
  // `txid_current()` is the transaction, not a count of them.
  {
    const t1 = (await dbMod.systemDb.$queryRawUnsafe<Array<{ t: bigint }>>("select txid_current() as t"))[0].t;
    const t2 = (await dbMod.systemDb.$queryRawUnsafe<Array<{ t: bigint }>>("select txid_current() as t"))[0].t;
    // THE DENOMINATOR: the same two statements INSIDE one transaction must share
    // an id. Without it, "they differ" could just mean the probe is broken.
    const [u1, u2] = await dbMod.systemDb.$transaction(async (tx) => [
      (await tx.$queryRawUnsafe<Array<{ t: bigint }>>("select txid_current() as t"))[0].t,
      (await tx.$queryRawUnsafe<Array<{ t: bigint }>>("select txid_current() as t"))[0].t,
    ]);
    check(16, "[channel] two successive statements on the system client run in DIFFERENT transactions, while two inside one $transaction share an id — so no operational-ledger write is enclosed in a long-lived transaction",
      String(t1) !== String(t2) && String(u1) === String(u2),
      `autocommit=${t1}/${t2} inTransaction=${u1}/${u2}`);
  }

  // ── 17. [channel] THE PROVIDER ROUND TRIP HOLDS NO TRANSACTION ────────────
  // `instrumentProviderCall` is the REAL production function and takes the
  // provider call as a thunk, so this needs no seam added to production code —
  // the brief's prohibition on inventing one does not bite here.
  //
  // AND IT CARRIES ITS DENOMINATOR, which is the half that makes it mean
  // anything: a probe reading 0 because it cannot see fm_system backends at all
  // would approve everything.
  {
    const idleProbe = `select count(*) from pg_stat_activity where state='idle in transaction' and usename='fm_system';`;
    let heldDuringTransaction = "unread";
    await dbMod.systemDb.$transaction(async (tx) => {
      await tx.$queryRawUnsafe("select 1");
      heldDuringTransaction = psql(h.ownerUrl, idleProbe).out.trim();
    }, { timeout: 20_000 });

    const recorder = ledger.ledgerRecorderFor(SYS_LEDGER);
    const handle = await recorder.open({
      runId: "p2-run-provider", plaidItemId: "pi_alice", sourceKind: "PLAID_ITEM",
      sourceRef: null, network: null, trigger: "MANUAL", profile: "FULL_REFRESH",
      parentJobRunId: null, startedAt: new Date(), overallStatus: "RUNNING", deploymentSha: null,
    });
    let duringCall = "unread";
    await provider.instrumentProviderCall(
      "accountsGet",
      { ledger: handle!, currentEndpoint: "BALANCES", attempts: new Map() },
      async () => {
        duringCall = psql(h.ownerUrl, idleProbe).out.trim();
        return { data: { request_id: "p2-req-1" } };
      },
    );
    await new Promise((r) => setTimeout(r, 200)); // the emit is void-dispatched
    const landed = ownerCount("ProviderCall", `"refreshExecutionId"='${handle?.executionId}'`);
    check(17, "[channel] the probe SEES a held fm_system transaction (>=1), reads 0 while a real instrumented provider call is in flight, and the ProviderCall row still lands afterwards",
      Number(heldDuringTransaction) >= 1 && duringCall === "0" && landed === 1,
      `heldDuringTransaction=${heldDuringTransaction} duringProviderCall=${duringCall} providerCallRows=${landed}`);
  }

  // ── 18. [source] ONE WRITER, ONE WRITE AUTHORITY, AND NO STRAY ONES ──────
  {
    const ACCESSOR = /\.(refreshExecution|refreshEndpointResult|refreshEndpointAccountCoverage|providerCall)\s*\./;
    const WRITE = /\.(refreshExecution|refreshEndpointResult|refreshEndpointAccountCoverage|providerCall)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/;
    const files = ["lib", "app", "components", "jobs"].flatMap((r) => walk(r))
      .filter((f) => !/\.test\.tsx?$/.test(f));
    const DOOR = "lib/plaid/refresh-ledger.ts";

    // (a) exactly one WRITER, and it holds no client of its own — the authority
    //     arrives as an argument, which is what made the flip one line.
    const writers = files.filter((f) => WRITE.test(code(f)));

    // (b) exactly one file BINDS that argument. This is the authority decision,
    //     and the audit allowlist sanctions `lib/plaid/` for systemDb wholesale,
    //     so nothing but this scan keeps the opening from spreading.
    // ⚠️ THE DECLARATION IS NOT A CALL SITE. A bare `/ledgerRecorderFor\s*\(/`
    //    matches `export function ledgerRecorderFor(` in the door itself, which
    //    would have made this read "two binders" for ever and hidden the arrival
    //    of a real third one in the noise.
    const binders = files.filter((f) =>
      /ledgerRecorderFor\s*\(/.test(code(f).replace(/export function ledgerRecorderFor\s*\(/g, "DECL(")));

    // (c) every OTHER file that names systemDb beside one of the four tables is
    //     a READ seam and performs no write verb on them. Measured rather than
    //     listed, so a fourth one cannot arrive unannounced.
    const openings = files.filter((f) => /\bsystemDb\b/.test(code(f)) && ACCESSOR.test(code(f)));
    const openingsThatWrite = openings.filter((f) => WRITE.test(code(f)));

    console.log(`     · systemDb sites touching the four tables: ${openings.join(", ")}`);
    check(18, `[source] ONE product file writes the four refresh tables and holds no database client; ONE file binds its authority; the ${openings.length} other systemDb sites touching those tables are READ seams that write nothing (over ${files.length} scanned)`,
      writers.length === 1 && writers[0] === DOOR
      && !code(DOOR).includes("@/lib/db")
      && binders.length === 1 && binders[0] === "lib/plaid/refresh-execution.ts"
      // The binder NAMES fm_system and no longer names the migration principal.
      // Case 8 discriminates this behaviourally; this is the cheap mechanical
      // half, and the two fail for different reasons.
      && /\bsystemDb\b/.test(code("lib/plaid/refresh-execution.ts"))
      && !/import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*["']@\/lib\/db["']/.test(code("lib/plaid/refresh-execution.ts"))
      && openings.length === 3
      && openingsThatWrite.length === 0,
      `writers=[${writers.join(",")}] binders=[${binders.join(",")}] openings=[${openings.join(",")}] openingsThatWrite=[${openingsThatWrite.join(",")}]`);
  }

  // ── 19. [source] THE INCIDENT PAIR'S RESIDUE, MEASURED NOT DESCRIBED ─────
  // For SyncIssue / SyncIssueOccurrence the flip is TWO DEFAULTS, not one line:
  // the client is a PARAMETER, because the injection seam is what keeps a unit
  // test's error path from writing a real row (the eight stray
  // `opening-position-repair` rows in the local dev database are what happens
  // when it escapes). So a producer that threads a client still decides its own
  // authority for these two tables, and the honest thing is to count them.
  {
    const files = ["lib", "app", "jobs"].flatMap((r) => walk(r)).filter((f) => !/\.test\.tsx?$/.test(f));
    const threading = files.filter((f) => /recordSyncIssue\([\s\S]{0,900}?\},\s*(client|database|incidents|db)\s*\)/.test(code(f))
      || /resolveCursorBlockingIssues\([^)]*,\s*(client|database|incidents|db)\s*[,)]/.test(code(f)));
    // Threading is fine WHEN THE THREADED CLIENT IS fm_system. syncTransactions
    // resolves `incidents = deps.db ?? systemDb`, so production lands on
    // fm_system and only an injected fake diverts it. The remainder thread a
    // caller-supplied client of unresolved authority.
    const onSystem = threading.filter((f) => /=\s*deps\.db\s*\?\?\s*systemDb/.test(code(f)));
    const unresolved = threading.filter((f) => !onSystem.includes(f));
    const defaults = ["lib/plaid/syncIssues.ts", "lib/platform/incidents/lifecycle.ts"]
      .filter((f) => /=\s*systemDb\b/.test(code(f)));
    console.log(`     · threads a systemDb-derived client: ${onSystem.join(", ") || "(none)"}`);
    console.log(`     · threads a caller-supplied client (UNRESOLVED authority): ${unresolved.join(", ") || "(none)"}`);
    check(19, `[source] BOTH incident defaults are fm_system; of the ${threading.length} producers that still thread a client, ${onSystem.length} resolve fm_system themselves and the remaining ${unresolved.length} are the lib/investments import chain this slice does not own`,
      defaults.length === 2
      && threading.length >= 1
      && onSystem.length === 1 && onSystem[0] === "lib/plaid/syncTransactions.ts"
      && unresolved.length > 0 && unresolved.every((f) => f.startsWith("lib/investments/")),
      `defaults=[${defaults.join(",")}] onSystem=[${onSystem.join(",")}] unresolved=[${unresolved.join(",")}]`);
  }

  // ── 20. [role] RLS-16'S NARROW READ IS INTACT AND STILL NARROW ────────────
  // The one deliberate fm_app read on this family: six columns of SyncIssue,
  // tenant-scoped, so the activity timeline can say "a sync problem happened on
  // this account" without reaching `detail` — which carries another tenant's
  // merchant strings and amounts. A slice that moved this family's authority
  // could break it in either direction, so both are asserted.
  {
    const shape = psql(h.appUrl,
      `begin; set local app.user_id='alice';
       select count(*) from "SyncIssue" where "financialAccountId" is not null; commit;`, false);
    const content = psql(h.appUrl,
      `begin; set local app.user_id='alice'; select detail from "SyncIssue"; commit;`, false);
    const scoped = psql(h.appUrl,
      `begin; set local app.user_id='alice';
       select coalesce(string_agg("financialAccountId",',' order by "financialAccountId"),'(none)')
         from "SyncIssue"; commit;`, false);
    check(20, "[role] fm_app can still read a SyncIssue's SHAPE, is still refused its `detail`, and still sees only accounts it can reach — Bob's issue and the orphan are absent",
      shape.ok && Number(shape.out.trim()) >= 1
      && deniedByGrant(content)
      && scoped.ok && !scoped.out.includes("acct_bob"),
      `shapeRead=${shape.out.trim() || shape.err.split("\n")[0]} detail=${content.err.split("\n")[0] || `ALLOWED (${content.out.trim()})`} visible=[${scoped.out.trim()}]`);
  }

  await (dbMod.tenantDb as { $disconnect: () => Promise<void> }).$disconnect();
  await (dbMod.authDb as { $disconnect: () => Promise<void> }).$disconnect();
  await (dbMod.systemDb as { $disconnect: () => Promise<void> }).$disconnect();

  const failures = report("PLAID OPERATIONAL LEDGER");
  if (failures) process.exit(1);
  console.log("\nThe operational ledger is written by fm_system, is unreachable from fm_app, and reports every write it fails to make.\n");
}

main()
  .catch((e) => {
    console.error(`\n[rls] SUITE ERROR: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exitCode = 1;
  })
  .finally(() => teardownHarness(KEEP));
