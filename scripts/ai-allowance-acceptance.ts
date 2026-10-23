/**
 * scripts/ai-allowance-acceptance.ts  (AI RELIABILITY — the allowance reservation, against a REAL fm_system)
 *
 * WHY THIS SUITE EXISTS. lib/platform/ai/allowance-reservation.test.ts proves the
 * reservation's SEMANTICS over a fake transaction. The fake's lock statement
 * returned `[]`, so it could not see that Prisma must DESERIALIZE every column a
 * `$queryRaw` returns and refuses `pg_advisory_xact_lock`'s `void` (P2010 "Failed
 * to deserialize column of type 'void'"). On every real database the
 * transaction threw, the module fell back to the plain check, and the
 * reservation never ran once — while the unit suite stayed green. Every claim
 * below is therefore issued through the production module on a REAL fm_system
 * client (lib/db.ts wired from the environment, connection_limit as in
 * production) against a throwaway Postgres carrying the committed migrations.
 *
 *   [channel]  a database-level mechanism (the lock, its scope, rollback)
 *   [service]  the production function through real role clients
 *   [source]   a repository scan
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/ai-allowance-acceptance.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { prepareHarness, assertTenantClientBound, teardownHarness, psql, makeRecorder } from "./lib/rls-harness";

const KEEP = process.argv.includes("--keep");
const { check, report } = makeRecorder();
const ROOT = process.cwd();
const strip = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Today's spend for a user, as the ledger's own rows (gpt-5.1 prompt tokens at $1.25 / M). */
function seedSpend(ownerUrl: string, userId: string, promptTokens: number, now: Date): void {
  const r = psql(ownerUrl, `insert into "AiInvocation" (id,provider,model,"occurredAt","promptTokens","completionTokens","latencyMs",environment,surface,"userId",outcome)
    values ('aa_${userId}_${promptTokens}_${now.getTime()}','OPENAI','gpt-5.1','${now.toISOString()}',${promptTokens},0,1,'development','chat','${userId}','RETURNED');`);
  if (!r.ok) throw new Error(`spend seed failed: ${r.err}`);
}
const setting = (ownerUrl: string, key: string, value: string | null) => {
  const r = psql(ownerUrl, value === null
    ? `delete from "PlatformSetting" where key='${key}';`
    : `insert into "PlatformSetting" (key,value,"updatedAt") values ('${key}','${value}',now()) on conflict (key) do update set value=excluded.value, "updatedAt"=now();`);
  if (!r.ok) throw new Error(`setting ${key} failed: ${r.err}`);
};
const inflightRows = (ownerUrl: string, userId: string) =>
  Number(psql(ownerUrl, `select coalesce(sum(count),0) from "RateLimit" where key='user:ai-inflight:${userId}';`).out.trim());
const advisoryLocksHeld = (ownerUrl: string) =>
  Number(psql(ownerUrl, `select count(*) from pg_locks where locktype='advisory' and granted;`).out.trim());
const advisoryLocksWaiting = (ownerUrl: string) =>
  Number(psql(ownerUrl, `select count(*) from pg_locks where locktype='advisory' and not granted;`).out.trim());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log("\n=== AI ALLOWANCE RESERVATION — REAL fm_system ACCEPTANCE ===\n");
  const h = prepareHarness("aiallow");
  await assertTenantClientBound();
  const seed = psql(h.ownerUrl, `insert into "User" (id,email,name,"updatedAt") values
    ('ua','ua@example.test','A',now()),('ub','ub@example.test','B',now()),('uc','uc@example.test','C',now()),
    ('ud','ud@example.test','D',now()),('ue','ue@example.test','E',now()),('uf','uf@example.test','F',now()),('ug','ug@example.test','G',now());`);
  if (!seed.ok) throw new Error(`user seed failed: ${seed.err}`);

  // Imported only now: lib/db.ts binds its clients at module load from the env prepareHarness() set.
  const { systemDb, activeDbRoles } = await import("@/lib/db");
  const { reserveAiTurn } = await import("@/lib/platform/ai/allowance-reservation");
  const { RESERVE_USD } = await import("@/lib/ai/allowance-core");
  const { dailyAiAllowanceFor, allowanceUsdOf } = await import("@/lib/ai/allowance");
  const { entitlementsForUser } = await import("@/lib/entitlements/consume");
  const { readPaidRequestsAdmission } = await import("@/lib/platform/ai/paid-requests-admission");
  type Client = Parameters<typeof reserveAiTurn>[3];
  const now = () => new Date();

  // ── 1. [channel] THE DEFECT, REPRODUCED, AND THE STATEMENT THAT REPLACES IT ──
  {
    let p2010 = "";
    try { await systemDb.$transaction(async (tx) => { await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${"probe"}))`; }); }
    catch (e) { p2010 = `${(e as { code?: string }).code} ${String((e as Error).message).includes("deserialize column of type 'void'")}`; }
    const rows = await systemDb.$transaction(async (tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"probe"}))`);
    const roles = activeDbRoles();
    check(1, "[channel] on a real fm_system client the old $queryRaw lock throws P2010 'deserialize column of type void'; the same SELECT through $executeRaw succeeds (1 row)",
      p2010 === "P2010 true" && rows === 1 && roles.system === true, `queryRaw=${p2010 || "no error"} executeRaw=${rows} roles=${JSON.stringify(roles)}`);
  }

  // ── 2. [service] ONE TURN: RESERVED, A REAL COUNTER ROW, RELEASED ──────────
  {
    seedSpend(h.ownerUrl, "ua", 1_000_000, now()); // $1.25 of $5
    const r = await reserveAiTurn("ua", 5);
    const held = inflightRows(h.ownerUrl, "ua");
    await r.release(); await r.release();
    const after = inflightRows(h.ownerUrl, "ua");
    check(2, "[service] reserveAiTurn on the production client is RESERVED (not the fallback), reads $1.25 through the transaction, writes ONE in-flight row, and release() returns it to 0 exactly once",
      r.verdict.allowed && r.verdict.reservation === "RESERVED" && Math.abs(r.verdict.spentUsd - 1.25) < 1e-9 && held === 1 && after === 0,
      `reservation=${r.verdict.reservation} spent=${r.verdict.spentUsd} held=${held} after=${after}`);
  }

  // ── 3. [service] EIGHT CONCURRENT TURNS FOR ONE CUSTOMER: SERIALISED, BOUNDED ─
  {
    seedSpend(h.ownerUrl, "ub", 3_040_000, now()); // $3.80 of $5 ⇒ 3.80 + 4 × reserve ≥ 5 refuses the fifth
    const expected = Math.ceil((5 - 3.8) / RESERVE_USD); // admissions while spent + k×reserve < 5
    const results = await Promise.all(Array.from({ length: 8 }, () => reserveAiTurn("ub", 5)));
    const admitted = results.filter((r) => r.verdict.allowed);
    const seen = results.map((r) => r.verdict.inFlight).sort((a, b) => a - b).join();
    const want = [...Array.from({ length: expected }, (_, i) => i), ...Array(8 - expected).fill(expected)].join();
    const held = inflightRows(h.ownerUrl, "ub");
    check(3, `[service] 8 simultaneous turns for ONE customer on a 3-connection fm_system pool: exactly ${expected} admitted (reserve $${RESERVE_USD.toFixed(3)}), every one RESERVED, in-flight counts seen are 0…${expected - 1} then ${expected} for each refusal (serialised by the lock), ${expected} rows held`,
      admitted.length === expected && results.every((r) => r.verdict.reservation === "RESERVED") && seen === want && held === expected
        && results.filter((r) => !r.verdict.allowed).every((r) => !r.verdict.allowed && r.verdict.reason === "ALLOWANCE_EXHAUSTED"),
      `admitted=${admitted.length} seen=${seen} want=${want} held=${held}`);
    await Promise.all(results.map((r) => r.release()));
    check(3, "[service] after every release the customer holds 0 in flight and a new turn is judged on the ledger alone again",
      inflightRows(h.ownerUrl, "ub") === 0 && (await reserveAiTurn("ub", 5).then(async (r) => { await r.release(); return r.verdict.allowed && r.verdict.inFlight === 0; })));
  }

  // ── 4. [channel] THE LOCK IS TRANSACTION-SCOPED, PER CUSTOMER, AND RELEASED AT COMMIT ─
  {
    const HOLD_MS = 1500;
    let holderDone = 0;
    // Hold customer C's lock inside a real fm_system transaction for HOLD_MS.
    const holder = systemDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"ai-allowance:uc"}))`;
      await tx.$executeRaw`SELECT pg_sleep(${HOLD_MS / 1000})`;
    }, { timeout: 10_000 }).then(() => { holderDone = Date.now(); });
    await sleep(200);
    const heldDuring = advisoryLocksHeld(h.ownerUrl);
    const t0 = Date.now();
    const other = await reserveAiTurn("ud", 5); // a DIFFERENT customer
    const otherMs = Date.now() - t0;
    const sameP = reserveAiTurn("uc", 5).then((r) => ({ r, at: Date.now() }));
    await sleep(150);
    const waiting = advisoryLocksWaiting(h.ownerUrl);
    const same = await sameP;
    await holder;
    const heldAfter = advisoryLocksHeld(h.ownerUrl);
    check(4, "[channel] while customer C's lock is held in an open transaction: customer D is reserved without waiting (< 1 s), C's own turn WAITS on the advisory lock (seen in pg_locks as not granted) and is decided only after C's holder commits",
      heldDuring >= 1 && other.verdict.reservation === "RESERVED" && otherMs < 1000 && waiting >= 1
        && same.r.verdict.reservation === "RESERVED" && same.at >= holderDone,
      `heldDuring=${heldDuring} otherMs=${otherMs} waiting=${waiting} sameAfterHolder=${same.at - holderDone}ms`);
    check(4, "[channel] no advisory lock survives its transaction (pg_advisory_xact_lock is released at commit — nothing session-scoped leaks into the pool)", heldAfter === 0, `held after=${heldAfter}`);
    await other.release(); await same.r.release();
  }

  // ── 5. [service] EXHAUSTION AND THE PER-CUSTOMER OVERRIDE, END TO END ──────
  {
    seedSpend(h.ownerUrl, "ue", 4_000_000, now()); // $5.00
    const exhausted = await reserveAiTurn("ue", 5);
    check(5, "[service] spend at the allowance ⇒ refused ALLOWANCE_EXHAUSTED inside the reservation, and NO in-flight row is written for a refusal",
      !exhausted.verdict.allowed && exhausted.verdict.reservation === "RESERVED" && exhausted.verdict.reason === "ALLOWANCE_EXHAUSTED" && inflightRows(h.ownerUrl, "ue") === 0);

    const before = await entitlementsForUser("ue");
    const ins = psql(h.ownerUrl, `insert into "CustomerPolicyAssignment" (id,"userId","policyGroup","aiDailyUsdAllowanceOverride","updatedAt") values ('cpa_ue','ue','BETA_FULL_ACCESS_V1',2,now());`);
    const withOverride = await entitlementsForUser("ue");
    psql(h.ownerUrl, `delete from "AiInvocation" where "userId"='ue';`);
    seedSpend(h.ownerUrl, "ue", 1_600_000, now()); // $2.00: at the $2 override, well under the plan default
    const adm = await dailyAiAllowanceFor("ue", withOverride);
    await adm.release();
    const dflt = await dailyAiAllowanceFor("ue", before);
    await dflt.release();
    check(5, "[service] a per-customer override (written to CustomerPolicyAssignment, resolved through the REAL tenant entitlement loader) is the allowance the reservation judges: $2.00 spent ≥ the $2 override ⇒ refused, while the plan default would have admitted",
      ins.ok && allowanceUsdOf(withOverride) === 2 && allowanceUsdOf(before) > 2 && dflt.allowed && !adm.allowed && adm.reservation === "RESERVED" && adm.allowanceUsd === 2,
      `default=${allowanceUsdOf(before)} override=${allowanceUsdOf(withOverride)} allowed=${adm.allowed} reservation=${adm.reservation}`);
  }

  // ── 6. [service] THE ENFORCEMENT TOGGLE AND THE EMERGENCY PAUSE ────────────
  {
    seedSpend(h.ownerUrl, "uf", 8_000_000, now()); // $10 over $5
    setting(h.ownerUrl, "ai_daily_allowance_enforced", "false");
    const off = await reserveAiTurn("uf", 5);
    const offHeld = inflightRows(h.ownerUrl, "uf");
    await off.release();
    setting(h.ownerUrl, "ai_daily_allowance_enforced", "garbage");
    const garbage = await reserveAiTurn("uf", 5);
    setting(h.ownerUrl, "ai_daily_allowance_enforced", null);
    const missing = await reserveAiTurn("uf", 5);
    check(6, "[service] enforcement 'false' ⇒ admitted over the allowance, RESERVED, counter still runs; any other value or a missing row ⇒ ENFORCED and refused",
      off.verdict.allowed && !off.verdict.enforced && off.verdict.reservation === "RESERVED" && offHeld === 1
        && !garbage.verdict.allowed && garbage.verdict.enforced && !missing.verdict.allowed && missing.verdict.enforced);

    setting(h.ownerUrl, "ai_paid_requests_paused", "true");
    const paused = await readPaidRequestsAdmission();
    setting(h.ownerUrl, "ai_paid_requests_paused", "maybe");
    const invalid = await readPaidRequestsAdmission();
    setting(h.ownerUrl, "ai_paid_requests_paused", null);
    const clear = await readPaidRequestsAdmission();
    const route = strip("app/api/ai/chat/route.ts");
    const pauseFirst = route.indexOf("readPaidRequestsAdmission()") > 0 && route.indexOf("readPaidRequestsAdmission()") < route.indexOf("dailyAiAllowanceFor(");
    check(6, "[service] the emergency pause read on the real fm_system client: 'true' ⇒ paused, an invalid value ⇒ paused (fail closed), absent ⇒ open; and the chat route judges it BEFORE the reservation (a paused platform takes no lock)",
      paused.paused && invalid.paused && !clear.paused && pauseFirst, `paused=${paused.state} invalid=${invalid.state} clear=${clear.state} pauseFirst=${pauseFirst}`);
  }

  // ── 7. [channel] ADVISORY-LOCK FAILURE AND TRANSACTION FAILURE ⇒ THE FALLBACK, STILL ENFORCING ─
  {
    seedSpend(h.ownerUrl, "ug", 3_040_000, now()); // $3.80 of $5
    const revokeLock = psql(h.ownerUrl, `revoke execute on function pg_advisory_xact_lock(bigint) from public;`);
    const lockless = await reserveAiTurn("ug", 5);
    const locklessOver = await reserveAiTurn("ug", 3);
    psql(h.ownerUrl, `grant execute on function pg_advisory_xact_lock(bigint) to public;`);
    const reason = (v: { allowed: boolean }) => (v as { reason?: string }).reason;
    check(7, "[channel] the lock REFUSED (execute revoked) ⇒ the transaction aborts, no counter row is left behind, and with enforcement ON the turn FAILS CLOSED (RESERVATION_UNAVAILABLE) even under the allowance",
      revokeLock.ok && !lockless.verdict.allowed && reason(lockless.verdict) === "RESERVATION_UNAVAILABLE" && lockless.verdict.reservation === "UNAVAILABLE"
        && inflightRows(h.ownerUrl, "ug") === 0 && !locklessOver.verdict.allowed,
      `lockless=${lockless.verdict.reservation}/${lockless.verdict.allowed}/${reason(lockless.verdict)} over=${locklessOver.verdict.allowed}`);

    const revokeCounter = psql(h.ownerUrl, `revoke insert, update on table public."RateLimit" from fm_system;`);
    const noCounter = await reserveAiTurn("ug", 5);
    psql(h.ownerUrl, `grant insert, update on table public."RateLimit" to fm_system;`);
    check(7, "[channel] the counter write REFUSED mid-transaction ⇒ rolled back (0 rows), UNAVAILABLE, refused (fail closed)",
      revokeCounter.ok && noCounter.verdict.reservation === "UNAVAILABLE" && !noCounter.verdict.allowed
        && reason(noCounter.verdict) === "RESERVATION_UNAVAILABLE" && inflightRows(h.ownerUrl, "ug") === 0);

    // FAIL CLOSED under concurrency: the plain check has no in-flight count, so it is never the enforcer.
    const broken = new Proxy(systemDb as object, { get: (t, k) => k === "$transaction" ? () => Promise.reject(new Error("transaction unavailable")) : Reflect.get(t, k) }) as unknown as Client;
    const closed = await Promise.all(Array.from({ length: 8 }, () => reserveAiTurn("ug", 5, new Date(), broken)));
    const reserved = await Promise.all(Array.from({ length: 8 }, () => reserveAiTurn("ug", 5)));
    const reservedAdmitted = reserved.filter((r) => r.verdict.allowed).length;
    await Promise.all(reserved.map((r) => r.release()));
    check(7, "[service] with the transaction unavailable, 8 simultaneous turns at $3.80 of $5 admit NONE (fail closed, retryable); with the reservation working the same 8 admit only the bounded number",
      closed.every((r) => !r.verdict.allowed && reason(r.verdict) === "RESERVATION_UNAVAILABLE") && reservedAdmitted === Math.ceil((5 - 3.8) / RESERVE_USD),
      `closed admitted=${closed.filter((r) => r.verdict.allowed).length}/8 reserved admitted=${reservedAdmitted}/8`);
    setting(h.ownerUrl, "ai_daily_allowance_enforced", "false");
    const open = await Promise.all(Array.from({ length: 3 }, () => reserveAiTurn("ug", 5, new Date(), broken)));
    setting(h.ownerUrl, "ai_daily_allowance_enforced", null);
    check(7, "[service] enforcement EXPLICITLY OFF by an operator ⇒ the pre-existing plain check decides with the reservation unavailable (admitted, UNAVAILABLE, enforced false)",
      open.every((r) => r.verdict.allowed && r.verdict.reservation === "UNAVAILABLE" && !r.verdict.enforced));
  }

  // ── 8. [source] NO PATH AROUND THE ALLOWANCE ──────────────────────────────
  {
    const chat = strip("app/api/ai/chat/route.ts");
    const brief = strip("app/api/brief/generate/route.ts");
    const chatOrder = chat.indexOf("dailyAiAllowanceFor(") > 0 && chat.indexOf("dailyAiAllowanceFor(") < chat.indexOf("runStatelessTurn(") && /finally\s*\{[^}]*?await allowance\.release\(\)/.test(chat) /* SEC-AI-003: the turn deadline is disposed in the same finally */;
    const briefUses = /dailyAiAllowanceFor\(/.test(brief) && /allowanceRefusal\(/.test(brief);
    const mod = strip("lib/platform/ai/allowance-reservation.ts");
    check(8, "[source] chat reserves BEFORE the turn and releases in `finally`; the Brief route runs the same allowance; the reservation module issues no $queryRaw",
      chatOrder && briefUses && !/\$queryRaw\b/.test(mod), `chatOrder=${chatOrder} briefUses=${briefUses}`);
  }

  await systemDb.$disconnect();
  const failed = report("AI ALLOWANCE RESERVATION");
  teardownHarness(KEEP);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); teardownHarness(KEEP); process.exit(1); });
