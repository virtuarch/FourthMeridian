/**
 * lib/debt/user-terms.test.ts
 *
 * Standalone tsx guard (house convention: exit 0/1).
 *
 *   npx tsx lib/debt/user-terms.test.ts
 *
 * Pins the user-declared debt-facts WRITE PATH end to end without a server:
 *
 *   1. parsing — blank is never 0; out-of-range is refused before any request;
 *   2. persistence — each save hits the ONE existing authority for its fact, with
 *      exactly the field it owns (an APR save can never carry a minimum payment);
 *   3. the write lands where the read authority looks FIRST — a saved APR, fed
 *      through `resolveEffectiveDebtTerms`, IS the effective APR, and that
 *      effective APR moves both the interest cost and the payoff schedule.
 */

import {
  parseAprInput, parseCreditLimitInput, parseCreditScoreInput,
  saveAccountApr, saveAccountCreditLimit, saveCreditScore,
} from "./user-terms";
import { resolveEffectiveDebtTerms } from "./effective-terms";
import { computeInterestCost } from "./interest-cost";
import { planPayoff } from "./payoff";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

type Call = { url: string; method?: string; body: unknown };
function fakeFetch(status: number, json: unknown) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  };
  return { calls, impl };
}

async function main(): Promise<void> {
  console.log("1. APR parsing — unknown is left by typing a number, never by a blank");
  {
    const ok = (raw: string) => { const r = parseAprInput(raw); return r.ok ? r.value : null; };
    check("'24.99' ⇒ 24.99", ok("24.99") === 24.99);
    check("'24.99%' ⇒ 24.99", ok(" 24.99% ") === 24.99);
    check("'0' ⇒ 0 — an explicit zero is a rate", ok("0") === 0);
    check("blank ⇒ REFUSED (not 0)", parseAprInput("").ok === false && parseAprInput("   ").ok === false);
    check("text ⇒ refused", parseAprInput("abc").ok === false && parseAprInput("12abc").ok === false);
    check("negative ⇒ refused", parseAprInput("-3").ok === false);
    check("over 100 ⇒ refused", parseAprInput("100.01").ok === false);
    check("100 ⇒ accepted (the route's own bound)", ok("100") === 100);
  }

  console.log("2. Credit limit + score parsing");
  {
    const lim = parseCreditLimitInput("$5,000");
    check("'$5,000' ⇒ 5000", lim.ok && lim.value === 5000);
    check("0 / blank limit ⇒ refused", !parseCreditLimitInput("0").ok && !parseCreditLimitInput("").ok);
    const sc = parseCreditScoreInput("720");
    check("'720' ⇒ 720", sc.ok && sc.value === 720);
    check("299 / 851 / '7 20' / blank ⇒ refused",
      !parseCreditScoreInput("299").ok && !parseCreditScoreInput("851").ok && !parseCreditScoreInput("7 20").ok && !parseCreditScoreInput("").ok);
  }

  console.log("3. APR persists to the canonical liability authority — and only the APR");
  {
    const f = fakeFetch(200, { ok: true, debtProfile: { apr: 24.99 } });
    const res = await saveAccountApr("acct_1", 24.99, f.impl);
    check("save reports ok", res.ok);
    check("one request", f.calls.length === 1);
    check("PATCH /api/accounts/acct_1/debt-profile", f.calls[0]?.url === "/api/accounts/acct_1/debt-profile" && f.calls[0]?.method === "PATCH", f.calls[0]?.url);
    check("body is exactly { apr } — no minimumPayment, no other field rides along",
      JSON.stringify(f.calls[0]?.body) === JSON.stringify({ apr: 24.99 }), JSON.stringify(f.calls[0]?.body));
  }

  console.log("4. Failure is reported, never swallowed into a fake success");
  {
    const forbidden = await saveAccountApr("acct_2", 10, fakeFetch(403, { error: "Forbidden" }).impl);
    check("403 ⇒ owner-only message", !forbidden.ok && forbidden.error.includes("owner"));
    const bad = await saveAccountApr("acct_2", 10, fakeFetch(400, { error: "Invalid apr — must be 0–100" }).impl);
    check("400 ⇒ the route's own error", !bad.ok && bad.error.includes("0–100"));
    const down = await saveAccountApr("acct_2", 10, async () => { throw new Error("offline"); });
    check("network failure ⇒ error result", !down.ok);
  }

  console.log("5. Credit Health inputs persist through their existing authorities");
  {
    const l = fakeFetch(200, { ok: true });
    await saveAccountCreditLimit("acct_3", 5000, l.impl);
    check("limit ⇒ PATCH /api/accounts/acct_3 { creditLimit }",
      l.calls[0]?.url === "/api/accounts/acct_3" && JSON.stringify(l.calls[0]?.body) === JSON.stringify({ creditLimit: 5000 }));
    const s = fakeFetch(200, { success: true, score: 731, recordedAt: "2026-09-20T10:00:00.000Z" });
    const saved = await saveCreditScore(731, s.impl);
    check("score ⇒ PATCH /api/credit/update-fico { score, source: manual }",
      s.calls[0]?.url === "/api/credit/update-fico" && JSON.stringify(s.calls[0]?.body) === JSON.stringify({ score: 731, source: "manual" }));
    check("returns the row the SERVER recorded", saved.ok && saved.data.score === 731 && saved.data.recordedAt === "2026-09-20T10:00:00.000Z");
  }

  console.log("6. ONE APR PATH — the saved value is the value every calculation reads");
  {
    // What the write changes: DebtProfile.apr. What every reader resolves through:
    const before = resolveEffectiveDebtTerms({ interestRate: null, debtProfile: null });
    check("before: no rate anywhere ⇒ effective APR is null (UNKNOWN)", before.apr === null);
    const after = resolveEffectiveDebtTerms({ interestRate: null, debtProfile: { apr: 24 } });
    check("after the save: effective APR is the saved 24", after.apr === 24);
    const overLegacy = resolveEffectiveDebtTerms({ interestRate: 9.9, debtProfile: { apr: 24 } });
    check("the saved profile APR outranks a stale flat column (no second authority wins)", overLegacy.apr === 24);

    const cost = (apr: number | null) => computeInterestCost([{ id: "a", balance: 1174, aprPct: apr }]);
    check("interest cost: unknown ⇒ no figure", cost(before.apr).rows[0].monthly === null && cost(before.apr).unknownCount === 1);
    check("interest cost: after the save ⇒ 1174 × 24% / 12 = 23.48", Math.abs(cost(after.apr).totalMonthly - 23.48) < 1e-9, `${cost(after.apr).totalMonthly}`);

    const plan = (apr: number | null) => planPayoff({ balance: 1174, aprPct: apr, payment: 500, startISO: "2026-01-01" });
    const est = plan(before.apr);
    check("payoff: unknown ⇒ a PRINCIPAL_ONLY estimate, the APR still null in its basis",
      est.status === "paid_off" && est.basis.interest === "PRINCIPAL_ONLY" && est.liabilities[0].aprPct === null && est.finalPayment === 174);
    check("…and the canonical authority still says UNKNOWN — the estimate wrote nothing", resolveEffectiveDebtTerms({ interestRate: null, debtProfile: null }).apr === null);
    const p = plan(after.apr);
    check("payoff: after the save ⇒ the SAME calculation, now interest-aware",
      p.status === "paid_off" && p.basis.interest === "INTEREST_AWARE" && p.finalPayment === 212.72 && p.payoffISO === "2026-03-15", JSON.stringify(p));
    const p2 = plan(12);
    check("payoff: a different APR ⇒ a different final payment",
      p2.status === "paid_off" && p.status === "paid_off" && p2.finalPayment !== p.finalPayment && p2.finalPayment < p.finalPayment);
  }

  console.log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
