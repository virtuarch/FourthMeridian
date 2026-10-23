/**
 * lib/connections/connection-cap.test.ts  (BETA C7′)
 *
 * The connection-count entitlement: the pure verdict, the resolved limit, the
 * one refusal shape, and where it is (and is not) enforced.
 *
 *   npx tsx lib/connections/connection-cap.test.ts
 */

import { readFileSync } from "node:fs";
import {
  connectionCapVerdict, connectionCapForUser, connectionLimitMessage, connectionLimitResponse, countConnections,
  CONNECTION_LIMIT_CODE, type ConnectionCountClient,
} from "./connection-cap";
import { resolveEffectiveEntitlements } from "@/lib/entitlements/resolve";
import { ENTITLEMENT_DIMENSIONS } from "@/lib/entitlements/catalogue";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const strip = (rel: string) => readFileSync(rel, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

async function main(): Promise<void> {
  console.log("\n1. the pure verdict");
  {
    const v = connectionCapVerdict({ nonRevokedPlaidItems: 6, walletConnections: 3, limit: 10 });
    check("9 of 10 → allowed, UNDER_LIMIT", v.allowed && v.current === 9 && v.limit === 10 && v.reason === "UNDER_LIMIT");
    const at = connectionCapVerdict({ nonRevokedPlaidItems: 7, walletConnections: 3, limit: 10 });
    check("10 of 10 → refused, AT_LIMIT", !at.allowed && at.current === 10 && at.reason === "AT_LIMIT");
    const over = connectionCapVerdict({ nonRevokedPlaidItems: 12, walletConnections: 0, limit: 10 });
    check("12 of 10 (limit lowered after the fact) → refused, OVER_LIMIT, nothing deleted", !over.allowed && over.current === 12 && over.reason === "OVER_LIMIT");
    check("wallets and Items share the one pool", connectionCapVerdict({ nonRevokedPlaidItems: 0, walletConnections: 10, limit: 10 }).allowed === false);
    check("a limit below 1 refuses (fail closed), never allows", !connectionCapVerdict({ nonRevokedPlaidItems: 0, walletConnections: 0, limit: 0 }).allowed);
    check("a non-finite limit refuses", !connectionCapVerdict({ nonRevokedPlaidItems: 0, walletConnections: 0, limit: Number.NaN }).allowed);
    check("negative counts clamp to zero", connectionCapVerdict({ nonRevokedPlaidItems: -1, walletConnections: -1, limit: 1 }).current === 0);
  }

  console.log("\n2. the resolved limit is the effective maxConnections entitlement");
  {
    const beta = resolveEffectiveEntitlements(null);
    const founder = resolveEffectiveEntitlements({ policyGroup: beta.policyGroup, overlay: "FOUNDER_INTERNAL_V1", assignedAt: new Date(), assignedById: null });
    check("BETA policy value is 10", beta.dimensions.maxConnections.value === 10);
    check("founder overlay is 25, at the ceiling", founder.dimensions.maxConnections.value === 25 && ENTITLEMENT_DIMENSIONS.maxConnections.ceiling === 25);
    const counts = async () => ({ nonRevokedPlaidItems: 9, walletConnections: 1 });
    const asBeta = await connectionCapForUser("u1", { counts, entitlements: async () => beta });
    const asFounder = await connectionCapForUser("u1", { counts, entitlements: async () => founder });
    check("10 connections: refused on BETA, allowed on the founder overlay", !asBeta.allowed && asBeta.limit === 10 && asFounder.allowed && asFounder.limit === 25);
  }

  console.log("\n3. the counts ask the right questions of the tenant client");
  {
    const asked: unknown[] = [];
    const client: ConnectionCountClient = {
      plaidItem: { count: async (a) => { asked.push(a.where); return 4; } },
      connection: { count: async (a) => { asked.push(a.where); return 2; } },
    };
    const c = await countConnections(client, "user-1");
    check("4 Items + 2 wallets", c.nonRevokedPlaidItems === 4 && c.walletConnections === 2);
    const j = JSON.stringify(asked);
    check("Plaid: the user's non-REVOKED Items (NEEDS_REAUTH / ERROR still count — they still bill)", /"userId":"user-1","status":\{"not":"REVOKED"\}/.test(j));
    check("wallets: the user's non-REVOKED WALLET Connections with a live AccountConnection (the hub's population)",
      /"provider":"WALLET","status":\{"not":"REVOKED"\},"accountConnections":\{"some":\{"deletedAt":null\}\}/.test(j), j);
  }

  console.log("\n4. the one refusal shape and the customer sentence");
  {
    const v = connectionCapVerdict({ nonRevokedPlaidItems: 10, walletConnections: 0, limit: 10 });
    check("the sentence the Connect button shows", connectionLimitMessage(v).startsWith("Connection limit reached (10 of 10)"));
    const res = connectionLimitResponse(v);
    const body = await res.json();
    check("403", res.status === 403);
    check("{ error, code: CONNECTION_LIMIT, current, limit }",
      body.code === CONNECTION_LIMIT_CODE && body.current === 10 && body.limit === 10 && /Connection limit reached \(10 of 10\)/.test(body.error), JSON.stringify(body));
    check("no-store", res.headers.get("Cache-Control") === "no-store");
  }

  console.log("\n5. [source] enforced on fresh links and new wallets only, before any provider call or write");
  {
    const link = strip("app/api/plaid/link-token/route.ts");
    check("link-token: the cap is checked only when no access token was resolved (fresh link)",
      /if \(!accessToken\) \{\s*const cap = await connectionCapForUser\(user\.id\);\s*if \(!cap\.allowed\) \{[\s\S]*?return connectionLimitResponse\(cap\);/.test(link));
    check("link-token: checked BEFORE linkTokenCreate (a refused session mints no token)",
      link.indexOf("connectionCapForUser(") < link.indexOf("plaidClient.linkTokenCreate("));
    check("link-token: AFTER the rate limit and the auth gate", link.indexOf("limitByUser(") < link.indexOf("connectionCapForUser(") && link.indexOf("requireUser()") < link.indexOf("connectionCapForUser("));
    check("link-token: update-mode paths (plaidItemId / institutionId detection) resolve accessToken before the check",
      link.indexOf("reconnectItemId") < link.indexOf("connectionCapForUser("));
    const wallet = strip("app/api/accounts/wallet/route.ts");
    check("wallet: the cap is checked before the tenant write phase",
      wallet.indexOf("connectionCapForUser(userId)") < wallet.indexOf("const resolved = await withTenantDb("));
    check("wallet: an already-ACTIVE address (a re-share, not a new connection) is never refused",
      /if \(!cap\.allowed\) \{\s*const alreadyActive = await withTenantDb\(userId,[\s\S]*?walletAddress: walletValue, deletedAt: null[\s\S]*?if \(!alreadyActive\) \{[\s\S]*?return connectionLimitResponse\(cap\);/.test(wallet));
    check("wallet: after input validation and the Space context", wallet.indexOf("getSpaceContext()") < wallet.indexOf("connectionCapForUser("));
    const helper = strip("lib/connections/connection-cap.ts");
    check("the helper reads the entitlement through the shared consume seam (entitlementsForUser + countLimit)",
      /entitlementsForUser\(userId, deps\.entitlements\)/.test(helper) && /countLimit\(entitlements, "maxConnections"\)/.test(helper));
    check("…and counts on the tenant role, never systemDb or the global db",
      /withTenantDb\(userId/.test(helper) && !/systemDb|from "@\/lib\/db"(?!\/tenant-context)/.test(helper));
    check("the Connect button renders the 403 body's `error` as-is (no client change needed)",
      /if \(!res\.ok\) throw new Error\(data\.error \?\? "Could not start Plaid Link\."\)/.test(readFileSync("context/PlaidContext.tsx", "utf8")));
  }

  console.log(failures === 0 ? "\n✅ connection cap: pure verdict, entitlement-resolved limit, fresh links and new wallets only.\n" : `\n❌ ${failures} failure(s)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
