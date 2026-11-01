/**
 * lib/platform/growth/beta-blocklist-core.test.ts  (owner P2-1 · pure rules)
 *
 * The canonical mailbox (collisions AND non-collisions), the versioned keyring
 * (missing, short, malformed, rotation), the Production test, the correction /
 * retention bounds, and how a block fact enters every issuance plan and the
 * bulk eligibility (precedence: SUSPECTED_ABUSE, then IDENTIFIER_BLOCKED).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/growth/beta-blocklist-core.test.ts
 */

import {
  BLOCKLIST_MAX_DAYS, BLOCKLIST_RETENTION_DAYS, EVIDENCE_MAX_RETAIN_DAYS,
  blockExpiryFor, blocklistHmac, blocklistMailbox, blocklistMode, checkCorrectedExpiry, checkRetainUntil, hmacPrefix,
  identifierPairs, isProductionEnv, resolveBlocklistKeys, mailboxLockKey } from "./beta-blocklist-core";
import { planApprove, planDirect, planReissue, type InviteRowFacts } from "./invitation-issue.core";
import { approvalEligibility } from "./bulk-approve.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const DAY = 86_400_000;
const K1 = "k".repeat(32);
const K2 = "z".repeat(40);

console.log("1. blocklistMailbox — conservative canonical mailbox");
{
  const same = (a: string, b: string) => blocklistMailbox(a) === blocklistMailbox(b);
  check("COLLISION: J.O.E+x@googlemail.com ≡ joe@gmail.com (dots + tag folded, domain folded)", same("J.O.E+x@googlemail.com", "joe@gmail.com"), blocklistMailbox("J.O.E+x@googlemail.com"));
  check("COLLISION: j.o.e+x@googlemail.com ≡ joe@gmail.com", same("j.o.e+x@googlemail.com", "joe@gmail.com"));
  check("the advisory-lock key is per MAILBOX (aliases share it) and never contains the address",
    mailboxLockKey("J.O.E+x@googlemail.com") === mailboxLockKey("joe@gmail.com") && mailboxLockKey("joe@gmail.com") !== mailboxLockKey("joe1@gmail.com")
    && !mailboxLockKey("joe@gmail.com").includes("joe"));
  check("COLLISION: a fully-qualified trailing dot (joe@gmail.com.) is the same mailbox", same("joe@gmail.com.", "joe@gmail.com") && same("a+b@outlook.com.", "a@outlook.com"));
  check("COLLISION: a+b@outlook.com ≡ a@outlook.com (listed provider: tag folded)", same("a+b@outlook.com", "a@outlook.com"));
  for (const d of ["hotmail.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "fastmail.com", "proton.me", "protonmail.com", "pm.me"]) {
    check(`COLLISION: tag folded on ${d}`, same(`x+tag@${d}`, `x@${d}`));
  }
  check("NON-COLLISION: listed providers keep dots (j.doe@outlook.com ≠ jdoe@outlook.com)", !same("j.doe@outlook.com", "jdoe@outlook.com"));
  check("NON-COLLISION: j.doe@example.com ≠ jdoe@example.com (dots significant elsewhere)", !same("j.doe@example.com", "jdoe@example.com"));
  check("NON-COLLISION: a+b@example.com ≠ a@example.com (+ significant elsewhere)", !same("a+b@example.com", "a@example.com"));
  check("case and whitespace never matter", same("  Someone@Example.COM ", "someone@example.com"));
  check("gmail dots folded without a tag", same("j.o.e@gmail.com", "joe@gmail.com"));
  check("a leading + is not treated as a tag (no empty local part)", blocklistMailbox("+x@gmail.com") === "+x@gmail.com");
  check("not stricter than needed: a different gmail mailbox is different", !same("joe1@gmail.com", "joe@gmail.com"));
}

console.log("\n2. keyring — dedicated, versioned, ≥ 32 characters, never another secret");
{
  const none = resolveBlocklistKeys({ NEXTAUTH_SECRET: "x".repeat(64), ENCRYPTION_KEY: "a".repeat(64), BETA_INTAKE_HASH_KEY_V1: K1 });
  check("unset → no current key, a named problem, and NO fallback to other secrets", none.current === null && none.all.length === 0 && /BETA_BLOCKLIST_HMAC_KEY_V1 is not set/.test(none.problem ?? ""), none.problem);
  const short = resolveBlocklistKeys({ BETA_BLOCKLIST_HMAC_KEY_V1: "k".repeat(31) });
  check("a key shorter than 32 characters is rejected", short.current === null && short.all.length === 0 && /shorter than 32/.test(short.problem ?? ""), short.problem);
  const bad = resolveBlocklistKeys({ BETA_BLOCKLIST_HMAC_KEY_VERSION: "latest", BETA_BLOCKLIST_HMAC_KEY_V1: K1 });
  check("a malformed version → no write key", bad.current === null && /not v1, v2/.test(bad.problem ?? ""), bad.problem);
  const ok = resolveBlocklistKeys({ BETA_BLOCKLIST_HMAC_KEY_V1: K1 });
  check("V1 set → current v1 (the default version)", ok.current?.version === "v1" && ok.current.key.equals(Buffer.from(K1)) && ok.problem === null);
  const rot = resolveBlocklistKeys({ BETA_BLOCKLIST_HMAC_KEY_VERSION: "v2", BETA_BLOCKLIST_HMAC_KEY_V1: K1, BETA_BLOCKLIST_HMAC_KEY_V2: K2 });
  check("rotation: VERSION=v2 writes with v2 and still LOOKS UP v1 (current first)", rot.current?.version === "v2" && rot.all.map((k) => k.version).join() === "v2,v1", rot.all.map((k) => k.version));
  const v2missing = resolveBlocklistKeys({ BETA_BLOCKLIST_HMAC_KEY_VERSION: "v2", BETA_BLOCKLIST_HMAC_KEY_V1: K1 });
  check("VERSION=v2 without _V2 → no write key (lookups could still see v1, writes cannot)", v2missing.current === null && v2missing.all.length === 1, v2missing);
  const pairs = identifierPairs("J.O.E+x@googlemail.com", rot.all);
  check("identifierPairs: one (hmac, version) per configured version, of the CANONICAL mailbox",
    pairs.length === 2 && pairs[0].identifierHmac === blocklistHmac("joe@gmail.com", Buffer.from(K2)) && pairs[1].identifierHmac === blocklistHmac("joe@gmail.com", Buffer.from(K1)));
  check("the HMAC is keyed (another key → another value) and 64 hex", /^[0-9a-f]{64}$/.test(pairs[0].identifierHmac) && pairs[0].identifierHmac !== pairs[1].identifierHmac);
  check("hmacPrefix is 8 hex characters", hmacPrefix(pairs[0].identifierHmac).length === 8);
}

console.log("\n3. Production = VERCEL_ENV === production (an env object, per call)");
{
  check("VERCEL_ENV=production → Production", isProductionEnv({ VERCEL_ENV: "production" }));
  check("preview / unset / NODE_ENV=production alone → not Production",
    !isProductionEnv({ VERCEL_ENV: "preview" }) && !isProductionEnv({}) && !isProductionEnv({ NODE_ENV: "production" }));
  check("no key in Production → UNAVAILABLE (fail closed)", blocklistMode({ VERCEL_ENV: "production" }).mode === "UNAVAILABLE");
  check("short key in Production → UNAVAILABLE", blocklistMode({ VERCEL_ENV: "production", BETA_BLOCKLIST_HMAC_KEY_V1: "short" }).mode === "UNAVAILABLE");
  check("no key outside Production → SKIP", blocklistMode({ VERCEL_ENV: "preview" }).mode === "SKIP" && blocklistMode({}).mode === "SKIP");
  check("a usable key → ENFORCE everywhere", blocklistMode({ VERCEL_ENV: "production", BETA_BLOCKLIST_HMAC_KEY_V1: K1 }).mode === "ENFORCE" && blocklistMode({ BETA_BLOCKLIST_HMAC_KEY_V1: K1 }).mode === "ENFORCE");
}

console.log("\n4. bounds — block expiry, correction, evidence retainUntil");
{
  const created = new Date("2026-11-01T00:00:00Z");
  const now = new Date("2026-12-01T00:00:00Z");
  check("default expiry = createdAt + 730 days", blockExpiryFor(created).getTime() === created.getTime() + BLOCKLIST_RETENTION_DAYS * DAY && BLOCKLIST_RETENTION_DAYS === 730);
  const iso = (ms: number) => new Date(ms).toISOString();
  check("correction below now + 1 day is refused", !checkCorrectedExpiry(iso(now.getTime() + DAY - 1), created, now).ok);
  check("correction at exactly now + 1 day is allowed", checkCorrectedExpiry(iso(now.getTime() + DAY), created, now).ok);
  check("correction at exactly createdAt + 1095 days is allowed", checkCorrectedExpiry(iso(created.getTime() + BLOCKLIST_MAX_DAYS * DAY), created, now).ok && BLOCKLIST_MAX_DAYS === 1095);
  check("correction past createdAt + 1095 days is refused (never clamped)", !checkCorrectedExpiry(iso(created.getTime() + BLOCKLIST_MAX_DAYS * DAY + 1), created, now).ok);
  check("junk expiry refused", !checkCorrectedExpiry("tomorrow", created, now).ok && !checkCorrectedExpiry(undefined, created, now).ok);
  check("retainUntil is required", !checkRetainUntil(undefined, now).ok && !checkRetainUntil("", now).ok);
  check("retainUntil in the past refused", !checkRetainUntil(iso(now.getTime() - 1), now).ok);
  check("retainUntil at capture + 3 years allowed, one ms more refused",
    checkRetainUntil(iso(now.getTime() + EVIDENCE_MAX_RETAIN_DAYS * DAY), now).ok && !checkRetainUntil(iso(now.getTime() + EVIDENCE_MAX_RETAIN_DAYS * DAY + 1), now).ok);
}

console.log("\n5. issuance plans read the block fact (precedence: SUSPECTED_ABUSE, then IDENTIFIER_BLOCKED)");
{
  const now = new Date("2026-11-01T00:00:00Z");
  const row = (over: Partial<InviteRowFacts> = {}): InviteRowFacts => ({
    id: "r1", email: "a@example.com", status: "PENDING", inviteTokenHash: null, inviteExpiresAt: null, ...over,
  });
  const code = (p: ReturnType<typeof planApprove>) => (p.action === "refuse" ? p.refusal.code : p.action);
  check("approve: PENDING + BLOCKED → IDENTIFIER_BLOCKED (409)", code(planApprove(row({ block: "BLOCKED" }), false)) === "IDENTIFIER_BLOCKED");
  check("approve: PENDING + UNAVAILABLE → BLOCKLIST_UNAVAILABLE", code(planApprove(row({ block: "UNAVAILABLE" }), false)) === "BLOCKLIST_UNAVAILABLE");
  check("approve: CLEAR / absent → approve", code(planApprove(row({ block: "CLEAR" }), false)) === "approve" && code(planApprove(row(), false)) === "approve");
  check("approve: SUSPECTED_ABUSE outranks IDENTIFIER_BLOCKED", code(planApprove(row({ status: "DENIED", suspectedAbuse: true, block: "BLOCKED" }), false)) === "SUSPECTED_ABUSE");
  check("approve: IDENTIFIER_BLOCKED outranks ACCOUNT_EXISTS and STATUS_CHANGED",
    code(planApprove(row({ block: "BLOCKED" }), true)) === "IDENTIFIER_BLOCKED" && code(planApprove(row({ status: "DENIED", block: "BLOCKED" }), false, "PENDING")) === "IDENTIFIER_BLOCKED");
  check("approve: an APPROVED row stays alreadyApproved (nothing minted)", code(planApprove(row({ status: "APPROVED", block: "BLOCKED" }), false)) === "alreadyApproved");
  check("reissue: a blocked APPROVED alias gets no new token", code(planReissue(row({ status: "APPROVED", inviteTokenHash: "h", block: "BLOCKED" }), false)) === "IDENTIFIER_BLOCKED");
  check("direct: no row + blocked address → IDENTIFIER_BLOCKED (never create)", code(planDirect(null, false, now, "BLOCKED")) === "IDENTIFIER_BLOCKED");
  check("direct: no row + UNAVAILABLE → BLOCKLIST_UNAVAILABLE", code(planDirect(null, false, now, "UNAVAILABLE")) === "BLOCKLIST_UNAVAILABLE");
  check("direct: DENIED + suspected abuse + blocked → SUSPECTED_ABUSE first", code(planDirect(row({ status: "DENIED", suspectedAbuse: true, block: "BLOCKED" }), false, now, "BLOCKED")) === "SUSPECTED_ABUSE");
  check("direct: PENDING + blocked → IDENTIFIER_BLOCKED (not approved)", code(planDirect(row({ block: "BLOCKED" }), false, now, "BLOCKED")) === "IDENTIFIER_BLOCKED");
  check("direct: clear address → create", code(planDirect(null, false, now, "CLEAR")) === "create" && code(planDirect(null, false, now)) === "create");
  const e = approvalEligibility(row({ block: "BLOCKED" }), false);
  const u = approvalEligibility(row({ block: "UNAVAILABLE" }), false);
  check("bulk eligibility: blocked → ineligible IDENTIFIER_BLOCKED; unavailable → BLOCKLIST_UNAVAILABLE",
    !e.approvable && e.code === "IDENTIFIER_BLOCKED" && !u.approvable && u.code === "BLOCKLIST_UNAVAILABLE", [e, u]);
}

if (failures > 0) { console.error(`\n❌ beta-blocklist-core: ${failures} check(s) failed`); process.exit(1); }
console.log("\n✅ beta-blocklist-core: all checks passed");
