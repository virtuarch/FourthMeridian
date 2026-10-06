/**
 * lib/possessive.test.ts  (2026-10-07)
 *
 * The product's possessive convention — "Chris'", "James'", "Brandon's",
 * "Alex's" — for strings the product builds (possessive) AND for prose a model
 * wrote (applyPossessiveConvention). Dogfood: Conversations said "Chris's account".
 *
 *   npx tsx lib/possessive.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyPossessiveConvention, possessive } from "./format";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("possessive() — strings the product builds");
for (const [name, want] of [["Chris", "Chris'"], ["James", "James'"], ["Brandon", "Brandon's"], ["Alex", "Alex's"]]) {
  check(`${name} → ${want}`, possessive(name) === want, possessive(name));
}

console.log("applyPossessiveConvention() — prose a model wrote");
const cases: [string, string][] = [
  ["Chris's account is up 4%.", "Chris' account is up 4%."],
  ["James's IRA and Brandon's 401(k)", "James' IRA and Brandon's 401(k)"],
  ["Alex's checking", "Alex's checking"],
  ["Chris’s savings (curly apostrophe)", "Chris’ savings (curly apostrophe)"],
  ["the bus's schedule", "the bus's schedule"],
  ["the US's rates", "the US's rates"],
  ["Chris' account (already right)", "Chris' account (already right)"],
  ["Wells Fargo's fee", "Wells Fargo's fee"],
  ["\"It's\" stays; it's lowercase", "\"It's\" stays; it's lowercase"],
];
for (const [input, want] of cases) {
  const got = applyPossessiveConvention(input);
  check(JSON.stringify(input), got === want, got);
}
check("idempotent", applyPossessiveConvention(applyPossessiveConvention(cases[0][0])) === cases[0][1]);

console.log("Conversations applies it to the answer AND the transcript tail it seals");
{
  const route = readFileSync(join(process.cwd(), "app/api/ai/chat/route.ts"), "utf8");
  check("the chat route normalizes the model's answer once, before it is sealed or returned",
    /const answer = applyPossessiveConvention\(turn\.answer\)/.test(route)
    && /content: answer/.test(route) && /message: answer/.test(route) && !/message: turn\.answer/.test(route));
}

if (failures > 0) { console.error(`\npossessive.test: ${failures} failure(s).`); process.exit(1); }
console.log("\npossessive.test: all passed.");
