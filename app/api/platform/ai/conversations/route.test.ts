/**
 * app/api/platform/ai/conversations/route.test.ts  (B11 — every conversation route, flags OFF and ON)
 *
 * The REAL handlers through the route harness over the in-memory Prisma fake.
 *
 *   1. OFF (the default): PLATFORM_AI_CONVERSATIONS_ENABLED unset — and, as a
 *      second case, set while PLATFORM_AI_ENABLED is unset — every handler (GET
 *      list, POST create, GET one, DELETE) answers 404 NOT_AVAILABLE and reads
 *      NOTHING (no session, grant, setting, rate-limit or table read).
 *   2. ON: the gate chain before any lookup — anonymous ⇒ 401; no grant ⇒ 403;
 *      a REVOKED grant ⇒ 403; an ACTIVE grant without 2FA while enforced ⇒
 *      v0's 403 OPERATOR_TOTP_REQUIRED; a break-glass SYSTEM_ADMIN (no grant) ⇒
 *      403 — and none of these reads a conversation row.
 *
 * lib/env.ts snapshots process.env when it is first imported, so each phase
 * runs in its own child process of this file with its flags set before any
 * import. No network, no provider.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/platform/ai/conversations/route.test.ts
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

const PHASE = process.env.FM_CONV_ROUTE_PHASE ?? "parent";

if (PHASE === "parent") {
  // Each phase needs its own env snapshot at import time: run them as children.
  let failed = 0;
  for (const phase of ["off", "off-v0", "on"]) {
    const r = spawnSync(process.execPath, [...process.execArgv, path.resolve(__filename)], {
      encoding: "utf8", env: { ...process.env, FM_CONV_ROUTE_PHASE: phase },
    });
    process.stdout.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
    if (r.status !== 0) failed++;
  }
  process.exit(failed ? 1 : 0);
} else {
  void runPhase(PHASE).catch((e) => { console.error(e); process.exit(1); });
}

async function runPhase(phase: string): Promise<void> {
  await import("@/lib/test-support/route-env");
  delete process.env.OPENAI_API_KEY;
  if (phase === "off") { process.env.PLATFORM_AI_ENABLED = "true"; delete process.env.PLATFORM_AI_CONVERSATIONS_ENABLED; }
  if (phase === "off-v0") { delete process.env.PLATFORM_AI_ENABLED; process.env.PLATFORM_AI_CONVERSATIONS_ENABLED = "true"; }
  if (phase === "on") { process.env.PLATFORM_AI_ENABLED = "true"; process.env.PLATFORM_AI_CONVERSATIONS_ENABLED = "true"; process.env.OPERATOR_TOTP_ENFORCEMENT = "enforce"; }

  const bcrypt = (await import("bcryptjs")).default;
  const { FakePrisma, installFakePrisma } = await import("@/lib/test-support/fake-prisma");
  const { invoke, request, makeChecker, signIn } = await import("@/lib/test-support/route-harness");
  const t = makeChecker(`/api/platform/ai/conversations — phase ${phase}`);
  const fake = new FakePrisma();
  await installFakePrisma(fake);
  const list = await import("./route");
  const one = await import("./[id]/route");
  const hash = await bcrypt.hash("pw", 4);
  const user = (username: string, extra: Record<string, unknown> = {}) =>
    fake.seed("User", { email: `${username}@fm.test`, username, passwordHash: hash, emailVerifiedAt: new Date(), role: "USER", ...extra }).id as string;
  const op = user("op", { totpEnabled: true });
  fake.seed("PlatformGrant", { userId: op, area: "PLATFORM_OPS", level: "CONTROL", status: "ACTIVE" });
  fake.seed("Space", { name: "Platform Operations", type: "PLATFORM", platformArea: "PLATFORM_OPS" });
  const cookieOf = async (id: string) => (await signIn(fake, id)).cookie;
  const ID = "c000000000000000000000001";
  const BASE = "/api/platform/ai/conversations";
  const body = { clientRequestId: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b", question: "How are providers?" };
  const all = (cookie: string | null) => Promise.all([
    invoke(list.GET, request(BASE, { method: "GET", cookie })),
    invoke(list.POST, request(BASE, { method: "POST", cookie, body })),
    invoke(one.GET, request(`${BASE}/${ID}`, { method: "GET", cookie }), { id: ID }),
    invoke(one.DELETE, request(`${BASE}/${ID}`, { method: "DELETE", cookie }), { id: ID }),
  ]);
  const touchedConversations = () => fake.calls.some((c) => /^platformAi/i.test(String(c.model)));

  if (phase === "off" || phase === "off-v0") {
    const cookie = await cookieOf(op);
    fake.calls.length = 0;
    const anon = await all(null);
    const signed = await all(cookie);
    t.check(`${phase === "off" ? "PLATFORM_AI_CONVERSATIONS_ENABLED unset" : "PLATFORM_AI_ENABLED unset"}: every handler ⇒ 404 NOT_AVAILABLE, anonymous or a CONTROL operator`,
      [...anon, ...signed].every((r) => r.status === 404 && (r.body as { code?: string }).code === "NOT_AVAILABLE"), [...anon, ...signed].map((r) => r.status));
    t.check("…byte-identical for every caller and route", [...anon, ...signed].every((r) => r.text === anon[0].text));
    t.check("…no-store", signed.every((r) => r.headers.get("cache-control") === "no-store"));
    t.check("…and NOTHING was read or written (no session, grant, setting, rate-limit or table)", fake.calls.length === 0, fake.calls.map((c) => `${c.model}.${c.op}`));
    t.done();
    return;
  }

  // phase on — the gate chain before any lookup.
  const noTotp = user("nototp", { totpEnabled: false });
  const nobody = user("nobody", { totpEnabled: true });
  const revoked = user("revoked", { totpEnabled: true });
  const admin = user("admin", { totpEnabled: true, role: "SYSTEM_ADMIN" });
  fake.seed("PlatformGrant", { userId: noTotp, area: "PLATFORM_OPS", level: "READ", status: "ACTIVE" });
  fake.seed("PlatformGrant", { userId: revoked, area: "PLATFORM_OPS", level: "READ", status: "REVOKED" });
  fake.calls.length = 0;
  const anon = await all(null);
  t.check("anonymous ⇒ 401 on every handler", anon.every((r) => r.status === 401), anon.map((r) => r.status));
  t.check("no grant ⇒ 403 on every handler", (await all(await cookieOf(nobody))).every((r) => r.status === 403));
  t.check("a REVOKED grant ⇒ 403 on every handler", (await all(await cookieOf(revoked))).every((r) => r.status === 403));
  const mfa = await all(await cookieOf(noTotp));
  t.check("an ACTIVE grant without 2FA while enforced ⇒ v0's 403 OPERATOR_TOTP_REQUIRED on every handler",
    mfa.every((r) => r.status === 403 && (r.body as { code?: string }).code === "OPERATOR_TOTP_REQUIRED"), mfa.map((r) => r.body));
  const bg = await all(await cookieOf(admin));
  t.check("a SYSTEM_ADMIN (break-glass, no grant) ⇒ 403 on every handler — no oversight read", bg.every((r) => r.status === 403), bg.map((r) => r.status));
  t.check("none of these refusals read a conversation row (the viewer gate runs before any lookup)", !touchedConversations(),
    fake.calls.filter((c) => /^platformAi/i.test(String(c.model))).map((c) => `${c.model}.${c.op}`));
  t.done();
}
