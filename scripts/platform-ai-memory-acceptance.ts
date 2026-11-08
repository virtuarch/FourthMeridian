/**
 * scripts/platform-ai-memory-acceptance.ts  (Platform AI operational memory on REAL PostgreSQL roles)
 *
 * Design v2 §8 "Real-PG acceptance (rls:accept:ai-memory)", plus every O1 (b)
 * case of S2's approval (2026-11-08). The rls:accept pattern: a throwaway
 * Postgres carrying the committed migration history (scripts/lib/rls-harness.ts,
 * removed with `docker rm -f -v`), real fm_app / fm_system / fm_auth logins,
 * plain SQL for the boundary, then the REAL store (fm_app tenant client) and the
 * REAL retention seam (fm_system). Synthetic data only; keys generated per run.
 *
 *   [sql]      grants, policies, triggers, CHECKs, the B2 sourceRefs validation
 *   [o1]       the soft-delete definer — the sole soft-delete path (S2's list)
 *   [owner]    the definers owned by a BYPASSRLS non-superuser, and the negative
 *              control (a NON-bypass owner ⇒ 0, nothing deleted)
 *   [store]    store.ts as fm_app: insert / replay / renew / invalidate / delete,
 *              the visibility helper (D8), audits without a note
 *   [revoke]   area revocation: hidden at once with no app guard, purged, regrant
 *              restores, offboarding + purge ⇒ 0
 *   [stale]    72 h + 1 s invisible before any purge; 100 reads never move expiresAt
 *   [job]      the real retention seam: audited count == rows removed
 *   [loophole] design §8: canary conversations, an adversarial proposer (copied
 *              spans, the email, the amount, the cuid — as proposed AND as edited
 *              notes at confirm), ref-id smuggling, the transcript purge, then
 *              every memory column decrypted and scanned
 *   [precheck] the pre-enable check against the real catalog PASSES
 *
 *   npm run rls:accept:ai-memory [-- --keep]
 */

import { randomBytes } from "node:crypto";
import { prepareHarness, assertTenantClientBound, teardownHarness, psql, makeRecorder, deniedByGrant, deniedByRls } from "./lib/rls-harness";

const KEEP = process.argv.includes("--keep");
const { check, report } = makeRecorder();

process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
delete process.env.ENCRYPTION_KEY_PREVIOUS;
process.env.PLATFORM_AI_MEMORY_PURGE_ENABLED = "true";   // the [job] case runs the REAL seam (read at lib/env import)

const A = "aimem_op_a", B = "aimem_op_b", C = "aimem_op_c";
const errLine = (r: { err: string }) => r.err.split("\n").find((l) => /ERROR/.test(l)) ?? r.err.split("\n")[0] ?? "";
const T = `"PlatformAiMemoryFact"`;
const REF_M = `'[{"t":"METRIC","id":"provider-outcome@1","part":"failing","w":7,"observedState":"DEGRADED"}]'::jsonb`;
const REF_J = `'[{"t":"JOB","id":"sync-banks","observedState":"FAILED"}]'::jsonb`;
const N = `(now() at time zone 'UTC')`;

async function main(): Promise<number> {
  console.log("\n=== PLATFORM AI MEMORY — REAL-ROLE ACCEPTANCE ===\n");
  const h = prepareHarness("aimem");
  const owner = h.ownerUrl;
  const one = (sql: string) => { const r = psql(owner, sql); if (!r.ok) throw new Error(`fixture SQL failed: ${r.err}`); return r.out.trim(); };
  const asApp = (user: string, sql: string) => psql(h.appUrl, `BEGIN;\nSET LOCAL app.user_id = '${user}';\n${sql}\nCOMMIT;`, false);
  const asSys = (sql: string) => psql(h.systemUrl, sql, false);
  const asAuth = (sql: string) => psql(h.authUrl, sql, false);
  /** Owner fixture with the insert trigger suspended (the only way to choose time; one transaction). */
  const seed = (values: string) => one(`begin;
    alter table ${T} disable trigger platform_ai_memory_insert;
    insert into ${T} (id,"operatorUserId","platformArea","factType",origin,payload,"sourceRefs",ttl,"createdAt","observedAt","expiresAt","invalidatedAt","invalidReason","deletedAt") values ${values};
    alter table ${T} enable trigger platform_ai_memory_insert;
    commit; select 'ok';`);
  const ins = (id: string, opUser: string, area = "PLATFORM_OPS", type = "WATCHING_ISSUE", ttl = "D7", refs = REF_M, payload = "'{}'::jsonb") =>
    `insert into ${T} (id,"operatorUserId","platformArea","factType",origin,payload,"sourceRefs",ttl) values ('${id}','${opUser}','${area}','${type}','TOOL_DERIVED',${payload},${refs},'${ttl}');`;
  const count = (where: string) => Number(one(`select count(*) from ${T} where ${where};`));

  one(`insert into "User" (id,email,name,"updatedAt") values
    ('${A}','aimem-a@example.test','Operator A',now()), ('${B}','aimem-b@example.test','Operator B',now()), ('${C}','aimem-c@example.test','Operator C',now());
    insert into "PlatformGrant" (id,"userId",area,level,"updatedAt") values
    ('pg_a_ops','${A}','PLATFORM_OPS','READ',now()), ('pg_a_sec','${A}','SECURITY_OPS','READ',now()),
    ('pg_b_ops','${B}','PLATFORM_OPS','READ',now()), ('pg_c_ops','${C}','PLATFORM_OPS','READ',now());`);

  // ── [sql] ──────────────────────────────────────────────────────────────────
  console.log("[sql] grants, policies, triggers and CHECKs (as fm_app / fm_system / fm_auth)\n");
  const i1 = asApp(A, ins("mf_a1", A));
  check(1, "fm_app inserts its OWN fact naming only the writer columns", i1.ok, errLine(i1));
  const ts = one(`select ("createdAt" = "observedAt" and "expiresAt" = "createdAt" + interval '7 days' and abs(extract(epoch from ("createdAt" - ${N}))) < 60)::text from ${T} where id='mf_a1';`);
  check(2, "createdAt = observedAt = now() UTC; expiresAt = createdAt + least(ttl D7, cap) — the trigger's", ts === "true", ts);
  const named = ["createdAt", "observedAt", "expiresAt", "invalidatedAt", "invalidReason", "deletedAt"].filter((col) => {
    const v = col === "invalidReason" ? "'GONE'" : "now()";
    return !deniedByGrant(asApp(A, `insert into ${T} (id,"operatorUserId","platformArea","factType",origin,payload,"sourceRefs",ttl,"${col}") values ('mf_t_${col}','${A}','PLATFORM_OPS','WATCHING_ISSUE','TOOL_DERIVED','{}'::jsonb,${REF_M},'D7',${v});`));
  });
  check(3, "timestamps cannot be inserted: naming createdAt / observedAt / expiresAt / invalidatedAt / invalidReason / deletedAt ⇒ permission denied (each)", named.length === 0, named.join(","));
  const forB = asApp(A, ins("mf_evil", B));
  const noGrantArea = asApp(A, ins("mf_gr", A, "GROWTH_REVENUE"));
  check(4, "INSERT for ANOTHER operator, or in an area the operator does not hold ACTIVE ⇒ denied by WITH CHECK", deniedByRls(forB) && deniedByRls(noGrantArea), `${errLine(forB)} | ${errLine(noGrantArea)}`);
  asApp(B, ins("mf_b1", B));
  const aSees = asApp(A, `select count(*) from ${T};`), bSees = asApp(B, `select count(*) from ${T};`);
  const bById = asApp(B, `select count(*) from ${T} where id='mf_a1';`);
  check(5, "two operators: each reads only its own (A 1, B 1); B naming A's id ⇒ 0 rows", aSees.out === "1" && bSees.out === "1" && bById.out === "0", `${aSees.out} ${bSees.out} ${bById.out}`);
  const noGuc = psql(h.appUrl, `select count(*) from ${T};`, false);
  check(6, "no app.user_id ⇒ 0 rows (fail closed)", noGuc.ok && noGuc.out === "0", noGuc.out || errLine(noGuc));
  const ownGrants = asApp(A, `select count(*) from "PlatformGrant";`), otherGrants = asApp(A, `select count(*) from "PlatformGrant" where "userId"='${B}';`);
  check(7, "fm_app sees its OWN PlatformGrant rows (2) and none of another operator's (D6)", ownGrants.out === "2" && otherGrants.out === "0", `${ownGrants.out} ${otherGrants.out}`);
  const updLeaks = [`"expiresAt" = now() + interval '1 year'`, `payload = '{}'::jsonb`, `"sourceRefs" = ${REF_J}`, `"noteEncrypted" = 'x'`, `"createdAt" = now()`, `ttl = 'D30'`, `"deletedAt" = now()`]
    .filter((set) => !deniedByGrant(asApp(A, `update ${T} set ${set} where id='mf_a1';`)));
  check(8, "fm_app UPDATE of any non-invalidation column (incl. expiresAt and deletedAt — O1 (b)) ⇒ permission denied", updLeaks.length === 0, updLeaks.join(" | "));
  const immExp = psql(owner, `update ${T} set "expiresAt" = "expiresAt" + interval '1 day' where id='mf_a1';`, false);
  const immPay = psql(owner, `update ${T} set "sourceRefs" = ${REF_J} where id='mf_a1';`, false);
  check(9, "IMMUTABILITY holds even for the owner: expiresAt / sourceRefs ⇒ 'memory fact is immutable'", /memory fact is immutable/.test(immExp.err) && /memory fact is immutable/.test(immPay.err), `${errLine(immExp)} | ${errLine(immPay)}`);
  const del = asApp(A, `delete from ${T} where id='mf_a1';`);
  check(10, "fm_app has NO DELETE", deniedByGrant(del), errLine(del));

  // CHECK bounds (owner, trigger suspended so the writer could choose time).
  const c31 = psql(owner, `begin; alter table ${T} disable trigger platform_ai_memory_insert;
    insert into ${T} (id,"operatorUserId","platformArea","factType",origin,payload,"sourceRefs",ttl,"createdAt","expiresAt") values ('mf_c31','${A}','PLATFORM_OPS','WATCHING_ISSUE','TOOL_DERIVED','{}'::jsonb,${REF_M},'D30',${N},${N} + interval '31 days'); commit;`, false);
  const c73 = psql(owner, `begin; alter table ${T} disable trigger platform_ai_memory_insert;
    insert into ${T} (id,"operatorUserId","platformArea","factType",origin,payload,"sourceRefs",ttl,"createdAt","expiresAt") values ('mf_c73','${A}','PLATFORM_OPS','OPERATIONAL_STATE','TOOL_DERIVED','{}'::jsonb,${REF_M},'H72',${N},${N} + interval '73 hours'); commit;`, false);
  const big = `'[${Array(5).fill(`{"t":"PAGE","id":"${"x".repeat(250)}","observedState":"OK"}`).join(",")}]'::jsonb`;
  const cBig = psql(owner, `begin; alter table ${T} disable trigger platform_ai_memory_insert;
    insert into ${T} (id,"operatorUserId","platformArea","factType",origin,payload,"sourceRefs",ttl) values ('mf_big','${A}','PLATFORM_OPS','WATCHING_ISSUE','TOOL_DERIVED','{}'::jsonb,${big},'D7'); commit;`, false);
  check(11, "CHECK bounds: 31 days ⇒ rejected; OPERATIONAL_STATE at 73 h ⇒ rejected; sourceRefs over 1024 octets ⇒ rejected",
    /expiry_bounded/.test(c31.err) && /expiry_bounded/.test(c73.err) && /refs_bounded/.test(cBig.err), `${errLine(c31)} | ${errLine(c73)} | ${errLine(cBig)}`);
  asApp(A, ins("mf_os", A, "PLATFORM_OPS", "OPERATIONAL_STATE", "D30"));
  const capped = one(`select ("expiresAt" = "createdAt" + interval '72 hours')::text from ${T} where id='mf_os';`);
  check(12, "an OPERATIONAL_STATE fact asking D30 is capped by the trigger at 72 h", capped === "true", capped);

  // B2: the trigger refuses every malformed ref (as fm_app — the writer's own path).
  const refCases: Array<[string, string]> = [
    ["an extra key", `'[{"t":"METRIC","id":"provider-outcome@1","observedState":"OK","note":"x"}]'::jsonb`],
    ["an id over 64 characters", `'[{"t":"PAGE","id":"${"p".repeat(65)}","observedState":"OK"}]'::jsonb`],
    ["an unregistered metric", `'[{"t":"METRIC","id":"provider-outcome@9","observedState":"OK"}]'::jsonb`],
    ["an unregistered page", `'[{"t":"PAGE","id":"PLATFORM_OPS:secret","observedState":"OK"}]'::jsonb`],
    ["a numeric observedState", `'[{"t":"METRIC","id":"provider-outcome@1","observedState":3}]'::jsonb`],
    ["an unknown part", `'[{"t":"METRIC","id":"provider-outcome@1","part":"secretPart","observedState":"OK"}]'::jsonb`],
    ["an unknown window", `'[{"t":"METRIC","id":"provider-outcome@1","w":14,"observedState":"OK"}]'::jsonb`],
    ["a window as a string", `'[{"t":"METRIC","id":"provider-outcome@1","w":"7","observedState":"OK"}]'::jsonb`],
    ["an unknown ref type", `'[{"t":"USER","id":"u1","observedState":"OK"}]'::jsonb`],
    ["REF-ID SMUGGLING: transcript text as an INCIDENT id", `'[{"t":"INCIDENT","id":"the customer said the card ends in seven","observedState":"OPEN"}]'::jsonb`],
    ["REF-ID SMUGGLING: an email as a PROVIDER id", `'[{"t":"PROVIDER","id":"jane@example.com","observedState":"OK"}]'::jsonb`],
  ];
  const admitted = refCases.filter(([, refs], k) => asApp(A, ins(`mf_ref${k}`, A, "PLATFORM_OPS", "WATCHING_ISSUE", "D7", refs)).ok).map(([w]) => w);
  check(13, "the B2 trigger rejects each: extra key, id > 64, unregistered metric / page, numeric observedState, unknown part / w, a ref id holding transcript text", admitted.length === 0, admitted.join(" | "));
  const payloadBad = asApp(A, ins("mf_pl1", A, "PLATFORM_OPS", "WATCHING_ISSUE", "D7", REF_M, `'{"conversationId":"x"}'::jsonb`));
  const payloadVal = asApp(A, ins("mf_pl2", A, "PLATFORM_OPS", "OPERATIONAL_STATE", "H72", REF_M, `'{"expected":"the customer is angry"}'::jsonb`));
  check(14, "the payload allowlist: a conversation key, or a free-text value ⇒ refused", /payload key refused/.test(payloadBad.err) && /payload value not allowed/.test(payloadVal.err), `${errLine(payloadBad)} | ${errLine(payloadVal)}`);

  // S2 M1: supersedesId must name a visible fact of the same operator and area.
  asApp(A, ins("mf_m1own", A));
  const supIns = (op: string, id: string, sup: string, area = "PLATFORM_OPS") => asApp(op, `insert into ${T} (id,"operatorUserId","platformArea","factType",origin,payload,"sourceRefs",ttl,"supersedesId") values ('${id}','${op}','${area}','WATCHING_ISSUE','TOOL_DERIVED','{}'::jsonb,${REF_M},'D7','${sup}');`);
  const supOther = supIns(A, "mf_m1x", "mf_b1");
  const supArea = supIns(A, "mf_m1y", "mf_m1own", "SECURITY_OPS");
  const supOwn = supIns(A, "mf_m1z", "mf_m1own");
  check(62, "S2 M1: another operator's fact id as supersedesId ⇒ refused; own fact of another area ⇒ refused; own fact, same area ⇒ OK",
    /same operator and area/.test(supOther.err) && /same operator and area/.test(supArea.err) && supOwn.ok, `${errLine(supOther)} | ${errLine(supArea)} | ${errLine(supOwn)}`);

  // fm_system / fm_auth: nothing on the table; EXECUTE matrix.
  const sysOpen = [`select count(*) from ${T};`, `delete from ${T};`, `update ${T} set "invalidReason"='GONE';`, ins("mf_sys", A)].filter((q) => !deniedByGrant(asSys(q)));
  check(15, "fm_system has NO table access (SELECT / INSERT / UPDATE / DELETE ⇒ permission denied)", sysOpen.length === 0, sysOpen.join(" | "));
  check(16, "fm_auth cannot read the table", deniedByGrant(asAuth(`select count(*) from ${T};`)));
  const appPurge = asApp(A, `select fm_purge_platform_ai_memory(10);`), appPurgeOp = asApp(A, `select fm_purge_platform_ai_memory_for_operator('${A}');`);
  check(17, "fm_app cannot EXECUTE either purge", deniedByGrant(appPurge) && deniedByGrant(appPurgeOp), `${errLine(appPurge)} | ${errLine(appPurgeOp)}`);
  const sysLimit = asSys(`select fm_purge_platform_ai_memory(501);`);
  check(18, "fm_system may EXECUTE the purge, p_limit bounded (501 ⇒ refused)", /p_limit out of range/.test(sysLimit.err), errLine(sysLimit));

  // ── [o1] the soft-delete definer — S2's list ───────────────────────────────
  console.log("\n[o1] fm_platform_ai_memory_soft_delete — the sole soft-delete path\n");
  asApp(A, `${ins("mf_o1", A)} ${ins("mf_o2", A)} ${ins("mf_sec", A, "SECURITY_OPS")}`);
  const own = asApp(A, `select fm_platform_ai_memory_soft_delete('mf_o1');`);
  const afterOwn = asApp(A, `select count(*) from ${T} where id='mf_o1';`);
  check(19, "own → 1, then invisible to fm_app (the row stays for the purge, deletedAt = now())",
    own.out === "1" && afterOwn.out === "0" && one(`select ("deletedAt" is not null and abs(extract(epoch from ("deletedAt" - ${N}))) < 60)::text from ${T} where id='mf_o1';`) === "true", `${own.out || errLine(own)} ${afterOwn.out}`);
  const other = asApp(B, `select fm_platform_ai_memory_soft_delete('mf_o2');`);
  check(20, "another operator naming the id → 0 (nothing changed)", other.out === "0" && one(`select ("deletedAt" is null)::text from ${T} where id='mf_o2';`) === "true", other.out || errLine(other));
  one(`update "PlatformGrant" set status='REVOKED', "revokedAt"=now() where id='pg_a_sec';`);
  const revoked = asApp(A, `select fm_platform_ai_memory_soft_delete('mf_sec');`);
  check(21, "revoked area → 0", revoked.out === "0" && one(`select ("deletedAt" is null)::text from ${T} where id='mf_sec';`) === "true", revoked.out || errLine(revoked));
  const again = asApp(A, `select fm_platform_ai_memory_soft_delete('mf_o1');`);
  seed(`('mf_exp','${A}','PLATFORM_OPS','WATCHING_ISSUE','TOOL_DERIVED','{}'::jsonb,${REF_M},'D7',${N} - interval '8 days',${N} - interval '8 days',${N} - interval '1 day',NULL,NULL,NULL)`);
  const expired = asApp(A, `select fm_platform_ai_memory_soft_delete('mf_exp');`);
  check(22, "already deleted → 0; expired → 0", again.out === "0" && expired.out === "0" && one(`select ("deletedAt" is null)::text from ${T} where id='mf_exp';`) === "true", `${again.out} ${expired.out}`);
  const nullGuc = psql(h.appUrl, `select fm_platform_ai_memory_soft_delete('mf_o2');`, false);
  const emptyGuc = psql(h.appUrl, `BEGIN; SET LOCAL app.user_id = ''; select fm_platform_ai_memory_soft_delete(NULL); COMMIT;`, false);
  check(23, "NULL GUC → exception; empty GUC → exception (nothing changed)", /no operator bound/.test(nullGuc.err) && /no operator bound/.test(emptyGuc.err) && one(`select ("deletedAt" is null)::text from ${T} where id='mf_o2';`) === "true", `${errLine(nullGuc)} | ${errLine(emptyGuc)}`);
  const sysSd = asSys(`select fm_platform_ai_memory_soft_delete('mf_o2');`), authSd = asAuth(`select fm_platform_ai_memory_soft_delete('mf_o2');`);
  const pub = one(`select exists (select 1 from aclexplode(coalesce((select proacl from pg_proc where oid='public.fm_platform_ai_memory_soft_delete(text)'::regprocedure), acldefault('f', 10))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')::text;`);
  check(24, "PUBLIC (no EXECUTE ACL entry) and fm_system / fm_auth cannot EXECUTE the soft delete", deniedByGrant(sysSd) && deniedByGrant(authSd) && pub === "false", `${errLine(sysSd)} | ${errLine(authSd)} | public=${pub}`);
  const directDel = asApp(A, `update ${T} set "deletedAt" = now() where id='mf_o2';`);
  check(25, "a direct fm_app UPDATE of deletedAt → permission denied", deniedByGrant(directDel), errLine(directDel));
  asApp(A, ins("mf_o3", A));
  asApp(B, ins("mf_b2", B));
  const liveA = asApp(A, `select count(*) from ${T};`).out;
  const all = asApp(A, `select fm_platform_ai_memory_soft_delete(NULL);`);
  check(26, "delete-all (p_id NULL) touches ONLY the caller's live rows in held areas: B's rows and A's revoked-area row untouched",
    all.out === liveA && Number(liveA) >= 2 && count(`"operatorUserId"='${B}' and "deletedAt" is not null`) === 0 && one(`select ("deletedAt" is null)::text from ${T} where id='mf_sec';`) === "true",
    `${all.out || errLine(all)} vs ${liveA}`);
  asApp(A, ins("mf_inv", A));
  const inv = asApp(A, `update ${T} set "invalidReason" = 'GONE' where id='mf_inv';`);
  const invAt = one(`select ("invalidatedAt" is not null)::text || '|' || "invalidReason" from ${T} where id='mf_inv';`);
  const inv2 = asApp(A, `update ${T} set "invalidReason" = 'STATE_CHANGED' where id='mf_inv';`);
  check(27, "invalidation still works for fm_app (invalidatedAt stamped by the trigger), and only once", inv.ok && invAt === "true|GONE" && /already invalidated/.test(inv2.err), `${errLine(inv)} ${invAt} ${errLine(inv2)}`);

  // ── [owner] the definers on a BYPASSRLS non-superuser, then the negative control ──
  console.log("\n[owner] the definer functions owned as on Supabase (BYPASSRLS, NOT superuser)\n");
  one(`create role fm_aimem_owner nologin bypassrls nosuperuser; create role fm_aimem_nobypass nologin nobypassrls nosuperuser;
       grant usage, create on schema public to fm_aimem_owner, fm_aimem_nobypass;
       grant execute on function public.current_fm_user_id() to fm_aimem_owner, fm_aimem_nobypass;
       grant select on "PlatformGrant" to fm_aimem_owner, fm_aimem_nobypass;`);
  const setOwner = (role: string) => one(`alter table ${T} owner to ${role};
       alter function public.fm_platform_ai_memory_soft_delete(text) owner to ${role};
       alter function public.fm_purge_platform_ai_memory(integer) owner to ${role};
       alter function public.fm_purge_platform_ai_memory_for_operator(text) owner to ${role};
       select 'ok';`);
  setOwner("fm_aimem_owner");
  asApp(A, ins("mf_own1", A));
  const sdOwner = asApp(A, `select fm_platform_ai_memory_soft_delete('mf_own1');`);
  check(28, "owned by a BYPASSRLS non-superuser: the soft delete works (1)", sdOwner.out === "1", sdOwner.out || errLine(sdOwner));
  const before = count("true");
  const expectGone = count(`"expiresAt" <= ${N} or "deletedAt" is not null or "invalidatedAt" < ${N} - interval '1 day' or not exists (select 1 from "PlatformGrant" g where g."userId" = "operatorUserId" and g.area = "platformArea" and g.status = 'ACTIVE')`);
  setOwner("fm_aimem_nobypass");
  const nc = asSys(`select fm_purge_platform_ai_memory(500);`);
  asApp(A, ins("mf_nc", A));
  const ncSd = asApp(A, `select fm_platform_ai_memory_soft_delete('mf_nc');`);
  check(29, "NEGATIVE CONTROL: a NON-bypass owner under FORCE RLS: the purge returns 0 and deletes nothing; the soft delete returns 0",
    nc.out === "0" && count("true") === before + 1 && ncSd.out === "0", `${nc.out || errLine(nc)} ${ncSd.out || errLine(ncSd)}`);
  setOwner("fm_aimem_owner");
  const purged = asSys(`select fm_purge_platform_ai_memory(500);`);
  check(30, "…and under the BYPASSRLS owner the definer deletes under FORCE RLS exactly the rows its rules name (expired, deleted, revoked area)",
    purged.ok && Number(purged.out) === expectGone && expectGone >= 3 && count("id in ('mf_o1','mf_exp','mf_sec','mf_own1')") === 0 && count("id='mf_inv'") === 1,
    `${purged.out || errLine(purged)} expected ${expectGone}`);

  // Key rotation's narrow path.
  one(`insert into ${T} (id,"operatorUserId","platformArea","factType",origin,payload,"sourceRefs",ttl,"noteEncrypted") values ('mf_rot','${A}','PLATFORM_OPS','WATCHING_ISSUE','TOOL_DERIVED','{}'::jsonb,${REF_M},'D7','v2:old'); select 'ok';`);
  const rotOk = psql(owner, `BEGIN; SET LOCAL ROLE fm_aimem_owner; UPDATE ${T} SET "noteEncrypted" = 'v2:new' WHERE id = 'mf_rot'; COMMIT;`, false);
  const rotBad = psql(owner, `BEGIN; SET LOCAL ROLE fm_aimem_owner; UPDATE ${T} SET "noteEncrypted" = 'v2:x', ttl = 'D30' WHERE id = 'mf_rot'; COMMIT;`, false);
  check(31, "ROTATION: a BYPASSRLS role changes noteEncrypted ALONE; with any other column ⇒ immutable",
    rotOk.ok && one(`select "noteEncrypted" from ${T} where id='mf_rot';`) === "v2:new" && /memory fact is immutable/.test(rotBad.err), `${errLine(rotOk)} | ${errLine(rotBad)}`);

  // ── [store] the REAL data module through lib/db's fm_app client ─────────────
  console.log("\n[store] store.ts through the bound fm_app tenant client\n");
  await assertTenantClientBound();
  const store = await import("@/lib/platform/intelligence/ai/memory/store");
  const enc = await import("@/lib/plaid/encryption");
  const ref = { t: "METRIC" as const, id: "provider-outcome@1", part: "failing", w: 7, observedState: "DEGRADED" as const };
  const NOTE = "webhook retries look stuck, check after deploy";
  const c1 = await store.insertFact({ operatorId: C, area: "PLATFORM_OPS", factType: "WATCHING_ISSUE", origin: "TOOL_DERIVED", concern: "DEGRADATION", note: NOTE, payload: {}, refs: [ref], ttl: "D7", proposalJti: "jti-1" });
  check(32, "insertFact ⇒ CREATED", c1.kind === "CREATED", c1.kind);
  if (c1.kind !== "CREATED") return report("PLATFORM AI MEMORY ACCEPTANCE");
  const cipher = one(`select "noteEncrypted" from ${T} where id='${c1.fact.id}';`);
  check(33, "the note is stored ENCRYPTED under PLATFORM_AI_MEMORY (v2) and decrypts exactly", cipher.startsWith("v2:") && !cipher.includes("webhook") && enc.decryptWithPurpose(cipher, enc.EncryptionPurpose.PLATFORM_AI_MEMORY) === NOTE);
  const aud = one(`select count(*) || '|' || coalesce(max(metadata::text), '') from "AuditLog" where action='PLATFORM_AI_MEMORY_CONFIRMED' and metadata->'target'->>'id' = '${c1.fact.id}';`);
  check(34, "the CONFIRMED audit row: same transaction, {area, factType, origin, refCount, ttl}, NO note / ref id", aud.startsWith("1|") && /"refCount":\s*1/.test(aud) && !aud.includes("webhook") && !aud.includes("provider-outcome"), aud);
  const replay = await store.insertFact({ operatorId: C, area: "PLATFORM_OPS", factType: "WATCHING_ISSUE", origin: "TOOL_DERIVED", concern: null, note: null, payload: {}, refs: [ref], ttl: "D7", proposalJti: "jti-1" });
  check(35, "a replayed proposalJti ⇒ REPLAY (the route's 409); nothing written", replay.kind === "REPLAY" && count(`"operatorUserId"='${C}'`) === 1, replay.kind);
  const bad = await store.insertFact({ operatorId: C, area: "PLATFORM_OPS", factType: "WATCHING_ISSUE", origin: "TOOL_DERIVED", concern: null, note: null, payload: {}, refs: [{ ...ref, id: "the customer jane" }], ttl: "D7", proposalJti: null });
  check(36, "a smuggled ref id is refused by the store before the database (INVALID)", bad.kind === "INVALID");
  const vis = await store.visibleFacts(C);
  check(37, "visibleFacts: the operator's fact, note decrypted, refs parsed", vis.length === 1 && vis[0].note === NOTE && vis[0].refs[0]?.id === "provider-outcome@1");
  const ren = await store.renewFact(C, c1.fact.id, [{ ...ref, observedState: "OK" }]);
  const visAfter = await store.visibleFacts(C);
  check(38, "renewFact: a NEW row (supersedesId = old, current observedState), the old invalidated SUPERSEDED and hidden; RENEWED audited",
    ren.kind === "RENEWED" && visAfter.length === 1 && visAfter[0].id === ren.fact.id && visAfter[0].supersedesId === c1.fact.id && visAfter[0].refs[0].observedState === "OK"
      && one(`select "invalidReason" from ${T} where id='${c1.fact.id}';`) === "SUPERSEDED"
      && one(`select count(*) from "AuditLog" where action='PLATFORM_AI_MEMORY_RENEWED';`) === "1", JSON.stringify(ren.kind));
  const ren2 = await store.renewFact(C, c1.fact.id, [ref]);
  check(39, "renewing the superseded (hidden) row again ⇒ NOT_FOUND", ren2.kind === "NOT_FOUND", ren2.kind);
  if (ren.kind !== "RENEWED") return report("PLATFORM AI MEMORY ACCEPTANCE");
  const invN = await store.invalidateFacts(C, [{ id: ren.fact.id, area: "PLATFORM_OPS", reason: "STATE_CHANGED" }]);
  const invAud = one(`select coalesce(max(metadata::text),'') from "AuditLog" where action='PLATFORM_AI_MEMORY_INVALIDATED';`);
  check(40, "invalidateFacts: 1 changed; the row is ABSENT from visibleFacts (list / injection / recall) but PRESENT for the purge; one aggregated {area, reason, count} audit",
    invN === 1 && (await store.visibleFacts(C)).length === 0 && count(`id='${ren.fact.id}'`) === 1 && /"count":\s*1/.test(invAud) && /STATE_CHANGED/.test(invAud) && !invAud.includes("provider-outcome"), invAud);
  const keptByPurge = asSys(`select fm_purge_platform_ai_memory(500);`);
  check(41, "a freshly invalidated row is kept by the purge (< 1 day); backdated past 1 day it is removed", count(`id='${ren.fact.id}'`) === 1 && keptByPurge.ok
    && (() => { one(`begin; alter table ${T} disable trigger platform_ai_memory_immutable; update ${T} set "invalidatedAt" = ${N} - interval '25 hours' where id='${ren.fact.id}'; alter table ${T} enable trigger platform_ai_memory_immutable; commit; select 'ok';`); asSys(`select fm_purge_platform_ai_memory(500);`); return count(`id='${ren.fact.id}'`) === 0; })());
  const d1 = await store.insertFact({ operatorId: C, area: "PLATFORM_OPS", factType: "FOLLOW_UP", origin: "OPERATOR_EXPLICIT", concern: "AWAITING_FIX", note: null, payload: { due: "D7" }, refs: [{ t: "JOB", id: "sync-banks", observedState: "FAILED" }], ttl: "D30", proposalJti: null });
  const sd = d1.kind === "CREATED" ? await store.softDeleteFact(C, d1.fact.id) : { deleted: -1 };
  const sdAud = one(`select coalesce(max(metadata::text),'') from "AuditLog" where action='PLATFORM_AI_MEMORY_DELETED';`);
  check(42, "softDeleteFact goes through the definer: 1, hidden at once, DELETED audit {area, count} in the same transaction",
    sd.deleted === 1 && (await store.visibleFacts(C)).length === 0 && /"count":\s*1/.test(sdAud) && /PLATFORM_OPS/.test(sdAud), sdAud);
  const hiddenInvalidated = count(`"operatorUserId"='${C}' and "deletedAt" is null and "invalidatedAt" is not null and "expiresAt" > ${N}`);
  for (const k of [1, 2, 3]) await store.insertFact({ operatorId: C, area: "PLATFORM_OPS", factType: "WATCHING_ISSUE", origin: "TOOL_DERIVED", concern: null, note: null, payload: {}, refs: [ref], ttl: "D7", proposalJti: `jti-all-${k}` });
  const allC = await store.softDeleteAllFacts(C);
  const wantAll = 3 + hiddenInvalidated;
  check(43, "softDeleteAllFacts: the 3 visible rows AND the hidden invalidated (unexpired) row (S2's predicate has no invalidatedAt term) — all deleted, one DELETED audit row {area: ALL, count}",
    hiddenInvalidated === 1 && allC.deleted === wantAll && (await store.visibleFacts(C)).length === 0
      && count(`"operatorUserId"='${C}' and "deletedAt" is null and "expiresAt" > ${N}`) === 0
      && one(`select count(*) from "AuditLog" where action='PLATFORM_AI_MEMORY_DELETED' and metadata->>'area' = 'ALL' and (metadata->>'count')::int = ${wantAll};`) === "1",
    `${allC.deleted} vs ${wantAll} (hidden invalidated ${hiddenInvalidated})`);

  // ── [revoke] area revocation (design §8) ──────────────────────────────────
  console.log("\n[revoke] area revocation: hidden at once (no app guard), purged, regrant restores, offboarding\n");
  const r1 = await store.insertFact({ operatorId: B, area: "PLATFORM_OPS", factType: "WATCHING_ISSUE", origin: "TOOL_DERIVED", concern: null, note: "watch this", payload: {}, refs: [ref], ttl: "D7", proposalJti: null });
  const bBefore = (await store.visibleFacts(B)).length;
  one(`update "PlatformGrant" set status='REVOKED', "revokedAt"=now() where id='pg_b_ops';`);
  const bRevoked = (await store.visibleFacts(B)).length + (await store.visibleFacts(B, { areas: ["PLATFORM_OPS"] })).length;
  one(`update "PlatformGrant" set status='ACTIVE', "revokedAt"=null where id='pg_b_ops';`);
  const bRegrant = (await store.visibleFacts(B)).length;
  check(44, "revoked ⇒ the store (no app guard at all) returns 0 for list / injection / recall; regranted BEFORE the purge ⇒ visible again",
    r1.kind === "CREATED" && bBefore >= 1 && bRevoked === 0 && bRegrant === bBefore, `${bBefore} ${bRevoked} ${bRegrant}`);
  one(`update "PlatformGrant" set status='REVOKED', "revokedAt"=now() where id='pg_b_ops';`);
  asSys(`select fm_purge_platform_ai_memory(500);`);
  check(45, "revoked then purged ⇒ the purge deleted every B row (no ACTIVE grant)", count(`"operatorUserId"='${B}'`) === 0);
  one(`update "PlatformGrant" set status='ACTIVE', "revokedAt"=null where id='pg_b_ops';`);
  await store.insertFact({ operatorId: B, area: "PLATFORM_OPS", factType: "WATCHING_ISSUE", origin: "TOOL_DERIVED", concern: null, note: null, payload: {}, refs: [ref], ttl: "D7", proposalJti: null });
  one(`update "PlatformGrant" set status='REVOKED', "revokedAt"=now() where "userId"='${B}';`);
  const off = asSys(`select fm_purge_platform_ai_memory_for_operator('${B}');`);
  check(46, "offboarding (every grant revoked) + the per-operator purge ⇒ 0 rows for that operator", off.out === "1" && count(`"operatorUserId"='${B}'`) === 0, off.out || errLine(off));
  const offNull = asSys(`select fm_purge_platform_ai_memory_for_operator(NULL);`);
  check(47, "the per-operator purge refuses a NULL operator", /p_user required/.test(offNull.err), errLine(offNull));

  // ── [stale] expiry on read, never extended ─────────────────────────────────
  console.log("\n[stale] expiry is authoritative on read and never moves\n");
  seed(`('mf_os72','${C}','PLATFORM_OPS','OPERATIONAL_STATE','TOOL_DERIVED','{}'::jsonb,${REF_M},'H72',${N} - interval '72 hours 1 second',${N} - interval '72 hours 1 second',${N} - interval '1 second',NULL,NULL,NULL),
        ('mf_os71','${C}','PLATFORM_OPS','OPERATIONAL_STATE','TOOL_DERIVED','{}'::jsonb,${REF_M},'H72',${N} - interval '71 hours',${N} - interval '71 hours',${N} + interval '1 hour',NULL,NULL,NULL)`);
  const seen = (await store.visibleFacts(C)).map((f) => f.id);
  check(48, "an OPERATIONAL_STATE fact at 72 h + 1 s is INVISIBLE before any purge; at 71 h it is visible", !seen.includes("mf_os72") && seen.includes("mf_os71") && count("id='mf_os72'") === 1, JSON.stringify(seen));
  const expBefore = one(`select "expiresAt"::text from ${T} where id='mf_os71';`);
  for (let k = 0; k < 100; k++) await store.visibleFacts(C, { ids: ["mf_os71"] });
  check(49, "100 recalls leave expiresAt unchanged (memory reads never extend it)", one(`select "expiresAt"::text from ${T} where id='mf_os71';`) === expBefore);

  // ── [job] the REAL retention seam ──────────────────────────────────────────
  console.log("\n[job] jobs/data-retention.ts memory seam with PLATFORM_AI_MEMORY_PURGE_ENABLED\n");
  {
    const { platformAiMemoryPurgeDeps } = await import("../jobs/data-retention");
    const { runPlatformAiMemoryPurge } = await import("@/lib/platform/intelligence/ai/memory/purge");
    const beforeJ = count("true");
    const r = await runPlatformAiMemoryPurge(await platformAiMemoryPurgeDeps("SCHEDULED"));
    const removed = beforeJ - count("true");
    const a = one(`select coalesce((select metadata::text from "AuditLog" where action='PLATFORM_AI_MEMORY_PURGED' order by "createdAt" desc, id desc limit 1), '');`);
    check(50, "SCHEDULED: enabled by the flag; the audited count equals the rows removed; no userId / ids in the audit",
      r.enabled && r.facts === removed && removed >= 1 && a.includes(`"facts": ${removed}`) && !a.includes(C) && !a.includes("mf_"), `${JSON.stringify(r)} removed=${removed} audit=${a}`);
    const m = await runPlatformAiMemoryPurge(await platformAiMemoryPurgeDeps("MANUAL_DISPATCH"));
    check(51, "MANUAL_DISPATCH: always on, audited every run (zero included), tagged", m.enabled && m.facts === 0
      && one(`select count(*) from "AuditLog" where action='PLATFORM_AI_MEMORY_PURGED' and metadata->>'trigger' = 'MANUAL_DISPATCH';`) === "1");
  }

  // Account deletion cascades.
  await store.insertFact({ operatorId: A, area: "PLATFORM_OPS", factType: "WATCHING_ISSUE", origin: "TOOL_DERIVED", concern: null, note: null, payload: {}, refs: [ref], ttl: "D7", proposalJti: null });
  const aRows = count(`"operatorUserId"='${A}'`);
  const uDel = asSys(`delete from "User" where id='${A}';`);
  check(52, "account deletion as fm_system (the account purge's role) under FORCE RLS cascades — every fact of the user removed",
    aRows >= 1 && uDel.ok && count(`"operatorUserId"='${A}'`) === 0, `${aRows} ${errLine(uDel)}`);

  // ── [loophole] design §8: memory can never become a transcript side channel ──
  console.log("\n[loophole] canary conversations, an adversarial proposer, the transcript purge, then every memory column decrypted\n");
  {
    const D = "aimem_op_d";
    one(`insert into "User" (id,email,name,"updatedAt") values ('${D}','aimem-d@example.test','Operator D',now());
      insert into "PlatformGrant" (id,"userId",area,level,"updatedAt") values ('pg_d_ops','${D}','PLATFORM_OPS','READ',now()); select 'ok';`);
    const convStore = await import("@/lib/platform/intelligence/ai/conversations/store");
    const { scrubOperatorText } = await import("@/lib/ai/privacy/scrub");
    const { buildMemoryTurn } = await import("@/lib/platform/intelligence/ai/memory/turn");
    const { handleConfirm } = await import("@/lib/platform/intelligence/ai/memory/handlers");
    const CANARY_CUID = `c${randomBytes(12).toString("hex")}`;
    const CANARY_EMAIL = "canary.person@example.test";
    const CANARY_SENTENCE = "the orange heron flies at midnight over the quiet harbour";
    const CANARY_ANSWER = "the violet lantern hums beneath the old stone bridge tonight";
    const rawQ = `${CANARY_SENTENCE}; mail ${CANARY_EMAIL} about $4,321.99 and incident ${CANARY_CUID}`;
    const q = scrubOperatorText(rawQ, 500);
    const conv = await convStore.createConversation({ operatorId: D, area: "PLATFORM_OPS", createRequestId: randomBytes(16).toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-4$3-8$4-$5").slice(0, 36), scrubbedQuestion: q });
    if (conv.kind !== "CREATED") throw new Error(`loophole fixture: ${conv.kind}`);
    await convStore.settleTurn(D, conv.conversation.id, conv.pair.assistant.id, { status: "COMPLETE", answer: { v: 1, segments: [{ kind: "text", text: `${CANARY_ANSWER} and the $4,321.99 figure` }], citations: [], notes: [], stop: "ANSWERED" }, evidenceRefs: [] });
    const purgedTexts = [q, `${CANARY_ANSWER} and the $4,321.99 figure`];
    const PAGE = "PLATFORM_OPS:platform-incidents:open";
    const pageReaders = { metric: async () => null, page: async () => ({ state: "OK" as const, label: "Open incidents", updatedAt: null }), incident: async () => null, job: async () => null, provider: async () => null };
    const deps = { heldAreas: async () => new Set(["PLATFORM_OPS"] as const), readersFor: async () => pageReaders, store, now: () => new Date() };
    const ev = { envelopes: [], hrefs: new Set<string>(), definitions: [], labels: new Set<string>(), trace: [], pages: new Map([["/x", { id: PAGE, params: {} }]]) } as never;
    // The adversarial generator: notes copying spans, the email, the amount, the cuid — as proposed notes AND as edited notes at confirm.
    const attacks = [
      CANARY_SENTENCE, `remember ${CANARY_SENTENCE.split(" ").slice(2, 8).join(" ")}`, CANARY_ANSWER.split(" ").slice(1, 7).join(" "),
      `ping ${CANARY_EMAIL}`, "about $4,321.99", "about 4321 dollars", `see ${CANARY_CUID}`, CANARY_CUID.slice(0, 25),
      "orange heron flies at midnight", "watch the queue tomorrow",
    ];
    let accepted = 0, offered = 0;
    for (const note of attacks) {
      for (const mode of ["proposed", "edited"] as const) {
        const t = buildMemoryTurn({ operatorId: D, area: "PLATFORM_OPS", facts: [], question: q, historyNewestFirst: [], metricLabel: () => null, pageLabel: () => "Open incidents", now: () => new Date() });
        t.hooks.propose({ factType: "WATCHING_ISSUE", subjectRef: PAGE, ...(mode === "proposed" ? { note } : {}) }, ev);
        const fin = t.finalize(`${CANARY_ANSWER} and the $4,321.99 figure`);
        if (!fin.card) continue;
        offered++;
        const r = await handleConfirm(D, { token: fin.card.token, ttl: "D7", ...(mode === "edited" ? { note } : {}) }, deps);
        if (r.status === 201) accepted++;
      }
    }
    // Ref-id smuggling straight at the table (the writer's own path): the trigger refuses it.
    const smuggle = asApp(D, `insert into ${T} (id,"operatorUserId","platformArea","factType",origin,payload,"sourceRefs",ttl) values ('mf_smug','${D}','PLATFORM_OPS','WATCHING_ISSUE','TOOL_DERIVED','{}'::jsonb,'[{"t":"INCIDENT","id":"${CANARY_SENTENCE.slice(0, 40)}","observedState":"OPEN"}]'::jsonb,'D7');`);
    check(55, "LOOPHOLE: a ref id holding transcript text is rejected by the trigger", !smuggle.ok && /not a cuid/.test(smuggle.err), errLine(smuggle));
    // The transcript purge: the conversation's messages expire and fm_system purges them.
    one(`begin; alter table "PlatformAiMessage" disable trigger platform_ai_message_settle;
      update "PlatformAiMessage" set "createdAt" = ${N} - interval '8 days', "purgeAfter" = ${N} - interval '1 day' where "conversationId" = '${conv.conversation.id}';
      alter table "PlatformAiMessage" enable trigger platform_ai_message_settle; commit; select 'ok';`);
    asSys(`select * from fm_purge_platform_ai_conversations(500);`);
    const leftMsgs = one(`select count(*) from "PlatformAiMessage" where "conversationId" = '${conv.conversation.id}';`);
    // Decrypt EVERY memory column of D and scan.
    const encMod = await import("@/lib/plaid/encryption");
    const dump = psql(owner, `select coalesce("noteEncrypted",'') || E'\t' || payload::text || E'\t' || "sourceRefs"::text from ${T} where "operatorUserId" = '${D}';`).out.split("\n").filter(Boolean);
    const plain = dump.map((line) => { const [c, pl, refs] = line.split("\t"); return { note: c ? encMod.decryptWithPurpose(c, encMod.EncryptionPurpose.PLATFORM_AI_MEMORY) : "", pl, refs }; });
    const all = plain.map((x) => `${x.note}\n${x.pl}\n${x.refs}`).join("\n").toLowerCase();
    const canaries = [CANARY_EMAIL, CANARY_CUID, "4,321", "4321", "orange heron", "violet lantern"];
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
    const purgedNorm = purgedTexts.map(norm);
    const words6 = plain.flatMap((x) => { const w = norm(x.note).split(" ").filter(Boolean); const out: string[] = []; for (let i = 0; i + 6 <= w.length; i++) out.push(w.slice(i, i + 6).join(" ")); return out; });
    const chars24 = plain.flatMap((x) => { const n = norm(x.note); const out: string[] = []; for (let i = 0; i + 24 <= n.length; i++) out.push(n.slice(i, i + 24)); return out; });
    const cuidsOutsideIncident = plain.flatMap((x) => [...`${x.note} ${x.pl}`.matchAll(/\bc[a-z0-9]{20,}\b/g)].map((m) => m[0]))
      .concat(plain.flatMap((x) => (JSON.parse(x.refs) as Array<{ t: string; id: string }>).filter((r) => r.t !== "INCIDENT" && /^c[a-z0-9]{20,}$/.test(r.id)).map((r) => r.id)));
    check(56, "LOOPHOLE: the adversary was answered (proposals offered, at least the benign one confirmed) and the transcript is purged",
      offered >= 1 && accepted >= 1 && leftMsgs === "0", `offered=${offered} accepted=${accepted} left=${leftMsgs}`);
    check(57, "LOOPHOLE: after the purge, no canary (email, cuid, amount, sentence) in ANY decrypted memory column",
      !canaries.some((c) => all.includes(c.toLowerCase())), canaries.filter((c) => all.includes(c.toLowerCase())).join(","));
    check(58, "LOOPHOLE: no span of 6+ words or 24+ characters of any purged message; no conversation / message keys; no cuid outside an INCIDENT id",
      !words6.some((w) => purgedNorm.some((p) => p.includes(w))) && !chars24.some((c) => purgedNorm.some((p) => p.includes(c)))
        && !/conversation|message|transcript/i.test(plain.map((x) => `${x.pl}${x.refs}`).join("")) && cuidsOutsideIncident.length === 0,
      JSON.stringify({ w: words6.filter((w) => purgedNorm.some((p) => p.includes(w))), c: cuidsOutsideIncident }));

    // S2 C1 — a saved CANARY note the model echoes never reaches the stored transcript (PlatformAiMessage, decrypted).
    {
      const CANARY_NOTE = "watch the amber falcon tower drill tonight";
      const ins1 = await store.insertFact({ operatorId: D, area: "PLATFORM_OPS", factType: "WATCHING_ISSUE", origin: "OPERATOR_EXPLICIT", concern: null, note: CANARY_NOTE, payload: {}, refs: [{ t: "PAGE", id: PAGE, observedState: "OK" }], ttl: "D7", proposalJti: null });
      const { retrieveFacts } = await import("@/lib/platform/intelligence/ai/memory/retrieve");
      const { runConversationTurn } = await import("@/lib/platform/intelligence/ai/conversations/turn");
      const { facts } = await retrieveFacts({ operatorId: D, areas: ["PLATFORM_OPS"], readersFor: async () => pageReaders, store, mode: "inject" });
      const mt = buildMemoryTurn({ operatorId: D, area: "PLATFORM_OPS", facts, question: "what was I watching", historyNewestFirst: [], metricLabel: () => null, pageLabel: () => "Open incidents", now: () => new Date() });
      const fakeBinding = { surfaceLabel: "Platform Operations", listMetrics: () => [], describeMetric: () => null, readMetric: async () => null,
        listPages: () => [{ id: PAGE, label: "Open incidents", workspaceLabel: null, areaLabel: "Platform Operations", metrics: [], params: [] }], resolvePage: () => null } as never;
      const generate = (async () => ({ content: `You noted: ${CANARY_NOTE}.`, toolCalls: [], raw: { role: "assistant", content: `You noted: ${CANARY_NOTE}.` }, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 5, reasoningTokens: 0 } })) as never;
      const c2 = await convStore.createConversation({ operatorId: D, area: "PLATFORM_OPS", createRequestId: crypto.randomUUID(), scrubbedQuestion: "what was I watching" });
      if (c2.kind !== "CREATED" || ins1.kind !== "CREATED") throw new Error("C1 fixture");
      const run = await runConversationTurn({ conversationId: c2.conversation.id, question: "what was I watching", binding: fakeBinding, history: [], generate, model: "m", classify: () => "PROVIDER", memory: mt });
      if (run.outcome.status === "COMPLETE") await convStore.settleTurn(D, c2.conversation.id, c2.pair.assistant.id, run.outcome);
      const ciphers = psql(owner, `select coalesce("contentEncrypted",'') from "PlatformAiMessage" where "conversationId"='${c2.conversation.id}';`).out.split("\n").filter(Boolean);
      const plainMsgs = ciphers.map((c) => encMod.decryptWithPurpose(c, encMod.EncryptionPurpose.PLATFORM_AI_MESSAGE)).join("\n").toLowerCase();
      check(63, "S2 C1 LOOPHOLE: the model echoed a saved canary note; the decrypted PlatformAiMessage rows never contain it ('[your saved note]' instead)",
        run.outcome.status === "COMPLETE" && plainMsgs.includes("[your saved note]") && !plainMsgs.includes("amber falcon"), plainMsgs.slice(0, 300));
    }

    // D13 — the operator's own data export: held areas only, the note in plaintext, type, refs and dates; EXPORTED audit = count only.
    const { assembleUserExport } = await import("@/lib/export/assemble");
    const quietly = async <X,>(f: () => Promise<X>): Promise<X> => { const o = { log: console.log, error: console.error, warn: console.warn }; console.log = () => {}; console.error = () => {}; console.warn = () => {}; try { return await f(); } finally { Object.assign(console, o); } };
    // The Platform directory lists an ACTIVE grant only beside its Platform Space (loadPlatformDirectory).
    one(`insert into "Space" (id,name,"platformArea","updatedAt") values ('sp_aimem_ops','Platform Ops','PLATFORM_OPS',now()) on conflict do nothing; select 'ok';`);
    const visibleD = Number(one(`select count(*) from ${T} where "operatorUserId"='${D}' and "deletedAt" is null and "invalidatedAt" is null and "expiresAt" > ${N};`));
    const ex = await quietly(() => assembleUserExport(D));
    const audEx = one(`select coalesce(max(metadata::text),'') from "AuditLog" where action='PLATFORM_AI_MEMORY_EXPORTED' and "performedByAdminId"='${D}';`);
    one(`update "PlatformGrant" set status='REVOKED', "revokedAt"=now() where id='pg_d_ops'; select 'ok';`);
    const exLost = await quietly(() => assembleUserExport(D));
    check(59, "D13: the export carries the operator's visible facts (note plaintext, type, refs, dates) and an EXPORTED audit with the count only; a lost area exports none",
      visibleD >= 1 && ex.platformAiMemory.length === visibleD && ex.platformAiMemory.every((f) => typeof f.notedAt === "string" && Array.isArray(f.refs))
        && ex.manifest.counts.platformAiMemory === visibleD && new RegExp(`"count":\\s*${visibleD}`).test(audEx) && !/note|refs/.test(audEx.replace(/"actor"[^}]*\}/, ""))
        && exLost.platformAiMemory.length === 0, `${visibleD} ${ex.platformAiMemory.length} ${audEx} lost=${exLost.platformAiMemory.length}`);
  }

  // ── [precheck] the pre-enable check against the real catalog ───────────────
  console.log("\n[precheck] the memory pre-enable check against the real catalog\n");
  {
    const core = await import("./lib/platform-ai-memory-precheck.core");
    const { db } = await import("@/lib/db");
    const rows = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(core.MEMORY_PRECHECK_READ_ONLY_STATEMENT);
      return {
        fns: await tx.$queryRawUnsafe<import("./lib/platform-ai-memory-precheck.core").MemoryFunctionRow[]>(core.MEMORY_PRECHECK_FUNCTIONS_SQL),
        table: await tx.$queryRawUnsafe<import("./lib/platform-ai-memory-precheck.core").MemoryTableRow[]>(core.MEMORY_PRECHECK_TABLE_SQL),
        ret: await tx.$queryRawUnsafe<import("./lib/platform-ai-memory-precheck.core").MemoryRetentionRow[]>(core.MEMORY_PRECHECK_RETENTION_SQL),
      };
    });
    const v = core.evaluateMemoryPrecheck(rows.fns, rows.table, rows.ret);
    check(60, "the pre-enable check PASSES on the migrated catalog (definer inventory, owners bypass, EXECUTE matrix, no fm_app UPDATE on deletedAt, 7-day retention)",
      v.ok, JSON.stringify(v.lines.filter((l) => !l.ok)));
    setOwner("fm_aimem_nobypass");
    one(`alter function public.fm_platform_ai_memory_soft_delete(text) owner to fm_aimem_nobypass; select 'ok';`);
    const fns2 = await db.$queryRawUnsafe<import("./lib/platform-ai-memory-precheck.core").MemoryFunctionRow[]>(core.MEMORY_PRECHECK_FUNCTIONS_SQL);
    const v2 = core.evaluateMemoryPrecheck(fns2, rows.table, rows.ret);
    setOwner("fm_aimem_owner");
    check(61, "…and FAILS when the definers are owned by a role without BYPASSRLS", !v2.ok && v2.lines.some((l) => !l.ok && /OWNER bypasses RLS/.test(l.text)));
    await db.$disconnect();
  }
  const { tenantDb, systemDb } = await import("@/lib/db");
  await (tenantDb as unknown as { $disconnect(): Promise<void> }).$disconnect();
  await (systemDb as unknown as { $disconnect(): Promise<void> }).$disconnect();
  return report("PLATFORM AI MEMORY ACCEPTANCE");
}

main()
  .then((failed) => { teardownHarness(KEEP); process.exit(failed ? 1 : 0); })
  .catch((e) => { console.error(e instanceof Error ? e.message : e); teardownHarness(KEEP); process.exit(1); });
