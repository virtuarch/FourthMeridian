/**
 * lib/ai/allowance.test.ts  (BETA C7 — the per-customer daily AI allowance)
 *
 * The verdict, the fold of today's spend, the loader against an injected
 * client, the refusal contract, and the two routes' wiring. NO LIVE DATABASE.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/allowance.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveEffectiveEntitlements } from "@/lib/entitlements/resolve";
import {
  allowanceRefusalBody, allowanceRefusalStatus, dailyAllowanceVerdict, sumTodaySpend, ALLOWANCE_CODE,
  RESERVE_INVOCATIONS_PER_TURN, RESERVE_MODEL, RESERVE_USD, RESERVE_USD_FALLBACK, reserveUsdFor, reservedAllowanceVerdict,
} from "./allowance-core";
import { CHAT_MODEL } from "@/lib/ai/conversation/engine";
import { allowanceRefusal, allowanceUsdOf, dailyAiAllowanceFor, loadTodaySpend, utcDayStart, type AllowanceReadClient } from "./allowance";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected:", err); process.exit(1);
});
const ROOT = process.cwd();
const strip = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const NOW = new Date("2026-10-15T15:30:00.000Z");
const TODAY = "2026-10-15";
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const BETA = resolveEffectiveEntitlements(null);
const FOUNDER = resolveEffectiveEntitlements({ policyGroup: "BETA_FULL_ACCESS_V1", overlay: "FOUNDER_INTERNAL_V1", assignedAt: NOW, assignedById: null });

async function main() {
  console.log("1. the verdict (pure)");
  {
    const ok = dailyAllowanceVerdict({ spentUsd: 1.2, allowanceUsd: 5, unpricedInvocations: 0 });
    check("under the allowance ⇒ allowed with the remainder", ok.allowed && close(ok.remainingUsd, 3.8));
    const at = dailyAllowanceVerdict({ spentUsd: 5, allowanceUsd: 5, unpricedInvocations: 0 });
    check("AT the allowance ⇒ refused (the next turn would exceed it)", !at.allowed && at.reason === "ALLOWANCE_EXHAUSTED");
    check("over ⇒ refused", !dailyAllowanceVerdict({ spentUsd: 5.01, allowanceUsd: 5, unpricedInvocations: 0 }).allowed);
    check("an allowance of 0 refuses every turn — never 'unlimited'", !dailyAllowanceVerdict({ spentUsd: 0, allowanceUsd: 0, unpricedInvocations: 0 }).allowed);
    // ⚠️ FAIL CLOSED on a malformed limit: below 1 (negative, NaN) is 0, and 0 refuses.
    const negative = dailyAllowanceVerdict({ spentUsd: 0, allowanceUsd: -3, unpricedInvocations: 0 });
    check("a limit below 1 (negative) refuses — fail closed, reported as allowance 0", !negative.allowed && negative.allowanceUsd === 0 && negative.reason === "ALLOWANCE_EXHAUSTED");
    check("a NaN limit refuses too", !dailyAllowanceVerdict({ spentUsd: 0, allowanceUsd: NaN, unpricedInvocations: 0 }).allowed);
    // ⚠️ FAIL CLOSED: an unknown spend is never "under the allowance".
    const unpriced = dailyAllowanceVerdict({ spentUsd: 0.01, allowanceUsd: 20, unpricedInvocations: 1 });
    check("ANY unpriced invocation today ⇒ refused with UNPRICED_MODEL, whatever the priced part says", !unpriced.allowed && unpriced.reason === "UNPRICED_MODEL" && unpriced.unpricedInvocations === 1);
    check("unpriced outranks exhausted as the reason", dailyAllowanceVerdict({ spentUsd: 9, allowanceUsd: 5, unpricedInvocations: 2 }).allowed === false
      && (dailyAllowanceVerdict({ spentUsd: 9, allowanceUsd: 5, unpricedInvocations: 2 }) as { reason: string }).reason === "UNPRICED_MODEL");
    check("malformed inputs are treated as zero, never NaN", dailyAllowanceVerdict({ spentUsd: NaN, allowanceUsd: 5, unpricedInvocations: NaN }).allowed === true);
    // AI COST CONTROLS — the verdict carries the enforcement flag and the reservation state.
    check("the plain verdict says enforced, reservation NONE, inFlight 0", ok.enforced === true && ok.reservation === "NONE" && ok.inFlight === 0);
    const off = dailyAllowanceVerdict({ spentUsd: 9, allowanceUsd: 5, unpricedInvocations: 0, enforced: false });
    check("enforcement OFF ⇒ over the allowance is still ALLOWED, and the verdict says enforced:false with the spend intact", off.allowed && off.enforced === false && off.spentUsd === 9);
    const offUnpriced = dailyAllowanceVerdict({ spentUsd: 0, allowanceUsd: 5, unpricedInvocations: 1, enforced: false });
    check("enforcement OFF does NOT lift the UNPRICED_MODEL refusal (pricing validation is not the allowance)", !offUnpriced.allowed && offUnpriced.reason === "UNPRICED_MODEL");
  }

  console.log("\n1b. AI COST CONTROLS — the in-flight reservation (pure)");
  {
    check("RESERVE_USD is derived from the rate card for the engine's model and the turn's invocation cap",
      RESERVE_MODEL === CHAT_MODEL && RESERVE_INVOCATIONS_PER_TURN === 6 && reserveUsdFor(CHAT_MODEL) !== null && RESERVE_USD === reserveUsdFor(CHAT_MODEL)
      && close(RESERVE_USD, 6 * (30_000 * 1.25 / 1e6 + 1_500 * 10 / 1e6)), String(RESERVE_USD));
    check("…and never 0 even for an unpriced model (the fallback)", (reserveUsdFor("gpt-99-nope") ?? RESERVE_USD_FALLBACK) > 0);
    const base = { spentUsd: 4.5, allowanceUsd: 5, unpricedInvocations: 0, reserveUsd: 0.315, enforced: true, reservation: "RESERVED" as const };
    check("no turns in flight ⇒ allowed with the remainder", reservedAllowanceVerdict({ ...base, inFlight: 0 }).allowed);
    check("one turn in flight ⇒ 4.5 + 0.315 < 5 ⇒ still allowed, remaining net of the reserve", (() => { const v = reservedAllowanceVerdict({ ...base, inFlight: 1 }); return v.allowed && v.inFlight === 1 && close((v as { remainingUsd: number }).remainingUsd, 0.185); })());
    check("two in flight ⇒ 4.5 + 0.63 ≥ 5 ⇒ refused ALLOWANCE_EXHAUSTED", (() => { const v = reservedAllowanceVerdict({ ...base, inFlight: 2 }); return !v.allowed && v.reason === "ALLOWANCE_EXHAUSTED" && v.reservation === "RESERVED"; })());
    // FIVE concurrent admissions against a fresh $5 allowance with $3.80 already spent: each admission raises the next one's committed figure by one reserve.
    let inFlight = 0; const admitted: boolean[] = [];
    for (let i = 0; i < 5; i++) { const v = reservedAllowanceVerdict({ ...base, spentUsd: 3.8, inFlight }); admitted.push(v.allowed); if (v.allowed) inFlight++; }
    check("5 concurrent turns at $3.80 spent of $5: exactly 4 admitted (3.8 + 4 × 0.315 = 5.06 ≥ 5 refuses the fifth)", admitted.join() === "true,true,true,true,false" && inFlight === 4, admitted.join());
    check("…whereas the stale-sum check would have admitted all five", Array.from({ length: 5 }, () => dailyAllowanceVerdict({ spentUsd: 3.8, allowanceUsd: 5, unpricedInvocations: 0 }).allowed).every(Boolean));
    check("enforcement OFF ignores the reservation too", reservedAllowanceVerdict({ ...base, inFlight: 50, enforced: false }).allowed);
  }

  console.log("\n2. today's spend (pure fold at today's rate)");
  {
    const s = sumTodaySpend([
      { provider: "OPENAI", model: "gpt-5.1", invocations: 3, promptTokens: 1_000_000, cachedPromptTokens: 0, completionTokens: 0 },   // $1.25
      { provider: "OPENAI", model: "gpt-5.1", invocations: 1, promptTokens: 0, cachedPromptTokens: 0, completionTokens: 100_000 },     // $1.00
      { provider: "OPENAI", model: "gpt-7-preview", invocations: 2, promptTokens: 10, cachedPromptTokens: 0, completionTokens: 10 },  // unpriced
    ], TODAY);
    check("priced groups sum; unpriced groups are counted with their model, never added at $0", close(s.spentUsd, 2.25) && s.invocations === 6 && s.unpricedInvocations === 2 && s.unpricedModels.join() === "OPENAI:gpt-7-preview");
    check("no rows ⇒ $0 spent, nothing unpriced", sumTodaySpend([], TODAY).spentUsd === 0 && sumTodaySpend([], TODAY).unpricedInvocations === 0);
  }

  console.log("\n3. the loader (injected client) and the verdict for a customer");
  {
    let seen: Record<string, unknown> | null = null;
    const client = (rows: { provider: string; model: string; n: number; p: number; c: number; o: number }[]): AllowanceReadClient => ({
      aiInvocation: { groupBy: async (args) => { seen = args as unknown as Record<string, unknown>; return rows.map((r) => ({ provider: r.provider, model: r.model, _count: { _all: r.n }, _sum: { promptTokens: r.p, cachedPromptTokens: r.c, completionTokens: r.o } })); } },
    });
    const spend = await loadTodaySpend("usr_1", NOW, client([{ provider: "OPENAI", model: "gpt-5.1", n: 2, p: 2_000_000, c: 0, o: 0 }]));
    check("the read is THIS user's RETURNED rows on customer surfaces since the UTC day start, grouped by model",
      seen !== null && (seen as { where: { userId: string; outcome: string; surface: { in: string[] }; occurredAt: { gte: Date } } }).where.userId === "usr_1"
      && (seen as { where: { outcome: string } }).where.outcome === "RETURNED"
      && (seen as { where: { surface: { in: string[] } } }).where.surface.in.join() === "chat,brief"
      && (seen as { where: { occurredAt: { gte: Date } } }).where.occurredAt.gte.toISOString() === "2026-10-15T00:00:00.000Z"
      && JSON.stringify((seen as { by: string[] }).by) === JSON.stringify(["provider", "model"]));
    check("today's spend priced at today's rate", close(spend.spentUsd, 2.5));
    check("utcDayStart is midnight UTC of the given instant", utcDayStart(NOW).toISOString() === "2026-10-15T00:00:00.000Z");

    check("the allowance comes from the resolved dimension: BETA $5, FOUNDER $20", allowanceUsdOf(BETA) === 5 && allowanceUsdOf(FOUNDER) === 20);
    const beta = await dailyAiAllowanceFor("usr_1", BETA, { now: NOW, client: client([{ provider: "OPENAI", model: "gpt-5.1", n: 4, p: 4_000_000, c: 0, o: 0 }]) });
    check("a BETA customer at $5.00 is refused", !beta.allowed && beta.reason === "ALLOWANCE_EXHAUSTED" && close(beta.spentUsd, 5) && beta.allowanceUsd === 5);
    const founder = await dailyAiAllowanceFor("usr_1", FOUNDER, { now: NOW, client: client([{ provider: "OPENAI", model: "gpt-5.1", n: 4, p: 4_000_000, c: 0, o: 0 }]) });
    check("the FOUNDER overlay lifts the same spend under its $20", founder.allowed && founder.allowanceUsd === 20);
    const gap = await dailyAiAllowanceFor("usr_1", FOUNDER, { now: NOW, client: client([{ provider: "OPENAI", model: "gpt-9-nightly", n: 1, p: 10, c: 0, o: 1 }]) });
    check("an unpriced invocation today refuses even the founder (fail closed)", !gap.allowed && gap.reason === "UNPRICED_MODEL");
    const fresh = await dailyAiAllowanceFor("usr_1", BETA, { now: NOW, client: client([]) });
    check("nothing spent ⇒ allowed with the whole allowance remaining", fresh.allowed && fresh.remainingUsd === 5);
    check("the injected-client path says reservation NONE and hands back a no-op release", fresh.reservation === "NONE" && typeof fresh.release === "function");
    await fresh.release();
    const notEnforced = await dailyAiAllowanceFor("usr_1", BETA, { now: NOW, enforced: false, client: client([{ provider: "OPENAI", model: "gpt-5.1", n: 4, p: 4_000_000, c: 0, o: 0 }]) });
    check("enforcement off ⇒ the same $5.00 spend is allowed and the verdict says so", notEnforced.allowed && notEnforced.enforced === false);
    // The reservation seam: the route-facing loader composes the fm_system reservation and forwards its release.
    let released = 0;
    const reserved = await dailyAiAllowanceFor("usr_1", BETA, { now: NOW, reserve: async (u, a) => ({ verdict: { allowed: true, spentUsd: 1, allowanceUsd: a, remainingUsd: a - 1, enforced: true, reservation: "RESERVED", inFlight: 2 }, release: async () => { released++; } }) });
    check("the reservation seam's verdict and release come back together", reserved.allowed && reserved.reservation === "RESERVED" && reserved.inFlight === 2 && reserved.allowanceUsd === 5);
    await reserved.release(); await reserved.release();
    check("release is forwarded (the reservation module makes it idempotent)", released === 2);
  }

  console.log("\n4. the refusal contract (shared by Conversations and the Daily Brief)");
  {
    const common = { enforced: true, reservation: "NONE" as const, inFlight: 0 };
    const exhausted = { ...common, allowed: false as const, reason: "ALLOWANCE_EXHAUSTED" as const, spentUsd: 5.004, allowanceUsd: 5, unpricedInvocations: 0 };
    const body = allowanceRefusalBody(exhausted, "Conversations");
    check("body: { error, code: AI_ALLOWANCE, reason, spentUsd (cents), allowanceUsd }",
      body.code === ALLOWANCE_CODE && body.code === "AI_ALLOWANCE" && body.reason === "ALLOWANCE_EXHAUSTED" && body.spentUsd === 5 && body.allowanceUsd === 5);
    check("the sentence is customer-readable: names the allowance (currency-aware figure), the UTC reset, nothing changed", /\$5\.00/.test(body.error) && /midnight UTC/.test(body.error) && /Nothing was changed/.test(body.error) && !/UNPRICED|ledger|rate card/.test(body.error));
    check("exhausted ⇒ 429 (time cures it)", allowanceRefusalStatus(exhausted) === 429);
    const unpriced = { ...common, allowed: false as const, reason: "UNPRICED_MODEL" as const, spentUsd: 0.2, allowanceUsd: 5, unpricedInvocations: 1 };
    check("unpriced ⇒ 503 (the service cannot price what it would run; the operator's to fix — the status the chat route gives the chokepoint's refusal) and the sentence says the allowance can't be checked",
      allowanceRefusalStatus(unpriced) === 503 && /can’t be checked/.test(allowanceRefusalBody(unpriced, "The Daily Brief").error));
    const res = allowanceRefusal(exhausted, "Conversations");
    check("allowanceRefusal: a 429 NextResponse, no-store", res !== null && res.status === 429 && res.headers.get("Cache-Control") === "no-store");
    check("…and null when allowed", allowanceRefusal({ ...common, allowed: true, spentUsd: 0, allowanceUsd: 5, remainingUsd: 5 }, "x") === null);
    const json = await res!.json() as Record<string, unknown>;
    check("the response body is the contract", json.code === "AI_ALLOWANCE" && typeof json.error === "string" && json.spentUsd === 5 && json.allowanceUsd === 5);
  }

  console.log("\n5. the routes consume it after their pacing windows and before any model work");
  {
    const chat = strip("app/api/ai/chat/route.ts");
    check("chat: allowance after the hour window, before the body is read and before the turn",
      chat.indexOf("'ai-chat-hour'") < chat.indexOf("dailyAiAllowanceFor(user.id, entitlements)")
      && chat.indexOf("dailyAiAllowanceFor(") < chat.indexOf("req.json()") && chat.indexOf("dailyAiAllowanceFor(") < chat.indexOf("runStatelessTurn("));
    check("chat: the refusal is the shared response, not a sentence of its own", /allowanceRefusal\(allowance, 'Conversations'\)/.test(chat));
    check("chat: the kill switch is judged after the hour window and BEFORE the allowance; the reservation is released in finally",
      chat.indexOf("'ai-chat-hour'") < chat.indexOf("readPaidRequestsAdmission()") && chat.indexOf("readPaidRequestsAdmission()") < chat.indexOf("dailyAiAllowanceFor(")
      // SEC-AI-003 — the turn's clock is disposed in the same finally, before the release.
      && /finally \{\s*deadline\.dispose\(\);\s*await allowance\.release\(\);\s*\}/.test(chat) && /paidRequestsPausedResponse\(\)/.test(chat) && /isAiPausedFailure\(turn\.record\.error\)/.test(chat) && /err instanceof AiPausedError/.test(chat));
    check("chat: an unpriced model thrown by the chokepoint gets its own sentence", /err instanceof UnpricedModelError/.test(chat) && /SAY\.unpriced/.test(chat));
    const brief = strip("app/api/brief/generate/route.ts");
    check("brief: allowance after the 20/min window, before the generation call",
      brief.indexOf("'ai-brief-generate'") < brief.indexOf("dailyAiAllowanceFor(user.id, entitlements)") && brief.indexOf("dailyAiAllowanceFor(") < brief.indexOf("generateBriefResponse("));
    check("brief: the same refusal", /allowanceRefusal\(allowance, 'The Daily Brief'\)/.test(brief));
    check("brief: the kill switch is judged after the pacing window and BEFORE the allowance; the reservation is released in finally",
      brief.indexOf("'ai-brief-generate'") < brief.indexOf("readPaidRequestsAdmission()") && brief.indexOf("readPaidRequestsAdmission()") < brief.indexOf("dailyAiAllowanceFor(")
      && /finally \{\s*await allowance\.release\(\);\s*\}/.test(brief) && /paidRequestsPausedResponse\(\)/.test(brief));
    check("both routes hand the loader the AUTHENTICATED session's id and the entitlements resolved for it, nothing else",
      /dailyAiAllowanceFor\(user\.id, entitlements\)/.test(chat) && /dailyAiAllowanceFor\(user\.id, entitlements\)/.test(brief)
      && /entitlements = await entitlementsForUser\(user\.id\)/.test(chat) && /entitlements = await entitlementsForUser\(user\.id\)/.test(brief));
    const loader = strip("lib/ai/allowance.ts");
    const reader = strip("lib/platform/ai/customer-spend-today.ts");
    check("the loader holds NO database client — it composes the lib/platform reader (AiInvocation is revoked from the tenant role; systemDb stays under lib/platform/)",
      !/@\/lib\/db/.test(loader) && /from "@\/lib\/platform\/ai\/customer-spend-today"/.test(loader) && !/withTenantDb|tenantDb/.test(loader));
    check("the reader runs on fm_system and selects by the given userId only — RETURNED, customer surfaces, since midnight UTC; no email, no other customer",
      /import \{ systemDb \} from "@\/lib\/db"/.test(reader)
      && /where: \{ userId, outcome: "RETURNED", surface: \{ in: \[\.\.\.CUSTOMER_SURFACES\] \}, occurredAt: \{ gte: utcDayStart\(now\) \} \}/.test(reader)
      && !/email/.test(reader));
    const core = strip("lib/ai/allowance-core.ts");
    check("the core is pure: no db, no clock, no React", !/@\/lib\/db|Date\.now\(\)|new Date\(\)|from "react"/.test(core));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}
void main();
