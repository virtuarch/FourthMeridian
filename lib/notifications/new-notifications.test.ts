/**
 * lib/notifications/new-notifications.test.ts  (owner-approved 2026-10-31)
 *
 * The four new notifications and the digest skeleton, BEHAVIOURALLY: real
 * producers, the real chokepoint (createNotification), the real email
 * chokepoint (capture transport) and the real routes, against the in-memory
 * Prisma fake. (Welcome at the routes: app/api/auth/register/route.test.ts §8b
 * and app/api/auth/verify-email/route.test.ts §3b.)
 *
 *   1. welcome — ledger keys on both legs; one-time dedupe
 *   2. bank re-login from the Plaid webhook — through SYNC_FAILED, shared key,
 *      user-removal suppression
 *   3. wallet sync failure — sustained only, Cost Freeze, removal, release
 *   4. Platform access granted / changed / removed — the real admin routes
 *   5. digest — never sent while disabled
 *   6. catalog classification + storm limit for the new keys
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/notifications/new-notifications.test.ts
 */

import "@/lib/test-support/route-env";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";
import { capturedEmails, clearCapturedEmails, captureAdapter } from "@/lib/email/providers/capture";
import type { CommsDeliveryRow } from "@/lib/notifications/delivery/types";

const t = makeChecker("New notifications (2026-10-31)");
const fake = new FakePrisma();
const HOUR = 3_600_000;
const subjects = () => capturedEmails().map((m) => m.subject);

function reset() {
  fake.reset();
  freshCache();
  clearCapturedEmails();
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:])\/\/.*$/gm, "$1");
}
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|json)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

async function main() {
  await installFakePrisma(fake);
  const { createNotification } = await import("@/lib/notifications/create");
  const { createEmailSender } = await import("@/lib/email/send");
  const { sendWelcome } = await import("@/lib/notifications/welcome");
  const { handlePlaidWebhook } = await import("@/lib/plaid/webhook-receiver");
  const { notifyItemSyncFailed } = await import("@/lib/plaid/sync-notifications");
  const { evaluateWalletSyncAttention } = await import("@/lib/crypto/wallet-sync-notifications");
  const { sendDigest, DIGEST_ENABLED } = await import("@/lib/notifications/digest");
  const { COMMS_CATALOG, isStormLimitedKey, EMAIL_TEMPLATE_VERSIONS } = await import("@/lib/notifications/catalog/definitions");
  const { NOTIFICATION_REGISTRY } = await import("@/lib/notifications/registry");
  const { decideStorm, PendingSends } = await import("@/lib/notifications/delivery/storm");
  const { POST: GRANT } = await import("@/app/api/admin/platform-grants/route");
  const { PATCH: REVOKE } = await import("@/app/api/admin/platform-grants/[grantId]/route");

  // ── 1. Welcome — ledger keys + one-time dedupe ─────────────────────────────
  t.section("1. welcome: ledger keys on BOTH legs; a second trigger sends nothing");
  {
    reset();
    const u = fake.seed("User", { email: "w@example.test", username: "w", passwordHash: "x", emailVerifiedAt: new Date() });
    const ledger: CommsDeliveryRow[] = [];
    const writer = async (row: CommsDeliveryRow) => { ledger.push(row); };
    const send = createEmailSender({ env: { NODE_ENV: "test" }, provider: captureAdapter, capture: captureAdapter, ledger: writer });
    const create: typeof createNotification = (input) => createNotification(input, { ledger: writer });
    const first = await sendWelcome({ userId: u.id as string, email: "w@example.test", firstName: "Wren" }, { create, send });
    const inApp = ledger.find((r) => r.channel === "IN_APP");
    const email = ledger.find((r) => r.channel === "EMAIL");
    t.check("first trigger → sent", first === "sent", first);
    t.check("IN_APP leg ACCEPTED under catalog key ACCOUNT_WELCOME", inApp?.definitionKey === "ACCOUNT_WELCOME" && inApp.status === "ACCEPTED", inApp);
    t.check("EMAIL leg recorded under ACCOUNT_WELCOME, for the account, linked to its in-app twin",
      email?.definitionKey === "ACCOUNT_WELCOME" && email.recipientUserId === u.id && email.notificationId === inApp?.notificationId, email);
    t.check("the welcome template version is recorded", email?.templateVersion === EMAIL_TEMPLATE_VERSIONS.welcome);
    const second = await sendWelcome({ userId: u.id as string, email: "w@example.test", firstName: "Wren" }, { create, send });
    t.check("second trigger → duplicate: ledger says IN_APP SUPPRESSED DEDUPE_OPEN, no EMAIL row, one e-mail total",
      second === "duplicate" && ledger.filter((r) => r.channel === "EMAIL").length === 1
        && ledger.some((r) => r.channel === "IN_APP" && r.status === "SUPPRESSED" && r.reason === "DEDUPE_OPEN") && capturedEmails().length === 1);
    // REVIEW FIX (M5) — retirement can never release the one-time key.
    const { retireOpenNotification } = await import("@/lib/notifications/resolve");
    const retired = await retireOpenNotification(u.id as string, "ACCOUNT_WELCOME", {});
    const held = fake.rows("Notification", { userId: u.id, type: "ACCOUNT_WELCOME" });
    t.check("retireOpenNotification(ACCOUNT_WELCOME) is a no-op: 0 retired, the row keeps its :once key, unarchived",
      retired === 0 && held.length === 1 && held[0].dedupeKey === `ACCOUNT_WELCOME:user:${u.id}:once` && held[0].archivedAt === null);
    t.check("…so a later trigger is still a duplicate",
      (await sendWelcome({ userId: u.id as string, email: "w@example.test" }, { create, send })) === "duplicate" && capturedEmails().length === 1);

    // REVIEW FIX — the :once key is freed by retention after 90 d; safe only while nothing can re-trigger.
    const prod = walk("lib").concat(walk("app"), walk("jobs"), walk("scripts"));
    const callers = prod.filter((f) => f !== "lib/notifications/welcome.ts" && /\bsendWelcome\(/.test(stripComments(readFileSync(f, "utf8")))).sort();
    t.check("sendWelcome is called from exactly the register and verify-email routes",
      callers.join() === "app/api/auth/register/route.ts,app/api/auth/verify-email/route.ts", callers);
    t.check("email change never welcomes", !/welcome/i.test(stripComments(readFileSync("app/api/user/email/confirm/route.ts", "utf8"))));
    const resets = prod.filter((f) => /emailVerifiedAt:\s*null/.test(stripComments(readFileSync(f, "utf8"))));
    t.check("nothing resets emailVerifiedAt to null (the verify route welcomes only on null → set)", resets.length === 0, resets);

    // Every preference off: the welcome is locked per type — it still lands.
    reset();
    const v = fake.seed("User", { email: "v@example.test", username: "v", passwordHash: "x", emailVerifiedAt: new Date() });
    for (const category of ["PLATFORM", "FINANCIAL", "SPACES", "AI"]) for (const channel of ["IN_APP", "EMAIL"]) {
      fake.seed("NotificationPreference", { userId: v.id, category, channel, enabled: false });
    }
    t.check("not preference-suppressible: every category × channel OFF still welcomes once",
      (await sendWelcome({ userId: v.id as string, email: "v@example.test" })) === "sent" && capturedEmails().length === 1
        && /Welcome to Fourth Meridian/.test(capturedEmails()[0].subject));
    t.check("…unnamed greeting when there is no first name", /Welcome to Fourth Meridian/.test(capturedEmails()[0].text) && !/Welcome, /.test(capturedEmails()[0].text));
    reset();
    const z = fake.seed("User", { email: "z@example.test", username: "z", passwordHash: "x", emailVerifiedAt: new Date() });
    fake.on("Notification", "create", () => { throw new Error("db down"); }, { once: true });
    t.check("the anchor cannot be written → no e-mail (a retry can never double-send)",
      (await sendWelcome({ userId: z.id as string, email: "z@example.test" })) === "error" && capturedEmails().length === 0);
  }

  // ── 2. Bank re-login from the Plaid webhook ─────────────────────────────────
  t.section("2. Plaid webhook NEEDS_REAUTH / REVOKED → SYNC_FAILED (existing path, shared key, removal rule)");
  {
    reset();
    const u = fake.seed("User", { email: "bank@example.test", username: "bank", passwordHash: "x", emailVerifiedAt: new Date() });
    const mkItem = (ext: string, status = "ACTIVE") => fake.seed("PlaidItem", {
      userId: u.id, externalItemId: ext, institutionId: "ins_1", institutionName: `Bank ${ext}`, encryptedToken: "enc", status,
    });
    const link = (itemId: unknown, removed: boolean) => fake.seed("AccountConnection", {
      financialAccountId: `fa-${String(itemId)}`, plaidItemDbId: itemId, ...(removed ? { deletedAt: new Date() } : {}),
    });
    const reauth = mkItem("ext-reauth"); link(reauth.id, false);
    const removed = mkItem("ext-removed"); link(removed.id, true);
    const revoked = mkItem("ext-revoked"); link(revoked.id, false);
    const dead = mkItem("ext-dead", "REVOKED"); link(dead.id, false);
    const expiring = mkItem("ext-expiring"); link(expiring.id, false);

    const deliver = (body: Record<string, unknown>) => handlePlaidWebhook(JSON.stringify(body), "sig", {
      verify: async () => ({ ok: true }),
      lookupItem: async (ext) => {
        const row = fake.one("PlaidItem", { externalItemId: ext });
        return row ? { id: row.id as string, status: row.status as string, ownerDeactivated: false } : null;
      },
      recordEvent: () => {},
      scheduleSync: () => {},
      environment: () => "test",
      isDuplicate: async () => false,
      log: { log: () => {}, warn: () => {} },
      // applyHealth OMITTED: the production default (lib/plaid/webhook-health.ts) runs.
    });
    const syncFailed = (itemId: unknown) => fake.rows("Notification", { type: "SYNC_FAILED" }).filter((n) => (n.metadata as Record<string, unknown>)?.plaidItemId === itemId);

    const r1 = await deliver({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "ext-reauth", error: { error_code: "ITEM_LOGIN_REQUIRED" } });
    const n1 = syncFailed(reauth.id);
    t.check("ITEM_LOGIN_REQUIRED → item NEEDS_REAUTH, 200 handled", r1.status === 200 && fake.one("PlaidItem", { id: reauth.id })!.status === "NEEDS_REAUTH");
    t.check("…ONE SYNC_FAILED notice, state reauth-required, on the shared open key",
      n1.length === 1 && (n1[0].metadata as Record<string, unknown>).connectionState === "reauth-required"
        && n1[0].dedupeKey === `SYNC_FAILED:item:${reauth.id}:open` && n1[0].userId === u.id, n1);
    t.check("…and ONE e-mail: \"Bank ext-reauth needs you to sign in again\"",
      subjects().filter((s) => s === "Bank ext-reauth needs you to sign in again").length === 1 && capturedEmails().length === 1, subjects());
    await deliver({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "ext-reauth", error: { error_code: "ITEM_LOGIN_REQUIRED" } });
    await notifyItemSyncFailed(reauth.id as string); // the cron observing the same outage
    t.check("a repeat webhook and the cron for the same outage → still one notice, one e-mail (suppress-while-open)",
      syncFailed(reauth.id).length === 1 && capturedEmails().length === 1);

    // REVIEW FIX — escalation while the reauth notice is open: updated in place, no second e-mail.
    await deliver({ webhook_type: "ITEM", webhook_code: "USER_PERMISSION_REVOKED", item_id: "ext-reauth" });
    const esc = syncFailed(reauth.id);
    t.check("NEEDS_REAUTH → REVOKED while open: the SAME notice now says disconnected (state, title, body)",
      esc.length === 1 && (esc[0].metadata as Record<string, unknown>).connectionState === "disconnected"
        && esc[0].title === "Bank ext-reauth is disconnected" && /can no longer sync/.test(String(esc[0].body))
        && esc[0].dedupeKey === `SYNC_FAILED:item:${reauth.id}:open` && esc[0].archivedAt === null, esc.map((r) => r.title));
    t.check("…and NO second e-mail for the escalation (decision: the outage's one e-mail stands)", capturedEmails().length === 1, subjects());
    await notifyItemSyncFailed(reauth.id as string);
    t.check("…a later observation keeps it disconnected (no downgrade, still one row)",
      syncFailed(reauth.id).length === 1 && (syncFailed(reauth.id)[0].metadata as Record<string, unknown>).connectionState === "disconnected");

    // E1 — escalation is ONLY to "disconnected": a NEEDS_REAUTH re-trigger or a plain ERROR while a
    // notice is open never rewrites it.
    const steady = mkItem("ext-steady"); link(steady.id, false);
    await deliver({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "ext-steady", error: { error_code: "ITEM_LOGIN_REQUIRED" } });
    const steadyRow = () => syncFailed(steady.id)[0];
    const steadyTitle = String(steadyRow().title);
    await deliver({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "ext-steady", error: { error_code: "ITEM_LOGIN_REQUIRED" } });
    fake.table("PlaidItem").forEach((r) => { if (r.id === steady.id) r.status = "ERROR"; });
    await notifyItemSyncFailed(steady.id as string); // an ERROR observed by a sync during the open reauth notice
    t.check("NEEDS_REAUTH re-trigger + an ERROR during the open notice → NOT rewritten (still reauth-required, same copy)",
      syncFailed(steady.id).length === 1 && (steadyRow().metadata as Record<string, unknown>).connectionState === "reauth-required"
        && steadyRow().title === steadyTitle, steadyRow().title);

    // E3 — escalation is scoped to the item's OWNER: another user's open notice — even one carrying the
    // same key string — is untouched.
    const other = fake.seed("User", { email: "other@example.test", username: "other", passwordHash: "x", emailVerifiedAt: new Date() });
    const shared = mkItem("ext-shared"); link(shared.id, false);
    await deliver({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "ext-shared", error: { error_code: "ITEM_LOGIN_REQUIRED" } });
    const foreign = fake.seed("Notification", {
      userId: other.id, category: "FINANCIAL", type: "SYNC_FAILED", priority: "HIGH", title: "Other user's notice", body: "untouched",
      dedupeKey: `SYNC_FAILED:item:${shared.id}:open`, metadata: { plaidItemId: shared.id, institutionName: "Other", connectionState: "reauth-required" },
    });
    await deliver({ webhook_type: "ITEM", webhook_code: "USER_PERMISSION_REVOKED", item_id: "ext-shared" });
    const foreignAfter = fake.one("Notification", { id: foreign.id })!;
    const ownerAfter = syncFailed(shared.id).find((r) => r.userId === u.id)!;
    t.check("the owner's notice escalated, another user's notice (same key string) untouched",
      (ownerAfter.metadata as Record<string, unknown>).connectionState === "disconnected"
        && foreignAfter.title === "Other user's notice" && (foreignAfter.metadata as Record<string, unknown>).connectionState === "reauth-required");

    // The removal rule still applies to escalation: reauth notice open, the user removes, then the revoke lands.
    const gone = mkItem("ext-gone"); link(gone.id, false);
    const mailBeforeGone = capturedEmails().length;
    await deliver({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "ext-gone", error: { error_code: "ITEM_LOGIN_REQUIRED" } });
    fake.table("AccountConnection").forEach((r) => { if (r.plaidItemDbId === gone.id) r.deletedAt = new Date(); });
    await deliver({ webhook_type: "ITEM", webhook_code: "USER_PERMISSION_REVOKED", item_id: "ext-gone" });
    t.check("removed by the user mid-outage: the open notice is NOT escalated to 'disconnected', no e-mail",
      syncFailed(gone.id).length === 1 && (syncFailed(gone.id)[0].metadata as Record<string, unknown>).connectionState === "reauth-required"
        && capturedEmails().length === mailBeforeGone + 1, subjects());

    // An email ANCHOR (FINANCIAL in-app off, email on — A-2b) is archived and never re-rendered by an
    // escalation: rewriting its metadata would drop the anchor marker, and the outage would e-mail again
    // once in-app is turned back on.
    const anchored = mkItem("ext-anchor"); link(anchored.id, false);
    const mailBeforeAnchor = capturedEmails().length;
    const pref = fake.seed("NotificationPreference", { userId: u.id, category: "FINANCIAL", channel: "IN_APP", enabled: false });
    await deliver({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "ext-anchor", error: { error_code: "ITEM_LOGIN_REQUIRED" } });
    const before = capturedEmails().length;
    await deliver({ webhook_type: "ITEM", webhook_code: "USER_PERMISSION_REVOKED", item_id: "ext-anchor" });
    fake.table("NotificationPreference").splice(fake.table("NotificationPreference").indexOf(pref), 1);
    await notifyItemSyncFailed(anchored.id as string);
    // E2 — the escalation IS reached with the archived anchor present (the create is suppressed by it),
    // and the anchor stays untouched.
    const { refreshOpenNotification } = await import("@/lib/notifications/resolve");
    const anchorBefore = JSON.stringify(syncFailed(anchored.id)[0]);
    let reached = 0, updated = -1;
    fake.seed("NotificationPreference", { userId: u.id, category: "FINANCIAL", channel: "IN_APP", enabled: false });
    await notifyItemSyncFailed(anchored.id as string, {
      itemClient: (await import("@/lib/db")).systemDb as never,
      refreshFn: async (...a) => { reached++; updated = await refreshOpenNotification(...a); return updated; },
    });
    fake.table("NotificationPreference").splice(0);
    t.check("escalation REACHED with the anchor holding the key (REVOKED item, suppressed create) — and it updates nothing",
      reached === 1 && updated === 0 && JSON.stringify(syncFailed(anchored.id)[0]) === anchorBefore, { reached, updated });
    t.check("an archived email anchor is left alone by the escalation: in-app back on, still no second e-mail",
      syncFailed(anchored.id).length === 1 && capturedEmails().length === before
        && (syncFailed(anchored.id)[0].metadata as Record<string, unknown>).connectionState === "reauth-required", subjects());

    await deliver({ webhook_type: "ITEM", webhook_code: "USER_PERMISSION_REVOKED", item_id: "ext-removed" });
    t.check("the user REMOVED the connection: webhook REVOKED writes the status but notifies NOBODY",
      fake.one("PlaidItem", { id: removed.id })!.status === "REVOKED" && syncFailed(removed.id).length === 0 && capturedEmails().length === mailBeforeAnchor + 1);

    await deliver({ webhook_type: "ITEM", webhook_code: "USER_PERMISSION_REVOKED", item_id: "ext-revoked" });
    const n3 = syncFailed(revoked.id);
    t.check("a PROVIDER-side revocation (connections live) → one notice, state disconnected",
      n3.length === 1 && (n3[0].metadata as Record<string, unknown>).connectionState === "disconnected" && capturedEmails().length === mailBeforeAnchor + 2);

    await deliver({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "ext-dead", error: { error_code: "ITEM_LOGIN_REQUIRED" } });
    t.check("an item already REVOKED is never re-notified", syncFailed(dead.id).length === 0 && fake.one("PlaidItem", { id: dead.id })!.status === "REVOKED");
    await deliver({ webhook_type: "ITEM", webhook_code: "PENDING_EXPIRATION", item_id: "ext-expiring" });
    await deliver({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "ext-expiring", error: { error_code: "INSTITUTION_DOWN" } });
    t.check("PENDING_EXPIRATION and a transient ITEM/ERROR move no state and notify nobody",
      syncFailed(expiring.id).length === 0 && fake.one("PlaidItem", { id: expiring.id })!.status === "ACTIVE" && capturedEmails().length === mailBeforeAnchor + 2);
  }

  // ── 3. Wallet sync failure ──────────────────────────────────────────────────
  t.section("3. wallet sync failure: sustained only, never under Cost Freeze, removal suppressed, recovery releases");
  {
    let runSeq = 0;
    /** One sync attempt in the per-attempt ledger (RefreshExecution), `hoursAgo` before now. */
    const attempt = (fa: Record<string, unknown>, overallStatus: string, hoursAgo: number) => fake.seed("RefreshExecution", {
      runId: `run-${++runSeq}`, trigger: "CRON", profile: "WALLET_SYNC", sourceKind: "WALLET", sourceRef: fa.id, overallStatus,
      startedAt: new Date(Date.now() - hoursAgo * HOUR),
    });
    /**
     * A wallet whose current failure run began `runStartHoursAgo` ago (null: no run on
     * record). The current failed attempt (now) is always in the ledger, as
     * runFullRefresh writes it before syncWalletByChain evaluates.
     */
    function wallet(opts: { runStartHoursAgo?: number | null; errorCode?: string | null; deleted?: boolean } = {}) {
      reset();
      const u = fake.seed("User", { email: "coin@example.test", username: "coin", passwordHash: "x", emailVerifiedAt: new Date() });
      const fa = fake.seed("FinancialAccount", {
        ownerUserId: u.id, name: "Cold BTC", walletChain: "BTC", walletAddress: "bc1qexampleexampleexample", type: "CRYPTO",
        ...(opts.deleted ? { deletedAt: new Date() } : {}),
      });
      const c = fake.seed("Connection", { userId: u.id, provider: "WALLET", errorCode: opts.errorCode === undefined ? "BALANCE_UNAVAILABLE" : opts.errorCode });
      fake.seed("AccountConnection", { financialAccountId: fa.id, connectionId: c.id });
      if (opts.runStartHoursAgo !== null) {
        attempt(fa, "FAILED", opts.runStartHoursAgo ?? 25);
        attempt(fa, "FAILED", 0);
      }
      return { u, fa, c };
    }
    const fail = (fa: Record<string, unknown>, errorCode = "BALANCE_UNAVAILABLE") =>
      evaluateWalletSyncAttention({ accountId: fa.id as string, chain: "BTC", ok: false, errorCode });
    const ok = (fa: Record<string, unknown>) => evaluateWalletSyncAttention({ accountId: fa.id as string, chain: "BTC", ok: true });
    const notices = () => fake.rows("Notification", { type: "WALLET_SYNC_FAILED" });

    let w = wallet({ runStartHoursAgo: 1 });
    t.check("a failure 1 h into an outage (a blip) → NOT_SUSTAINED, nothing written", (await fail(w.fa)) === "NOT_SUSTAINED" && notices().length === 0);
    w = wallet({ runStartHoursAgo: 23.9 });
    t.check("23.9 h → still NOT_SUSTAINED (threshold 24 h)", (await fail(w.fa)) === "NOT_SUSTAINED" && notices().length === 0);
    w = wallet({ runStartHoursAgo: null });
    t.check("no failed attempt on record → no notice (conservative)", (await fail(w.fa)) === "NOT_SUSTAINED" && notices().length === 0);

    // REVIEW FIX — the clock is the run of FAILED ATTEMPTS, not the Connection's DEGRADED period.
    // An xpub with NO_USED_ADDRESSES has been DEGRADED for a week while every sync SUCCEEDED;
    // one timeout now must not be "more than a day" of failure.
    w = wallet({ runStartHoursAgo: null, errorCode: "NO_USED_ADDRESSES" });
    fake.seed("AuditLog", { userId: w.u.id, action: "WALLET_CONNECTION_STATUS_CHANGED",
      metadata: { provider: "WALLET", connectionId: w.c.id, from: "HEALTHY", to: "DEGRADED", errorCode: "NO_USED_ADDRESSES" },
      createdAt: new Date(Date.now() - 7 * 24 * HOUR) });
    attempt(w.fa, "FAILED", 8 * 24);                          // an old, long-closed failure
    for (let d = 6; d >= 1; d--) attempt(w.fa, "SUCCEEDED", d * 24); // a week of successful syncs (HEALTHY_NOOP each)
    attempt(w.fa, "SUCCEEDED", 1);
    attempt(w.fa, "FAILED", 0);                               // the one timeout
    t.check("degraded a week with SUCCESSFUL syncs, then ONE failure → NOT_SUSTAINED (no false 'more than a day')",
      (await fail(w.fa)) === "NOT_SUSTAINED" && notices().length === 0);
    w = wallet({ runStartHoursAgo: null });
    attempt(w.fa, "FAILED", 30); attempt(w.fa, "PARTIAL", 2); attempt(w.fa, "FAILED", 0);
    t.check("a PARTIAL attempt (balance read, a later stage failed) is a success: it resets the run",
      (await fail(w.fa)) === "NOT_SUSTAINED" && notices().length === 0);
    w = wallet({ runStartHoursAgo: null });
    attempt(w.fa, "FAILED", 30); attempt(w.fa, "SKIPPED", 10); attempt(w.fa, "FAILED", 0);
    t.check("a SKIPPED attempt is neither: the 30 h run of failures still notifies",
      (await fail(w.fa)) === "NOTIFIED" && notices().length === 1);
    w = wallet({ runStartHoursAgo: null });
    attempt(w.fa, "SKIPPED", 30); attempt(w.fa, "FAILED", 0);
    t.check("SKIPPED 30 h ago, then ONE failure now → NOT_SUSTAINED (a skip is not a failure)",
      (await fail(w.fa)) === "NOT_SUSTAINED" && notices().length === 0);
    w = wallet({ runStartHoursAgo: null });
    attempt(w.fa, "FAILED", 30); attempt(w.fa, "FAILED", 0); // a gap (no attempts) between them
    t.check("a failure BEFORE a gap and one after, ≥ 24 h apart, no success → qualifies (the gap does not break the run)",
      (await fail(w.fa)) === "NOTIFIED" && notices().length === 1);

    w = wallet({ runStartHoursAgo: 25 });
    const v1 = await fail(w.fa);
    const n = notices();
    t.check("failing ≥ 24 h → ONE notice for the owner, keyed per wallet", v1 === "NOTIFIED" && n.length === 1 && n[0].userId === w.u.id
      && n[0].dedupeKey === `WALLET_SYNC_FAILED:account:${w.fa.id}:open`, n.map((r) => r.dedupeKey));
    const md = n[0].metadata as Record<string, unknown>;
    t.check("…state temporary, network named, account label shown, NO address in the notice",
      md.walletState === "temporary" && md.network === "Bitcoin" && md.walletName === "Cold BTC"
        && !JSON.stringify(n[0]).includes("bc1qexample"), md);
    t.check("…copy: still connected, retrying — never 'disconnected'",
      /still connected/.test(String(n[0].body)) && /keep retrying/.test(String(n[0].body)) && !/disconnect/i.test(`${n[0].title} ${n[0].body}`));
    t.check("…in-app only by default (no e-mail)", capturedEmails().length === 0);
    await fail(w.fa); await fail(w.fa);
    t.check("repeat failures in the same outage → still ONE notice (suppress-while-open)", notices().length === 1);
    fake.table("Connection").forEach((r) => { if (r.id === w.c.id) r.errorCode = "NO_USED_ADDRESSES"; });
    t.check("an ok run that leaves a code (NO_USED_ADDRESSES) is not a recovery: nothing released",
      (await ok(w.fa)) === "HEALTHY_NOOP" && notices()[0].archivedAt === null && notices()[0].dedupeKey !== null);
    fake.table("Connection").forEach((r) => { if (r.id === w.c.id) r.errorCode = null; });
    t.check("a clean success RELEASES it: archived, key freed", (await ok(w.fa)) === "RETIRED"
      && notices()[0].archivedAt instanceof Date && notices()[0].dedupeKey === null);
    fake.table("Connection").forEach((r) => { if (r.id === w.c.id) r.errorCode = "BALANCE_UNAVAILABLE"; });
    fake.table("RefreshExecution").splice(0);
    attempt(w.fa, "SUCCEEDED", 60); attempt(w.fa, "FAILED", 48); attempt(w.fa, "FAILED", 0);
    t.check("…so the NEXT sustained outage notifies again", (await fail(w.fa)) === "NOTIFIED" && notices().length === 2
      && notices().filter((r) => r.archivedAt === null).length === 1);

    w = wallet({ runStartHoursAgo: 25 });
    fake.seed("PlatformSetting", { key: "platform_cost_frozen", value: "true" });
    t.check("under the global Cost Freeze → COST_FROZEN, nothing written", (await fail(w.fa)) === "COST_FROZEN" && notices().length === 0);
    w = wallet({ runStartHoursAgo: 25 });
    fake.on("PlatformSetting", "findUnique", () => { throw new Error("unreadable"); });
    t.check("an UNREADABLE freeze flag counts as frozen (fail closed)", (await fail(w.fa)) === "COST_FROZEN" && notices().length === 0);
    fake.clearHooks();

    w = wallet({ runStartHoursAgo: 25, deleted: true });
    t.check("a wallet the user REMOVED → REMOVED, nothing written", (await fail(w.fa)) === "REMOVED" && notices().length === 0);
    w = wallet({ runStartHoursAgo: 25, errorCode: "PROVIDER_NOT_CONFIGURED" });
    t.check("a platform-side cause (provider not configured) → never notified", (await fail(w.fa, "PROVIDER_NOT_CONFIGURED")) === "NOT_NOTIFIABLE" && notices().length === 0);
    w = wallet({ runStartHoursAgo: 25, errorCode: "INVALID_XPUB" });
    await fail(w.fa, "BALANCE_UNAVAILABLE");
    t.check("BTC INVALID_XPUB on the Connection (the attempt's own code generic) → needs-attention",
      (notices()[0]?.metadata as Record<string, unknown>)?.walletState === "needs-attention");
    w = wallet({ runStartHoursAgo: 25, errorCode: "INVALID_WALLET_ADDRESS" });
    await fail(w.fa, "INVALID_WALLET_ADDRESS");
    t.check("an invalid address → state needs-attention, 'needs attention' copy",
      (notices()[0]?.metadata as Record<string, unknown>)?.walletState === "needs-attention" && /needs attention/.test(String(notices()[0]?.title))
        && !/disconnect/i.test(String(notices()[0]?.body)));

    w = wallet({ runStartHoursAgo: 25 });
    fake.seed("NotificationPreference", { userId: w.u.id, category: "FINANCIAL", channel: "EMAIL", enabled: true });
    fake.seed("NotificationPreference", { userId: w.u.id, category: "FINANCIAL", channel: "IN_APP", enabled: false });
    await fail(w.fa);
    t.check("FINANCIAL email opted in + in-app OFF (O-7 independence) → the e-mail still ships, the row is an archived anchor",
      capturedEmails().length === 1 && /haven't been able to update Cold BTC/.test(capturedEmails()[0].subject) && notices()[0].archivedAt instanceof Date,
      subjects());

    // The hook sits after every freeze / plan gate: only syncWalletByChain calls the evaluator, after the run.
    const dispatch = stripComments(readFileSync("lib/crypto/wallet-sync-dispatch.ts", "utf8"));
    t.check("syncWalletByChain evaluates its outcome AFTER runFullRefresh (one call site)",
      dispatch.indexOf("runFullRefresh<WalletSyncOutcome>(") > 0
        && dispatch.indexOf("evaluateWalletSyncAttention)(outcome)") > dispatch.indexOf("runFullRefresh<WalletSyncOutcome>(")
        && dispatch.split("evaluateWalletSyncAttention)(").length === 2);
    const importers = walk("lib").concat(walk("app"), walk("jobs")).filter((f) => /wallet-sync-notifications"/.test(readFileSync(f, "utf8")));
    t.check("the producer is imported only by the dispatcher", importers.join() === "lib/crypto/wallet-sync-dispatch.ts", importers);
    // Behavioural: a Cost-Frozen sweep never calls syncWalletByChain, so the evaluator (inside it) never runs.
    const { refreshScheduledWallets } = await import("@/lib/crypto/wallet-refresh");
    const { resolveRefreshPolicy } = await import("@/lib/platform/refresh-policy.core");
    let synced = 0;
    const frozen = await refreshScheduledWallets({
      now: new Date(),
      deps: {
        listWallets: async () => [{ accountId: "fa-frozen", chain: "BTC", lastSuccessAt: null, ownerUserId: "owner-1" }],
        billable: async (ids) => new Map(ids.map((id) => [id, { allowed: false as const, reason: "COST_FREEZE" as const }])),
        sync: async () => { synced++; throw new Error("must not sync under a freeze"); },
        policy: async () => resolveRefreshPolicy({ sourceKind: "WALLET" }, null),
        admit: async () => ({ decision: "ADMIT" as const }),
        clock: () => Date.now(),
      },
    });
    t.check("a Cost Freeze SKIP is not a failure: the sweep never syncs, so nothing is evaluated or counted as failed",
      synced === 0 && frozen.planRestricted === 1 && frozen.failed === 0 && notices().length === 1);
  }

  // ── 4. Platform access granted / changed / removed ─────────────────────────
  t.section("4. Platform access: the real grant + revoke routes notify the grantee (in-app + security e-mail)");
  {
    reset();
    const hash = await bcrypt.hash("pw", 4);
    const admin = fake.seed("User", { email: "root-admin@example.test", username: "rootadmin", name: "Root Admin", passwordHash: hash, emailVerifiedAt: new Date(), role: "SYSTEM_ADMIN", totpEnabled: true, totpSecret: "x" });
    const op = fake.seed("User", { email: "op@example.test", username: "op", passwordHash: hash, emailVerifiedAt: new Date() });
    // The strongest mute: ACCOUNT_SECURITY is locked, so even rows written behind the API change nothing.
    fake.seed("NotificationPreference", { userId: op.id, category: "ACCOUNT_SECURITY", channel: "IN_APP", enabled: false });
    const s = await signIn(fake, admin.id as string);
    const grant = (level: string) => invoke(GRANT as never, request("/api/admin/platform-grants", { method: "POST", cookie: s.cookie, body: { userId: op.id, area: "SECURITY_OPS", level } }));
    const revoke = (grantId: string) => invoke(REVOKE as never, request(`/api/admin/platform-grants/${grantId}`, { method: "PATCH", cookie: s.cookie, body: { action: "revoke" } }), { grantId });
    const granted = () => fake.rows("Notification", { userId: op.id, type: "PLATFORM_ACCESS_GRANTED" });
    const revokedRows = () => fake.rows("Notification", { userId: op.id, type: "PLATFORM_ACCESS_REVOKED" });
    const toOp = () => capturedEmails().filter((m) => m.to === "op@example.test");

    const g1 = await grant("READ");
    t.check("create → 200 changed", g1.status === 200 && g1.body.changed === true, g1.body);
    t.check("…ONE in-app notice to the GRANTEE (locked: the ACCOUNT_SECURITY mute is ignored), change granted",
      granted().length === 1 && (granted()[0].metadata as Record<string, unknown>).change === "granted"
        && String(granted()[0].title) === "You were given access to Security Operations" && granted()[0].href === "/dashboard/platform/SECURITY_OPS");
    t.check("…ONE security-alert e-mail to the grantee naming area + level + the grantor's ROLE",
      toOp().length === 1 && /You were given access to Security Operations/.test(toOp()[0].subject)
        && /system administrator/.test(toOp()[0].text) && /read-only/.test(toOp()[0].text) && /\/dashboard\/platform\/SECURITY_OPS/.test(toOp()[0].text));
    t.check("…never the grantor's name, username or address",
      !/Root Admin|rootadmin|root-admin@/.test(toOp()[0].text) && !/Root Admin|rootadmin/.test(`${granted()[0].title} ${granted()[0].body}`));
    t.check("…and the in-app row links the grant's audit row (F5)",
      granted()[0].auditLogId === fake.one("AuditLog", { action: "PLATFORM_GRANT_CREATED" })?.id);
    t.check("the admin is not notified", fake.rows("Notification", { userId: admin.id }).length === 0 && capturedEmails().every((m) => m.to !== "root-admin@example.test"));

    const same = await grant("READ");
    t.check("the same grant again → changed:false, NO notice, NO e-mail", same.body.changed === false && granted().length === 1 && toOp().length === 1);

    await grant("WRITE");
    t.check("level change → one more notice (level_changed) + e-mail 'access changed'",
      granted().length === 2 && granted().some((r) => (r.metadata as Record<string, unknown>).change === "level_changed")
        && toOp().length === 2 && /Your Security Operations access changed/.test(toOp()[1].subject) && /read and write/.test(toOp()[1].text));

    const grantId = fake.one("PlatformGrant", { userId: op.id, area: "SECURITY_OPS" })!.id as string;
    const r1 = await revoke(grantId);
    t.check("revoke → 200, ONE 'removed' notice + e-mail",
      r1.status === 200 && revokedRows().length === 1 && /Your access to Security Operations was removed/.test(String(revokedRows()[0].title))
        && toOp().length === 3 && /was removed/.test(toOp()[2].subject));
    const r2 = await revoke(grantId);
    t.check("revoking a revoked grant → 400, nothing sent", r2.status === 400 && revokedRows().length === 1 && toOp().length === 3);
    await grant("READ");
    t.check("reinstate → a 'granted' notice (change reinstated) + e-mail",
      granted().length === 3 && granted().some((r) => (r.metadata as Record<string, unknown>).change === "reinstated") && toOp().length === 4);
  }

  // ── 5. Digest: never sent while disabled ────────────────────────────────────
  t.section("5. digest: built, OFF — no code path sends it");
  {
    reset();
    let sends = 0;
    const spy = (async () => { sends++; return { status: "sent", provider: "x" }; }) as never;
    const out = await sendDigest({ userId: "u", email: "d@example.test", periodLabel: "Oct 30", items: ["A", "B"] }, { send: spy });
    t.check("DIGEST_ENABLED is false", DIGEST_ENABLED === false);
    t.check("sendDigest → 'disabled', the chokepoint is never called, nothing captured", out === "disabled" && sends === 0 && capturedEmails().length === 0);
    const files = walk("lib").concat(walk("app"), walk("jobs"), walk("scripts"), walk("components"));
    const importers = files.filter((f) => /["']@\/lib\/notifications\/digest["']/.test(readFileSync(f, "utf8")));
    t.check("no production module imports the digest producer (nothing schedules it)", importers.length === 0, importers);
    const digestSends = files.filter((f) => /\bsendEmail\(\s*"digest"/.test(stripComments(readFileSync(f, "utf8"))));
    t.check("the ONLY sendEmail(\"digest\") site is the gated producer", digestSends.join() === "lib/notifications/digest.ts", digestSends);
    t.check("no job or cron names the digest",
      !/digest/i.test(readFileSync("lib/jobs/registry.core.ts", "utf8")) && !/digest/i.test(readFileSync("vercel.json", "utf8")));
    t.check("no DIGEST_SENT notification is produced anywhere",
      files.filter((f) => /type:\s*"DIGEST_SENT"/.test(stripComments(readFileSync(f, "utf8")))).length === 0);
  }

  // ── 6. Catalog classification + storm limit ─────────────────────────────────
  t.section("6. catalog entries + storm classification for the new keys");
  {
    const C = COMMS_CATALOG as Record<string, (typeof COMMS_CATALOG)["SYNC_FAILED"]>;
    const w = C.ACCOUNT_WELCOME, wal = C.WALLET_SYNC_FAILED, pg = C.PLATFORM_ACCESS_GRANTED, pr = C.PLATFORM_ACCESS_REVOKED, dg = C.DIGEST_SENT;
    t.check("ACCOUNT_WELCOME: ENABLED, SERVICE, not user-suppressible, one-time dedupe, IN_APP + DIRECT welcome e-mail",
      w.status === "ENABLED" && w.consentClass === "SERVICE" && !w.preference.userSuppressible
        && w.dedupe.keyTemplate === "ACCOUNT_WELCOME:user:{userId}:once" && NOTIFICATION_REGISTRY.ACCOUNT_WELCOME.dedupeNeverReleases === true
        && w.channels.map((c) => `${c.channel}:${c.path}:${c.template?.id}`).sort().join() === "EMAIL:DIRECT:welcome,IN_APP:REGISTRY:registry:ACCOUNT_WELCOME");
    t.check("WALLET_SYNC_FAILED: ENABLED, SERVICE, FINANCIAL-suppressible, per-wallet open key, email opt-in + independent",
      wal.status === "ENABLED" && wal.consentClass === "SERVICE" && wal.preference.category === "FINANCIAL"
        && wal.dedupe.keyTemplate === "WALLET_SYNC_FAILED:account:{financialAccountId}:open"
        && wal.channels.find((c) => c.channel === "EMAIL")?.defaultOn === false && NOTIFICATION_REGISTRY.WALLET_SYNC_FAILED.emailIndependentOfInApp === true);
    t.check("PLATFORM_ACCESS_GRANTED / _REVOKED: SECURITY_CRITICAL, protected, not editable, no automation, security-alert e-mail",
      [pg, pr].every((d) => d.status === "ENABLED" && d.consentClass === "SECURITY_CRITICAL" && d.protected && !d.editable
        && !d.supportedActions.includes("AUTOMATE") && !d.preference.userSuppressible
        && d.channels.some((c) => c.path === "DIRECT" && c.email?.template === "security-alert")));
    t.check("DIGEST_SENT: BUILD_OFF, every leg default OFF, read-only actions only", dg.status === "BUILD_OFF"
      && dg.channels.every((c) => !c.defaultOn) && !dg.editable && dg.supportedActions.every((a) => a === "PREVIEW" || a === "VIEW_DELIVERY" || a === "LINK_OUT"));
    t.check("template versions exist for welcome and digest", EMAIL_TEMPLATE_VERSIONS.welcome === 1 && EMAIL_TEMPLATE_VERSIONS.digest === 1);

    t.check("storm-LIMITED: ACCOUNT_WELCOME, WALLET_SYNC_FAILED, DIGEST_SENT (SERVICE / AWARENESS)",
      ["ACCOUNT_WELCOME", "WALLET_SYNC_FAILED", "DIGEST_SENT"].every(isStormLimitedKey));
    t.check("storm-EXEMPT: PLATFORM_ACCESS_GRANTED / _REVOKED (SECURITY_CRITICAL)",
      !isStormLimitedKey("PLATFORM_ACCESS_GRANTED") && !isStormLimitedKey("PLATFORM_ACCESS_REVOKED"));
    const now = new Date();
    const held = await decideStorm({ key: "ACCOUNT_WELCOME", recipientUserId: "u1", recipientHash: null, counter: async () => 5, now, pending: new PendingSends() });
    t.check("a welcome to a recipient already at the limit is HELD (RATE_LIMITED)", held.send === false && held.reason === "RATE_LIMITED");
    const ex = await decideStorm({ key: "PLATFORM_ACCESS_GRANTED", recipientUserId: "u1", recipientHash: null, counter: async () => { throw new Error("down"); }, now, pending: new PendingSends() });
    t.check("a Platform access e-mail is EXEMPT: it sends even when the count is unreadable", ex.send === true && ex.exempt === true);
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
