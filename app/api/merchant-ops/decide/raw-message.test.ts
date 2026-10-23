/** SEC-013 — the decide route never returns a raw exception message except the domain refusal. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
let f = 0;
const check = (n: string, ok: boolean) => { if (!ok) f++; console.log(`  ${ok ? "✓" : "✗"} ${n}`); };
const src = readFileSync(join(process.cwd(), "app/api/merchant-ops/decide/route.ts"), "utf8");
const handler = src.slice(src.indexOf("} catch (e) {"));
check("no generic `e.message` passthrough", !/const message = e instanceof Error \? e\.message/.test(src));
check("only MergeReviewIneligibleError echoes its message", (handler.match(/e\.message/g) ?? []).length === 1
  && /MergeReviewIneligibleError\) return NextResponse\.json\(\{ error: e\.message \}/.test(handler));
check("the 409 carries a fixed sentence", /status: 409/.test(handler) && /could not be applied because the candidate changed/.test(handler));
if (f) process.exit(1);
console.log("\nall checks passed");
