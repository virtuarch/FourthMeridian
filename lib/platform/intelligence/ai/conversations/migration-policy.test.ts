/**
 * lib/platform/intelligence/ai/conversations/migration-policy.test.ts  (the migration, parse-pinned)
 *
 * The DB-010 pattern (jobs/auditlog-append-only-policy.test.ts): the migration
 * duplicates constants from code and carries security-load-bearing function
 * bodies, so this test parses
 * prisma/migrations/20261104120000_platform_ai_conversations/migration.sql and
 * pins:
 *   · the intervals = PLATFORM_AI_RETENTION_DAYS / _DELETE_GRACE_DAYS / _SHELL_MIN_AGE_DAYS,
 *     and the batch bounds = PLATFORM_AI_PURGE_BATCH / _EXCHANGE_FACTOR;
 *   · the BYPASSRLS assertion of the migration principal (S2 REQUIRED 2);
 *   · fm_platform_ai_message_settle is SECURITY INVOKER — FAILS IF EVER DEFINER
 *     (as a definer, current_user would be the bypassing owner and the
 *     rotation exception would admit fm_app);
 *   · fm_platform_ai_touch_conversation: its body, exactly, and REVOKE ALL … FROM PUBLIC;
 *   · the purge: p_limit the only argument, RETURNS TABLE counts only, no
 *     dynamic SQL, fixed predicates, parents locked FOR UPDATE and replies
 *     locked + counted in the same window, EXECUTE to fm_system alone;
 *   · the column grants exclude every timestamp and retention column (S2 REQUIRED 1),
 *     fm_app has no DELETE, no statement grants fm_system / fm_auth a table;
 *   · the header says B11 and the timestamp sorts after every B10 migration.
 *
 *   npx tsx lib/platform/intelligence/ai/conversations/migration-policy.test.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  PLATFORM_AI_DELETE_GRACE_DAYS, PLATFORM_AI_PURGE_BATCH, PLATFORM_AI_PURGE_EXCHANGE_FACTOR,
  PLATFORM_AI_RETENTION_DAYS, PLATFORM_AI_SHELL_MIN_AGE_DAYS,
} from "./constants";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const NAME = "20261104120000_platform_ai_conversations";
const raw = readFileSync(path.join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf8");
const sql = raw.replace(/--[^\n]*/g, "");
const EXPIRY_NAME = "20261105120000_platform_ai_message_expiry_on_read";
const expiryRaw = readFileSync(path.join(ROOT, "prisma/migrations", EXPIRY_NAME, "migration.sql"), "utf8");
const expiry = expiryRaw.replace(/--[^\n]*/g, "").replace(/\s+/g, " ");
const flat = sql.replace(/\s+/g, " ");

/** The full CREATE FUNCTION … END $$; statement for `name`. */
function fn(name: string): string {
  const at = sql.indexOf(`CREATE FUNCTION public.${name}(`);
  if (at < 0) return "";
  const end = sql.indexOf("END $$;", at);
  return end < 0 ? "" : sql.slice(at, end + "END $$;".length);
}
const header = (f: string) => f.slice(0, f.indexOf("AS $$")).replace(/\s+/g, " ");
const body = (f: string) => f.slice(f.indexOf("AS $$") + 5, f.lastIndexOf("END $$;")).replace(/\s+/g, " ").trim();

console.log("0. the batch and the place in history");
{
  check("the header says \"B11 batch — not part of B10\"", raw.split("\n").slice(0, 3).join("\n").includes("B11 batch — not part of B10"));
  const names = readdirSync(path.join(ROOT, "prisma/migrations")).filter((n) => /^\d{14}_/.test(n)).sort();
  check("it sorts after every B10 migration (last B10 = 20261103160000_fin_e_restricted_cash), and only B11 migrations follow it",
    NAME > "20261103160000_fin_e_restricted_cash"
      && JSON.stringify(names.slice(names.indexOf(NAME))) === JSON.stringify([NAME, EXPIRY_NAME]), names.slice(-3).join(", "));
  check("lock_timeout bounds the FK lock on \"User\" (transaction-local)", /SET LOCAL lock_timeout = '5s';/.test(sql));
  check("no session-level SET (only SET LOCAL; a function-level search_path is not a session SET)", !/^\s*SET (?!LOCAL|search_path = pg_catalog, public$)/m.test(sql));
}

console.log("1. S2 REQUIRED 2 — the migration principal must bypass RLS");
{
  const m = /DO \$\$\s*BEGIN\s*IF NOT \(SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user\) THEN\s*RAISE EXCEPTION '[^']*BYPASSRLS[^']*'/.exec(sql);
  check("a DO block RAISEs unless current_user has rolbypassrls OR rolsuper", !!m);
  check("…and it runs BEFORE any table or function is created", !!m && m.index < sql.indexOf("CREATE TABLE") && m.index < sql.indexOf("CREATE FUNCTION"));
}

console.log("2. the intervals and bounds equal the code constants");
{
  const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
  const retention = `'${days(PLATFORM_AI_RETENTION_DAYS)}'`;
  check(`purgeAfter DEFAULT = createdAt + ${retention}`, flat.includes(`"purgeAfter" TIMESTAMP(3) NOT NULL DEFAULT ((now() AT TIME ZONE 'UTC'::text) + ${retention}::interval)`));
  check(`the CHECK bounds purgeAfter by createdAt + interval ${retention}`, flat.includes(`CHECK ("purgeAfter" <= "createdAt" + interval ${retention})`));
  const purge = fn("fm_purge_platform_ai_conversations");
  check(`the delete grace = interval '${days(PLATFORM_AI_DELETE_GRACE_DAYS)}' (PLATFORM_AI_DELETE_GRACE_DAYS, OD-10)`,
    purge.replace(/\s+/g, " ").includes(`c."deletedAt" < v_now - interval '${days(PLATFORM_AI_DELETE_GRACE_DAYS)}'`));
  check(`the shell age = interval '${days(PLATFORM_AI_SHELL_MIN_AGE_DAYS)}'`,
    purge.replace(/\s+/g, " ").includes(`c."createdAt" < v_now - interval '${days(PLATFORM_AI_SHELL_MIN_AGE_DAYS)}'`));
  check(`p_limit is bounded 1..${PLATFORM_AI_PURGE_BATCH}`, body(purge).includes(`IF p_limit IS NULL OR p_limit < 1 OR p_limit > ${PLATFORM_AI_PURGE_BATCH} THEN RAISE EXCEPTION`));
  check(`expired exchanges per call = p_limit * ${PLATFORM_AI_PURGE_EXCHANGE_FACTOR}`, body(purge).includes(`LIMIT p_limit * ${PLATFORM_AI_PURGE_EXCHANGE_FACTOR} FOR UPDATE SKIP LOCKED`));
  check("every interval in the file is one of the pinned ones", [...flat.matchAll(/'(\d+ days?)'/g)].every((m) =>
    [days(PLATFORM_AI_RETENTION_DAYS), days(PLATFORM_AI_DELETE_GRACE_DAYS), days(PLATFORM_AI_SHELL_MIN_AGE_DAYS)].includes(m[1])),
    [...flat.matchAll(/'(\d+ days?)'/g)].map((m) => m[1]).join(", "));
  check("every comparison is UTC-to-UTC (no bare now() comparison)", !/[<>]=?\s*now\(\)/.test(flat));
}

console.log("3. the settle trigger is SECURITY INVOKER (S2: fails if it is ever DEFINER)");
{
  const f = fn("fm_platform_ai_message_settle");
  check("the function exists", f.length > 0);
  check("its header declares SECURITY INVOKER", /\bSECURITY INVOKER\b/.test(header(f)), header(f));
  check("its header does NOT declare SECURITY DEFINER", !/\bSECURITY DEFINER\b/.test(header(f)), header(f));
  check("no later statement turns it into a definer", !/ALTER FUNCTION[^;]*fm_platform_ai_message_settle[^;]*SECURITY DEFINER/i.test(sql));
  check("search_path is pinned", /SET search_path = pg_catalog, public/.test(header(f)));
  const b = body(f);
  check("a settled row is immutable (RAISE)", b.includes("IF OLD.status <> 'PENDING' THEN") && b.includes("RAISE EXCEPTION 'settled message is immutable'"));
  check("the ONE exception: a role that bypasses RLS, judged by current_user", b.includes("(SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user)"));
  const cols = ["id", "\"conversationId\"", "role", "\"evidenceRefs\"", "\"clientRequestId\"", "\"replyToId\"", "status", "\"failureCode\"", "\"createdAt\"", "\"completedAt\"", "\"purgeAfter\""];
  check("…and only when EVERY column but contentEncrypted is NOT DISTINCT from its old value",
    b.includes(`(${cols.map((c) => `NEW.${c}`).join(", ")}) IS NOT DISTINCT FROM (${cols.map((c) => `OLD.${c}`).join(", ")})`) && !/NEW\."contentEncrypted"\s*[,)]/.test(b));
  check("completedAt is the database's", b.includes("IF NEW.status <> 'PENDING' THEN NEW.\"completedAt\" := now() AT TIME ZONE 'UTC'; END IF;"));
  check("BEFORE UPDATE, FOR EACH ROW", /CREATE TRIGGER platform_ai_message_settle BEFORE UPDATE ON public\."PlatformAiMessage"\s+FOR EACH ROW EXECUTE FUNCTION public\.fm_platform_ai_message_settle\(\);/.test(sql));
}

console.log("4. the touch trigger (DEFINER): body pinned, REVOKE ALL … FROM PUBLIC");
{
  const f = fn("fm_platform_ai_touch_conversation");
  check("SECURITY DEFINER with a pinned search_path", /LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public/.test(header(f)), header(f));
  check("the body is EXACTLY the one UPDATE of lastActivityAt by the NEW row's conversation, then RETURN NULL",
    body(f) === `BEGIN UPDATE public."PlatformAiConversation" SET "lastActivityAt" = now() AT TIME ZONE 'UTC' WHERE id = NEW."conversationId"; RETURN NULL;`, body(f));
  check("REVOKE ALL ON FUNCTION … FROM PUBLIC", sql.includes("REVOKE ALL ON FUNCTION public.fm_platform_ai_touch_conversation() FROM PUBLIC;"));
  check("no GRANT on it to anyone", !/GRANT[^;]*fm_platform_ai_touch_conversation/.test(sql));
  check("fires AFTER INSERT of a USER row only",
    /CREATE TRIGGER platform_ai_touch_conversation AFTER INSERT ON public\."PlatformAiMessage"\s+FOR EACH ROW WHEN \(NEW\.role = 'USER'\) EXECUTE FUNCTION public\.fm_platform_ai_touch_conversation\(\);/.test(sql));
}

console.log("5. the soft-delete trigger");
{
  const f = fn("fm_platform_ai_conversation_soft_delete");
  check("SECURITY INVOKER (not a definer)", /SECURITY INVOKER/.test(header(f)) && !/SECURITY DEFINER/.test(header(f)));
  check("refuses a second delete / an un-delete, and stores now()",
    body(f) === `BEGIN IF OLD."deletedAt" IS NOT NULL THEN RAISE EXCEPTION 'conversation already deleted'; END IF; IF NEW."deletedAt" IS NOT NULL THEN NEW."deletedAt" := now() AT TIME ZONE 'UTC'; END IF; RETURN NEW;`, body(f));
  check("REVOKE ALL … FROM PUBLIC", sql.includes("REVOKE ALL ON FUNCTION public.fm_platform_ai_conversation_soft_delete() FROM PUBLIC;"));
  check("settle REVOKE ALL … FROM PUBLIC", sql.includes("REVOKE ALL ON FUNCTION public.fm_platform_ai_message_settle() FROM PUBLIC;"));
}

console.log("6. the purge function (S2 Q4 conditions + the post-approval counting rule)");
{
  const f = fn("fm_purge_platform_ai_conversations");
  const h = header(f), b = body(f);
  check("p_limit integer is the ONLY argument", /fm_purge_platform_ai_conversations\(p_limit integer\)/.test(h) && (h.match(/\(/g) ?? []).length >= 1);
  check("RETURNS TABLE (conversations integer, messages integer) — counts only", /RETURNS TABLE \(conversations integer, messages integer\)/.test(h));
  check("SECURITY DEFINER, VOLATILE, search_path pinned", /LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public/.test(h), h);
  check("no dynamic SQL (no EXECUTE, no format())", !/\bEXECUTE\b/.test(b) && !/\bformat\s*\(/.test(b));
  check("the clock is UTC at the columns' precision: v_now timestamp(3) := now() AT TIME ZONE 'UTC' (a sub-millisecond clock would purge an exactly-90-day row early)",
    b.includes("v_now timestamp(3) := now() AT TIME ZONE 'UTC';"));
  check("step 1 selects expired USER rows by purgeAfter, locked FOR UPDATE SKIP LOCKED",
    b.includes(`SELECT id FROM public."PlatformAiMessage" WHERE role = 'USER' AND "purgeAfter" < v_now ORDER BY "purgeAfter" LIMIT p_limit * ${PLATFORM_AI_PURGE_EXCHANGE_FACTOR} FOR UPDATE SKIP LOCKED`));
  check("…their replies are LOCKED and COUNTED in the same window, before the parents are deleted",
    b.indexOf(`SELECT id FROM public."PlatformAiMessage" WHERE "replyToId" = ANY (v_users) FOR UPDATE`) > 0
      && b.indexOf(`SELECT id FROM public."PlatformAiMessage" WHERE "replyToId" = ANY (v_users) FOR UPDATE`) < b.indexOf(`DELETE FROM public."PlatformAiMessage" WHERE id = ANY (v_users);`));
  check("OD-7 (per-message, owner 2026-11-04): lastActivityAt is in NO purge or expiry predicate (ordering only)", !b.includes("lastActivityAt"));
  check("…and the parents' count is the DELETE's own ROW_COUNT", b.includes(`DELETE FROM public."PlatformAiMessage" WHERE id = ANY (v_users); GET DIAGNOSTICS v_parents = ROW_COUNT;`));
  check("step 2 predicate: deleted past the grace OR an empty shell older than the shell age",
    b.includes(`WHERE c."deletedAt" < v_now - interval`) && b.includes(`OR (c."createdAt" < v_now - interval`) && b.includes(`AND NOT EXISTS (SELECT 1 FROM public."PlatformAiMessage" m WHERE m."conversationId" = c.id))`)
      && b.includes("ORDER BY c.\"createdAt\" LIMIT p_limit FOR UPDATE SKIP LOCKED"));
  check("…the remaining messages are locked + counted before the conversations go",
    b.indexOf(`SELECT id FROM public."PlatformAiMessage" WHERE "conversationId" = ANY (v_conv) FOR UPDATE`) > 0
      && b.indexOf(`SELECT id FROM public."PlatformAiMessage" WHERE "conversationId" = ANY (v_conv) FOR UPDATE`) < b.indexOf(`DELETE FROM public."PlatformAiConversation" WHERE id = ANY (v_conv);`));
  check("it returns exactly the counts", b.includes("RETURN QUERY SELECT v_nconv, v_parents + v_replies + v_cmsgs;"));
  check("it writes no retention / timestamp column (no UPDATE, no INSERT)", !/\bUPDATE\b/.test(b.replace(/FOR UPDATE/g, "")) && !/\bINSERT\b/.test(b));
  check("REVOKE ALL FROM PUBLIC, then EXECUTE to fm_system ALONE",
    sql.includes("REVOKE ALL ON FUNCTION public.fm_purge_platform_ai_conversations(integer) FROM PUBLIC;")
      && (sql.match(/GRANT EXECUTE ON FUNCTION public\.fm_purge_platform_ai_conversations\(integer\) TO (\w+);/g) ?? []).join() === "GRANT EXECUTE ON FUNCTION public.fm_purge_platform_ai_conversations(integer) TO fm_system;");
  check("the Supabase API roles lose EXECUTE on all four functions where they exist",
    /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'anon'\) THEN\s*EXECUTE 'REVOKE ALL ON FUNCTION public\.fm_platform_ai_conversation_soft_delete\(\), public\.fm_platform_ai_touch_conversation\(\), public\.fm_platform_ai_message_settle\(\), public\.fm_purge_platform_ai_conversations\(integer\) FROM anon, authenticated, service_role';/.test(sql));
  check("exactly four functions are created", (sql.match(/CREATE FUNCTION/g) ?? []).length === 4);
  check("two of them are SECURITY DEFINER (purge, touch) — no other", (sql.match(/SECURITY DEFINER/g) ?? []).length === 2);
}

console.log("7. S2 REQUIRED 1 — the grants");
{
  const grants = [...flat.matchAll(/GRANT ([^;]*?) ON (?:TABLE )?public\."(PlatformAi\w+)" TO (\w+);/g)].map((m) => ({ priv: m[1], table: m[2], role: m[3] }));
  check("every table grant is to fm_app", grants.length === 6 && grants.every((g) => g.role === "fm_app"), JSON.stringify(grants));
  const TIMES = ["createdAt", "lastActivityAt", "purgeAfter", "completedAt", "deletedAt"];
  const insConv = grants.find((g) => g.table === "PlatformAiConversation" && g.priv.startsWith("INSERT"))?.priv ?? "";
  check("conversation INSERT grant = id, operatorUserId, area, createRequestId", insConv === `INSERT ("id", "operatorUserId", "area", "createRequestId")`, insConv);
  const insMsg = grants.find((g) => g.table === "PlatformAiMessage" && g.priv.startsWith("INSERT"))?.priv ?? "";
  check("message INSERT grant names no timestamp, retention column or failureCode",
    insMsg === `INSERT ("id", "conversationId", "role", "contentEncrypted", "evidenceRefs", "clientRequestId", "replyToId", "status")`, insMsg);
  const upd = grants.filter((g) => g.priv.startsWith("UPDATE")).map((g) => `${g.table}:${g.priv}`);
  check("UPDATE grants: deletedAt (conversation); content/evidence/status/failureCode (message) — no other timestamp",
    upd.join("|") === `PlatformAiConversation:UPDATE ("deletedAt")|PlatformAiMessage:UPDATE ("contentEncrypted", "evidenceRefs", "status", "failureCode")`, upd.join("|"));
  check("no grant names createdAt / lastActivityAt / purgeAfter / completedAt", grants.every((g) => !TIMES.filter((t) => t !== "deletedAt").some((t) => g.priv.includes(`"${t}"`))));
  check("no DELETE for anyone; no table-wide INSERT / UPDATE", grants.every((g) => !/DELETE/.test(g.priv) && !/^(INSERT|UPDATE)$/.test(g.priv.trim()) && !/ALL/.test(g.priv)));
  check("no statement names fm_system, fm_auth or fm_backup on the tables", !/(GRANT|POLICY)[^;]*PlatformAi[^;]*(fm_system|fm_auth|fm_backup)/.test(flat) && !/(GRANT|POLICY)[^;]*(fm_system|fm_auth)[^;]*PlatformAi/.test(flat.replace(/GRANT EXECUTE ON FUNCTION public\.fm_purge_platform_ai_conversations\(integer\) TO fm_system;/, "")));
  check("both tables ENABLE + FORCE row-level security",
    ["PlatformAiConversation", "PlatformAiMessage"].every((t) => new RegExp(`ALTER TABLE public\\."${t}"\\s+ENABLE ROW LEVEL SECURITY`).test(sql) && new RegExp(`ALTER TABLE public\\."${t}"\\s+FORCE\\s+ROW LEVEL SECURITY`).test(sql)));
  check("every policy is TO fm_app and keyed on current_fm_user_id()",
    [...flat.matchAll(/CREATE POLICY (\w+) ON public\."(PlatformAi\w+)" FOR (\w+) TO (\w+)([^;]*);/g)].every((m) => m[4] === "fm_app" && m[5].includes("current_fm_user_id()"))
      && (flat.match(/CREATE POLICY/g) ?? []).length === 6);
  check("the message INSERT policy requires a LIVE parent (deletedAt IS NULL)", /CREATE POLICY fm_app_ins ON public\."PlatformAiMessage"[^;]*c\."deletedAt" IS NULL/.test(flat));
  check("the one-PENDING partial unique index", flat.includes(`CREATE UNIQUE INDEX "PlatformAiMessage_one_pending_per_conversation" ON public."PlatformAiMessage" ("conversationId") WHERE status = 'PENDING';`));
  check("the composite reply FK (S2 Q6)", flat.includes(`FOREIGN KEY ("conversationId", "replyToId") REFERENCES "PlatformAiMessage"("conversationId", "id") ON DELETE CASCADE`));
  check("User → conversation cascades (S2 REQUIRED 3)", flat.includes(`FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE CASCADE`));
  check("the FAILED ⇔ failureCode CHECK", flat.includes(`CHECK ((status = 'FAILED') = ("failureCode" IS NOT NULL))`));
}

console.log("9. expiry on read (20261105120000, OD-7 + S2 C1)");
{
  const pred = `"purgeAfter" > (now() AT TIME ZONE 'UTC'::text)`;
  check("the header says \"B11 batch — not part of B10\"", expiryRaw.split("\n").slice(0, 3).join("\n").includes("B11 batch — not part of B10"));
  check("SET LOCAL lock_timeout, and no session-level SET", /SET LOCAL lock_timeout = '5s';/.test(expiry) && !/(^|; )SET (?!LOCAL)/.test(expiry));
  const sel = /CREATE POLICY fm_app_sel ON public\."PlatformAiMessage" FOR SELECT TO fm_app USING \(([^;]*)\);/.exec(expiry)?.[1] ?? "";
  const upd = /CREATE POLICY fm_app_upd ON public\."PlatformAiMessage" FOR UPDATE TO fm_app USING \(([^;]*)\) WITH CHECK/.exec(expiry)?.[1] ?? "";
  check("message SELECT policy: the DB-clock expiry predicate AND the owner sub-select", sel.startsWith(pred) && sel.includes(`c."operatorUserId" = current_fm_user_id()`), sel);
  check("message UPDATE policy USING: the same predicate AND the owner sub-select", upd.startsWith(pred) && upd.includes(`c."operatorUserId" = current_fm_user_id()`), upd);
  check("the predicate is the purge's clock form (UTC, strict >, no app-supplied time)", flat.includes("now() AT TIME ZONE 'UTC'") && !/\$\d|current_setting\('app\./.test(expiry));
  check("exactly the two message policies are replaced; the conversation policies and every grant are untouched",
    (expiry.match(/DROP POLICY/g) ?? []).length === 2 && (expiry.match(/CREATE POLICY/g) ?? []).length === 2
      && !/PlatformAiConversation" FOR|GRANT|REVOKE|ALTER TABLE|CREATE FUNCTION|DELETE/.test(expiry.replace(/FROM public\."PlatformAiConversation" c/g, "")));
  check("the INSERT policy is not changed (a new row's default purgeAfter passes SELECT for RETURNING)", !/fm_app_ins/.test(expiry));
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
