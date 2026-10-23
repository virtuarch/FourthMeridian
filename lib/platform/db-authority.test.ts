/**
 * lib/platform/db-authority.test.ts  (RLS-PREP-B)
 *
 * The deployed-authority report must tell "looks like fm_app" from "is fm_app",
 * must fail closed when it cannot tell, and must be incapable of leaking the
 * thing it inspects.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildDbAuthorityReport, connectionShape, RESIDUE_SAMPLES, type AuthorityProbeClient } from "./db-authority";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) { failures++; console.error(`FAIL  ${name}${detail ? `  -> ${detail}` : ""}`); }
  else console.log(`pass  ${name}`);
}

const REF = "abcdefghijklmnopqrst";
const POOL = "aws-0-ap-southeast-1.pooler.supabase.com";
const SECRET = "sup3r-s3cret-pw";
const env = {
  FM_RLS_STRICT: "true",
  DATABASE_URL:        `postgresql://postgres.${REF}:${SECRET}@${POOL}:6543/postgres?pgbouncer=true`,
  DATABASE_URL_APP:    `postgresql://fm_app.${REF}:${SECRET}@${POOL}:6543/postgres?pgbouncer=true`,
  DATABASE_URL_AUTH:   `postgresql://fm_auth.${REF}:${SECRET}@${POOL}:6543/postgres?pgbouncer=true`,
  DATABASE_URL_SYSTEM: `postgresql://fm_system.${REF}:${SECRET}@${POOL}:6543/postgres?pgbouncer=true`,
} as unknown as NodeJS.ProcessEnv;

type Identity = { who: string; super: boolean; bypass: boolean; owned: bigint; member_of: string[] };
const identity = (who: string, over: Partial<Identity> = {}): Identity =>
  ({ who, super: false, bypass: false, owned: BigInt(0), member_of: [], ...over });

/** A fake role client: answers the identity, residue and posture queries. */
function client(id: Identity, opts: { residue?: string | null; posture?: object | null } = {}): AuthorityProbeClient {
  return {
    $queryRawUnsafe: async <T,>(sql: string) => {
      if (sql.includes("current_setting")) return [{ v: opts.residue ?? null }] as T;
      if (sql.includes("relforcerowsecurity")) {
        return (opts.posture === null ? [] : [opts.posture ?? { tables: 64, enabled: 56, forced: 56, policies: 180 }]) as T;
      }
      return [id] as T;
    },
  };
}

const good = () => ({
  DATABASE_URL_APP:    client(identity("fm_app")),
  DATABASE_URL_AUTH:   client(identity("fm_auth")),
  DATABASE_URL_SYSTEM: client(identity("fm_system")),
});
const base = { env, probeUserId: "operator-1", readIdentityInsideTenantTransaction: async (u: string) => u };

void (async () => {
  // ── the intended posture ───────────────────────────────────────────────────
  const ok = await buildDbAuthorityReport({ ...base, clients: good() });
  check("three verified roles + a clean channel + installed policies ⇒ ok", ok.ok, JSON.stringify(ok));
  check("each role reports what the SERVER said, not what the URL said",
    ok.roles.map((r) => r.verdict?.actual).join() === "fm_app,fm_auth,fm_system");
  check("the tenant channel was probed inside and outside a transaction",
    ok.tenantChannel.boundInsideTransaction === true && ok.tenantChannel.residueObserved === 0
    && ok.tenantChannel.residueSamples === RESIDUE_SAMPLES);
  check("the legacy client is classified from its URL and never queried",
    ok.legacyClient.configured && ok.legacyClient.migrationPrincipal === true);

  // ── "looks like fm_app" is not "is fm_app" ─────────────────────────────────
  const impostor = await buildDbAuthorityReport({ ...base,
    clients: { ...good(), DATABASE_URL_APP: client(identity("postgres", { bypass: true, owned: BigInt(56) })) } });
  check("a URL spelled fm_app that executes as the owner is NOT ok, though strict config is clean",
    !impostor.ok && impostor.configProblems.length === 0
    && impostor.roles[0].problems.length === 3, JSON.stringify(impostor.roles[0]));

  const bypass = await buildDbAuthorityReport({ ...base,
    clients: { ...good(), DATABASE_URL_SYSTEM: client(identity("fm_system", { bypass: true })) } });
  check("fm_system carrying BYPASSRLS is NOT ok", !bypass.ok && /BYPASSRLS/.test(bypass.roles[2].problems.join()));

  const member = await buildDbAuthorityReport({ ...base,
    clients: { ...good(), DATABASE_URL_AUTH: client(identity("fm_auth", { member_of: ["postgres"] })) } });
  check("a runtime role that can SET ROLE elsewhere is NOT ok", !member.ok && /MEMBER/.test(member.roles[1].problems.join()));

  // ── the fallback is reported, never interrogated ───────────────────────────
  const { DATABASE_URL_SYSTEM: _dropped, ...twoClients } = good();
  void _dropped;
  const fallback = await buildDbAuthorityReport({ ...base, clients: twoClients });
  check("an unbound role is NOT ok and carries no verdict (a fallback would answer for the owner)",
    !fallback.ok && fallback.roles[2].bound === false && fallback.roles[2].verdict === null
    && /legacy client/.test(fallback.roles[2].problems.join()));

  const none = await buildDbAuthorityReport({ ...base, env: {} as NodeJS.ProcessEnv, clients: {} });
  check("nothing configured ⇒ not ok, strict false, every probe says why it did not run",
    !none.ok && none.strict === false && none.roles.every((r) => !r.bound)
    && none.tenantChannel.problems.length === 1 && none.rls.problems.length === 1);

  const notStrict = await buildDbAuthorityReport({ ...base,
    env: { ...env, FM_RLS_STRICT: "" } as unknown as NodeJS.ProcessEnv, clients: good() });
  check("verified roles WITHOUT strict mode are not ok (a later missing URL would fall back silently)",
    !notStrict.ok && notStrict.roles.every((r) => r.problems.length === 0));

  // ── the channel ────────────────────────────────────────────────────────────
  const residue = await buildDbAuthorityReport({ ...base,
    clients: { ...good(), DATABASE_URL_APP: client(identity("fm_app"), { residue: "someone-else" }) } });
  check("a LEFTOVER app.user_id on a bare statement is NOT ok",
    !residue.ok && residue.tenantChannel.residueObserved === RESIDUE_SAMPLES);
  check("…and the leftover identity itself is never echoed",
    !JSON.stringify(residue).includes("someone-else"));

  const unbound = await buildDbAuthorityReport({ ...base, clients: good(),
    readIdentityInsideTenantTransaction: async () => null });
  check("an identity that does not read back inside the transaction is NOT ok",
    !unbound.ok && unbound.tenantChannel.boundInsideTransaction === false);

  const broken = await buildDbAuthorityReport({ ...base, clients: good(),
    readIdentityInsideTenantTransaction: async () => { throw new Error("pool timeout"); } });
  check("a probe that throws is a PROBLEM, not a pass and not a crash",
    !broken.ok && /could not be probed/.test(broken.tenantChannel.problems.join()));

  // ── the installed policies ─────────────────────────────────────────────────
  const cold = await buildDbAuthorityReport({ ...base,
    clients: { ...good(), DATABASE_URL_APP: client(identity("fm_app"), { posture: { tables: 56, enabled: 0, forced: 0, policies: 0 } }) } });
  check("no policies installed ⇒ NOT ok (the migrations are not applied)",
    !cold.ok && /not applied/.test(cold.rls.problems.join()));
  const unforced = await buildDbAuthorityReport({ ...base,
    clients: { ...good(), DATABASE_URL_APP: client(identity("fm_app"), { posture: { tables: 64, enabled: 56, forced: 40, policies: 180 } }) } });
  check("RLS enabled but not FORCED ⇒ NOT ok", !unforced.ok);

  // ── availability: pooled without pgbouncer mode ────────────────────────────
  const noBouncer = await buildDbAuthorityReport({ ...base, clients: good(),
    env: { ...env, DATABASE_URL_APP: `postgresql://fm_app.${REF}:${SECRET}@${POOL}:6543/postgres` } as unknown as NodeJS.ProcessEnv });
  check("a pooler URL without pgbouncer=true is reported", /pgbouncer=true/.test(noBouncer.roles[0].problems.join()));

  // ── it cannot leak what it inspects ────────────────────────────────────────
  const everything = JSON.stringify([ok, impostor, fallback, residue, noBouncer]);
  check("no report contains a password", !everything.includes(SECRET));
  check("no report contains a host name", !everything.includes(POOL) && !everything.includes("supabase.com"));
  check("no report contains the project reference", !everything.includes(REF));
  check("no report contains a connection string", !/postgres(ql)?:\/\//.test(everything));
  const shape = connectionShape(env.DATABASE_URL_APP);
  check("a URL reduces to exactly five shape facts",
    Object.keys(shape).sort().join() === "configured,pgbouncer,port,supabasePoolerHost,usernameForm"
    && shape.usernameForm === "pooler" && shape.port === "6543" && shape.pgbouncer === true && shape.supabasePoolerHost === true);
  check("an unset or unparseable URL has a shape and no value",
    connectionShape(undefined).configured === false && connectionShape("not a url").usernameForm === "unparseable");

  // ── the surface ────────────────────────────────────────────────────────────
  const route = readFileSync(join(process.cwd(), "app/api/platform/platform-ops/db-authority/route.ts"), "utf8");
  const code = route.replace(/\/\*[\s\S]*?\*\//g, "");
  check("the route is operator-gated with the live-revocation re-check",
    /requireFreshPlatformAccess\("PLATFORM_OPS", "READ"\)/.test(code) && code.indexOf("requireFreshPlatformAccess(") < code.indexOf("getDbAuthorityReport("));
  check("the route answers 503 when the deployment is not isolated", /report\.ok \? 200 : 503/.test(code));
  check("the route is never cached", /no-store/.test(code) && /force-dynamic/.test(code));
  const lib = readFileSync(join(process.cwd(), "lib/platform/db-authority.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  check("the module takes no client by name from lib/db (it adds nothing to the ratchet)",
    !/\b(db|tenantDb|authDb|systemDb)\b\s*[,}]/.test(lib.match(/await import\("@\/lib\/db"\)[^;]*;/)?.[0] ?? "")
    && /configuredRoleClients/.test(lib));
  const health = readFileSync(join(process.cwd(), "app/api/health/route.ts"), "utf8");
  check("/api/health stays narrow: it does not report authority", !/db-authority|verifyDbAuthorit|rolbypassrls/.test(health));

  if (failures > 0) { console.error(`\ndb-authority: ${failures} failure(s).`); process.exit(1); }
  console.log("\ndb-authority: all passed.");
})();
