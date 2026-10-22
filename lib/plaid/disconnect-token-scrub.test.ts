/**
 * lib/plaid/disconnect-token-scrub.test.ts  (PRIV-004)
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/plaid/disconnect-token-scrub.test.ts
 */
process.env.ENCRYPTION_KEY ??= "0".repeat(64);
import { encryptWithPurpose, EncryptionPurpose, decryptWithPurpose } from "@/lib/plaid/encryption";
import { disconnectPlaidItemIfOrphaned, REVOKED_TOKEN_SENTINEL, type DisconnectDeps } from "@/lib/plaid/disconnect";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const TOKEN = encryptWithPurpose("access-sandbox-x", EncryptionPurpose.PLAID_ACCESS_TOKEN);
const plaidError = (code: string) => ({ isAxiosError: true, response: { status: 400, data: { error_code: code, error_type: "ITEM_ERROR" } }, message: code });

function world(removal: "ok" | "gone" | "fail") {
  const item = { id: "pi", userId: "u", encryptedToken: TOKEN, status: "ACTIVE" };
  const db = {
    accountConnection: { count: async () => 0 },
    plaidItem: {
      findUnique: async () => ({ ...item }),
      update: async ({ data }: { data: { encryptedToken?: string; status?: string } }) => { Object.assign(item, data); return { ...item }; },
    },
    auditLog: { create: async () => ({}) },
  };
  const deps: DisconnectDeps = {
    db: db as never,
    plaid: { itemRemove: (async () => { if (removal === "fail") throw plaidError("INTERNAL_SERVER_ERROR"); if (removal === "gone") throw plaidError("ITEM_NOT_FOUND"); return {}; }) as never },
    setHealth: (async (_id: string, h: { status: string }) => { item.status = h.status; }) as never,
  };
  return { item, deps };
}

async function main() {
  const e = console.error; console.error = () => {};
  const ok = world("ok"); await disconnectPlaidItemIfOrphaned("pi", ok.deps);
  const gone = world("gone"); await disconnectPlaidItemIfOrphaned("pi", gone.deps);
  const fail = world("fail"); await disconnectPlaidItemIfOrphaned("pi", fail.deps);
  console.error = e;
  check("confirmed removal ⇒ REVOKED and the token scrubbed", ok.item.status === "REVOKED" && ok.item.encryptedToken === REVOKED_TOKEN_SENTINEL);
  check("already-gone (ITEM_NOT_FOUND) ⇒ scrubbed too", gone.item.encryptedToken === REVOKED_TOKEN_SENTINEL);
  check("UNCONFIRMED removal keeps the token for the retry path", fail.item.status === "REVOKED" && fail.item.encryptedToken === TOKEN);
  let threw = false; try { decryptWithPurpose(REVOKED_TOKEN_SENTINEL, EncryptionPurpose.PLAID_ACCESS_TOKEN); } catch { threw = true; }
  check("the sentinel cannot be decrypted into a token", threw);
  if (failures > 0) { console.error(`\n❌ token scrub: ${failures} check(s) failed`); process.exit(1); }
  console.log("\n✅ token scrub: all checks passed");
}
main().catch((err) => { console.error(err); process.exit(1); });
