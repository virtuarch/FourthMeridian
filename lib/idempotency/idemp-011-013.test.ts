/**
 * IDEMP-011 / IDEMP-013 — read-then-write races become conditional writes or 409s.
 * Route handlers import server-only + Prisma at module load, so these are source
 * pins on the exact shapes (the house pattern for routes without a seam).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
let f = 0;
const check = (n: string, ok: boolean) => { if (!ok) f++; console.log(`  ${ok ? "✓" : "✗"} ${n}`); };
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const approve = src("app/api/platform/growth-revenue/requests/[id]/approve/route.ts");
check("approve writes conditionally: only PENDING/DENIED → APPROVED (never REDEEMED, never re-approve) [IDEMP-011, I4]",
  /updateMany\(\{\s*where: \{ id, status: \{ in: \[BetaAccessRequestStatus\.PENDING, BetaAccessRequestStatus\.DENIED\] \} \}/.test(approve));
check("…a lost race sends nothing: APPROVED → alreadyApproved, otherwise 409", /if \(count !== 1\)[\s\S]{0,400}alreadyApproved: true[\s\S]{0,200}status: 409/.test(approve));
check("approve no longer uses an unconditional update", !/betaAccessRequest\.update\(/.test(approve));

const reset = src("app/api/auth/reset-password/route.ts");
check("reset consumes the token conditionally", /updateMany\(\{\s*where: \{ id: user\.id, passwordResetToken: hashResetToken\(token\) \}/.test(reset));
check("…a second consumer gets the invalid/expired answer", /consumed\.count !== 1[\s\S]{0,200}invalid or has expired/.test(reset));

const register = src("app/api/auth/register/route.ts");
check("register maps a unique race (P2002) to 409", /err\.code === "P2002"\)[\s\S]{0,160}status: 409/.test(register));

const share = src("app/api/spaces/[id]/accounts/share/route.ts");
check("share maps the lost HOME race (P2002) to 409", /err\.code === "P2002"\)[\s\S]{0,200}status: 409/.test(share));
check("…and rethrows anything else", /status: 409[\s\S]{0,40}\}\s*throw err;/.test(share));

if (f) process.exit(1);
console.log("\nall checks passed");
