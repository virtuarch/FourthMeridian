/**
 * lib/auth/deactivated-session-refusal.test.ts  (P1 — S2 sweep)
 *
 * Deactivation (user + CS operator) and a deletion request stamp the account
 * (`deactivatedAt`, + `deletionScheduledAt` for deletion) and THEN revoke every
 * session in a separate, non-transactional step. The session proof never read
 * the account state, so a revoke that failed or was partial left the sessions
 * live indefinitely — and a retry hit "already deactivated ⇒ success", which
 * never revoked.
 *
 * Fixed: (1) SESSION_ROW_SELECT reads both timestamps and factsFromRow refuses a
 * locked-out account exactly like a revoked row ("not-live"), within the
 * revocation cache's existing TTL; (2) every "already" branch re-runs the
 * idempotent revocation; (3) reactivation / cancel-deletion clear the lockout in
 * authorize() BEFORE the new session row is minted (pinned).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/auth/deactivated-session-refusal.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { factsFromRow, judgeSession, SESSION_ROW_SELECT } from "./session-proof";
import {
  resolveRevocation, clearAllSessions, _debugSetCheckedAt, SESSION_CACHE_TTL_MS,
} from "@/lib/session-cache";

const checks: string[] = [];
const ok = (l: string) => checks.push(l);
const USER = "cmuser0000000000000000001";
const TOKEN = "0b6f2a4e-5c1d-4f8e-9a7b-000000000001";
const DAY = 86_400_000;
const noTotpAll = async () => false;
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const src = (rel: string) => strip(readFileSync(new URL(rel, import.meta.url), "utf8"));

// The account state as the store holds it; the session row is NEVER revoked here.
const account = { deactivatedAt: null as Date | null, deletionScheduledAt: null as Date | null };
const row = () => ({
  userId: USER, revokedAt: null as Date | null, createdAt: new Date(Date.now() - DAY), lastActiveAt: new Date(Date.now() - 60_000),
  user: { id: USER, role: "USER", totpEnabled: false, ...account },
});
const claims = { userId: USER, sessionToken: TOKEN };
const lookup = () => factsFromRow(row(), noTotpAll);

async function main() {
  // ── the select carries the lockout ─────────────────────────────────────────
  assert.equal(SESSION_ROW_SELECT.user.select.deactivatedAt, true);
  assert.equal(SESSION_ROW_SELECT.user.select.deletionScheduledAt, true);
  // Both proof callers use THAT select (never a narrower copy).
  assert.equal((src("../auth.ts").match(/select: SESSION_ROW_SELECT/g) ?? []).length >= 2, true);
  assert.ok(/select: SESSION_ROW_SELECT/.test(src("../session.ts")));
  ok("SESSION_ROW_SELECT reads deactivatedAt + deletionScheduledAt; every proof lookup uses it");

  // ── a deactivated user with a still-unrevoked session is refused ───────────
  account.deactivatedAt = null; account.deletionScheduledAt = null;
  const liveFacts = await lookup();
  assert.ok(liveFacts && liveFacts.userId === USER, "control: an active account's session is proved");
  account.deactivatedAt = new Date();
  assert.equal(await lookup(), null, "deactivated ⇒ the row proves nothing (revokedAt still null)");
  assert.deepEqual(judgeSession(claims, { valid: false, facts: null, disposition: "MISS" } as never), { kind: "refused", reason: "not-live" },
    "the verdict is the revoked-row verdict");
  // A deletion-scheduled user is refused (either timestamp suffices).
  account.deactivatedAt = null; account.deletionScheduledAt = new Date(Date.now() + 30 * DAY);
  assert.equal(await lookup(), null, "deletion-scheduled ⇒ refused");
  account.deactivatedAt = new Date();
  assert.equal(await lookup(), null, "deletion request (both stamps) ⇒ refused");
  ok("deactivated / deletion-scheduled account with an UNREVOKED session ⇒ refused (not-live)");

  // ── within the existing revocation-cache TTL, never longer ─────────────────
  clearAllSessions();
  account.deactivatedAt = null; account.deletionScheduledAt = null;
  const first = await resolveRevocation(TOKEN, lookup);
  assert.equal(first.valid, true, "a live session is cached");
  account.deactivatedAt = new Date(); // stamped; the revoke FAILED (no cache clear)
  const cached = await resolveRevocation(TOKEN, lookup);
  assert.equal(cached.valid, true, "inside the TTL the cached answer stands — as it does for a revoked row");
  _debugSetCheckedAt(TOKEN, Date.now() - SESSION_CACHE_TTL_MS - 1);
  const after = await resolveRevocation(TOKEN, lookup);
  assert.equal(after.valid, false, "once the TTL lapses the lockout refuses — no longer than a revocation takes");
  assert.equal(judgeSession(claims, after).kind, "refused");
  assert.equal(SESSION_CACHE_TTL_MS, 30_000, "the TTL is unchanged");
  ok("refusal applies within the existing revocation-cache TTL (30 s), not later");

  // ── revoke failure, then retry ⇒ revoked ───────────────────────────────────
  // Each "already" branch now re-runs the idempotent revocation BEFORE it
  // returns success, so a retry after a failed revoke revokes.
  const branch = (file: string, guard: RegExp) => {
    const s = src(file);
    const at = s.search(guard);
    assert.ok(at > -1, `${file}: the "already" branch exists`);
    const body = s.slice(at, s.indexOf("return NextResponse.json", at) + 1);
    assert.ok(/await revokeAllUserSessions\(/.test(body), `${file}: the "already" branch revokes before returning`);
  };
  branch("../../app/api/user/deactivate/route.ts", /if \(dbUser\.deactivatedAt\) \{/);
  branch("../../app/api/user/delete/route.ts", /if \(dbUser\.deletionScheduledAt\) \{/);
  branch("../../app/api/platform/customer-success/customers/[userId]/access/route.ts", /if \(target\.deactivatedAt\) \{/);
  // …and the first attempt still stamps BEFORE it revokes (no window for a fresh login).
  for (const [f, stamp] of [
    ["../../app/api/user/deactivate/route.ts", "data:  { deactivatedAt: new Date() }"],
    ["../../app/api/user/delete/route.ts", "deactivatedAt:       now,"],
    ["../../app/api/platform/customer-success/customers/[userId]/access/route.ts", "data: { deactivatedAt: now }"],
  ] as const) {
    const s = src(f);
    assert.ok(s.indexOf(stamp) > -1 && s.indexOf("revokeAllUserSessions(", s.indexOf(stamp)) > s.indexOf(stamp), `${f}: stamp, then revoke`);
  }
  // Behaviourally: first attempt stamps, revoke throws; the session is already
  // refused by the lockout. The retry's revocation then revokes the row.
  let revokedAt: Date | null = null;
  const revokeAll = async (fail: boolean) => { if (fail) throw new Error("pooler"); revokedAt = new Date(); };
  account.deactivatedAt = null; account.deletionScheduledAt = null;
  const attempt = async (fail: boolean) => {
    if (account.deactivatedAt) { await revokeAll(fail); return "already"; }
    account.deactivatedAt = new Date();
    await revokeAll(fail);
    return "done";
  };
  await assert.rejects(attempt(true));
  assert.equal(revokedAt, null, "the first revoke failed");
  assert.equal(await factsFromRow({ ...row(), revokedAt }, noTotpAll), null, "…yet the unrevoked session is refused");
  assert.equal(await attempt(false), "already");
  assert.ok(revokedAt !== null, "the retry revoked");
  ok("a revoke failure is covered by the lockout, and a retry revokes (all three routes)");

  // ── reactivation lets a fresh login work ───────────────────────────────────
  const auth = src("../auth.ts");
  const mint = auth.indexOf("db.userSession.create(");
  const reactivate = auth.indexOf("data:  { deactivatedAt: null }");
  const cancel = auth.indexOf("data:  { deletionRequestedAt: null, deletionScheduledAt: null, deactivatedAt: null }");
  assert.ok(mint > 0 && reactivate > 0 && cancel > 0);
  assert.ok(reactivate < mint && cancel < mint, "authorize clears the lockout BEFORE the session row is minted");
  account.deactivatedAt = null; account.deletionScheduledAt = null;
  clearAllSessions();
  const fresh = await resolveRevocation("0b6f2a4e-5c1d-4f8e-9a7b-000000000002", lookup);
  assert.equal(judgeSession({ userId: USER, sessionToken: "0b6f2a4e-5c1d-4f8e-9a7b-000000000002" }, fresh).kind, "authenticated",
    "a fresh login after reactivation is proved live");
  ok("reactivation / cancel-deletion clear the lockout before minting; the fresh session authenticates");
}

main().then(() => {
  for (const c of checks) console.log("  ✓ " + c);
  console.log(`deactivated-session-refusal: ${checks.length} checks passed`);
}).catch((e) => { console.error(e); process.exit(1); });
