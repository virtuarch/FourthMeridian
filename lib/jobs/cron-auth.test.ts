/**
 * lib/jobs/cron-auth.test.ts  (SEC-009 adoption)
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/jobs/cron-auth.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { isAuthorizedCronRequest } from "@/lib/jobs/cron-auth";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

check("exact bearer accepted", isAuthorizedCronRequest("Bearer s3cret", "s3cret"));
check("wrong secret refused", !isAuthorizedCronRequest("Bearer s3creT", "s3cret"));
check("length mismatch refused (no throw)", !isAuthorizedCronRequest("Bearer s3cret-and-more", "s3cret"));
check("missing header refused", !isAuthorizedCronRequest(null, "s3cret"));
check("unset secret refuses everything, even 'Bearer '", !isAuthorizedCronRequest("Bearer ", undefined) && !isAuthorizedCronRequest("Bearer ", ""));
// The scheme is required; its case is not (RFC 7235 §2.1 — auth schemes are case-insensitive).
check("scheme is part of the match", !isAuthorizedCronRequest("s3cret", "s3cret") && !isAuthorizedCronRequest("Basic s3cret", "s3cret") && isAuthorizedCronRequest("bearer s3cret", "s3cret"));
check("multi-byte secrets compare by bytes", isAuthorizedCronRequest("Bearer pässwörd", "pässwörd") && !isAuthorizedCronRequest("Bearer passwörd", "pässwörd"));
const helper = readFileSync("lib/jobs/cron-auth.ts", "utf8");
// SEC-009 consolidation: one comparison, the shared fixed-width-digest verifier.
check("helper delegates to the shared timing-safe verifier", /verifyCronAuthorization\(authorizationHeader, secret\) === "AUTHORIZED"/.test(helper)
  && /timingSafeEqual\(a, b\)/.test(readFileSync("lib/security/cron-secret.ts", "utf8")));

const routes = readdirSync("app/api/jobs").map((d) => `app/api/jobs/${d}/route.ts`);
check("six job routes found", routes.length === 6, routes.join());
for (const r of routes) {
  const src = readFileSync(r, "utf8");
  check(`${r}: uses the timing-safe helper and no string compare of the bearer`,
    /isAuthorizedCronRequest\(req\.headers\.get\("authorization"\), process\.env\.CRON_SECRET\)/.test(src) && !/!==\s*`Bearer/.test(src));
}

if (failures > 0) { console.error(`\n❌ cron auth: ${failures} check(s) failed`); process.exit(1); }
console.log("\n✅ cron auth: all checks passed");
