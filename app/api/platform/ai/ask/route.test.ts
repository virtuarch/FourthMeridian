/**
 * app/api/platform/ai/ask/route.test.ts  (Platform AI v0 — the route with the flag OFF, the default)
 *
 * The REAL handler through the route harness (lib/test-support/route-harness.ts)
 * over the in-memory Prisma fake, with PLATFORM_AI_ENABLED unset: every caller —
 * anonymous or a signed-in operator — gets 404 NOT_AVAILABLE, and the handler
 * reads nothing (no session row, no grant, no setting, no ledger) and calls no
 * provider. The flag-ON gate chain is ./route-enabled.test.ts; the turn itself
 * is lib/platform/intelligence/ai/platform-ai.test.ts. No network.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/platform/ai/ask/route.test.ts
 */

import "@/lib/test-support/route-env";

delete process.env.PLATFORM_AI_ENABLED;
delete process.env.OPENAI_API_KEY;

import bcrypt from "bcryptjs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn } from "@/lib/test-support/route-harness";

const t = makeChecker("POST /api/platform/ai/ask — PLATFORM_AI_ENABLED off (default)");
const fake = new FakePrisma();

async function main() {
  await installFakePrisma(fake);
  const { POST } = await import("./route");
  const op = fake.seed("User", { email: "op@fm.test", username: "op", passwordHash: await bcrypt.hash("pw", 4), emailVerifiedAt: new Date(), role: "USER", totpEnabled: true }).id as string;
  fake.seed("PlatformGrant", { userId: op, area: "PLATFORM_OPS", level: "CONTROL", status: "ACTIVE" });
  const cookie = (await signIn(fake, op)).cookie;
  fake.calls.length = 0;

  const anon = await invoke(POST, request("/api/platform/ai/ask", { method: "POST", body: { question: "How are providers?" } }));
  t.check("anonymous ⇒ 404 NOT_AVAILABLE (no 401: the route does not exist while off)", anon.status === 404 && (anon.body as { code?: string }).code === "NOT_AVAILABLE", anon.body);
  const signed = await invoke(POST, request("/api/platform/ai/ask", { method: "POST", cookie, body: { question: "How are providers?" } }));
  t.check("a CONTROL operator ⇒ the same 404", signed.status === 404 && signed.text === anon.text, signed.body);
  t.check("no-store", signed.headers.get("cache-control") === "no-store");
  t.check("the handler touched NOTHING: no session, grant, setting, rate-limit or ledger read or write", fake.calls.length === 0, fake.calls.map((c) => `${c.model}.${c.op}`));
  t.check("no AiInvocation row exists", fake.rows("AiInvocation").length === 0);
  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
