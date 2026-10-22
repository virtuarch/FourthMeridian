/** UI-022 follow-up — the admin lists say when the 200-row cap was hit. */
import { readFileSync } from "node:fs";
let f = 0;
const check = (n: string, ok: boolean) => { if (!ok) f++; console.log(`  ${ok ? "✓" : "✗"} ${n}`); };
for (const [page, api] of [["app/admin/users/page.tsx", "app/api/admin/users/route.ts"], ["app/admin/spaces/page.tsx", "app/api/admin/spaces/route.ts"]]) {
  const p = readFileSync(page, "utf8"), a = readFileSync(api, "utf8");
  check(`${api} returns truncated`, /truncated/.test(a) && /NextResponse\.json\(\{[^}]*truncated/.test(a));
  check(`${page} reads truncated from the response`, /setTruncated\(d\.truncated === true\)/.test(p));
  check(`${page} shows the cap hint only when truncated`, /\{truncated && \(\s*<p[^>]*data-truncated-hint>Showing the newest 200/.test(p));
}
if (f) process.exit(1);
console.log("\nall checks passed");
