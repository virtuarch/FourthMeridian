/**
 * lib/analytics/product-events.test.ts  (BETA A1–A8)
 *
 * The product-event vocabulary, the writer and every call site, pinned without a
 * database:
 *
 *   1. VOCABULARY — PRODUCT_EVENT_ACTIONS is exactly the five, each a canon
 *      constant; WALLET_ADD / MANUAL_ASSET_ADD are promoted with their old values.
 *   2. DISJOINTNESS — no product event in Security History, the admin security
 *      filter, the admin dropdown groups, the operator feeds, the Platform Ops feed
 *      or the member Space feed.
 *   3. THE WRITER — one statement per event, deduped where the design says so,
 *      no read-back, ids/kinds/day only, null forensics, never throws.
 *   4. CALL SITES — every writer runs server-side, carries only allow-listed
 *      keys, and a regex for the forbidden material fails the build; the Brief
 *      view rule, the prefetch guards and the first-page guard are pinned by
 *      source; the A7 routes no longer write an address.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/analytics/product-events.test.ts
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AuditAction, PRODUCT_EVENT_ACTIONS, USER_SECURITY_HISTORY_ACTIONS, OPERATOR_ACTION_FEED_ACTIONS,
  ADMIN_SECURITY_FILTER_ACTIONS, AUDIT_ACTION_GROUPS,
} from "@/lib/audit-actions";
import { PLATFORM_OPS_FEED_ACTIONS, SECURITY_ONLY_ACTIONS } from "@/lib/platform/activity/operator-feed-core";
import {
  PRODUCT_EVENT_METADATA_KEYS, productEventDay, recordBriefViewed, recordManualAssetValueUpdated,
  recordSpaceViewed, recordTransactionsViewed, walletAddMetadata, manualAssetAddMetadata,
  type ProductEventClient,
} from "@/lib/analytics/product-events";
import { prefetchFromHeaders } from "@/lib/analytics/request-intent";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const FIVE = ["SESSION_ACTIVE_DAY", "SPACE_VIEWED", "BRIEF_VIEWED", "TRANSACTIONS_VIEWED", "MANUAL_ASSET_VALUE_UPDATED"];

async function main() {
  console.log("1. vocabulary");
  {
    check("PRODUCT_EVENT_ACTIONS is exactly the five, in order", JSON.stringify([...PRODUCT_EVENT_ACTIONS]) === JSON.stringify(FIVE));
    check("each is a canon constant whose value is its own name",
      FIVE.every((a) => (AuditAction as Record<string, string>)[a] === a));
    check("WALLET_ADD and MANUAL_ASSET_ADD are promoted with their historical values",
      AuditAction.WALLET_ADD === "WALLET_ADD" && AuditAction.MANUAL_ASSET_ADD === "MANUAL_ASSET_ADD");
    check("…and are NOT product events (their own retention and feeds)",
      !PRODUCT_EVENT_ACTIONS.includes(AuditAction.WALLET_ADD) && !PRODUCT_EVENT_ACTIONS.includes(AuditAction.MANUAL_ASSET_ADD));
    check("the metadata allowlist is the eight keys the design names",
      JSON.stringify([...PRODUCT_EVENT_METADATA_KEYS]) === JSON.stringify(["day", "spaceType", "briefDay", "cached", "accountId", "connectionId", "chain", "currency"]));
  }

  console.log("2. disjointness from every feed and allowlist");
  {
    const lists: [string, readonly string[]][] = [
      ["USER_SECURITY_HISTORY_ACTIONS", USER_SECURITY_HISTORY_ACTIONS],
      ["OPERATOR_ACTION_FEED_ACTIONS", OPERATOR_ACTION_FEED_ACTIONS],
      ["ADMIN_SECURITY_FILTER_ACTIONS", ADMIN_SECURITY_FILTER_ACTIONS],
      ["AUDIT_ACTION_GROUPS", AUDIT_ACTION_GROUPS.flatMap((g) => g.actions)],
      ["PLATFORM_OPS_FEED_ACTIONS", PLATFORM_OPS_FEED_ACTIONS],
      ["SECURITY_ONLY_ACTIONS", SECURITY_ONLY_ACTIONS],
    ];
    for (const [name, list] of lists) {
      const leaked = PRODUCT_EVENT_ACTIONS.filter((a) => list.includes(a));
      check(`${name} admits no product event`, leaked.length === 0, leaked.join(", "));
    }
    const feed = read("app/api/spaces/[id]/activity/route.ts");
    const m = /const ALLOWED_ACTIONS = new Set\(\[([\s\S]*?)\]\);/.exec(feed);
    const allowed = m ? [...m[1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]) : [];
    check("the member Space feed ALLOWED_ACTIONS was found and admits no product event",
      allowed.length > 10 && PRODUCT_EVENT_ACTIONS.every((a) => !allowed.includes(a)), allowed.filter((a) => FIVE.includes(a)).join(", "));
    const securityHistory = strip(read("lib/security-history.ts"));
    check("security history derives from the canon view only (no hand-typed product action)", !FIVE.some((a) => securityHistory.includes(`"${a}"`)));
  }

  console.log("3. the writer");
  {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const fake: ProductEventClient = {
      $executeRaw(q, ...values) { calls.push({ sql: q.join("$?").replace(/\s+/g, " "), values }); return Promise.resolve(1); },
    };
    const now = new Date("2026-10-15T23:59:30Z");
    const ok = await recordSpaceViewed(fake, { userId: "u1", spaceId: "s1", spaceType: "SHARED", now });
    const sv = calls[0];
    check("SPACE_VIEWED: one statement, inserted, resolves true", ok === true && calls.length === 1);
    check("…INSERT … SELECT … WHERE NOT EXISTS on the same client — no read-back, no second statement",
      /INSERT INTO "AuditLog" \("id", "userId", "spaceId", "action", "metadata", "ipAddress", "userAgent"\) SELECT/.test(sv.sql)
      && /WHERE NOT EXISTS \( SELECT 1 FROM "AuditLog" WHERE "userId" = \$\?::text AND "action" = \$\?::text AND "spaceId" IS NOT DISTINCT FROM \$\?::text AND "metadata"->>\(\$\?::text\) = \$\?::text \)/.test(sv.sql)
      && !/;|RETURNING|\bBEGIN\b/i.test(sv.sql), sv.sql);
    check("…forensics are NULL literals, never parameters", /\$\?::jsonb, NULL, NULL/.test(sv.sql));
    const meta = JSON.parse(String(sv.values[4])) as Record<string, unknown>;
    check("…metadata is the envelope plus allow-listed keys only",
      Object.keys(meta).sort().join(",") === "actorType,day,result,spaceType" && meta.actorType === "USER" && meta.result === "SUCCESS");
    check("…the day is the UTC calendar day of `now`, and the dedupe key is 'day'",
      meta.day === "2026-10-15" && sv.values[8] === "day" && sv.values[9] === "2026-10-15");
    check("…spaceType is a kind, and the Space id travels as a column (never a name)", meta.spaceType === "SHARED" && sv.values[2] === "s1" && sv.values[7] === "s1");
    check("…the id is generated client-side (nothing comes back)", typeof sv.values[0] === "string" && /^[0-9a-f-]{36}$/.test(String(sv.values[0])));
    check("productEventDay is the UTC day", productEventDay(new Date("2026-01-01T00:00:00Z")) === "2026-01-01");

    calls.length = 0;
    await recordBriefViewed(fake, { userId: "u1", spaceId: "s1", briefDay: "2026-10-14", cached: true });
    const bv = calls[0];
    const bmeta = JSON.parse(String(bv.values[4])) as Record<string, unknown>;
    check("BRIEF_VIEWED: keyed by the Brief's own day, carries cached, nothing else",
      Object.keys(bmeta).sort().join(",") === "actorType,briefDay,cached,result" && bmeta.briefDay === "2026-10-14" && bmeta.cached === true
      && bv.values[8] === "briefDay" && bv.values[9] === "2026-10-14");

    calls.length = 0;
    await recordTransactionsViewed(fake, { userId: "u1", spaceId: "s1", now });
    const tv = calls[0];
    const tmeta = JSON.parse(String(tv.values[4])) as Record<string, unknown>;
    check("TRANSACTIONS_VIEWED: day only, deduped per Space-day",
      Object.keys(tmeta).sort().join(",") === "actorType,day,result" && tv.values[3] === "TRANSACTIONS_VIEWED" && tv.values[8] === "day");

    calls.length = 0;
    await recordManualAssetValueUpdated(fake, { userId: "u1", accountId: "acct_1" });
    const mv = calls[0];
    const mmeta = JSON.parse(String(mv.values[4])) as Record<string, unknown>;
    check("MANUAL_ASSET_VALUE_UPDATED: every update is a row (no dedupe), account id only, no Space, no value",
      /INSERT INTO "AuditLog" \(.*\) VALUES \(/.test(mv.sql) && !/NOT EXISTS/.test(mv.sql)
      && Object.keys(mmeta).sort().join(",") === "accountId,actorType,result" && mv.values[2] === null);

    const broken: ProductEventClient = { $executeRaw() { return Promise.reject(new Error("permission denied for table AuditLog")); } };
    const warn = console.warn; const warned: string[] = [];
    console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
    const r = await recordSpaceViewed(broken, { userId: "u1", spaceId: "s1", spaceType: "PERSONAL" });
    console.warn = warn;
    check("a refused insert never throws into the request path: resolves false and logs the class",
      r === false && warned.length === 1 && /SPACE_VIEWED not recorded/.test(warned[0]));

    const zero: ProductEventClient = { $executeRaw() { return Promise.resolve(0); } };
    check("a deduped repeat resolves false (0 rows)", (await recordSpaceViewed(zero, { userId: "u1", spaceId: "s1", spaceType: "PERSONAL" })) === false);

    check("the normalised lifecycle metadata helpers emit exactly their two keys",
      JSON.stringify(walletAddMetadata({ connectionId: "c1", chain: "BTC" })) === '{"connectionId":"c1","chain":"BTC"}'
      && JSON.stringify(manualAssetAddMetadata({ accountId: "a1", currency: "USD" })) === '{"accountId":"a1","currency":"USD"}');
  }

  console.log("4. call sites");
  {
    const tracked = execSync("git ls-files -- '*.ts' '*.tsx'", { cwd: ROOT, encoding: "utf8" }).trim().split("\n");
    const importers = tracked.filter((f) => !f.endsWith(".test.ts") && /from ["']@\/lib\/analytics\/product-events["']/.test(read(f)));
    check("writers are imported by server code only (no components/, no jobs/, no client module)",
      importers.length > 0 && importers.every((f) => !f.startsWith("components/") && !f.startsWith("jobs/") && !/^\s*["']use client["']/m.test(read(f))),
      importers.join(", "));
    const EXPECTED = [
      "app/(shell)/dashboard/page.tsx", "app/(shell)/dashboard/brief/page.tsx", "app/api/brief/route.ts",
      "app/api/spaces/[id]/transactions/query/route.ts", "app/api/accounts/wallet/route.ts", "app/api/accounts/manual/route.ts",
    ];
    check("the call sites are exactly the ones the design names", JSON.stringify([...importers].sort()) === JSON.stringify([...EXPECTED].sort()),
      importers.join(", "));

    // Every argument literal handed to a record* helper carries only parameter names, and none of the forbidden words.
    const FORBIDDEN = /\b(email|name|balance|amount|address|description|prompt|value|token|institution)\b/i;
    const PARAMS = new Set(["userId", "spaceId", "spaceType", "briefDay", "cached", "accountId", "now"]);
    for (const f of importers) {
      const src = strip(read(f));
      for (const m of src.matchAll(/record(?:SpaceViewed|BriefViewed|TransactionsViewed|ManualAssetValueUpdated)\(\s*\w+\s*,\s*(\{[^}]*\})/g)) {
        const literal = m[1];
        const keys = [...literal.matchAll(/(\w+)\s*:/g)].map((k) => k[1]);
        check(`${f}: call literal carries parameters only (${keys.join(", ")})`, keys.length > 0 && keys.every((k) => PARAMS.has(k)));
        check(`${f}: call literal has no forbidden word`, !FORBIDDEN.test(literal.replace(/[a-z]+\.[a-zA-Z.!]+/g, "")), literal);
      }
    }

    const wallet = strip(read("app/api/accounts/wallet/route.ts"));
    const walletBlock = /action:\s*AuditAction\.WALLET_ADD,\s*metadata:\s*([^\n]+)/.exec(wallet)?.[1] ?? "";
    check("WALLET_ADD writes the enum and the normalised metadata (connectionId, chain) — no address, no name",
      /walletAddMetadata\(\{ connectionId: walletConnectionId, chain \}\)/.test(walletBlock) && !/action:\s*"WALLET_ADD"/.test(wallet));
    const manual = strip(read("app/api/accounts/manual/route.ts"));
    const manualBlock = /action:\s*AuditAction\.MANUAL_ASSET_ADD,\s*metadata:\s*([^\n]+)/.exec(manual)?.[1] ?? "";
    check("MANUAL_ASSET_ADD writes the enum and the normalised metadata (accountId, currency) — no name, balance or price",
      /manualAssetAddMetadata\(\{ accountId: fa\.id, currency: fa\.currency \}\)/.test(manualBlock) && !/action:\s*"MANUAL_ASSET_ADD"/.test(manual));
    for (const f of ["app/api/accounts/wallet/route.ts", "app/api/accounts/manual/route.ts"]) {
      const src = strip(read(f));
      const blocks = [...src.matchAll(/action:\s*AuditAction\.(?:WALLET_ADD|MANUAL_ASSET_ADD),\s*metadata:\s*[^\n]+/g)].map((m) => m[0]);
      check(`${f}: the normalised block names no forbidden material`, blocks.length === 1 && !/\b(name|balance|amount|address|purchasePrice|purchaseDate|description)\b/.test(blocks[0]));
    }

    console.log("4b. A7 — no raw address in audit metadata");
    for (const f of ["app/api/auth/register/route.ts", "app/api/auth/verify-email/route.ts", "app/api/access-request/route.ts"]) {
      const src = strip(read(f));
      const metas = [...src.matchAll(/metadata:\s*\{([^}]*)\}/g)].map((m) => m[1]);
      check(`${f}: every audit metadata literal references the address by digest only`,
        metas.length > 0 && metas.every((m) => !/\bemail\s*:/.test(m)) && /auditEmailHash\(/.test(src), metas.join(" | "));
    }

    console.log("4c. the view rules");
    const brief = strip(read("app/api/brief/route.ts"));
    check("GET /api/brief records a view iff the response carries a Brief, keyed by that Brief's day, as the user",
      /const shown = result\.body\.brief;\s*if \(shown\) \{\s*await withTenantDb\(user\.id, \(tx\) =>\s*recordBriefViewed\(tx, \{ userId: user\.id, spaceId, briefDay: shown\.briefDay, cached: true \}\)\);/.test(brief));
    check("…and the view is written after the 403 refusal, so a refused Space is never a view",
      brief.indexOf("status: 403") < brief.indexOf("recordBriefViewed(tx"));
    const briefPage = strip(read("app/(shell)/dashboard/brief/page.tsx"));
    check("the Brief page records its server-rendered first state only when it carries a Brief and is not a router prefetch",
      /if \(initial\?\.brief && !\(await isRouterPrefetch\(\)\)\)/.test(briefPage) && /recordBriefViewed\(tx, \{ userId: ctx\.userId, spaceId: ctx\.spaceId, briefDay: initial\.brief!\.briefDay, cached: true \}\)/.test(briefPage));
    const dash = strip(read("app/(shell)/dashboard/page.tsx"));
    check("the Space page records SPACE_VIEWED with the Space's kind, after the composition, never on a router prefetch",
      /if \(!\(await isRouterPrefetch\(\)\)\) \{\s*await withTenantDb\(ctx\.userId, \(tx\) =>\s*recordSpaceViewed\(tx, \{ userId: ctx\.userId, spaceId: ctx\.spaceId, spaceType: ctx\.space\.type \}\)\);/.test(dash)
      && dash.indexOf("composeFinancialInitialWorkspace(") < dash.indexOf("recordSpaceViewed("));
    const platform = strip(read("app/(shell)/dashboard/platform/[area]/page.tsx"));
    check("the Platform Space page writes no product event", !/product-events|recordSpaceViewed/.test(platform));
    const tx = strip(read("app/api/spaces/[id]/transactions/query/route.ts"));
    check("the Transactions query route records only a FIRST page, in its own tenant phase after the read",
      /if \(isFirstPage\) \{\s*await withTenantDb\(ctx\.user\.id, \(tx\) => recordTransactionsViewed\(tx, \{ userId: ctx\.user\.id, spaceId \}\)\);/.test(tx)
      && tx.indexOf("queryTransactions(tx") < tx.indexOf("recordTransactionsViewed("));
    const list = strip(read("app/api/spaces/[id]/transactions/route.ts"));
    check("the analytical /transactions feed (Cash Flow etc.) is not a view", !/product-events/.test(list));

    console.log("4d. prefetch detection");
    check("Next-Router-Prefetch: 1 is a prefetch", prefetchFromHeaders((n) => (n === "next-router-prefetch" ? "1" : null)));
    check("Sec-Purpose: prefetch is a prefetch", prefetchFromHeaders((n) => (n === "sec-purpose" ? "prefetch" : null)));
    check("a plain navigation (RSC: 1 only) is a person", !prefetchFromHeaders((n) => (n === "rsc" ? "1" : null)));
  }

  if (failures > 0) { console.error(`\nproduct-events.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nproduct-events.test: all passed.");
}

void main();
