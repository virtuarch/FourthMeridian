/**
 * app/api/platform/ai/memory/routes-flags-off.test.ts  (B11 release gate — Platform AI memory + purge-operator, flags OFF)
 *
 * ROUTE-LEVEL proof that every Platform AI operational-memory handler and the
 * System Admin memory purge-operator refuse when their flags are off, BEFORE any
 * session or database access. The REAL handlers are invoked directly (no route
 * harness: it would re-bind next/headers) with two tripwires installed:
 *
 *   • DATABASE — the in-memory Prisma fake is installed behind the process's one
 *     client (lib/test-support/fake-prisma.ts asserts no distinct role client
 *     exists), then EVERY model delegate of that client (all of Prisma.dmmf) and
 *     $transaction, $queryRaw*, $executeRaw*, $connect, $disconnect are re-defined
 *     as getters that RECORD the access (proven live through lib/db's db / authDb /
 *     systemDb). Any delegate access, any call, any raw statement fails
 *     the phase (fake.calls / fake.raw are asserted empty too).
 *   • SESSION — next/headers `cookies()` / `headers()` / `draftMode()` (the only
 *     way getServerSession / getToken / lib/session.ts can see a request) are
 *     replaced on the module's exports object with functions that RECORD and
 *     THROW. The request body is asserted unread (bodyUsed === false).
 *
 * Handlers covered (the actual paths):
 *   GET    /api/platform/ai/memory               (+ ?probe=1)
 *   DELETE /api/platform/ai/memory
 *   POST   /api/platform/ai/memory/confirm
 *   POST   /api/platform/ai/memory/remember
 *   DELETE /api/platform/ai/memory/[id]
 *   POST   /api/platform/ai/memory/[id]/renew
 *       ⇒ 404 { error: "Not available.", code: "NOT_AVAILABLE" }, Cache-Control: no-store
 *         (isMemoryEffective(env) — needs PLATFORM_AI_ENABLED, PLATFORM_AI_CONVERSATIONS_ENABLED,
 *         PLATFORM_AI_PURGE_ENABLED, PLATFORM_AI_MEMORY_PURGE_ENABLED, PLATFORM_AI_MEMORY_ENABLED,
 *         all strictly "true")
 *   POST   /api/platform/admin/ai-memory/purge-operator
 *       ⇒ 404 NOT_AVAILABLE (same body), no-store (env.isPlatformAiMemoryPurgeEnabled —
 *         PLATFORM_AI_MEMORY_PURGE_ENABLED strictly "true", independent of the memory flag)
 *
 * (The on-demand conversation purge, GET /api/jobs/dispatch?only=platform-ai-purge ⇒ 409
 * PURGE_ON_DEMAND_DISABLED with no fake contact, is pinned at route level by
 * lib/platform/intelligence/ai/conversations/purge-on-demand.test.ts §4–§5.)
 *
 * PHASES (lib/env snapshots process.env at import, so each runs in its own child):
 *   none           every flag unset
 *   no-<FLAG> ×5   that ONE flag unset, the other four "true"
 *   loose          every flag set to "TRUE" / "1" / " true" (strict === "true" only)
 *   on             every flag "true" — the POSITIVE CONTROL: memory routes and the
 *                  purge-operator get past the flag and DO trip the session tripwire,
 *                  proving the tripwires are live (a dead tripwire cannot pass the OFF phases vacuously).
 *
 * No database, no network, no provider.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/platform/ai/memory/routes-flags-off.test.ts
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const FLAGS = [
  "PLATFORM_AI_ENABLED",
  "PLATFORM_AI_CONVERSATIONS_ENABLED",
  "PLATFORM_AI_PURGE_ENABLED",
  "PLATFORM_AI_MEMORY_PURGE_ENABLED",
  "PLATFORM_AI_MEMORY_ENABLED",
] as const;
type Flag = (typeof FLAGS)[number];

const PHASE = process.env.FM_MEMORY_FLAGS_PHASE ?? "parent";

if (PHASE === "parent") {
  const phases = ["none", ...FLAGS.map((f) => `no-${f}`), "loose", "on"];
  let failed = 0;
  for (const phase of phases) {
    const r = spawnSync(process.execPath, [...process.execArgv, path.resolve(__filename)], {
      encoding: "utf8", env: { ...process.env, FM_MEMORY_FLAGS_PHASE: phase },
    });
    process.stdout.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
    if (r.status !== 0) { failed++; console.error(`  ✗ phase ${phase} exited ${r.status}`); }
  }
  console.log(failed ? `\n❌ ${failed} phase(s) failed` : `\n✅ platform-ai memory + purge-operator flags-off: all ${phases.length} phases passed`);
  process.exit(failed ? 1 : 0);
} else {
  void runPhase(PHASE).catch((e) => { console.error(e); process.exit(1); });
}

function setFlags(phase: string): void {
  for (const f of FLAGS) delete process.env[f];
  if (phase === "none") return;
  if (phase === "loose") {
    const loose = ["TRUE", "1", " true", "True", "yes"];
    FLAGS.forEach((f, i) => { process.env[f] = loose[i]; });
    return;
  }
  for (const f of FLAGS) process.env[f] = "true";
  if (phase.startsWith("no-")) delete process.env[phase.slice(3) as Flag];
}

async function runPhase(phase: string): Promise<void> {
  await import("@/lib/test-support/route-env");
  delete process.env.OPENAI_API_KEY;
  setFlags(phase);

  // ── SESSION tripwire: next/headers, on the module's own exports object (read at call time). ──
  const sessionReads: string[] = [];
  const nh = createRequire(__filename)("next/headers") as Record<string, unknown>;
  for (const k of ["cookies", "headers", "draftMode"]) {
    nh[k] = () => { sessionReads.push(k); throw new Error(`tripwire: next/headers.${k}() read`); };
  }

  // ── DATABASE tripwire: the fake behind the one client, then every model delegate (Prisma.dmmf —
  //    PlatformAiMemoryFact, User, PlatformGrant, UserSession, … whatever the schema holds) and the
  //    raw / transaction / connect surface re-defined as a getter that RECORDS the access. ──
  const { FakePrisma, installFakePrisma } = await import("@/lib/test-support/fake-prisma");
  const { Prisma } = await import("@prisma/client");
  const fake = new FakePrisma();
  await installFakePrisma(fake);
  const dbAccess: string[] = [];
  const client = (globalThis as unknown as { prisma: Record<string, unknown> }).prisma;
  const delegates = Prisma.dmmf.datamodel.models.map((m) => m.name.charAt(0).toLowerCase() + m.name.slice(1));
  const surface = [...delegates, "$transaction", "$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe", "$connect", "$disconnect"];
  const wrapped: string[] = [];
  for (const key of surface) {
    // The client is Prisma's composite Proxy: read the installed fake through the client (a descriptor's
    // `value` can read undefined there), then put a recording getter in front of it.
    const value = client[key];
    if (typeof value !== "object" && typeof value !== "function") continue;
    Object.defineProperty(client, key, { configurable: true, get: () => { dbAccess.push(key); return value; } });
    wrapped.push(key);
  }

  const { request, makeChecker } = await import("@/lib/test-support/route-harness");
  const { NOT_AVAILABLE_BODY } = await import("@/lib/platform/intelligence/ai/conversations/handlers");
  const t = makeChecker(`\nPlatform AI memory + purge-operator routes — phase ${phase} (${FLAGS.map((f) => `${f}=${JSON.stringify(process.env[f] ?? null)}`).join(" ")})`);
  t.check(`the DB tripwire wraps all ${delegates.length} model delegates and the raw / transaction / connect surface`,
    delegates.includes("user") && delegates.includes("platformGrant") && wrapped.length === surface.length, surface.filter((k) => !wrapped.includes(k)));
  {
    // …and it is LIVE: going through lib/db's exported clients (the very objects the routes import) records.
    const lib = (await import("@/lib/db")) as unknown as Record<"db" | "authDb" | "systemDb", Record<string, unknown>>;
    void lib.db.platformGrant; void lib.authDb.userSession; void lib.systemDb.$queryRawUnsafe; void lib.db.$transaction;
    t.check("…and LIVE: touching lib/db's `db` / `authDb` / `systemDb` is recorded",
      dbAccess.join() === "platformGrant,userSession,$queryRawUnsafe,$transaction", dbAccess);
    dbAccess.length = 0;
  }

  const memory = await import("./route");
  const confirm = await import("./confirm/route");
  const remember = await import("./remember/route");
  const one = await import("./[id]/route");
  const renew = await import("./[id]/renew/route");
  const purgeOperator = await import("@/app/api/platform/admin/ai-memory/purge-operator/route");

  const ID = "c000000000000000000000001";
  const BASE = "/api/platform/ai/memory";
  const COOKIE = "__Secure-next-auth.session-token=not-a-real-token";
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  type Call = { name: string; group: "memory" | "purge"; run: () => Promise<{ res: Response | null; req: Request; threw: boolean }> };
  const call = (name: string, group: Call["group"], req: Request, h: (req: never, ctx: never) => Promise<Response>, ctx?: unknown): Call => ({
    name, group,
    run: async () => {
      try { return { res: await h(req as never, ctx as never), req, threw: false }; }
      catch { return { res: null, req, threw: true }; }
    },
  });
  const calls = (cookie: string | null): Call[] => [
    call("GET /memory", "memory", request(BASE, { method: "GET", cookie }), memory.GET),
    call("GET /memory?probe=1", "memory", request(`${BASE}?probe=1`, { method: "GET", cookie }), memory.GET),
    call("DELETE /memory", "memory", request(BASE, { method: "DELETE", cookie }), memory.DELETE),
    call("POST /memory/confirm", "memory", request(`${BASE}/confirm`, { method: "POST", cookie, body: { token: "t", ttl: 30, note: "n" } }), confirm.POST),
    call("POST /memory/remember", "memory", request(`${BASE}/remember`, { method: "POST", cookie, body: { kind: "INCIDENT", ref: ID } }), remember.POST),
    call("DELETE /memory/[id]", "memory", request(`${BASE}/${ID}`, { method: "DELETE", cookie }), one.DELETE, params(ID)),
    call("POST /memory/[id]/renew", "memory", request(`${BASE}/${ID}/renew`, { method: "POST", cookie }), renew.POST, params(ID)),
    call("POST /admin/ai-memory/purge-operator", "purge", request("/api/platform/admin/ai-memory/purge-operator", { method: "POST", cookie, body: { userId: ID } }), purgeOperator.POST),
  ];

  const quiet = async <T,>(f: () => Promise<T>): Promise<T> => {
    const { log, warn, error } = console; console.log = () => {}; console.warn = () => {}; console.error = () => {};
    try { return await f(); } finally { console.log = log; console.warn = warn; console.error = error; }
  };
  const runOne = async (c: Call) => {
    sessionReads.length = 0; dbAccess.length = 0; fake.calls.length = 0; fake.raw.length = 0;
    const out = await quiet(c.run);
    const text = out.res ? await out.res.text() : "";
    return {
      ...out, text,
      status: out.res?.status ?? -1,
      cache: out.res?.headers.get("cache-control") ?? null,
      session: [...sessionReads], db: [...dbAccess],
      fakeCalls: fake.calls.map((x) => `${x.model}.${x.op}`), raw: fake.raw.length,
    };
  };
  const expectedBody = JSON.stringify(NOT_AVAILABLE_BODY);

  const memoryOff = phase !== "on";
  const purgeOff = phase === "none" || phase === "loose" || phase === "no-PLATFORM_AI_MEMORY_PURGE_ENABLED";

  for (const cookie of [null, COOKIE]) {
    const who = cookie ? "with a session cookie" : "anonymous";
    for (const c of calls(cookie)) {
      const off = c.group === "memory" ? memoryOff : purgeOff;
      const r = await runOne(c);
      if (off) {
        t.check(`${c.name} (${who}) ⇒ 404 NOT_AVAILABLE, exact body, no-store`,
          !r.threw && r.status === 404 && r.text === expectedBody && r.cache === "no-store", { status: r.status, text: r.text, cache: r.cache, threw: r.threw });
        t.check(`${c.name} (${who}) …NO session access (next/headers never read)`, r.session.length === 0, r.session);
        t.check(`${c.name} (${who}) …NO database access (no client property touched, no fake call, no raw SQL)`,
          r.db.length === 0 && r.fakeCalls.length === 0 && r.raw === 0, { db: r.db, calls: r.fakeCalls, raw: r.raw });
        t.check(`${c.name} (${who}) …request body never read`, r.req.bodyUsed === false);
      } else {
        // POSITIVE CONTROL: past the flag, the handler reaches for the session — the tripwire fires.
        t.check(`[control] ${c.name} (${who}) gets past the flag and trips the session tripwire (not a 404 NOT_AVAILABLE)`,
          r.session.length > 0 && r.text !== expectedBody, { status: r.status, session: r.session, threw: r.threw });
      }
    }
  }
  t.done();
}
