/**
 * app/api/platform/ai/ask/route-enabled.test.ts  (Platform AI v0 — the route's gate chain with the flag ON)
 *
 * The REAL handler through the route harness over the in-memory Prisma fake,
 * with PLATFORM_AI_ENABLED=true and operator 2FA ENFORCED (both read at load,
 * so they are set before any import). Every case is REFUSED before a provider
 * could be called — no OpenAI key is configured and the provider seam is
 * never reached (no AiInvocation row of outcome RETURNED; the kill-switch case
 * proves the server-side check runs before any call). No network.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/platform/ai/ask/route-enabled.test.ts
 */

import "@/lib/test-support/route-env";

process.env.PLATFORM_AI_ENABLED = "true";
process.env.OPERATOR_TOTP_ENFORCEMENT = "enforce";
process.env.RATE_LIMIT_ENABLED = "true";
delete process.env.OPENAI_API_KEY;

import bcrypt from "bcryptjs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";

const t = makeChecker("POST /api/platform/ai/ask — PLATFORM_AI_ENABLED on: the gate chain");
const fake = new FakePrisma();
const PATH = "/api/platform/ai/ask";

async function main() {
  await installFakePrisma(fake);
  const { POST } = await import("./route");
  const { PlatformSettingKey } = await import("@/lib/platform-settings");
  const hash = await bcrypt.hash("pw", 4);
  const user = (username: string, extra: Record<string, unknown> = {}) =>
    fake.seed("User", { email: `${username}@fm.test`, username, passwordHash: hash, emailVerifiedAt: new Date(), role: "USER", ...extra }).id as string;
  const op = user("op", { totpEnabled: true });
  const noTotp = user("nototp", { totpEnabled: false });
  const nobody = user("nobody", { totpEnabled: true });
  const revoked = user("revoked", { totpEnabled: true });
  for (const [u, status] of [[op, "ACTIVE"], [noTotp, "ACTIVE"], [revoked, "REVOKED"]] as const) fake.seed("PlatformGrant", { userId: u, area: "PLATFORM_OPS", level: "READ", status });
  fake.seed("Space", { name: "Platform Operations", type: "PLATFORM", platformArea: "PLATFORM_OPS" });

  const ask = async (cookie: string | null, body: unknown = { question: "How are providers?" }) =>
    invoke(POST, request(PATH, { method: "POST", cookie, body }));
  const cookieOf = async (id: string) => (await signIn(fake, id)).cookie;

  t.section("1. who may ask — the AI page's viewers, re-checked fresh");
  t.check("anonymous ⇒ 401", (await ask(null)).status === 401);
  t.check("no Platform grant ⇒ 403", (await ask(await cookieOf(nobody))).status === 403);
  t.check("a REVOKED grant ⇒ 403", (await ask(await cookieOf(revoked))).status === 403);
  const mfa = await ask(await cookieOf(noTotp));
  t.check("an ACTIVE grant without 2FA while enforced ⇒ 403 OPERATOR_TOTP_REQUIRED", mfa.status === 403 && (mfa.body as { code?: string }).code === "OPERATOR_TOTP_REQUIRED", mfa.body);

  t.section("2. the kill switch and the freeze — server-side, before any provider call");
  const c = await cookieOf(op);
  fake.seed("PlatformSetting", { key: PlatformSettingKey.AI_PAID_REQUESTS_PAUSED, value: "true" });
  freshCache();
  const paused = await ask(c);
  t.check("kill switch ON ⇒ 503 AI_UNAVAILABLE / KILL_SWITCH", paused.status === 503 && (paused.body as { reason?: string }).reason === "KILL_SWITCH", paused.body);
  const bad = await ask(c, { question: "x".repeat(501) });
  t.check("an over-long question ⇒ 400 (validated before any AI gate)", bad.status === 400, bad.body);
  fake.rows("PlatformSetting", { key: PlatformSettingKey.AI_PAID_REQUESTS_PAUSED }).forEach((r) => { r.value = "false"; });
  fake.seed("PlatformSetting", { key: PlatformSettingKey.PLATFORM_COST_FROZEN, value: "true" });
  const frozen = await ask(c);
  t.check("global cost freeze ON ⇒ 503 (refused before the provider)", frozen.status === 503 && ["COST_FREEZE", "KILL_SWITCH"].includes(String((frozen.body as { reason?: string }).reason)), frozen.body);
  t.check("no billed AiInvocation exists — the provider was never reached", !fake.rows("AiInvocation").some((r) => r.outcome === "RETURNED"));

  t.section("3. the #352 per-operator limiter (it is a POST)");
  let limited = 0;
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn };
  console.log = console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { for (let i = 0; i < 32; i++) if ((await ask(c)).status === 429) limited++; } finally { console.log = orig.log; console.warn = orig.warn; }
  t.check("past 30 requests a minute the operator gets the house 429", limited >= 1, limited);
  t.check("…keyed by the operator's user id on the platform-ai-ask bucket",
    lines.some((l) => l.includes(`key=user:platform-mutation:platform-ai-ask:${op} limit=30/60s`)), lines.filter((l) => /rate-limit/.test(l)).slice(0, 2));
  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
