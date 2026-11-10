/**
 * scripts/platform-ai-conversations-acceptance.ts  (B11 — Platform AI conversations on REAL PostgreSQL roles)
 *
 * Design: docs/plans/PLATFORM-AI-CONVERSATIONS-DESIGN.md §2.4, §7.2, §12 (S2
 * REQUIRED 1–3, S2 B4 / B6 / Q6, and S2's post-approval additions).
 *
 * The rls:accept pattern: a throwaway Postgres carrying the committed
 * migration history (scripts/lib/rls-harness.ts — removed with
 * `docker rm -f -v`), real fm_app / fm_system / fm_auth logins, plain SQL for
 * the boundary itself, and then the REAL data module (store.ts through
 * lib/db's fm_app tenant client) and the REAL retention job. Synthetic data
 * only; every key is generated per run.
 *
 *   [sql]   PostgreSQL's boundary: grants, policies, triggers, the definer
 *   [owner] the definer functions owned by a BYPASSRLS NON-superuser (as on
 *           Supabase), and the negative control: a NON-bypass owner ⇒ (0, 0)
 *   [app]   store.ts as fm_app: idempotency, one in-flight turn, caps, abandon,
 *           R2 (only an append moves lastActivityAt), audit without content
 *   [job]   jobs/data-retention.ts with PLATFORM_AI_PURGE_ENABLED: the audited
 *           count equals the rows actually removed
 *   [dispatch] the manual purge dispatch (Preview runs no crons — S2 REQUIRED 2
 *           on #424): the same rule once, as fm_system, audited counts every
 *           run (zero included); --env=production refused before any contact
 *   [export] PR D — the subject-access export: live conversations only
 *           (soft-deleted excluded), read-only; S2 STRICT: a lost area is a
 *           COUNT only, and a decrypt SPY proves none of its rows is decrypted;
 *           through the REAL assembleUserExport (no grant / grant / revoked / regrant)
 *   [purge-health] PR D — the staleness authority over the REAL ledgers
 *   [restore] PR D — the DR rehearsal step: a backup restored into a second
 *           throwaway database brings purged rows back; the pre-enable check and
 *           the purge dispatch against the RESTORED copy remove them, counted
 *   [expiry] expiry on read (20261105120000): expired rows invisible to every
 *           fm_app path (SQL, read, history, list, append, export, settle,
 *           soft delete) before any purge; the definer purge still deletes them;
 *           one pair moved across the 7-day line; the strict read boundary
 *           (purgeAfter = now() + 1 ms visible, = now() hidden, one DB now())
 *   [retention-7d] 20261108120000 (owner 2026-11-08): legacy 90-day rows are
 *           CLAMPED to question createdAt + 7 days, pairs together, never
 *           lengthened, a re-run is a no-op; the settle trigger is back on and
 *           still refuses; the 7-day read boundary; the purge removes them
 *   [pre-disable] PR D — the S2 disable order: the counts-only check FAILS
 *           while rows remain, FAILS CLOSED for a non-bypass reader, PASSES empty
 *
 *   npm run rls:accept:ai-conversations [-- --keep]
 */

import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PLATFORM_AI_RETENTION_DAYS } from "../lib/platform/intelligence/ai/conversations/constants";
import { prepareHarness, assertTenantClientBound, teardownHarness, psql, makeRecorder, deniedByGrant, deniedByRls } from "./lib/rls-harness";

const KEEP = process.argv.includes("--keep");
const { check, report } = makeRecorder();

process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
delete process.env.ENCRYPTION_KEY_PREVIOUS;
// The job case runs the REAL rule; its flag must be on in THIS process only (read at lib/env import).
process.env.PLATFORM_AI_PURGE_ENABLED = "true";

/** The retention window as SQL (= PLATFORM_AI_RETENTION_DAYS = the migration's default and bound). */
const RET = `interval '${PLATFORM_AI_RETENTION_DAYS} days'`;
const A = "aiconv_op_a", B = "aiconv_op_b", C = "aiconv_op_c";
const first = (r: { out: string; err: string }) => r.out.trim() || r.err.split("\n")[0];
const errLine = (r: { err: string }) => r.err.split("\n").find((l) => /ERROR/.test(l)) ?? r.err.split("\n")[0] ?? "";

async function main(): Promise<number> {
  console.log("\n=== PLATFORM AI CONVERSATIONS — REAL-ROLE ACCEPTANCE ===\n");
  const h = prepareHarness("aiconv");
  const owner = h.ownerUrl;
  const one = (sql: string) => { const r = psql(owner, sql); if (!r.ok) throw new Error(`fixture SQL failed: ${r.err}`); return r.out.trim(); };
  const asApp = (user: string, sql: string) => psql(h.appUrl, `BEGIN;\nSET LOCAL app.user_id = '${user}';\n${sql}\nCOMMIT;`, false);
  const asSys = (sql: string) => psql(h.systemUrl, sql, false);
  const asAuth = (sql: string) => psql(h.authUrl, sql, false);

  one(`insert into "User" (id,email,name,"updatedAt") values
    ('${A}','aiconv-a@example.test','Operator A',now()), ('${B}','aiconv-b@example.test','Operator B',now()), ('${C}','aiconv-c@example.test','Operator C',now());`);

  // ── [sql] REQUIRED 1: writers never choose time ────────────────────────────
  console.log("[sql] grants, policies and triggers (as fm_app / fm_system / fm_auth)\n");
  const insA = asApp(A, `insert into "PlatformAiConversation" (id,"operatorUserId",area,"createRequestId") values ('cv_a1','${A}','PLATFORM_OPS','k-a1');`);
  check(1, "fm_app inserts its OWN conversation naming only id / operatorUserId / area / createRequestId", insA.ok, insA.err);
  const ts = one(`select ("createdAt" is not null and "lastActivityAt" = "createdAt")::text from "PlatformAiConversation" where id='cv_a1';`);
  check(2, "createdAt and lastActivityAt are the database's defaults", ts === "true", ts);
  const insForB = asApp(A, `insert into "PlatformAiConversation" (id,"operatorUserId",area,"createRequestId") values ('cv_evil','${B}','PLATFORM_OPS','k-evil');`);
  check(3, "fm_app inserting a conversation for ANOTHER operator ⇒ denied by WITH CHECK", deniedByRls(insForB), errLine(insForB));
  const named = [
    [`insert into "PlatformAiConversation" (id,"operatorUserId",area,"createRequestId","createdAt") values ('cv_t1','${A}','PLATFORM_OPS','k-t1', now() - interval '1 year');`, "conversation createdAt"],
    [`insert into "PlatformAiConversation" (id,"operatorUserId",area,"createRequestId","lastActivityAt") values ('cv_t2','${A}','PLATFORM_OPS','k-t2', now() + interval '1 year');`, "conversation lastActivityAt"],
    [`insert into "PlatformAiConversation" (id,"operatorUserId",area,"createRequestId","deletedAt") values ('cv_t3','${A}','PLATFORM_OPS','k-t3', now());`, "conversation deletedAt"],
    [`insert into "PlatformAiMessage" (id,"conversationId",role,status,"clientRequestId","createdAt") values ('m_t1','cv_a1','USER','COMPLETE','r-t1', now() - interval '1 year');`, "message createdAt"],
    [`insert into "PlatformAiMessage" (id,"conversationId",role,status,"clientRequestId","purgeAfter") values ('m_t2','cv_a1','USER','COMPLETE','r-t2', now() + interval '10 years');`, "message purgeAfter"],
    [`insert into "PlatformAiMessage" (id,"conversationId",role,status,"clientRequestId","completedAt") values ('m_t3','cv_a1','USER','COMPLETE','r-t3', now());`, "message completedAt"],
  ] as const;
  const leaks = named.map(([q, what]) => (deniedByGrant(asApp(A, q)) ? null : what)).filter(Boolean);
  check(4, "fm_app INSERT naming createdAt / lastActivityAt / deletedAt / purgeAfter / completedAt ⇒ permission denied (each)", leaks.length === 0, leaks.join(", "));

  const u1 = asApp(A, `insert into "PlatformAiMessage" (id,"conversationId",role,status,"clientRequestId","contentEncrypted") values ('m_a1u','cv_a1','USER','COMPLETE','r-a1','cipher-a1');`);
  const a1 = asApp(A, `insert into "PlatformAiMessage" (id,"conversationId",role,status,"replyToId") values ('m_a1a','cv_a1','ASSISTANT','PENDING','m_a1u');`);
  check(5, "fm_app appends a USER row and its PENDING ASSISTANT reply", u1.ok && a1.ok, `${u1.err} ${a1.err}`);
  const pa = one(`select ("purgeAfter" = "createdAt" + ${RET})::text from "PlatformAiMessage" where id='m_a1u';`);
  check(6, `purgeAfter = createdAt + ${PLATFORM_AI_RETENTION_DAYS} days (DB default; OD-7 as amended 2026-11-08)`, PLATFORM_AI_RETENTION_DAYS === 7 && pa === "true", pa);
  const moved = one(`select ("lastActivityAt" > "createdAt")::text from "PlatformAiConversation" where id='cv_a1';`);
  check(7, "the USER insert moved lastActivityAt (the DEFINER touch trigger) — fm_app holds no grant on it", moved === "true", moved);
  const upd = [
    [`update "PlatformAiConversation" set "lastActivityAt" = now() + interval '1 year' where id='cv_a1';`, "conversation lastActivityAt"],
    [`update "PlatformAiConversation" set "createdAt" = now() where id='cv_a1';`, "conversation createdAt"],
    [`update "PlatformAiConversation" set area = 'SECURITY_OPS' where id='cv_a1';`, "conversation area"],
    [`update "PlatformAiMessage" set "purgeAfter" = now() + interval '10 years' where id='m_a1u';`, "message purgeAfter"],
    [`update "PlatformAiMessage" set "createdAt" = now() where id='m_a1u';`, "message createdAt"],
    [`update "PlatformAiMessage" set "completedAt" = now() where id='m_a1a';`, "message completedAt"],
  ] as const;
  const updLeaks = upd.map(([q, what]) => (deniedByGrant(asApp(A, q)) ? null : what)).filter(Boolean);
  check(8, "fm_app UPDATE of any timestamp / retention column (or area) ⇒ permission denied (each)", updLeaks.length === 0, updLeaks.join(", "));
  const pend2 = asApp(A, `insert into "PlatformAiMessage" (id,"conversationId",role,status,"clientRequestId") values ('m_a2u','cv_a1','USER','COMPLETE','r-a2');
    insert into "PlatformAiMessage" (id,"conversationId",role,status,"replyToId") values ('m_a2a','cv_a1','ASSISTANT','PENDING','m_a2u');`);
  check(9, "a second PENDING turn in one conversation ⇒ the partial unique index refuses it", /one_pending_per_conversation/.test(pend2.err), errLine(pend2));
  const settle = asApp(A, `update "PlatformAiMessage" set status='COMPLETE', "contentEncrypted"='cipher-ans', "evidenceRefs"='[{"k":"m","id":"provider-outcome@1","w":7}]'::jsonb where id='m_a1a';`);
  const done = one(`select status || '|' || ("completedAt" is not null)::text from "PlatformAiMessage" where id='m_a1a';`);
  check(10, "settling PENDING → COMPLETE as fm_app works, and completedAt is the database's", settle.ok && done === "COMPLETE|true", `${errLine(settle)} ${done}`);
  const reSettle = asApp(A, `update "PlatformAiMessage" set "contentEncrypted"='tampered' where id='m_a1a';`);
  const reStatus = asApp(A, `update "PlatformAiMessage" set status='FAILED', "failureCode"='PROVIDER' where id='m_a1a';`);
  check(11, "a settled message is immutable to fm_app — contentEncrypted alone or status ⇒ 'settled message is immutable'",
    /settled message is immutable/.test(reSettle.err) && /settled message is immutable/.test(reStatus.err) && one(`select "contentEncrypted" from "PlatformAiMessage" where id='m_a1a';`) === "cipher-ans", `${errLine(reSettle)} | ${errLine(reStatus)}`);

  // Ownership.
  const readOwn = asApp(A, `select count(*) from "PlatformAiConversation"; select count(*) from "PlatformAiMessage";`);
  const readB = asApp(B, `select count(*) from "PlatformAiConversation"; select count(*) from "PlatformAiMessage";`);
  check(12, "the OWNER reads their conversation and messages (1, 2)", readOwn.ok && readOwn.out.split("\n").join(",") === "1,2", readOwn.out || readOwn.err);
  check(13, "ANOTHER operator ⇒ 0 conversations and 0 messages, with no predicate at all", readB.ok && readB.out.split("\n").join(",") === "0,0", readB.out || readB.err);
  const bById = asApp(B, `select count(*) from "PlatformAiMessage" where "conversationId"='cv_a1';`);
  const bUpd = asApp(B, `with w as (update "PlatformAiConversation" set "deletedAt" = now() where id='cv_a1' returning 1) select count(*) from w;`);
  const bIns = asApp(B, `insert into "PlatformAiMessage" (id,"conversationId",role,status,"clientRequestId") values ('m_evil','cv_a1','USER','COMPLETE','r-evil');`);
  check(14, "another operator naming the id: SELECT 0 rows, UPDATE 0 rows, INSERT into it denied (no existence oracle)",
    bById.out === "0" && bUpd.ok && bUpd.out === "0" && deniedByRls(bIns) && one(`select ("deletedAt" is null)::text from "PlatformAiConversation" where id='cv_a1';`) === "true", `${bById.out} ${bUpd.out || bUpd.err} ${errLine(bIns)}`);
  const noId = psql(h.appUrl, `select count(*) from "PlatformAiConversation";`, false);
  check(15, "no app.user_id ⇒ 0 rows (fail closed)", noId.ok && noId.out.trim() === "0", first(noId));
  const appDel = asApp(A, `delete from "PlatformAiMessage" where id='m_a1u';`);
  const appDelC = asApp(A, `delete from "PlatformAiConversation" where id='cv_a1';`);
  check(16, "fm_app has NO DELETE on either table (hard deletion is the purge's alone)", deniedByGrant(appDel) && deniedByGrant(appDelC), `${errLine(appDel)} | ${errLine(appDelC)}`);

  // fm_system and fm_auth: nothing.
  const sysProbes = ["select count(*) from \"PlatformAiConversation\";", "select count(*) from \"PlatformAiMessage\";",
    "delete from \"PlatformAiConversation\";", "delete from \"PlatformAiMessage\";", "update \"PlatformAiMessage\" set status='FAILED';",
    `insert into "PlatformAiConversation" (id,"operatorUserId",area,"createRequestId") values ('cv_sys','${A}','PLATFORM_OPS','k-sys');`];
  const sysOpen = sysProbes.filter((q) => !deniedByGrant(asSys(q)));
  check(17, "fm_system SELECT / INSERT / UPDATE / DELETE on both tables ⇒ permission denied (S2 B4)", sysOpen.length === 0, sysOpen.join(" | "));
  const authOpen = ["select count(*) from \"PlatformAiConversation\";", "select count(*) from \"PlatformAiMessage\";"].filter((q) => !deniedByGrant(asAuth(q)));
  check(18, "fm_auth cannot read either table", authOpen.length === 0, authOpen.join(" | "));
  const appPurge = asApp(A, `select * from fm_purge_platform_ai_conversations(10);`);
  const authPurge = asAuth(`select * from fm_purge_platform_ai_conversations(10);`);
  check(19, "fm_app (and fm_auth) cannot EXECUTE the purge function ⇒ permission denied", deniedByGrant(appPurge) && deniedByGrant(authPurge), `${errLine(appPurge)} | ${errLine(authPurge)}`);
  const privs = one(`select string_agg(r || ':' || has_function_privilege(r, 'public.fm_platform_ai_touch_conversation()', 'EXECUTE')::text, ',' order by r) from unnest(array['fm_app','fm_auth','fm_system']) r;`);
  check(20, "nobody (fm_app, fm_auth, fm_system) may EXECUTE the touch trigger function directly (REVOKE ALL FROM PUBLIC)", privs === "fm_app:false,fm_auth:false,fm_system:false", privs);
  const sysLimit = asSys(`select * from fm_purge_platform_ai_conversations(501);`);
  check(21, "fm_system may EXECUTE the purge, and p_limit is bounded (501 ⇒ refused)", /p_limit out of range/.test(sysLimit.err), errLine(sysLimit));

  // Soft delete.
  asApp(A, `insert into "PlatformAiConversation" (id,"operatorUserId",area,"createRequestId") values ('cv_a2','${A}','PLATFORM_OPS','k-a2');`);
  const sd = asApp(A, `update "PlatformAiConversation" set "deletedAt" = now() - interval '30 days' where id='cv_a2';`);
  const sdAt = one(`select (abs(extract(epoch from ("deletedAt" - (now() at time zone 'UTC')))) < 60)::text from "PlatformAiConversation" where id='cv_a2';`);
  check(22, "a soft delete sending a PAST deletedAt stores now() (the trigger's value, not the writer's)", sd.ok && sdAt === "true", `${errLine(sd)} ${sdAt}`);
  const sd2 = asApp(A, `update "PlatformAiConversation" set "deletedAt" = now() where id='cv_a2';`);
  const undel = asApp(A, `update "PlatformAiConversation" set "deletedAt" = null where id='cv_a2';`);
  check(23, "a second delete and an un-delete ⇒ 'conversation already deleted'", /already deleted/.test(sd2.err) && /already deleted/.test(undel.err), `${errLine(sd2)} | ${errLine(undel)}`);
  const appendDeleted = asApp(A, `insert into "PlatformAiMessage" (id,"conversationId",role,status,"clientRequestId") values ('m_dead','cv_a2','USER','COMPLETE','r-dead');`);
  check(24, "a deleted conversation cannot be appended to (the INSERT policy requires a live parent)", deniedByRls(appendDeleted), errLine(appendDeleted));

  // Q6 + shapes.
  asApp(B, `insert into "PlatformAiConversation" (id,"operatorUserId",area,"createRequestId") values ('cv_b1','${B}','PLATFORM_OPS','k-b1');
    insert into "PlatformAiMessage" (id,"conversationId",role,status,"clientRequestId") values ('m_b1u','cv_b1','USER','COMPLETE','r-b1');`);
  one(`insert into "PlatformAiMessage" (id,"conversationId",role,status,"clientRequestId") values ('m_a3u','cv_a1','USER','COMPLETE','r-a3'); select 'ok';`);
  const cross = psql(owner, `insert into "PlatformAiMessage" (id,"conversationId",role,status,"replyToId") values ('m_x','cv_b1','ASSISTANT','PENDING','m_a3u');`, false);
  check(25, "Q6: a reply whose replyToId names a message in ANOTHER conversation ⇒ FK violation (even for the owner)", /foreign key/i.test(cross.err), errLine(cross));
  const noCode = psql(owner, `insert into "PlatformAiMessage" (id,"conversationId",role,status,"replyToId") values ('m_y','cv_b1','ASSISTANT','FAILED','m_b1u');`, false);
  const badCode = psql(owner, `insert into "PlatformAiMessage" (id,"conversationId",role,status,"replyToId","failureCode") values ('m_z','cv_b1','ASSISTANT','FAILED','m_b1u','the provider said: secret');`, false);
  check(26, "Q6: a FAILED row without a code ⇒ CHECK; a code outside the enum ⇒ refused", /failure_shape/.test(noCode.err) && /invalid input value for enum/.test(badCode.err), `${errLine(noCode)} | ${errLine(badCode)}`);
  const shape = psql(owner, `insert into "PlatformAiMessage" (id,"conversationId",role,status,"clientRequestId","replyToId") values ('m_s','cv_b1','USER','COMPLETE','r-s','m_b1u');`, false);
  const orphanA = psql(owner, `insert into "PlatformAiMessage" (id,"conversationId",role,status) values ('m_o','cv_b1','ASSISTANT','PENDING');`, false);
  check(27, "the role shape: a USER row with a reply link, or an ASSISTANT row answering nothing ⇒ CHECK (every reply is reachable by the purge)", /role_shape/.test(shape.err) && /role_shape/.test(orphanA.err), `${errLine(shape)} | ${errLine(orphanA)}`);

  // ── [owner] the definers on a BYPASSRLS NON-superuser, then the negative control ──
  console.log("\n[owner] the definer functions owned as on Supabase (BYPASSRLS, NOT superuser)\n");
  one(`create role fm_aiconv_owner nologin bypassrls nosuperuser; create role fm_aiconv_nobypass nologin nobypassrls nosuperuser;
       grant usage, create on schema public to fm_aiconv_owner, fm_aiconv_nobypass;`);
  const setOwner = (role: string) => one(`alter table "PlatformAiConversation" owner to ${role}; alter table "PlatformAiMessage" owner to ${role};
       alter function public.fm_purge_platform_ai_conversations(integer) owner to ${role};
       alter function public.fm_platform_ai_touch_conversation() owner to ${role};
       select 'ok';`);
  setOwner("fm_aiconv_owner");
  const who = one(`select r.rolname || '|' || r.rolbypassrls::text || '|' || r.rolsuper::text from pg_proc p join pg_roles r on r.oid = p.proowner where p.oid = 'public.fm_purge_platform_ai_conversations(integer)'::regprocedure;`);
  check(28, "the purge function's owner is a BYPASSRLS non-superuser (the Preview shape)", who === "fm_aiconv_owner|true|false", who);
  const doBlock = /DO \$\$\s*BEGIN\s*IF NOT \(SELECT rolbypassrls[\s\S]*?END \$\$;/.exec(readFileSync(path.join(process.cwd(), "prisma/migrations/20261104120000_platform_ai_conversations/migration.sql"), "utf8"))?.[0] ?? "";
  const asNoBypass = psql(owner, `BEGIN; SET LOCAL ROLE fm_aiconv_nobypass; ${doBlock} ROLLBACK;`, false);
  const asBypass = psql(owner, `BEGIN; SET LOCAL ROLE fm_aiconv_owner; ${doBlock} ROLLBACK;`, false);
  check(29, "the migration's DO block ABORTS for a non-bypass principal and passes for a BYPASSRLS one",
    doBlock.length > 0 && /must have BYPASSRLS/.test(asNoBypass.err) && asBypass.ok, `${errLine(asNoBypass)} | ${errLine(asBypass)}`);

  // Two operators' expired and unexpired rows (seeded as the owner — the only role that can set time).
  const seedExchange = (cid: string, n: string, ageSql: string) => `
    insert into "PlatformAiMessage" (id,"conversationId",role,status,"clientRequestId","contentEncrypted","createdAt","purgeAfter")
      values ('${n}u','${cid}','USER','COMPLETE','${n}-k','c-${n}', (now() at time zone 'UTC') - ${ageSql}, (now() at time zone 'UTC') - ${ageSql} + ${RET});
    insert into "PlatformAiMessage" (id,"conversationId",role,status,"replyToId","contentEncrypted","evidenceRefs","createdAt","purgeAfter","completedAt")
      values ('${n}a','${cid}','ASSISTANT','COMPLETE','${n}u','c-${n}a','[]'::jsonb, (now() at time zone 'UTC') - ${ageSql}, (now() at time zone 'UTC') - ${ageSql} + ${RET}, (now() at time zone 'UTC') - ${ageSql});`;
  one(`insert into "PlatformAiConversation" (id,"operatorUserId",area,"createRequestId") values ('cv_pa','${A}','PLATFORM_OPS','k-pa'), ('cv_pb','${B}','SECURITY_OPS','k-pb');
    ${seedExchange("cv_pa", "px_a_old1", "interval '91 days'")} ${seedExchange("cv_pa", "px_a_old2", "interval '120 days'")} ${seedExchange("cv_pa", "px_a_new", "interval '3 days'")}
    ${seedExchange("cv_pb", "px_b_old1", "interval '95 days'")} ${seedExchange("cv_pb", "px_b_new", "interval '1 day'")}
    select 'ok';`);
  const total = () => Number(one(`select count(*) from "PlatformAiMessage";`));
  const before = total();
  const r30 = asSys(`select conversations || '|' || messages from fm_purge_platform_ai_conversations(500);`);
  const removed = before - total();
  const left = one(`select string_agg(id, ',' order by id) from "PlatformAiMessage" where id like 'px_%';`);
  check(30, "fm_system purges BOTH operators' expired exchanges (3 exchanges = 6 rows) under FORCE RLS; unexpired rows remain",
    left === "px_a_newa,px_a_newu,px_b_newa,px_b_newu", left);
  check(31, "the returned `messages` count equals the rows ACTUALLY removed (parents locked FOR UPDATE, replies counted in the same window) — and the seeded expired count",
    r30.ok && r30.out.trim().split("|")[1] === String(removed) && removed === 6 + /* cv_a2 (deleted, grace 0) holds 0 rows */ 0, `${first(r30)} removed=${removed}`);
  check(32, "…and the deleted conversation (grace 0, OD-10 default IMMEDIATE) was purged with it", r30.out.trim().split("|")[0] === "1" && one(`select count(*) from "PlatformAiConversation" where id='cv_a2';`) === "0", first(r30));

  // R6 boundary — 7 d + 1 s purged, 6 d kept, exactly 7 d kept (strict <, the same-transaction clock).
  one(`insert into "PlatformAiConversation" (id,"operatorUserId",area,"createRequestId") values ('cv_bd','${A}','PLATFORM_OPS','k-bd');
    insert into "PlatformAiMessage" (id,"conversationId",role,status,"clientRequestId","createdAt","purgeAfter") values
      ('bd_over','cv_bd','USER','COMPLETE','bd-1', (now() at time zone 'UTC') - ${RET} - interval '1 second', (now() at time zone 'UTC') - interval '1 second'),
      ('bd_under','cv_bd','USER','COMPLETE','bd-2', (now() at time zone 'UTC') - interval '6 days', (now() at time zone 'UTC') - interval '6 days' + ${RET});
    select 'ok';`);
  const exact = psql(owner, `BEGIN;
    insert into "PlatformAiMessage" (id,"conversationId",role,status,"clientRequestId","createdAt","purgeAfter") values
      ('bd_exact','cv_bd','USER','COMPLETE','bd-3', (now() at time zone 'UTC') - ${RET}, (now() at time zone 'UTC'));
    SET LOCAL ROLE fm_system;
    SELECT messages FROM fm_purge_platform_ai_conversations(500);
    RESET ROLE;
    SELECT string_agg(id, ',' order by id) FROM "PlatformAiMessage" WHERE "conversationId" = 'cv_bd';
    ROLLBACK;`, false);
  const [, after] = exact.out.split("\n");
  check(33, "R6 boundary: 7 d + 1 s ⇒ purged; 6 d ⇒ kept; EXACTLY 7 d ⇒ kept (strict <, same clock)", exact.ok && after === "bd_exact,bd_under", `${exact.out.replace(/\n/g, " / ")} ${errLine(exact)}`);
  // Shells.
  one(`insert into "PlatformAiConversation" (id,"operatorUserId",area,"createRequestId","createdAt") values ('cv_shell_old','${B}','PLATFORM_OPS','k-so', (now() at time zone 'UTC') - interval '2 days'),
    ('cv_shell_new','${B}','PLATFORM_OPS','k-sn', (now() at time zone 'UTC') - interval '1 hour'); select 'ok';`);
  const r34 = asSys(`select conversations || '|' || messages from fm_purge_platform_ai_conversations(500);`);
  const shells = one(`select string_agg(id, ',' order by id) from "PlatformAiConversation" where id like 'cv_shell_%' or id = 'cv_bd';`);
  check(34, "an empty shell older than a day is purged; a just-created one is kept (a create in flight is never raced)",
    r34.ok && shells === "cv_bd,cv_shell_new", `${first(r34)} ${shells}`);

  // Negative control: a NON-bypass owner sees and deletes NOTHING under FORCE RLS.
  one(`${seedExchange("cv_pb", "nc_old", "interval '100 days'")} select 'ok';`);
  setOwner("fm_aiconv_nobypass");
  const nc = asSys(`select conversations || '|' || messages from fm_purge_platform_ai_conversations(500);`);
  const stillThere = one(`select count(*) from "PlatformAiMessage" where id like 'nc_old%';`);
  check(35, "NEGATIVE CONTROL: owned by a role WITHOUT BYPASSRLS the purge returns (0, 0) and deletes nothing — the fail-open the DO block prevents",
    nc.ok && nc.out.trim() === "0|0" && stillThere === "2", `${first(nc)} left=${stillThere}`);
  const tBefore = one(`select "lastActivityAt"::text from "PlatformAiConversation" where id='cv_b1';`);
  asApp(B, `insert into "PlatformAiMessage" (id,"conversationId",role,status,"clientRequestId") values ('m_b2u','cv_b1','USER','COMPLETE','r-b2');`);
  const tAfter = one(`select "lastActivityAt"::text from "PlatformAiConversation" where id='cv_b1';`);
  check(36, "NEGATIVE CONTROL: the touch trigger owned by a non-bypass role silently updates 0 rows (lastActivityAt unchanged)", tBefore === tAfter, `${tBefore} → ${tAfter}`);
  setOwner("fm_aiconv_owner");
  const t2 = asApp(B, `insert into "PlatformAiMessage" (id,"conversationId",role,status,"clientRequestId") values ('m_b3u','cv_b1','USER','COMPLETE','r-b3');`);
  const tAfter2 = one(`select "lastActivityAt"::text from "PlatformAiConversation" where id='cv_b1';`);
  const ncAgain = asSys(`select messages from fm_purge_platform_ai_conversations(500);`);
  check(37, "…and back under the BYPASSRLS owner both work again (touch moves it; the purge removes the 2 rows)",
    t2.ok && tAfter2 > tAfter && ncAgain.out.trim() === "2" && one(`select count(*) from "PlatformAiMessage" where id like 'nc_old%';`) === "0", `${tAfter2} ${first(ncAgain)}`);

  // The rotation's narrow path, both directions, on a settled row (design §2.3).
  const rotOk = psql(owner, `BEGIN; SET LOCAL ROLE fm_aiconv_owner; UPDATE "PlatformAiMessage" SET "contentEncrypted" = 'rotated-v3' WHERE id = 'm_a1a'; COMMIT;`, false);
  const rotVal = one(`select "contentEncrypted" from "PlatformAiMessage" where id='m_a1a';`);
  check(38, "ROTATION: a BYPASSRLS principal changes contentEncrypted ALONE on a settled row", rotOk.ok && rotVal === "rotated-v3", `${errLine(rotOk)} ${rotVal}`);
  const rotStatus = psql(owner, `BEGIN; SET LOCAL ROLE fm_aiconv_owner; UPDATE "PlatformAiMessage" SET status = 'FAILED', "failureCode" = 'PROVIDER' WHERE id = 'm_a1a'; COMMIT;`, false);
  const rotRefs = psql(owner, `BEGIN; SET LOCAL ROLE fm_aiconv_owner; UPDATE "PlatformAiMessage" SET "contentEncrypted" = 'x', "evidenceRefs" = '[]'::jsonb WHERE id = 'm_a1a'; COMMIT;`, false);
  const rotTime = psql(owner, `BEGIN; SET LOCAL ROLE fm_aiconv_owner; UPDATE "PlatformAiMessage" SET "purgeAfter" = "purgeAfter" - interval '1 day' WHERE id = 'm_a1a'; COMMIT;`, false);
  check(39, "ROTATION: the BYPASSRLS principal changing status, evidenceRefs or a retention column ⇒ 'settled message is immutable'",
    [rotStatus, rotRefs, rotTime].every((r) => /settled message is immutable/.test(r.err)) && one(`select "contentEncrypted" from "PlatformAiMessage" where id='m_a1a';`) === "rotated-v3",
    [rotStatus, rotRefs, rotTime].map(errLine).join(" | "));
  const rotApp = asApp(A, `update "PlatformAiMessage" set "contentEncrypted" = 'app-rotate' where id='m_a1a';`);
  check(40, "ROTATION: fm_app cannot use the path (contentEncrypted alone on a settled row ⇒ refused)", /settled message is immutable/.test(rotApp.err), errLine(rotApp));

  // ── [app] the REAL data module through lib/db's fm_app client ──────────────
  console.log("\n[app] store.ts through the bound fm_app tenant client\n");
  await assertTenantClientBound();
  const store = await import("@/lib/platform/intelligence/ai/conversations/store");
  const enc = await import("@/lib/plaid/encryption");
  const NOW = () => new Date();
  const k1 = randomUUID();
  const q1 = "How many provider incidents are broken right now?";
  const c1 = await store.createConversation({ operatorId: A, area: "PLATFORM_OPS", createRequestId: k1, scrubbedQuestion: q1 });
  check(41, "createConversation ⇒ CREATED with a USER row and a PENDING reply", c1.kind === "CREATED" && c1.pair.user.status === "COMPLETE" && c1.pair.assistant.status === "PENDING", c1.kind);
  if (c1.kind !== "CREATED") return report("PLATFORM AI CONVERSATIONS ACCEPTANCE");
  const cid = c1.conversation.id;
  const rowsAfterCreate = total();
  const c1r = await store.createConversation({ operatorId: A, area: "PLATFORM_OPS", createRequestId: k1, scrubbedQuestion: "different text" });
  check(42, "a replay of the same createRequestId ⇒ REPLAY, the SAME ids, nothing written", c1r.kind === "REPLAY" && c1r.conversation.id === cid && c1r.pair.user.id === c1.pair.user.id && total() === rowsAfterCreate);
  const stored = one(`select "contentEncrypted" from "PlatformAiMessage" where id='${c1.pair.user.id}';`);
  check(43, "content is stored ENCRYPTED (v2 outside a rotation) under PLATFORM_AI_MESSAGE, and decrypts to the scrubbed question exactly",
    stored.startsWith("v2:") && !stored.includes("provider") && enc.decryptWithPurpose(stored, enc.EncryptionPurpose.PLATFORM_AI_MESSAGE) === q1);
  const audit = one(`select count(*) || '|' || coalesce(max(metadata::text), '') from "AuditLog" where action='PLATFORM_AI_CONVERSATION_CREATED' and metadata->'target'->>'id' = '${cid}';`);
  check(44, "the CREATED audit row is written in the same transaction, with area and NO content", audit.startsWith("1|") && audit.includes("PLATFORM_OPS") && !audit.includes("provider incidents"), audit);
  const inflight = await store.appendTurn({ operatorId: A, conversationId: cid, clientRequestId: randomUUID(), scrubbedQuestion: "next?", now: NOW() });
  check(45, "appendTurn while the first turn is PENDING ⇒ IN_FLIGHT", inflight.kind === "IN_FLIGHT", inflight.kind);
  const settled = await store.settleTurn(A, cid, c1.pair.assistant.id, {
    status: "COMPLETE",
    answer: { v: 1, segments: [{ kind: "text", text: "There are " }, { kind: "figure", text: "2", metric: "incident-broken-now@1", window: null }, { kind: "text", text: " broken now." }], citations: [{ metric: "incident-broken-now@1", label: "Broken now", window: "now" }], notes: [], stop: "ANSWERED" },
    evidenceRefs: [{ k: "m", id: "incident-broken-now@1", w: null }],
  });
  const settleTwice = await store.settleTurn(A, cid, c1.pair.assistant.id, { status: "FAILED", failureCode: "PROVIDER" });
  check(46, "settleTurn COMPLETE once (true), and a second settle is a no-op (false) — no overwrite", settled && !settleTwice);
  const lastAct0 = one(`select "lastActivityAt"::text from "PlatformAiConversation" where id='${cid}';`);
  await store.listLiveConversations(A);
  await store.readConversation(A, cid, NOW());
  await store.createConversation({ operatorId: A, area: "PLATFORM_OPS", createRequestId: k1, scrubbedQuestion: q1 });
  check(47, "R2: a list, a read and a replay never move lastActivityAt", one(`select "lastActivityAt"::text from "PlatformAiConversation" where id='${cid}';`) === lastAct0);
  const kA = randomUUID(), kB = randomUUID();
  const [p1, p2] = await Promise.all([
    store.appendTurn({ operatorId: A, conversationId: cid, clientRequestId: kA, scrubbedQuestion: "first concurrent", now: NOW() }),
    store.appendTurn({ operatorId: A, conversationId: cid, clientRequestId: kB, scrubbedQuestion: "second concurrent", now: NOW() }),
  ]);
  check(48, "two concurrent appends ⇒ exactly one APPENDED and one IN_FLIGHT (one in-flight turn, on real PG)",
    [p1.kind, p2.kind].sort().join() === "APPENDED,IN_FLIGHT", `${p1.kind}/${p2.kind}`);
  check(49, "R2: the append (a USER insert) DID move lastActivityAt", one(`select "lastActivityAt"::text from "PlatformAiConversation" where id='${cid}';`) > lastAct0);
  const appended = p1.kind === "APPENDED" ? p1 : p2;
  const winnerKey = p1.kind === "APPENDED" ? kA : kB;
  const replay = await store.appendTurn({ operatorId: A, conversationId: cid, clientRequestId: winnerKey, scrubbedQuestion: "x", now: NOW() });
  check(50, "an append replay of a known clientRequestId ⇒ REPLAY of the same pair (PENDING ⇒ the route answers 409)",
    replay.kind === "REPLAY" && appended.kind === "APPENDED" && replay.pair.user.id === appended.pair.user.id && replay.pair.assistant.status === "PENDING");
  // Abandon: age the PENDING reply past 2 × the turn timeout (owner; a PENDING row may change).
  if (appended.kind === "APPENDED") one(`update "PlatformAiMessage" set "createdAt" = "createdAt" - interval '5 minutes', "purgeAfter" = "purgeAfter" - interval '5 minutes' where id='${appended.pair.assistant.id}'; select 'ok';`);
  const readBack = await store.readConversation(A, cid, NOW());
  const ab = readBack?.messages.find((m) => appended.kind === "APPENDED" && m.id === appended.pair.assistant.id);
  check(51, "a PENDING turn older than 2 × the turn timeout is marked FAILED / ABANDONED on the next read (completedAt set)",
    ab?.status === "FAILED" && ab.failureCode === "ABANDONED" && ab.completedAt !== null, JSON.stringify(ab ?? null));
  const answerMsg = readBack?.messages.find((m) => m.id === c1.pair.assistant.id);
  check(52, "the settled answer reads back as the typed stored answer (figure kept typed) with its evidence refs",
    !!answerMsg && typeof answerMsg.content === "object" && answerMsg.content !== null && (answerMsg.content as { segments: Array<{ kind: string }> }).segments.some((s) => s.kind === "figure") && answerMsg.evidenceRefs.length === 1);
  check(53, "another operator reads NOTHING of it through the module (findLive / read / history ⇒ null, list excludes it)",
    (await store.findLiveConversation(B, cid)) === null && (await store.readConversation(B, cid, NOW())) === null && (await store.loadConversationHistory(B, cid)) === null
      && !(await store.listLiveConversations(B)).some((c) => c.id === cid));
  const hist = await store.loadConversationHistory(A, cid);
  check(54, "loadConversationHistory returns ONE conversation's COMPLETE messages only", !!hist && hist.length > 0 && hist.every((m) => m.conversationId === cid && m.status === "COMPLETE"));
  const listed = (await store.listLiveConversations(A)).find((c) => c.id === cid);
  check(55, "the list's label source is the earliest USER message, decrypted (already scrubbed)", listed?.firstQuestion === q1, listed?.firstQuestion ?? "none");

  // The message cap (40, FAILED rows count) and the conversation cap (50).
  const capConv = await store.createConversation({ operatorId: C, area: "PLATFORM_OPS", createRequestId: randomUUID(), scrubbedQuestion: "cap" });
  if (capConv.kind === "CREATED") {
    await store.settleTurn(C, capConv.conversation.id, capConv.pair.assistant.id, { status: "FAILED", failureCode: "TIMEOUT" });
    let fill = "";
    for (let i = 0; i < 18; i++) fill += seedExchange(capConv.conversation.id, `cap${i}`, `interval '${i + 1} minutes'`);
    one(`${fill} select 'ok';`);
    const at38 = await store.appendTurn({ operatorId: C, conversationId: capConv.conversation.id, clientRequestId: randomUUID(), scrubbedQuestion: "39th and 40th", now: NOW() });
    if (at38.kind === "APPENDED") await store.settleTurn(C, capConv.conversation.id, at38.pair.assistant.id, { status: "FAILED", failureCode: "PROVIDER" });
    const at40 = await store.appendTurn({ operatorId: C, conversationId: capConv.conversation.id, clientRequestId: randomUUID(), scrubbedQuestion: "41st", now: NOW() });
    check(56, "the 40-message cap: 38 rows (FAILED counted) ⇒ one more exchange; 40 ⇒ FULL", at38.kind === "APPENDED" && at40.kind === "FULL", `${at38.kind}/${at40.kind}`);
  } else check(56, "the 40-message cap", false, capConv.kind);
  let created = 1;
  for (; created < 51; created++) {
    const r = await store.createConversation({ operatorId: C, area: "PLATFORM_OPS", createRequestId: randomUUID(), scrubbedQuestion: `q${created}` });
    if (r.kind !== "CREATED") break;
  }
  const over = await store.createConversation({ operatorId: C, area: "PLATFORM_OPS", createRequestId: randomUUID(), scrubbedQuestion: "51st" });
  check(57, "the 50-conversation cap: the 51st live create ⇒ LIMIT", created === 50 && over.kind === "LIMIT", `${created} ${over.kind}`);

  // Soft delete through the module.
  const del = await store.softDeleteConversation(A, cid);
  const delAudit = one(`select coalesce(max(metadata::text), '') from "AuditLog" where action='PLATFORM_AI_CONVERSATION_DELETED' and metadata->'target'->>'id' = '${cid}';`);
  check(58, "softDeleteConversation hides it at once (findLive null, list excludes) and audits area + messageCount, no content",
    del.deleted && (await store.findLiveConversation(A, cid)) === null && !(await store.listLiveConversations(A)).some((c) => c.id === cid)
      && /"messageCount":\s*\d+/.test(delAudit) && !delAudit.includes("provider incidents"), delAudit);
  check(59, "a second soft delete through the module ⇒ not deleted (invisible)", !(await store.softDeleteConversation(A, cid)).deleted);

  // ── [export] PR D — the subject-access export (design §7.3, S2 Q5; REQUIRED 4) ──
  console.log("\n[export] the operator's own data export: live conversations only, decrypted, Q5 projection\n");
  {
    const { projectPlatformAiConversationsForExport } = await import("@/lib/platform/intelligence/ai/conversations/export");
    const qx = "Export me: how many sync incidents opened today?";
    const cx = await store.createConversation({ operatorId: A, area: "PLATFORM_OPS", createRequestId: randomUUID(), scrubbedQuestion: qx });
    if (cx.kind === "CREATED") {
      await store.settleTurn(A, cx.conversation.id, cx.pair.assistant.id, {
        status: "COMPLETE",
        answer: { v: 1, segments: [{ kind: "text", text: "EXPORT-ANSWER-TEXT " }, { kind: "figure", text: "4", metric: "incident-broken-now@1", window: null }], citations: [], notes: [], stop: "ANSWERED" },
        evidenceRefs: [],
      });
    }
    // A PENDING turn older than the abandon window: the export must NOT settle it (read-only).
    const cp = await store.createConversation({ operatorId: A, area: "SECURITY_OPS", createRequestId: randomUUID(), scrubbedQuestion: "Export pending question" });
    if (cp.kind === "CREATED") one(`update "PlatformAiMessage" set "createdAt" = "createdAt" - interval '5 minutes', "purgeAfter" = "purgeAfter" - interval '5 minutes' where id='${cp.pair.assistant.id}'; select 'ok';`);
    const liveA = one(`select string_agg(id, ',' order by id) from "PlatformAiConversation" where "operatorUserId"='${A}' and "deletedAt" is null;`);
    const opsA = one(`select string_agg(id, ',' order by id) from "PlatformAiConversation" where "operatorUserId"='${A}' and "deletedAt" is null and area='PLATFORM_OPS';`);
    const secCount = Number(one(`select count(*) from "PlatformAiConversation" where "operatorUserId"='${A}' and "deletedAt" is null and area='SECURITY_OPS';`));
    const secCipher = new Set(one(`select coalesce(string_agg(m."contentEncrypted", E'\\n'), '') from "PlatformAiMessage" m join "PlatformAiConversation" c on c.id = m."conversationId" where c."operatorUserId"='${A}' and c.area='SECURITY_OPS' and m."contentEncrypted" is not null;`).split("\n").filter(Boolean));
    const beforeRows = total();
    const actBefore = one(`select string_agg("lastActivityAt"::text, ',' order by id) from "PlatformAiConversation";`);
    const seen: string[] = [];
    const spy = (c: string) => { seen.push(c); return enc.decryptWithPurpose(c, enc.EncryptionPurpose.PLATFORM_AI_MESSAGE); };
    const held = new Set(["PLATFORM_OPS"] as const);
    const ex = await store.readConversationsForExport(A, held, { decrypt: spy });
    check(66, "readConversationsForExport = EXACTLY the operator's LIVE conversations of the HELD area in full (the soft-deleted one EXCLUDED); the lost area a COUNT",
      ex.conversations.map((c) => c.id).sort().join(",") === opsA && !ex.conversations.some((c) => c.id === cid) && cx.kind === "CREATED"
        && JSON.stringify(ex.omitted) === JSON.stringify([{ area: "SECURITY_OPS", count: secCount }]) && secCount > 0 && liveA.split(",").length === ex.conversations.length + secCount,
      `${ex.conversations.map((c) => c.id).sort().join(",")} vs ${opsA}; omitted=${JSON.stringify(ex.omitted)} sec=${secCount}`);
    const mine = ex.conversations.find((c) => cx.kind === "CREATED" && c.id === cx.conversation.id);
    check(67, "…the held conversations decrypt inside the module: the scrubbed question and the typed answer read back",
      mine?.messages[0]?.content === qx && typeof mine?.messages[1]?.content === "object", JSON.stringify(mine?.messages.map((m) => m.role)));
    check(68, "S2 STRICT — the decrypt SPY: NOT ONE lost-area (SECURITY_OPS) ciphertext reached the decrypt; only held-area rows did",
      secCipher.size > 0 && seen.length > 0 && !seen.some((c) => secCipher.has(c)), `seen=${seen.length} lostCiphers=${secCipher.size}`);
    check(69, "the export WROTE nothing: no row added or removed, no lastActivityAt moved, the stale PENDING reply still PENDING",
      total() === beforeRows && one(`select string_agg("lastActivityAt"::text, ',' order by id) from "PlatformAiConversation";`) === actBefore
        && (cp.kind !== "CREATED" || one(`select status::text from "PlatformAiMessage" where id='${cp.pair.assistant.id}';`) === "PENDING"));
    const exB = await store.readConversationsForExport(B, new Set(["PLATFORM_OPS", "SECURITY_OPS"] as const));
    check(70, "another operator's export carries NONE of A's conversations (owner-only RLS + the owner predicate)",
      !exB.conversations.some((c) => ex.conversations.some((x) => x.id === c.id)) && exB.conversations.every((c) => one(`select "operatorUserId" from "PlatformAiConversation" where id='${c.id}';`) === B));

    // The REAL assembler, end to end (POST /api/user/export's body): A holds NO grant yet ⇒ counts only.
    const { assembleUserExport } = await import("@/lib/export/assemble");
    const quietly = async <T,>(f: () => Promise<T>): Promise<T> => { const o = { log: console.log, error: console.error, warn: console.warn }; console.log = () => {}; console.error = () => {}; console.warn = () => {}; try { return await f(); } finally { Object.assign(console, o); } };
    const allLive = liveA.split(",").length;
    const noGrant = await quietly(() => assembleUserExport(A));
    const ng = JSON.stringify({ c: noGrant.platformAiConversations, o: noGrant.platformAiConversationsOmitted, n: noGrant.manifest.notes });
    check(71, "assembleUserExport, NO grant: NO conversation content at all (no question, answer or label) — per-area counts + the S2 line + manifest counts",
      noGrant.platformAiConversations.length === 0 && noGrant.platformAiConversationsOmitted.reduce((n, o) => n + o.count, 0) === allLive
        && !ng.includes(qx) && !ng.includes("EXPORT-ANSWER-TEXT") && !ng.includes("Export pending question") && !ng.includes(cid)
        && noGrant.manifest.counts["platformAiConversationsOmitted:SECURITY_OPS"] === secCount
        && noGrant.manifest.notes.some((n) => new RegExp(`^Platform AI: ${secCount} conversations? in .+ omitted: you no longer have access\\.$`).test(n)), ng.slice(0, 400));
    one(`insert into "Space" (id,name,"platformArea","updatedAt") values ('sp_aiconv_ops','Platform Ops','PLATFORM_OPS',now());
      insert into "PlatformGrant" (id,"userId",area,level,"updatedAt") values ('pg_aiconv_a','${A}','PLATFORM_OPS','READ',now()); select 'ok';`);
    const withGrant = await quietly(() => assembleUserExport(A));
    const wg = JSON.stringify(withGrant.platformAiConversations);
    check(72, "…an ACTIVE PLATFORM_OPS grant: that area exports in full; SECURITY_OPS (not held) is a count only, its question absent",
      wg.includes("EXPORT-ANSWER-TEXT 4") && wg.includes(qx) && withGrant.platformAiConversations.every((c) => c.area === "PLATFORM_OPS")
        && !JSON.stringify(withGrant).includes("Export pending question") && withGrant.manifest.counts["platformAiConversationsOmitted:SECURITY_OPS"] === secCount, wg.slice(0, 300));
    one(`update "PlatformGrant" set status='REVOKED', "revokedAt"=now() where id='pg_aiconv_a'; select 'ok';`);
    const revoked = await quietly(() => assembleUserExport(A));
    check(73, "…the grant REVOKED ⇒ count only again (nothing of that area's content)",
      revoked.platformAiConversations.length === 0 && !JSON.stringify(revoked).includes(qx) && revoked.manifest.counts["platformAiConversationsOmitted:PLATFORM_OPS"] === opsA.split(",").length);
    one(`update "PlatformGrant" set status='ACTIVE', "revokedAt"=null where id='pg_aiconv_a'; select 'ok';`);
    const regranted = await quietly(() => assembleUserExport(A));
    check(74, "…REGRANTED ⇒ the full export of that area is restored; another operator's full export never carries A's conversations",
      JSON.stringify(regranted.platformAiConversations).includes("EXPORT-ANSWER-TEXT 4")
        && !(await quietly(() => assembleUserExport(B))).platformAiConversations.some((c) => ex.conversations.some((x) => x.id === c.id)));
  }

  // ── REQUIRED 3: account purge by FK cascade, as the account purge's role (fm_system) ──
  const cBefore = one(`select count(*) from "PlatformAiConversation" where "operatorUserId"='${C}';`);
  const userDel = asSys(`delete from "User" where id='${C}';`);
  const cAfter = one(`select count(*) || '|' || (select count(*) from "PlatformAiMessage" m where not exists (select 1 from "PlatformAiConversation" c where c.id = m."conversationId")) from "PlatformAiConversation" where "operatorUserId"='${C}';`);
  check(60, "REQUIRED 3: deleting the User as fm_system (the account purge's role) under FORCE RLS cascades — 0 conversations, 0 messages left",
    Number(cBefore) >= 50 && userDel.ok && cAfter === "0|0", `${cBefore} ${errLine(userDel)} ${cAfter}`);

  // ── [job] the REAL retention rule: audited count == rows actually removed ──
  console.log("\n[job] jobs/data-retention.ts with PLATFORM_AI_PURGE_ENABLED=true (this process only)\n");
  one(`insert into "PlatformAiConversation" (id,"operatorUserId",area,"createRequestId") values ('cv_job','${B}','PLATFORM_OPS','k-job');
    ${seedExchange("cv_job", "job1", "interval '91 days'")} ${seedExchange("cv_job", "job2", "interval '200 days'")} ${seedExchange("cv_job", "job3", "interval '5 days'")}
    select 'ok';`);
  // What the run must remove: the 2 expired exchanges (4 rows) + every message of a conversation
  // soft-deleted above (grace 0) — computed from the data, then compared with the audit.
  const expected = 4 + Number(one(`select count(*) from "PlatformAiMessage" m join "PlatformAiConversation" c on c.id = m."conversationId" where c."deletedAt" is not null;`));
  const jobBefore = total();
  const { runDataRetention } = await import("../jobs/data-retention");
  const orig = { log: console.log, error: console.error };
  console.log = () => {}; console.error = () => {};
  let jr: Awaited<ReturnType<typeof runDataRetention>>;
  try { jr = await runDataRetention(); } finally { console.log = orig.log; console.error = orig.error; }
  const jobRemoved = jobBefore - total();
  const jobAudit = one(`select coalesce(max(metadata::text), '') from "AuditLog" where action='PLATFORM_AI_CONVERSATIONS_PURGED';`);
  const meta = jobAudit ? JSON.parse(jobAudit) as Record<string, unknown> : {};
  const jobLeft = one(`select string_agg(id, ',' order by id) from "PlatformAiMessage" where id like 'job%';`);
  check(61, "the job's audited `messages` equals the rows actually removed (the expired exchanges + the deleted conversation's messages), counts only, no userId",
    jr.platformAiConversations?.error === undefined && jr.platformAiConversations?.messages === jobRemoved && jobRemoved === expected && meta.messages === jobRemoved
      && jobLeft === "job3a,job3u" && one(`select count(*) from "PlatformAiConversation" where id='${cid}';`) === "0"
      && Object.keys(meta).sort().join() === "actorType,batches,conversations,exhausted,messages"
      && one(`select count(*) from "AuditLog" where action='PLATFORM_AI_CONVERSATIONS_PURGED' and "userId" is not null;`) === "0", `${JSON.stringify(jr.platformAiConversations)} removed=${jobRemoved} audit=${jobAudit}`);

  // ── [dispatch] the manual purge dispatch — the job's own rule, once, audited ──
  console.log("\n[dispatch] scripts/platform-ai-conversations-purge-dispatch.ts (a child process; PLATFORM_AI_PURGE_ENABLED UNSET there)\n");
  const dispatch = (...args: string[]) => {
    const env = { ...process.env, FM_PRODUCTION_DB_REF: "prodprojectref0000001" } as NodeJS.ProcessEnv;
    delete env.PLATFORM_AI_PURGE_ENABLED; delete env.VERCEL_ENV;
    return spawnSync(process.execPath, [...process.execArgv, path.join(process.cwd(), "scripts/platform-ai-conversations-purge-dispatch.ts"), ...args], { encoding: "utf8", env });
  };
  const auditRows = () => Number(one(`select count(*) from "AuditLog" where action='PLATFORM_AI_CONVERSATIONS_PURGED';`));
  const lastManual = () => one(`select coalesce((select metadata::text from "AuditLog" where action='PLATFORM_AI_CONVERSATIONS_PURGED' and metadata->>'trigger'='MANUAL_DISPATCH' order by "createdAt" desc, id desc limit 1), '');`);
  const auditsBefore = auditRows();
  const refusedRun = dispatch("--env=production");
  check(62, "the dispatch with --env=production ⇒ exit 2, REFUSED before any contact, no audit row",
    refusedRun.status === 2 && /nothing was contacted/.test(refusedRun.stderr) && auditRows() === auditsBefore, `${refusedRun.status} ${refusedRun.stderr.slice(0, 200)}`);
  one(`insert into "PlatformAiConversation" (id,"operatorUserId",area,"createRequestId") values ('cv_dsp','${B}','PLATFORM_OPS','k-dsp');
    ${seedExchange("cv_dsp", "dsp1", "interval '95 days'")} ${seedExchange("cv_dsp", "dsp2", "interval '3 days'")}
    select 'ok';`);
  const dspBefore = total();
  const run1 = dispatch("--env=local");
  const dspRemoved = dspBefore - total();
  const m1 = lastManual() ? JSON.parse(lastManual()) as Record<string, unknown> : {};
  check(63, "the dispatch with --env=local (flag UNSET in its process) purges the expired exchange as fm_system: removed == audited `messages` == printed count, counts only",
    run1.status === 0 && dspRemoved === 2 && m1.messages === 2 && m1.trigger === "MANUAL_DISPATCH" && m1.actorType === "SYSTEM"
      && Object.keys(m1).sort().join() === "actorType,batches,conversations,exhausted,messages,trigger"
      && /messages removed:\s+2\b/.test(run1.stdout) && one(`select string_agg(id, ',' order by id) from "PlatformAiMessage" where id like 'dsp%';`) === "dsp2a,dsp2u",
    `${run1.status} removed=${dspRemoved} audit=${JSON.stringify(m1)} ${run1.stderr.slice(0, 300)}`);
  const n1 = auditRows();
  const run2 = dispatch("--env=local");
  const m2 = lastManual() ? JSON.parse(lastManual()) as Record<string, unknown> : {};
  check(64, "a second dispatch with nothing expired ⇒ exit 0 and STILL one counts-only audit row (zeros) — proof of the daily cadence; no userId on any",
    run2.status === 0 && auditRows() === n1 + 1 && m2.messages === 0 && m2.conversations === 0
      && one(`select count(*) from "AuditLog" where action='PLATFORM_AI_CONVERSATIONS_PURGED' and "userId" is not null;`) === "0",
    `${run2.status} ${JSON.stringify(m2)} ${run2.stderr.slice(0, 300)}`);

  // ── [turn] the B11 turn integration through the REAL store (handlers over fm_app) ──
  console.log("\n[turn] handleCreateConversation / handleAppendMessage over the real store (a scripted turn)\n");
  {
    const { handleCreateConversation, handleAppendMessage } = await import("@/lib/platform/intelligence/ai/conversations/handlers");
    const turns: string[] = [];
    const binding = {} as never;
    const answerV1 = { v: 1 as const, segments: [{ kind: "text" as const, text: "AI cost " }, { kind: "figure" as const, text: "$1.50 (in the last 7 days, estimated)", metric: "economics-ai-cost@1", window: 7 },
      { kind: "text" as const, text: ". See " }, { kind: "link" as const, text: "Economics", page: "PLATFORM_OPS:platform-economics", params: {} }], citations: [], notes: [], stop: "ANSWERED" as const };
    const deps = {
      store, now: () => new Date(),
      areaAccess: async () => ({ resolvePage: () => null, binding }),
      admission: async () => ({ paused: false }), freeze: async () => ({ frozen: false }), turns: async () => ({ allowed: true }),
      runTurn: async ({ question }: { question: string }) => { turns.push(question); return { status: "COMPLETE" as const, answer: answerV1, evidenceRefs: [{ k: "m" as const, id: "economics-ai-cost@1", w: 7 }] }; },
    };
    const V = { operatorId: B, area: "PLATFORM_OPS" as const };
    const ck = randomUUID();
    const cr = await handleCreateConversation(V, { clientRequestId: ck, question: "What's costing me the most money?" }, deps);
    const conv = (cr.body as { conversation?: { id: string } } | null)?.conversation?.id ?? "";
    const settledRow = one(`select status || '|' || ("evidenceRefs" = '[{"k":"m","id":"economics-ai-cost@1","w":7}]'::jsonb)::text || '|' || ("completedAt" is not null)::text from "PlatformAiMessage" where "conversationId"='${conv}' and role='ASSISTANT';`);
    check(65, "create on real PG: stored (tx 1) → the turn → settled COMPLETE (tx 2) with keys + windows only as evidence; 201 carries the settled reply",
      cr.status === 201 && (cr.body as { assistantMessage: { status: string } }).assistantMessage.status === "COMPLETE" && turns.length === 1 && settledRow === "COMPLETE|true|true", `${cr.status} ${settledRow}`);
    const replayBefore = turns.length;
    const cr2 = await handleCreateConversation(V, { clientRequestId: ck, question: "What's costing me the most money?" }, { ...deps, admission: async () => { throw new Error("no gate on replay"); }, turns: async () => { throw new Error("no daily turn on replay"); } });
    check(92, "a create REPLAY on real PG ⇒ 200, the same conversation, no gate, no turn, nothing written",
      cr2.status === 200 && (cr2.body as { conversation: { id: string } }).conversation.id === conv && turns.length === replayBefore
        && one(`select count(*) from "PlatformAiMessage" where "conversationId"='${conv}';`) === "2", `${cr2.status}`);
    const mk = randomUUID();
    const ap = await handleAppendMessage(V, conv, { clientRequestId: mk, question: "How does that compare with last month?" }, deps);
    const ap2 = await handleAppendMessage(V, conv, { clientRequestId: mk, question: "How does that compare with last month?" }, { ...deps, admission: async () => { throw new Error("no gate on replay"); } });
    const readBack = await store.readConversation(B, conv, new Date());
    const lastA = readBack?.messages.filter((m) => m.role === "ASSISTANT").at(-1);
    check(93, "append on real PG: 200 with the settled typed answer (figure typed, link as a page id); its replay ⇒ 200, no gate, no second turn; 4 rows",
      ap.status === 200 && ap2.status === 200 && turns.length === replayBefore + 1 && readBack?.messages.length === 4 && lastA?.status === "COMPLETE"
        && typeof lastA.content === "object" && lastA.content !== null && (lastA.content as typeof answerV1).segments.some((x) => x.kind === "figure" && x.window === 7)
        && (lastA.content as typeof answerV1).segments.some((x) => x.kind === "link" && x.page === "PLATFORM_OPS:platform-economics"), `${ap.status} ${ap2.status} ${turns.length}`);
  }

  // ── the read-only pre-enable check, against this throwaway target ─────────
  const { PRECHECK_FUNCTIONS_SQL, PRECHECK_POLICIES_SQL, PRECHECK_TABLES_SQL, evaluatePrecheck } = await import("./lib/platform-ai-conversations-precheck.core");
  type Pre = typeof import("./lib/platform-ai-conversations-precheck.core");
  type FnRows = Parameters<Pre["evaluatePrecheck"]>[0];
  type TabRows = Parameters<Pre["evaluatePrecheck"]>[1];
  type PolRows = Parameters<Pre["evaluatePrecheck"]>[2];
  const { db } = await import("@/lib/db");
  const pre = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return evaluatePrecheck(await tx.$queryRawUnsafe<FnRows>(PRECHECK_FUNCTIONS_SQL), await tx.$queryRawUnsafe<TabRows>(PRECHECK_TABLES_SQL), await tx.$queryRawUnsafe<PolRows>(PRECHECK_POLICIES_SQL));
  });
  setOwner("fm_aiconv_nobypass");
  const preBad = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return evaluatePrecheck(await tx.$queryRawUnsafe<FnRows>(PRECHECK_FUNCTIONS_SQL), await tx.$queryRawUnsafe<TabRows>(PRECHECK_TABLES_SQL), await tx.$queryRawUnsafe<PolRows>(PRECHECK_POLICIES_SQL));
  });
  setOwner("fm_aiconv_owner");
  check(94, "the pre-enable check PASSES on the BYPASSRLS-owner shape and FAILS (owner line) on a non-bypass owner",
    pre.ok && !preBad.ok && preBad.lines.filter((l) => !l.ok).every((l) => /OWNER bypasses RLS/.test(l.text)) && preBad.lines.filter((l) => !l.ok).length === 2,
    JSON.stringify(preBad.lines.filter((l) => !l.ok)));

  // ── [purge-health] PR D — the staleness authority over the REAL ledgers ──
  console.log("\n[purge-health] the purge-staleness authority over the real JobRun / AuditLog ledgers\n");
  {
    const { getPlatformAiPurgeHealth } = await import("@/lib/platform/intelligence/ai/conversations/purge-health.server");
    const offH = await getPlatformAiPurgeHealth(new Date());   // this process: conversations flag unset ⇒ OFF, nothing read
    const onH = await getPlatformAiPurgeHealth(new Date(), { conversationsOn: true });
    const later = await getPlatformAiPurgeHealth(new Date(Date.now() + 37 * 3_600_000), { conversationsOn: true });
    check(78, "real ledgers: flag OFF ⇒ OFF; ON right after the (zero-count) dispatch ⇒ OK; ON 37 h later with no new run ⇒ LATE",
      offH.state === "OFF" && onH.state === "OK" && later.state === "LATE" && onH.lastSuccessAt !== null, JSON.stringify({ offH, onH, later }));
  }

  // ── [restore] PR D — the DR rehearsal step (OD-7 activation (b)): purge BEFORE the restored copy serves ──
  console.log("\n[restore] a backup restored into a second throwaway database: purge before it serves, record the counts\n");
  {
    const src = new URL(owner); const srcDb = src.pathname.slice(1); const ownerUser = src.username;
    const RESTORED = "aiconv_restored";
    const at = (url: string) => { const u = new URL(url); u.pathname = `/${RESTORED}`; return u.toString(); };
    one(`insert into "PlatformAiConversation" (id,"operatorUserId",area,"createRequestId") values ('cv_dr','${B}','PLATFORM_OPS','k-dr');
      ${seedExchange("cv_dr", "dr1", "interval '100 days'")} ${seedExchange("cv_dr", "dr2", "interval '2 days'")} select 'ok';`);
    const dx = (...a: string[]) => spawnSync("docker", ["exec", h.containerName, ...a], { encoding: "utf8" });
    const dump = dx("pg_dump", "-U", ownerUser, "-d", srcDb, "-Fc", "-f", "/tmp/aiconv-backup.dump");
    // Production moves on: the scheduled purge removes the expired exchange from the SOURCE.
    asSys(`select * from fm_purge_platform_ai_conversations(500);`);
    const goneAtSource = one(`select count(*) from "PlatformAiMessage" where id like 'dr1%';`) === "0";
    const created = dx("createdb", "-U", ownerUser, RESTORED);
    const restore = dx("pg_restore", "-U", ownerUser, "-d", RESTORED, "--no-owner", "/tmp/aiconv-backup.dump");
    const back = psql(at(owner), `select count(*) from "PlatformAiMessage" where id like 'dr1%';`, false);
    check(79, "RESTORE: a --no-owner restore of the backup brings back the exchange the source had already purged",
      dump.status === 0 && created.status === 0 && goneAtSource && back.ok && back.out.trim() === "2", `${dump.stderr} ${created.stderr} ${restore.stderr.slice(0, 200)} back=${back.out}${back.err}`);
    const childEnv = (): NodeJS.ProcessEnv => {
      const env = { ...process.env, FM_PRODUCTION_DB_REF: "prodprojectref0000001",
        DATABASE_URL: `${at(owner)}?schema=public`, DIRECT_URL: `${at(owner)}?schema=public`,
        DATABASE_URL_APP: at(h.appUrl), DATABASE_URL_AUTH: at(h.authUrl), DATABASE_URL_SYSTEM: at(h.systemUrl) } as NodeJS.ProcessEnv;
      delete env.PLATFORM_AI_PURGE_ENABLED; delete env.VERCEL_ENV;
      return env;
    };
    const child = (script: string, ...args: string[]) => spawnSync(process.execPath, [...process.execArgv, path.join(process.cwd(), script), ...args], { encoding: "utf8", env: childEnv() });
    const pre = child("scripts/platform-ai-conversations-precheck.ts", "--env=local");
    check(80, "RESTORE: the pre-enable check against the RESTORED copy PASSES (the --no-owner restore re-owned the definers to a principal that bypasses RLS)",
      pre.status === 0 && /RESULT: PASS/.test(pre.stdout), `${pre.status} ${pre.stdout.slice(-300)} ${pre.stderr.slice(0, 200)}`);
    const restoredTotal = () => Number(psql(at(owner), `select count(*) from "PlatformAiMessage";`).out);
    const beforeR = restoredTotal();
    const purge = child("scripts/platform-ai-conversations-purge-dispatch.ts", "--env=local");
    const removedR = beforeR - restoredTotal();
    const auditR = psql(at(owner), `select coalesce((select metadata::text from "AuditLog" where action='PLATFORM_AI_CONVERSATIONS_PURGED' and metadata->>'trigger'='MANUAL_DISPATCH' order by "createdAt" desc, id desc limit 1), '');`).out;
    const metaR = auditR ? JSON.parse(auditR) as Record<string, unknown> : {};
    check(81, "RESTORE: the purge dispatch against the RESTORED copy removes what retention already required (the resurrected exchange), the counts recorded in ITS AuditLog; the unexpired one stays",
      purge.status === 0 && removedR >= 2 && metaR.messages === removedR
        && psql(at(owner), `select string_agg(id, ',' order by id) from "PlatformAiMessage" where id like 'dr%';`).out === "dr2a,dr2u", `${purge.status} removed=${removedR} audit=${auditR} ${purge.stderr.slice(0, 300)}`);
    dx("rm", "-f", "/tmp/aiconv-backup.dump");
    psql(owner, `drop database if exists ${RESTORED};`, false);
  }

  // ── [expiry] expiry on read (migration 20261105120000; OD-7, S2 C1) ─────────
  console.log("\n[expiry] an expired message is invisible on EVERY fm_app path before the purge runs; the purge still removes it\n");
  {
    const D = "aiconv_op_d";
    one(`insert into "User" (id,email,name,"updatedAt") values ('${D}','aiconv-d@example.test','Operator D',now()); select 'ok';`);
    const answer = (t: string) => ({ status: "COMPLETE" as const, answer: { v: 1 as const, segments: [{ kind: "text" as const, text: t }], citations: [], notes: [], stop: "ANSWERED" as const }, evidenceRefs: [] });
    // Fixture only, as the migration principal: back-date the rows (the settle trigger is suspended inside this one
    // transaction because settled rows are otherwise immutable; fm_app can write neither column).
    const expire = (ids: string[]) => one(`begin;
      alter table "PlatformAiMessage" disable trigger platform_ai_message_settle;
      update "PlatformAiMessage" set "createdAt" = (now() at time zone 'UTC') - interval '8 days', "purgeAfter" = (now() at time zone 'UTC') - interval '1 day' where id in (${ids.map((i) => `'${i}'`).join(",")});
      alter table "PlatformAiMessage" enable trigger platform_ai_message_settle;
      commit; select 'ok';`);
    // X: an expired exchange then a live one. Y: one exchange, all expired. Z: a PENDING turn, expired.
    const x = await store.createConversation({ operatorId: D, area: "PLATFORM_OPS", createRequestId: randomUUID(), scrubbedQuestion: "EXPIRED-QUESTION-X1" });
    const y = await store.createConversation({ operatorId: D, area: "PLATFORM_OPS", createRequestId: randomUUID(), scrubbedQuestion: "EXPIRED-QUESTION-Y1" });
    const z = await store.createConversation({ operatorId: D, area: "PLATFORM_OPS", createRequestId: randomUUID(), scrubbedQuestion: "pending then expired" });
    if (x.kind !== "CREATED" || y.kind !== "CREATED" || z.kind !== "CREATED") throw new Error("expiry fixtures: create failed");
    await store.settleTurn(D, x.conversation.id, x.pair.assistant.id, answer("EXPIRED-ANSWER-X1"));
    const x2 = await store.appendTurn({ operatorId: D, conversationId: x.conversation.id, clientRequestId: randomUUID(), scrubbedQuestion: "live question x2", now: NOW() });
    if (x2.kind !== "APPENDED") throw new Error(`expiry fixtures: append ${x2.kind}`);
    await store.settleTurn(D, x.conversation.id, x2.pair.assistant.id, answer("live answer x2"));
    await store.settleTurn(D, y.conversation.id, y.pair.assistant.id, answer("EXPIRED-ANSWER-Y1"));
    const pairSame = one(`select bool_and(a."purgeAfter" = u."purgeAfter")::text from "PlatformAiMessage" a join "PlatformAiMessage" u on u.id = a."replyToId" where a."conversationId" in ('${x.conversation.id}','${y.conversation.id}','${z.conversation.id}');`);
    check(82, "a question and its answer share ONE purgeAfter (inserted in one transaction: one now()), so an answer never outlives its question", pairSame === "true", pairSame);
    expire([x.pair.user.id, x.pair.assistant.id, y.pair.user.id, y.pair.assistant.id, z.pair.user.id, z.pair.assistant.id]);
    const xs = x.conversation.id, ys = y.conversation.id;
    const appSel = asApp(D, `select count(*) from "PlatformAiMessage" where "conversationId"='${xs}'; select count(*) from "PlatformAiMessage" where "conversationId"='${ys}';`);
    const ownerSees = one(`select count(*) from "PlatformAiMessage" where "conversationId" in ('${xs}','${ys}');`);
    check(83, "SQL as fm_app: the expired rows are INVISIBLE (X: 2 live of 4, Y: 0 of 2) though the table still holds them (6)",
      appSel.ok && appSel.out.split("\n").join(",") === "2,0" && ownerSees === "6", `${appSel.out || appSel.err} owner=${ownerSees}`);
    const appUpd = asApp(D, `with w as (update "PlatformAiMessage" set "failureCode" = 'PROVIDER', status = 'FAILED' where id='${z.pair.assistant.id}' returning 1) select count(*) from w;`);
    check(84, "SQL as fm_app: UPDATE of an expired row affects 0 rows (USING carries the predicate)", appUpd.ok && appUpd.out.trim() === "0", appUpd.out || appUpd.err);
    const rx = await store.readConversation(D, xs, NOW());
    check(85, "store.readConversation: only the live exchange, no expired text", !!rx && rx.messages.length === 2 && rx.messages.every((m) => m.id === x2.pair.user.id || m.id === x2.pair.assistant.id)
      && !JSON.stringify(rx.messages).includes("EXPIRED-"), JSON.stringify(rx?.messages.map((m) => m.id)));
    const hx = await store.loadConversationHistory(D, xs);
    check(86, "store.loadConversationHistory (follow-up context sent to the provider): only the live pair replays", !!hx && hx.length === 2 && !JSON.stringify(hx).includes("EXPIRED-"), JSON.stringify(hx?.map((m) => m.id)));
    const listD = (await store.listLiveConversations(D)).map((c) => c.id);
    const ay = await store.appendTurn({ operatorId: D, conversationId: ys, clientRequestId: randomUUID(), scrubbedQuestion: "revive?", now: NOW() });
    check(87, "an ALL-expired conversation is not live: not listed, findLive/read/history null, append NOT_FOUND (answered as a deleted one)",
      listD.includes(xs) && !listD.includes(ys) && (await store.findLiveConversation(D, ys)) === null && (await store.readConversation(D, ys, NOW())) === null
        && (await store.loadConversationHistory(D, ys)) === null && ay.kind === "NOT_FOUND", `${JSON.stringify(listD)} ${ay.kind}`);
    const exHeld = await store.readConversationsForExport(D, new Set(["PLATFORM_OPS"] as const));
    const exLost = await store.readConversationsForExport(D, new Set([] as const));
    check(88, "export: a held area drops the expired messages and the all-expired conversation; a lost area's COUNT is live conversations only",
      !JSON.stringify(exHeld).includes("EXPIRED-") && !exHeld.conversations.some((c) => c.id === ys)
        && exHeld.conversations.find((c) => c.id === xs)?.messages.length === 2
        && JSON.stringify(exLost.omitted) === JSON.stringify([{ area: "PLATFORM_OPS", count: exHeld.conversations.length }]), JSON.stringify(exLost.omitted));
    const settledExpired = await store.settleTurn(D, z.conversation.id, z.pair.assistant.id, answer("too late"));
    const delY = await store.softDeleteConversation(D, ys);
    check(89, "settle of an expired PENDING row ⇒ false (0 rows); soft delete of an all-expired conversation still succeeds, messageCount = live = 0",
      !settledExpired && delY.deleted && delY.messageCount === 0, `${settledExpired} ${JSON.stringify(delY)}`);
    const capPin = readFileSync(path.join(process.cwd(), "lib/platform/intelligence/ai/conversations/store.ts"), "utf8");
    check(90, "the 50-conversation cap counts LIVE conversations (an all-expired one never blocks a create)",
      /platformAiConversation\.count\(\{ where: \{ operatorUserId: operatorId, \.\.\.LIVE \} \}\)/.test(capPin));
    const purged = asSys(`select messages from public.fm_purge_platform_ai_conversations(500);`);
    const leftExpired = one(`select count(*) from "PlatformAiMessage" m join "PlatformAiConversation" c on c.id = m."conversationId" where c."operatorUserId"='${D}' and m."purgeAfter" < (now() at time zone 'UTC');`);
    const leftLive = one(`select count(*) from "PlatformAiMessage" where "conversationId"='${xs}';`);
    check(91, "NOT a substitute for the purge: the definer purge (fm_system) still physically deletes every expired row; the live exchange stays",
      purged.ok && Number(purged.out.trim()) >= 6 && leftExpired === "0" && leftLive === "2", `${purged.out || purged.err} expiredLeft=${leftExpired} live=${leftLive}`);

    // (a) ONE question/answer pair moved across the 7-day line, read on the fm_app path. Back-dated as the
    // migration principal relative to the DATABASE clock (purgeAfter = createdAt + 7 days, as the default sets it).
    const E = "aiconv_op_e";
    one(`insert into "User" (id,email,name,"updatedAt") values ('${E}','aiconv-e@example.test','Operator E',now()); select 'ok';`);
    const line = await store.createConversation({ operatorId: E, area: "PLATFORM_OPS", createRequestId: randomUUID(), scrubbedQuestion: "LINE-QUESTION" });
    if (line.kind !== "CREATED") throw new Error(`expiry line fixture: create ${line.kind}`);
    await store.settleTurn(E, line.conversation.id, line.pair.assistant.id, answer("LINE-ANSWER"));
    const ls = line.conversation.id, lu = line.pair.user.id, la = line.pair.assistant.id;
    const backdate = (age: string) => one(`begin;
      alter table "PlatformAiMessage" disable trigger platform_ai_message_settle;
      update "PlatformAiMessage" set "createdAt" = (now() at time zone 'UTC') - ${age}, "purgeAfter" = (now() at time zone 'UTC') - ${age} + ${RET} where id in ('${lu}','${la}');
      alter table "PlatformAiMessage" enable trigger platform_ai_message_settle;
      commit; select 'ok';`);
    const appIds = () => asApp(E, `select coalesce(string_agg(id, ',' order by id), '') from "PlatformAiMessage" where "conversationId"='${ls}';`);
    const pairIds = [lu, la].sort().join(",");
    backdate(`(${RET} - interval '1 minute')`); // 6 d 23 h 59 min old: one minute inside the line
    const inside = appIds();
    const insideRead = await store.readConversation(E, ls, NOW());
    backdate(`(${RET} + interval '1 second')`); // moved across: one second past the line
    const across = appIds();
    const acrossRead = await store.readConversation(E, ls, NOW());
    check(95, "ONE question/answer pair moved across the 7-day line (fm_app): both visible one minute inside it (SQL + store.readConversation), both hidden one second past it",
      inside.ok && inside.out === pairIds && insideRead?.messages.length === 2 && JSON.stringify(insideRead.messages).includes("LINE-QUESTION")
        && across.ok && across.out === "" && acrossRead === null,
      `inside=${inside.out || inside.err} read=${insideRead?.messages.length} across=${across.out || across.err} read=${acrossRead === null ? "null" : acrossRead.messages.length}`);

    // (b) The read boundary is STRICT ('>'): equal ⇒ hidden, +1 ms ⇒ visible. Deterministic, in two halves (the
    // earlier fixture waited for a transaction whose now() fell exactly on a millisecond — purgeAfter is
    // timestamp(3), now() carries microseconds — and on some CI runners no aligned now() was ever observed in
    // 20000 tries, so the check failed 'nohit' with correct code).
    //  · BEHAVIOUR, real policy as fm_app, one transaction (one now()), rolled back: with F = now() truncated to the
    //    millisecond (so F <= now() < F + 1 ms, exactly storable in timestamp(3)), purgeAfter = F + 1 ms ⇒ visible
    //    and purgeAfter = F ⇒ hidden — i.e. the policy flips inside the one-millisecond window around now().
    //  · EXACT EQUALITY, from the catalog: the ONLY read policy fm_app gets on the table (fm_app_sel; the UPDATE
    //    USING too) compares "purgeAfter" with the timestamp '>' operator (opno in the stored node tree; never
    //    '>='), and that very deparsed comparison, evaluated with purgeAfter = now() substituted as one literal
    //    instant, is false — and true at +1 ms. Together these replace "observe an aligned now()" without luck.
    const bnd = await store.createConversation({ operatorId: E, area: "PLATFORM_OPS", createRequestId: randomUUID(), scrubbedQuestion: "BOUNDARY-QUESTION" });
    if (bnd.kind !== "CREATED") throw new Error(`expiry boundary fixture: create ${bnd.kind}`);
    const bu = bnd.pair.user.id, ba = bnd.pair.assistant.id; // bu ⇒ F + 1 ms, ba ⇒ F (F = date_trunc('milliseconds', now()))
    const F = `date_trunc('milliseconds', (now() at time zone 'UTC'))`;
    const boundary = psql(owner, `begin;
alter table "PlatformAiMessage" disable trigger platform_ai_message_settle;
update "PlatformAiMessage" set "purgeAfter" = ${F} + interval '1 millisecond' where id = '${bu}';
update "PlatformAiMessage" set "purgeAfter" = ${F} where id = '${ba}';
alter table "PlatformAiMessage" enable trigger platform_ai_message_settle;
select 'stored|' || bool_and(case id when '${bu}' then "purgeAfter" = ${F} + interval '1 millisecond' and "purgeAfter" > (now() at time zone 'UTC')
  else "purgeAfter" = ${F} and "purgeAfter" <= (now() at time zone 'UTC') end)::text from "PlatformAiMessage" where id in ('${bu}','${ba}');
set local role fm_app;
set local app.user_id = '${E}';
select 'visible|' || coalesce(string_agg(id, ',' order by id), '') from "PlatformAiMessage" where "conversationId" = '${bnd.conversation.id}';
rollback;
`);
    const bOut = boundary.out.split("\n");
    // Every policy that can grant fm_app a read (SELECT or ALL, to fm_app or PUBLIC) plus the UPDATE USING:
    // name|cmd|uses timestamp '>'|uses timestamp '>='|deparsed USING.
    const pol = psql(owner, `select p.polname || '|' || p.polcmd || '|' || (p.polqual::text ~ (':opno ' || gt.oid || ' '))::text
        || '|' || (p.polqual::text ~ (':opno ' || ge.oid || ' '))::text || '|' || replace(pg_get_expr(p.polqual, p.polrelid), E'\\n', ' ')
      from pg_policy p,
        (select oid from pg_operator where oprname = '>'  and oprleft = 'timestamp'::regtype and oprright = 'timestamp'::regtype) gt,
        (select oid from pg_operator where oprname = '>=' and oprleft = 'timestamp'::regtype and oprright = 'timestamp'::regtype) ge
      where p.polrelid = 'public."PlatformAiMessage"'::regclass and p.polcmd in ('r', 'w', '*')
        and ('fm_app'::regrole = any(p.polroles) or 0::oid = any(p.polroles))
      order by p.polname;`);
    const polRows = pol.out.split("\n").filter(Boolean).map((l) => { const [name, cmd, gtUsed, geUsed, ...rest] = l.split("|"); return { name, cmd, gtUsed, geUsed, qual: rest.join("|") }; });
    // PG16 deparses AT TIME ZONE as timezone('UTC'::text, now()); PG17+ as (now() AT TIME ZONE 'UTC'::text).
    const CMP = /"purgeAfter" > (?:timezone\('UTC'::text, now\(\)\)|\(now\(\) AT TIME ZONE 'UTC'::text\))/;
    const strictPolicy = (p: (typeof polRows)[number]) => p.gtUsed === "true" && p.geUsed === "false" && CMP.test(p.qual)
      && (p.qual.match(/"purgeAfter"/g) ?? []).length === 1;
    const reads = polRows.filter((p) => p.cmd === "r" || p.cmd === "*");
    const updPol = polRows.find((p) => p.name === "fm_app_upd");
    const cmpText = reads[0]?.qual.match(CMP)?.[0] ?? "";
    const at = (purge: string) => cmpText.replace('"purgeAfter"', `'${purge}'::timestamp(3)`).replace("now()", "'2026-01-01 00:00:00.123+00'::timestamptz");
    const evalEq = cmpText ? psql(owner, `select (${at("2026-01-01 00:00:00.123")})::text || '|' || (${at("2026-01-01 00:00:00.124")})::text;`) : { ok: false, out: "", err: "no strict comparison in the read policy" };
    check(96, "read boundary is STRICT ('>'): fm_app_sel (the only fm_app read policy) and fm_app_upd USING use timestamp '>' (never '>='); that comparison at purgeAfter = now() exactly ⇒ false, +1 ms ⇒ true; as fm_app under the real policy (one now()): purgeAfter = ms-floor(now()) + 1 ms ⇒ visible, ms-floor(now()) (≤ now()) ⇒ hidden",
      boundary.ok && bOut.includes("stored|true") && bOut.includes(`visible|${bu}`)
        && pol.ok && reads.length === 1 && reads[0].name === "fm_app_sel" && reads[0].cmd === "r" && strictPolicy(reads[0]) && !!updPol && strictPolicy(updPol)
        && evalEq.ok && evalEq.out === "false|true",
      `${boundary.out.slice(0, 200)} ${errLine(boundary)} | ${pol.out.slice(0, 400)} ${errLine(pol)} | eval=${evalEq.out || evalEq.err}`);
  }

  // ── [retention-7d] 20261108120000 (owner 2026-11-08): the clamp of existing rows ──
  console.log("\n[retention-7d] legacy 90-day rows clamped to question createdAt + 7 days; the trigger, default, bound, read boundary and purge\n");
  {
    // ONE owner transaction, rolled back: put the table back in its pre-migration shape (the 90-day default, no
    // 7-day bound), seed legacy rows, apply the REAL migration file twice, then read as fm_app and purge as fm_system.
    const MIG = path.join(process.cwd(), "prisma/migrations/20261108120000_platform_ai_retention_7_days/migration.sql");
    const N = `(now() at time zone 'UTC')`;
    const legacy = `interval '90 days'`;
    const q = (id: string, created: string, purge: string) => `('${id}','cv_cl','USER','COMPLETE','${id}-k',NULL,NULL,${created},${purge})`;
    const a = (id: string, reply: string, created: string, purge: string, status = "COMPLETE") => `('${id}','cv_cl','ASSISTANT','${status}',NULL,'${reply}','[]'::jsonb,${created},${purge})`;
    const rows = [
      q("cl1u", `${N} - interval '3 days'`, `${N} - interval '3 days' + ${legacy}`), a("cl1a", "cl1u", `${N} - interval '3 days'`, `${N} - interval '3 days' + ${legacy}`),
      q("cl2u", `${N} - interval '30 days'`, `${N} - interval '30 days' + ${legacy}`), a("cl2a", "cl2u", `${N} - interval '30 days'`, `${N} - interval '30 days' + ${legacy}`),
      q("cl3u", `${N} - interval '2 days'`, `${N} - interval '1 day'`), a("cl3a", "cl3u", `${N} - interval '2 days'`, `${N} - interval '1 day'`),
      q("cl4u", `${N} - interval '5 days'`, `${N} - interval '5 days' + ${legacy}`), a("cl4a", "cl4u", `${N} - interval '5 days' + interval '1 minute'`, `${N} - interval '5 days' + interval '1 minute' + ${legacy}`),
      q("cl5u", `${N} - interval '4 days'`, `${N} - interval '4 days' + ${legacy}`), a("cl5a", "cl5u", `${N} - interval '4 days'`, `${N} - interval '2 days'`),
      q("cl6u", `${N} - ${RET} + interval '1 minute'`, `${N} - ${RET} + interval '1 minute' + ${legacy}`), a("cl6a", "cl6u", `${N} - ${RET} + interval '1 minute'`, `${N} - ${RET} + interval '1 minute' + ${legacy}`, "PENDING"),
      q("cl7u", `${N} - ${RET} - interval '1 second'`, `${N} - ${RET} - interval '1 second' + ${legacy}`),
    ];
    const expected = `case id
        when 'cl1u' then ${N} - interval '3 days' + ${RET}   when 'cl1a' then ${N} - interval '3 days' + ${RET}
        when 'cl2u' then ${N} - interval '30 days' + ${RET}  when 'cl2a' then ${N} - interval '30 days' + ${RET}
        when 'cl3u' then ${N} - interval '1 day'             when 'cl3a' then ${N} - interval '1 day'
        when 'cl4u' then ${N} - interval '5 days' + ${RET}   when 'cl4a' then ${N} - interval '5 days' + ${RET}
        when 'cl5u' then ${N} - interval '4 days' + ${RET}   when 'cl5a' then ${N} - interval '2 days'
        when 'cl6u' then ${N} + interval '1 minute'          when 'cl6a' then ${N} + interval '1 minute'
        when 'cl7u' then ${N} - interval '1 second' end`;
    const snap = `select string_agg(id || '@' || "purgeAfter"::text, ',' order by id) from "PlatformAiMessage"`;
    const sqlText = `BEGIN;
alter table "PlatformAiMessage" drop constraint "PlatformAiMessage_purgeAfter_bounded";
alter table "PlatformAiMessage" alter column "purgeAfter" set default (${N} + ${legacy});
insert into "PlatformAiConversation" (id,"operatorUserId",area,"createRequestId") values ('cv_cl','${A}','PLATFORM_OPS','k-cl');
insert into "PlatformAiMessage" (id,"conversationId",role,status,"clientRequestId","replyToId","evidenceRefs","createdAt","purgeAfter") values
  ${rows.join(",\n  ")};
create temp table cl_pre as select id, "purgeAfter" from "PlatformAiMessage";
create temp table cl_r (k text, v text);
\\i ${MIG}
select 'clamp|' || coalesce(string_agg(id, ',' order by id) filter (where "purgeAfter" is distinct from (${expected})::timestamp(3)), 'ok') from "PlatformAiMessage" where "conversationId" = 'cv_cl';
select 'never-longer|' || bool_and(m."purgeAfter" <= p."purgeAfter")::text || '|' || count(*) from "PlatformAiMessage" m join cl_pre p using (id);
select 'pairs|' || bool_and(a."purgeAfter" <= u."purgeAfter" and u."purgeAfter" <= u."createdAt" + ${RET})::text from "PlatformAiMessage" a join "PlatformAiMessage" u on u.id = a."replyToId";
create temp table cl_s1 as ${snap};
\\i ${MIG}
select 'rerun|' || ((${snap}) = (select * from cl_s1))::text;
select 'trigger|' || tgenabled::text from pg_trigger where tgrelid = '"PlatformAiMessage"'::regclass and tgname = 'platform_ai_message_settle';
DO $t$ BEGIN
  BEGIN UPDATE "PlatformAiMessage" SET "purgeAfter" = "purgeAfter" - interval '1 second' WHERE id = 'cl1a'; INSERT INTO cl_r VALUES ('immutable', 'UPDATED');
  EXCEPTION WHEN raise_exception THEN INSERT INTO cl_r VALUES ('immutable', SQLERRM); END;
  BEGIN INSERT INTO "PlatformAiMessage" (id,"conversationId",role,status,"clientRequestId","createdAt","purgeAfter") VALUES ('cl9u','cv_cl','USER','COMPLETE','cl9-k', ${N}, ${N} + ${RET} + interval '1 second'); INSERT INTO cl_r VALUES ('bound', 'INSERTED');
  EXCEPTION WHEN check_violation THEN INSERT INTO cl_r VALUES ('bound', 'check_violation'); END;
END $t$;
insert into "PlatformAiMessage" (id,"conversationId",role,status,"clientRequestId") values ('cl0u','cv_cl','USER','COMPLETE','cl0-k');
select 'default|' || ("purgeAfter" = "createdAt" + ${RET})::text from "PlatformAiMessage" where id = 'cl0u';
delete from "PlatformAiMessage" where id = 'cl0u';
select k || '|' || v from cl_r order by k;
set local role fm_app;
set local app.user_id = '${A}';
select 'visible|' || coalesce(string_agg(id, ',' order by id), '') from "PlatformAiMessage" where "conversationId" = 'cv_cl';
reset role;
set local role fm_system;
select 'purged|' || messages from fm_purge_platform_ai_conversations(500);
reset role;
select 'left|' || coalesce(string_agg(id, ',' order by id), '') from "PlatformAiMessage" where "conversationId" = 'cv_cl';
ROLLBACK;
`;
    const r = psql(owner, sqlText);
    const out = new Map(r.out.split("\n").map((l) => { const i = l.indexOf("|"); return [l.slice(0, i), l.slice(i + 1)] as const; }));
    const detail = `${r.out.replace(/\n/g, " / ").slice(0, 600)} ${errLine(r)}`;
    check(97, "CLAMP: legacy 90-day rows ⇒ question createdAt + 7 d (a later-written answer takes its QUESTION's line); already-shorter rows unchanged; PENDING rows too",
      r.ok && out.get("clamp") === "ok", detail);
    check(98, "the clamp NEVER lengthens a row (every row, every operator) and no answer outlives its question; no row is deleted by the migration",
      r.ok && out.get("never-longer")?.startsWith("true|") === true && out.get("pairs") === "true", detail);
    check(99, "IDEMPOTENT: applying the migration a second time changes nothing", r.ok && out.get("rerun") === "true", detail);
    check(100, "the settle trigger is ENABLED after the migration and still refuses a purgeAfter change on a settled row",
      r.ok && out.get("trigger") === "O" && out.get("immutable") === "settled message is immutable", detail);
    check(101, "the DB default is createdAt + 7 d and the CHECK refuses createdAt + 7 d + 1 s", r.ok && out.get("default") === "true" && out.get("bound") === "check_violation", detail);
    check(102, "expiry on read at the 7-day line (fm_app): 1 min inside visible; 1 s past hidden; clamped-expired pairs hidden; a shorter answer hidden alone",
      r.ok && out.get("visible") === "cl1a,cl1u,cl4a,cl4u,cl5u,cl6a,cl6u", detail);
    check(103, "the purge (fm_system) removes the clamped-expired exchanges (cl2 pair, cl3 pair, 7 d + 1 s); the rest stay (an expired answer goes with its question)",
      r.ok && Number(out.get("purged")) >= 5 && out.get("left") === "cl1a,cl1u,cl4a,cl4u,cl5a,cl5u,cl6a,cl6u", detail);
  }

  // ── [pre-disable] PR D — the S2 disable order: never the purge flag while rows remain ──
  console.log("\n[pre-disable] the read-only pre-disable check (counts only; fail-closed on a non-bypass reader)\n");
  {
    const { PREDISABLE_SQL, evaluatePredisable } = await import("./lib/platform-ai-conversations-precheck.core");
    type PreRows = Parameters<typeof evaluatePredisable>[0];
    const runPre = (role?: string) => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      if (role) await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      return evaluatePredisable(await tx.$queryRawUnsafe<PreRows>(PREDISABLE_SQL));
    });
    const remaining = Number(one(`select count(*) from "PlatformAiConversation";`)) + total();
    const withRows = await runPre();
    check(75, "rows remain ⇒ the pre-disable check FAILS (keep the purge flag on)", remaining > 0 && !withRows.ok && withRows.lines[0].ok, JSON.stringify(withRows.lines));
    setOwner("fm_aiconv_nobypass");
    one(`grant select on "PlatformAiConversation", "PlatformAiMessage" to fm_aiconv_nobypass; select 'ok';`);
    const blind = await runPre("fm_aiconv_nobypass");
    setOwner("fm_aiconv_owner");
    check(76, "FAIL-CLOSED: a NON-bypass reader (the table owner, under FORCE RLS) sees 0 rows while rows exist — and the check still FAILS",
      !blind.ok && blind.lines.every((l) => !l.ok) && /count=0\b/.test(blind.lines[1].text) && remaining > 0, JSON.stringify(blind.lines));
    one(`delete from "PlatformAiConversation"; select 'ok';`);
    const empty = await runPre();
    check(77, "once nothing remains (conversations and, by cascade, messages) ⇒ PASS — only now may the purge flag be unset",
      empty.ok && total() === 0, JSON.stringify(empty.lines));
  }
  await db.$disconnect();
  const { tenantDb, systemDb } = await import("@/lib/db");
  await (tenantDb as unknown as { $disconnect(): Promise<void> }).$disconnect();
  await (systemDb as unknown as { $disconnect(): Promise<void> }).$disconnect();

  return report("PLATFORM AI CONVERSATIONS ACCEPTANCE");
}

main()
  .then((failed) => { teardownHarness(KEEP); process.exit(failed ? 1 : 0); })
  .catch((e) => { console.error(e instanceof Error ? e.message : e); teardownHarness(KEEP); process.exit(1); });
