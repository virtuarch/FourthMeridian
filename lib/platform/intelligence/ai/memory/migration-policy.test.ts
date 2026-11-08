/**
 * lib/platform/intelligence/ai/memory/migration-policy.test.ts  (the memory migration, parse-pinned)
 *
 * The DB-010 pattern: prisma/migrations/20261110120000_platform_ai_operational_memory
 * duplicates constants and registries from ./constants.ts and carries
 * security-load-bearing function bodies, so this test parses the SQL and pins:
 *   · the place in history (after 20261108140000), lock_timeout, the BYPASSRLS
 *     assertion before any CREATE;
 *   · every interval / bound (TTL hours, the 72 h and 30 d caps, the 1-day keep,
 *     the purge batch, the octet / count / id-length CHECKs) = the constants;
 *   · the B2 registries (metric keys, page ids, parts, windows, jobs, providers,
 *     observed states, the INCIDENT cuid pattern) and the payload allowlist =
 *     the constants, element for element;
 *   · the two trigger functions SECURITY INVOKER (FAILS IF EVER DEFINER: the
 *     rotation exception would then admit fm_app);
 *   · O1 (b): fm_platform_ai_memory_soft_delete is SECURITY DEFINER, fixed
 *     search_path, schema-qualified, RAISEs on a NULL / empty caller, ONLY
 *     `SET "deletedAt"`, the owner + not-deleted + ACTIVE-grant predicate,
 *     returns an integer count; REVOKE PUBLIC, EXECUTE to fm_app ONLY; fm_app
 *     holds no UPDATE on "deletedAt";
 *   · the purges: DEFINER, counts only, no dynamic SQL, EXECUTE to fm_system only;
 *   · the grants: INSERT excludes every timestamp / lifecycle column, UPDATE =
 *     invalidatedAt + invalidReason, no DELETE, nothing for fm_system / fm_auth;
 *   · RLS ENABLE + FORCE; fm_app_upd's WITH CHECK has no deletedAt / expiresAt (B1).
 *
 *   npx tsx lib/platform/intelligence/ai/memory/migration-policy.test.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  MEMORY_INCIDENT_ID_PATTERN, MEMORY_INVALIDATED_KEEP_DAYS, MEMORY_JOB_NAMES, MEMORY_MAX_CAP_HOURS, MEMORY_METRIC_KEYS,
  MEMORY_METRIC_PARTS, MEMORY_METRIC_WINDOWS, MEMORY_NOTE_CIPHER_MAX, MEMORY_OBSERVED_STATES, MEMORY_OPERATIONAL_STATE_CAP_HOURS,
  MEMORY_PAGE_IDS, MEMORY_PAYLOAD_MAX_OCTETS, MEMORY_PAYLOAD_SCHEMA, MEMORY_PROVIDER_IDS, MEMORY_PURGE_BATCH, MEMORY_REF_ID_MAX,
  MEMORY_REF_KEYS, MEMORY_REF_TYPES, MEMORY_REFS_MAX, MEMORY_REFS_MAX_OCTETS, MEMORY_TTL_HOURS,
} from "./constants";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const MEMORY_MIGRATION = "20261110120000_platform_ai_operational_memory";
const raw = readFileSync(path.join(ROOT, "prisma/migrations", MEMORY_MIGRATION, "migration.sql"), "utf8");
const sql = raw.replace(/--[^\n]*/g, "");
const flat = sql.replace(/\s+/g, " ");

function fn(name: string): string {
  const at = sql.indexOf(`CREATE FUNCTION public.${name}(`);
  if (at < 0) return "";
  const end = sql.indexOf("END $$;", at);
  return end < 0 ? "" : sql.slice(at, end + "END $$;".length);
}
const header = (f: string) => f.slice(0, f.indexOf("AS $$")).replace(/\s+/g, " ");
const body = (f: string) => f.slice(f.indexOf("AS $$") + 5, f.lastIndexOf("END $$;")).replace(/\s+/g, " ").trim();
const same = (a: readonly (string | number)[], b: readonly (string | number)[]) => JSON.stringify([...a].map(String)) === JSON.stringify([...b].map(String));
/** The literal ARRAY[…]::text[] that immediately follows `marker` in the insert trigger. */
function arrayAfter(marker: string): string[] {
  const at = sql.indexOf(marker);
  if (at < 0) return [];
  const m = /ARRAY\[([\s\S]*?)\]::text\[\]/.exec(sql.slice(at));
  return m ? [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]) : [];
}

console.log("0. the place in history and the principal");
{
  check("the header says \"B11 batch — not part of B10\" and Preview only", raw.split("\n").slice(0, 3).join("\n").includes("B11 batch — not part of B10") && /Preview only/.test(raw.split("\n").slice(0, 3).join("\n")));
  const names = readdirSync(path.join(ROOT, "prisma/migrations")).filter((n) => /^\d{14}_/.test(n)).sort();
  check("it sorts after 20261108140000 (the last migration before it) and after the 7-day retention migration",
    MEMORY_MIGRATION > "20261108140000_mortgage_f9_property_value_basis" && MEMORY_MIGRATION > "20261108120000_platform_ai_retention_7_days" && names.includes(MEMORY_MIGRATION));
  check("lock_timeout bounds the FK lock on \"User\" (transaction-local)", /SET LOCAL lock_timeout = '5s';/.test(sql));
  check("no session-level SET", !/^\s*SET (?!LOCAL|search_path = pg_catalog, public$)/m.test(sql));
  const m = /DO \$\$\s*BEGIN\s*IF NOT \(SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user\) THEN\s*RAISE EXCEPTION '[^']*BYPASSRLS[^']*'/.exec(sql);
  check("a DO block RAISEs unless the principal has rolbypassrls OR rolsuper, BEFORE any table or function", !!m && m.index < sql.indexOf("CREATE TABLE") && m.index < sql.indexOf("CREATE FUNCTION"));
  check("no column references a conversation, message or invocation (design §1)", !/"(conversationId|messageId|aiInvocationId|invocationId)"/i.test(sql.slice(sql.indexOf("CREATE TABLE"), sql.indexOf("CONSTRAINT \"PlatformAiMemoryFact_pkey\""))));
}

console.log("1. intervals and bounds = the constants");
{
  const ins = fn("fm_platform_ai_memory_insert");
  const ttl = /v_ttl := CASE NEW\.ttl WHEN 'H24' THEN interval '(\d+) hours' WHEN 'H72' THEN interval '(\d+) hours'\s+WHEN 'D7' THEN interval '(\d+) hours' WHEN 'D30' THEN interval '(\d+) hours' END;/.exec(ins);
  check("TTL hours (H24 / H72 / D7 / D30) = MEMORY_TTL_HOURS", !!ttl && same(ttl.slice(1, 5), [MEMORY_TTL_HOURS.H24, MEMORY_TTL_HOURS.H72, MEMORY_TTL_HOURS.D7, MEMORY_TTL_HOURS.D30]), ttl?.slice(1).join());
  check(`the cap: OPERATIONAL_STATE ${MEMORY_OPERATIONAL_STATE_CAP_HOURS} h, others 30 days (= ${MEMORY_MAX_CAP_HOURS} h)`,
    /v_cap := CASE NEW\."factType" WHEN 'OPERATIONAL_STATE' THEN interval '72 hours' ELSE interval '30 days' END;/.test(ins) && MEMORY_OPERATIONAL_STATE_CAP_HOURS === 72 && MEMORY_MAX_CAP_HOURS === 30 * 24);
  check("expiresAt = createdAt + least(ttl, cap), createdAt = observedAt = now() UTC, lifecycle forced NULL",
    /NEW\."expiresAt" := v_now \+ LEAST\(v_ttl, v_cap\);/.test(ins) && /NEW\."createdAt" := v_now;/.test(ins) && /NEW\."observedAt" := v_now;/.test(ins)
      && /NEW\."invalidatedAt" := NULL;/.test(ins) && /NEW\."deletedAt" := NULL;/.test(ins) && /v_now timestamp\(3\) := now\(\) AT TIME ZONE 'UTC';/.test(ins));
  check("the expiry CHECK: ≤ 30 days, and ≤ 72 hours for OPERATIONAL_STATE",
    /"expiresAt" <= "createdAt" \+ interval '30 days' AND \("factType" <> 'OPERATIONAL_STATE' OR "expiresAt" <= "createdAt" \+ interval '72 hours'\)/.test(flat));
  check(`payload ≤ ${MEMORY_PAYLOAD_MAX_OCTETS} octets; note cipher ≤ ${MEMORY_NOTE_CIPHER_MAX}; refs ≤ ${MEMORY_REFS_MAX_OCTETS} octets and 0..${MEMORY_REFS_MAX}`,
    flat.includes(`octet_length("payload"::text) <= ${MEMORY_PAYLOAD_MAX_OCTETS}`) && flat.includes(`length("noteEncrypted") <= ${MEMORY_NOTE_CIPHER_MAX}`)
      && flat.includes(`octet_length("sourceRefs"::text) <= ${MEMORY_REFS_MAX_OCTETS}`) && flat.includes(`jsonb_array_length("sourceRefs") BETWEEN 0 AND ${MEMORY_REFS_MAX}`));
  check("non-PREFERENCE facts need ≥ 1 ref; invalidatedAt ⇔ invalidReason",
    /"factType" = 'OPERATOR_PREFERENCE' OR CASE WHEN jsonb_typeof\("sourceRefs"\) = 'array' THEN jsonb_array_length\("sourceRefs"\) >= 1 ELSE false END/.test(flat)
      && /\("invalidatedAt" IS NULL\) = \("invalidReason" IS NULL\)/.test(flat));
  check(`ref id ≤ ${MEMORY_REF_ID_MAX} characters`, ins.includes(`length(v_id) > ${MEMORY_REF_ID_MAX}`));
  const purge = fn("fm_purge_platform_ai_memory");
  check(`p_limit bounded to ${MEMORY_PURGE_BATCH}`, purge.includes(`p_limit > ${MEMORY_PURGE_BATCH}`));
  const days = `${MEMORY_INVALIDATED_KEEP_DAYS} day${MEMORY_INVALIDATED_KEEP_DAYS === 1 ? "" : "s"}`;
  check(`invalidated rows kept '${days}' (= MEMORY_INVALIDATED_KEEP_DAYS) in BOTH purges`,
    purge.includes(`"invalidatedAt" < v_now - interval '${days}'`) && fn("fm_purge_platform_ai_memory_for_operator").includes(`"invalidatedAt" < v_now - interval '${days}'`));
}

console.log("2. B2 — the registries and the payload allowlist = the constants");
{
  const ins = fn("fm_platform_ai_memory_insert");
  check("METRIC: the literal array = MEMORY_METRIC_KEYS", same(arrayAfter("ELSIF v_t = 'METRIC' THEN"), MEMORY_METRIC_KEYS));
  check("PAGE: the literal array = MEMORY_PAGE_IDS", same(arrayAfter("ELSIF v_t = 'PAGE' THEN"), MEMORY_PAGE_IDS));
  check("JOB: the literal array = MEMORY_JOB_NAMES", same(arrayAfter("ELSIF v_t = 'JOB' THEN"), MEMORY_JOB_NAMES));
  check("PROVIDER: the literal array = MEMORY_PROVIDER_IDS", same(arrayAfter("ELSIF v_t = 'PROVIDER' THEN"), MEMORY_PROVIDER_IDS));
  check("part: the literal array = MEMORY_METRIC_PARTS", same(arrayAfter("IF v_ref ? 'part' THEN"), MEMORY_METRIC_PARTS));
  check("w: the literal array = MEMORY_METRIC_WINDOWS (as text, JSON numbers only)", same(arrayAfter("IF v_ref ? 'w' THEN"), MEMORY_METRIC_WINDOWS) && ins.includes("jsonb_typeof(v_ref -> 'w') IS DISTINCT FROM 'number'"));
  check("observedState: the literal array = MEMORY_OBSERVED_STATES", same(arrayAfter("IF NOT ((v_ref ->> 'observedState') = ANY"), MEMORY_OBSERVED_STATES));
  check("INCIDENT: the cuid pattern = MEMORY_INCIDENT_ID_PATTERN", ins.includes(`v_id !~ '${MEMORY_INCIDENT_ID_PATTERN}'`));
  const refKeys = [...(/k <> ALL \(ARRAY\[([^\]]*)\]\)/.exec(ins)?.[1] ?? "").matchAll(/'([^']*)'/g)].map((x) => x[1]);
  check("ref keys ⊆ MEMORY_REF_KEYS; t, id, observedState required strings",
    same(refKeys, MEMORY_REF_KEYS)
      && /jsonb_typeof\(v_ref -> 't'\) IS DISTINCT FROM 'string' OR jsonb_typeof\(v_ref -> 'id'\) IS DISTINCT FROM 'string'\s+OR jsonb_typeof\(v_ref -> 'observedState'\) IS DISTINCT FROM 'string'/.test(ins), refKeys.join());
  const typesInSql = [...ins.matchAll(/v_t = '([A-Z]+)' THEN/g)].map((x) => x[1]);
  check("the ref types branched on = MEMORY_REF_TYPES (and anything else RAISEs)", same([...typesInSql].sort(), [...MEMORY_REF_TYPES].sort()) && /ELSE\s+RAISE EXCEPTION 'memory sourceRef type outside the enum';/.test(ins));
  check("part / w are METRIC-only", ins.includes("IF v_t <> 'METRIC' OR jsonb_typeof(v_ref -> 'part')") && ins.includes("IF v_t <> 'METRIC' OR jsonb_typeof(v_ref -> 'w')"));
  const allow: Record<string, Record<string, string[]>> = {};
  for (const m of ins.matchAll(/WHEN '([A-Z_]+)'\s+THEN '(\{[^']*\})'::jsonb/g)) allow[m[1]] = JSON.parse(m[2]);
  check("the payload allowlist = MEMORY_PAYLOAD_SCHEMA (every type, key and value)", JSON.stringify(allow) === JSON.stringify(MEMORY_PAYLOAD_SCHEMA), JSON.stringify(allow));
  check("payload keys containing conversation / message / transcript are refused",
    /v_key ILIKE '%conversation%' OR v_key ILIKE '%message%' OR v_key ILIKE '%transcript%'/.test(ins));
}

console.log("3. triggers: SECURITY INVOKER, immutability");
{
  const ins = fn("fm_platform_ai_memory_insert"), imm = fn("fm_platform_ai_memory_immutable");
  check("fm_platform_ai_memory_insert is SECURITY INVOKER with a fixed search_path", /SECURITY INVOKER SET search_path = pg_catalog, public/.test(header(ins)) && !/DEFINER/.test(header(ins)));
  check("fm_platform_ai_memory_immutable is SECURITY INVOKER — FAILS IF EVER DEFINER", /SECURITY INVOKER SET search_path = pg_catalog, public/.test(header(imm)) && !/DEFINER/.test(header(imm)));
  const b = body(imm);
  check("immutable: every non-lifecycle column must be NOT DISTINCT (incl. expiresAt, payload, sourceRefs, noteEncrypted)",
    /IS DISTINCT FROM \(OLD\.id, OLD\."operatorUserId", OLD\."platformArea", OLD\."factType", OLD\.origin, OLD\.concern, OLD\."noteEncrypted", OLD\.payload, OLD\."sourceRefs", OLD\.ttl, OLD\."proposalJti", OLD\."observedAt", OLD\."createdAt", OLD\."expiresAt", OLD\."supersedesId"\) THEN RAISE EXCEPTION 'memory fact is immutable'/.test(b));
  check("immutable: invalidation and deletion once each, NULL → now()",
    /'memory fact already invalidated'/.test(b) && /NEW\."invalidatedAt" := now\(\) AT TIME ZONE 'UTC';/.test(b) && /'memory fact already deleted'/.test(b) && /NEW\."deletedAt" := now\(\) AT TIME ZONE 'UTC';/.test(b));
  check("immutable: the ONE rotation exception — a role that bypasses RLS changing noteEncrypted ALONE",
    /AND NEW\."noteEncrypted" IS DISTINCT FROM OLD\."noteEncrypted" AND \(SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user\) THEN RETURN NEW; END IF;/.test(b));
  check("both triggers are BEFORE … FOR EACH ROW", /CREATE TRIGGER platform_ai_memory_insert BEFORE INSERT ON public\."PlatformAiMemoryFact" FOR EACH ROW/.test(flat)
    && /CREATE TRIGGER platform_ai_memory_immutable BEFORE UPDATE ON public\."PlatformAiMemoryFact" FOR EACH ROW/.test(flat));
}

console.log("4. O1 (b) — the soft-delete definer");
{
  const f = fn("fm_platform_ai_memory_soft_delete");
  check("SECURITY DEFINER, VOLATILE, search_path pg_catalog, public; RETURNS integer; one text argument",
    /CREATE FUNCTION public\.fm_platform_ai_memory_soft_delete\(p_id text\) RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public/.test(header(f)));
  const b = body(f);
  check("the caller is public.current_fm_user_id() and NULL / empty RAISEs",
    /v_user text := public\.current_fm_user_id\(\);/.test(b) && /IF v_user IS NULL OR v_user = '' THEN RAISE EXCEPTION/.test(b));
  check("ONLY one statement writes: UPDATE … SET \"deletedAt\" (no other column, no DELETE, no INSERT, no dynamic SQL)",
    (b.match(/\bUPDATE\b/g) ?? []).length === 1 && /UPDATE public\."PlatformAiMemoryFact" f SET "deletedAt" = v_now WHERE/.test(b) && !/\b(DELETE|INSERT|EXECUTE)\b/.test(b));
  check("the predicate: OWN AND not deleted AND not expired AND ACTIVE grant [AND id = p_id]",
    /f\."operatorUserId" = v_user AND f\."deletedAt" IS NULL AND f\."expiresAt" > v_now AND EXISTS \(SELECT 1 FROM public\."PlatformGrant" g WHERE g\."userId" = v_user AND g\.area = f\."platformArea" AND g\.status = 'ACTIVE'\) AND \(p_id IS NULL OR f\.id = p_id\);/.test(b));
  check("returns the ROW_COUNT only", /GET DIAGNOSTICS v_n = ROW_COUNT; RETURN v_n;/.test(b));
  check("REVOKE ALL FROM PUBLIC and EXECUTE to fm_app ONLY",
    /REVOKE ALL ON FUNCTION public\.fm_platform_ai_memory_soft_delete\(text\) FROM PUBLIC;/.test(flat)
      && (flat.match(/GRANT EXECUTE ON FUNCTION public\.fm_platform_ai_memory_soft_delete\(text\) TO ([a-z_, ]+);/g) ?? []).join() === "GRANT EXECUTE ON FUNCTION public.fm_platform_ai_memory_soft_delete(text) TO fm_app;");
  check("fm_app holds NO UPDATE on \"deletedAt\": not in the UPDATE grant, and REVOKEd explicitly",
    /GRANT UPDATE \("invalidatedAt", "invalidReason"\) ON public\."PlatformAiMemoryFact" TO fm_app;/.test(flat)
      && /REVOKE UPDATE \("deletedAt"\) ON public\."PlatformAiMemoryFact" FROM fm_app;/.test(flat)
      && (flat.match(/GRANT UPDATE/g) ?? []).length === 1);
}

console.log("5. the purge definers");
{
  for (const [name, arg] of [["fm_purge_platform_ai_memory", "p_limit integer"], ["fm_purge_platform_ai_memory_for_operator", "p_user text"]] as const) {
    const f = fn(name);
    check(`${name}: SECURITY DEFINER, search_path fixed, RETURNS integer, (${arg})`,
      new RegExp(`CREATE FUNCTION public\\.${name}\\(${arg}\\) RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public`).test(header(f)));
    const b = body(f);
    check(`${name}: no dynamic SQL; deletes only PlatformAiMemoryFact; no UPDATE / INSERT`, !/\bEXECUTE\b/.test(b) && /DELETE FROM public\."PlatformAiMemoryFact"/.test(b) && !/\bUPDATE public\b|\bINSERT\b/.test(b));
    check(`${name}: the four rules (expired, deleted, invalidated > 1 day, no ACTIVE grant)`,
      /"expiresAt" <= v_now/.test(b) && /"deletedAt" IS NOT NULL/.test(b) && /"invalidatedAt" < v_now - interval '1 day'/.test(b)
        && /NOT EXISTS \(SELECT 1 FROM public\."PlatformGrant" g WHERE g\."userId" = f\."operatorUserId" AND g\.area = f\."platformArea" AND g\.status = 'ACTIVE'\)/.test(b));
    check(`${name}: REVOKE ALL FROM PUBLIC; EXECUTE to fm_system ONLY`,
      flat.includes(`REVOKE ALL ON FUNCTION public.${name}(${arg.split(" ")[1]}) FROM PUBLIC;`)
        && (flat.match(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(${arg.split(" ")[1]}\\) TO ([a-z_, ]+);`, "g")) ?? []).join() === `GRANT EXECUTE ON FUNCTION public.${name}(${arg.split(" ")[1]}) TO fm_system;`);
  }
  check("the global purge locks FOR UPDATE SKIP LOCKED, bounded by p_limit", /ORDER BY f\."createdAt" LIMIT p_limit FOR UPDATE SKIP LOCKED/.test(body(fn("fm_purge_platform_ai_memory"))));
  check("the trigger functions are REVOKEd from PUBLIC (uncallable)",
    flat.includes("REVOKE ALL ON FUNCTION public.fm_platform_ai_memory_insert() FROM PUBLIC;") && flat.includes("REVOKE ALL ON FUNCTION public.fm_platform_ai_memory_immutable() FROM PUBLIC;"));
  check("exactly three SECURITY DEFINER functions", (sql.match(/SECURITY DEFINER/g) ?? []).length === 3);
}

console.log("6. table grants and RLS");
{
  const ins = /GRANT INSERT \(([^)]*)\) ON public\."PlatformAiMemoryFact" TO fm_app;/.exec(flat)?.[1].replace(/"/g, "").split(",").map((s) => s.trim()) ?? [];
  check("fm_app INSERT = exactly the writer columns (no timestamp, no lifecycle column)",
    same([...ins].sort(), ["concern", "factType", "id", "noteEncrypted", "operatorUserId", "origin", "payload", "platformArea", "proposalJti", "sourceRefs", "supersedesId", "ttl"]), ins.join());
  check("fm_app has NO DELETE and nobody else is granted the table", !/GRANT[^;]*DELETE[^;]*PlatformAiMemoryFact/.test(flat)
    && !/GRANT [^;]*ON public\."PlatformAiMemoryFact" TO (?!fm_app;)/.test(flat));
  check("ENABLE + FORCE row level security", /ALTER TABLE public\."PlatformAiMemoryFact" ENABLE ROW LEVEL SECURITY;/.test(flat) && /ALTER TABLE public\."PlatformAiMemoryFact" FORCE ROW LEVEL SECURITY;/.test(flat));
  const pol = (name: string) => new RegExp(`CREATE POLICY ${name} ON public\\."PlatformAiMemoryFact"[^;]*;`).exec(flat)?.[0] ?? "";
  const G = `EXISTS (SELECT 1 FROM public."PlatformGrant" g WHERE g."userId" = current_fm_user_id() AND g.area = "platformArea" AND g.status = 'ACTIVE')`;
  check("fm_app_sel: OWN AND not deleted AND not expired AND G", pol("fm_app_sel").includes(`USING ("operatorUserId" = current_fm_user_id() AND "deletedAt" IS NULL AND "expiresAt" > (now() AT TIME ZONE 'UTC'::text) AND ${G})`));
  check("fm_app_ins: WITH CHECK OWN AND G", pol("fm_app_ins").includes(`WITH CHECK ("operatorUserId" = current_fm_user_id() AND ${G})`));
  const upd = pol("fm_app_upd");
  const withCheck = upd.slice(upd.indexOf("WITH CHECK"));
  check("B1: fm_app_upd has its OWN WITH CHECK (OWN AND G) with NO deletedAt / expiresAt term",
    upd.includes(`USING ("operatorUserId" = current_fm_user_id() AND "deletedAt" IS NULL AND "expiresAt" > (now() AT TIME ZONE 'UTC'::text) AND ${G})`)
      && withCheck.includes(`WITH CHECK ("operatorUserId" = current_fm_user_id() AND ${G})`) && !/deletedAt|expiresAt/.test(withCheck));
  check("all policies are TO fm_app only", (flat.match(/CREATE POLICY [a-z_]+ ON public\."PlatformAiMemoryFact" FOR [A-Z]+ TO ([a-z_]+)/g) ?? []).every((p) => p.endsWith("TO fm_app")));
}

if (failures > 0) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nAll memory migration-policy checks passed.");
