/**
 * lib/platform/connections/removal-race.test.ts  (PB-5 — S2: in-flight removal vs. the scheduled retry)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/connections/removal-race.test.ts
 *
 * A PRE_PROVIDER marker reads OWED, so the daily plaid-removal-retry could pick
 * up an item whose operator removal is still running. Two guarantees:
 *
 *   (a) PRIMARY — a grace window. An owed item whose newest marker is a
 *       PRE_PROVIDER marker younger than PRE_PROVIDER_GRACE_MS is IN PROGRESS:
 *       the retry job skips it, the operator Retry POST refuses it
 *       (IN_PROGRESS), both UIs hide Retry. It still COUNTS as owed — the
 *       widget and the Removed list agree, in-progress included.
 *   (b) DEFENCE IN DEPTH — a second removal is harmless:
 *       · truly concurrent (both read the live token): the second itemRemove
 *         answers ITEM_NOT_FOUND ⇒ ALREADY_GONE ⇒ CONFIRMED; the verdict is
 *         CONFIRMED whichever marker lands last;
 *       · late (after the first confirmed and scrubbed the token): NO second
 *         itemRemove and NO marker — before PB-5 this wrote a spurious
 *         UNCONFIRMED (decrypt of "" fails ⇒ "retryable") that reopened a
 *         closed obligation for good; lib/plaid/disconnect.ts now returns on the
 *         sentinel;
 *       · nothing on the retry paths notifies the customer or writes an
 *         operator audit (only markers).
 *   (c) THE PHANTOM RULE — an existing phantom left by that late-call defect
 *       (newest UNCONFIRMED, an EARLIER CONFIRMED, token = the scrub sentinel)
 *       reads CONFIRMED in the shared fold, so on deploy the job does not
 *       re-attempt it, the widget and the list do not count it owed, and no
 *       Retry renders — with no data repair. Genuinely owed items (no earlier
 *       CONFIRMED, or a live token, i.e. re-linked) are unaffected.
 */

process.env.ENCRYPTION_KEY ??= "0".repeat(64);

import { readFileSync } from "node:fs";
import { encryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { disconnectPlaidItemIfOrphaned, REVOKED_TOKEN_SENTINEL } from "@/lib/plaid/disconnect";
import { AuditAction } from "@/lib/audit-actions";
import { __foldForTest as foldCleanupStatus } from "@/lib/platform/plaid/provider-cleanup";
import { PRE_PROVIDER_GRACE_MS, PRE_PROVIDER_PHASE, cleanupVerdicts, isRemovalInProgress, type MarkerRow } from "@/lib/platform/plaid/provider-cleanup.core";
import { foldRemovedConnections, queryRemovedConnections } from "./removed-connections.core";
import { selectRetryCandidates, retryPlaidRemovals } from "@/jobs/plaid-removal-retry";
import { readScrubbedItemIds } from "@/lib/plaid/token-scrub-state";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const code = (rel: string) => readFileSync(rel, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const NOW = new Date("2026-11-02T07:30:00.000Z"); // the retry's cadence slot
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const pre = (id: string, m: number): MarkerRow => ({ action: AuditAction.PLAID_ITEM_REVOCATION_UNCONFIRMED, createdAt: minsAgo(m), metadata: { provider: "PLAID", plaidItemId: id, phase: PRE_PROVIDER_PHASE } });
const unconfirmed = (id: string, m: number): MarkerRow => ({ action: AuditAction.PLAID_ITEM_REVOCATION_UNCONFIRMED, createdAt: minsAgo(m), metadata: { provider: "PLAID", plaidItemId: id, plaidErrorCode: "INTERNAL_SERVER_ERROR" } });
const item = (id: string) => ({ id, status: "REVOKED", institutionName: "Chase", userId: "user_owner_aaaaaa" });

async function main() {
  console.log("(a) the grace window — an in-flight operator removal is never raced");
  {
    check("the window is 15 minutes", PRE_PROVIDER_GRACE_MS === 15 * 60_000);
    const markers = [pre("young", 2), pre("aged", 20), unconfirmed("plain", 60), pre("retried", 30), unconfirmed("retried", 1)]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const status = foldCleanupStatus(markers, ["young", "aged", "plain", "retried"].map(item), NOW);
    const by = (id: string) => status.owed.find((o) => o.plaidItemId === id)!;
    check("a 2-minute-old PRE_PROVIDER marker: owed AND in progress", by("young").inProgress === true);
    check("a 20-minute-old PRE_PROVIDER marker with nothing after it: owed, NOT in progress (interrupted)", by("aged").inProgress === false);
    check("an ordinary UNCONFIRMED attempt is never in progress", by("plain").inProgress === false);
    check("a PRE_PROVIDER followed by a real attempt is not in progress (the attempt finished)", by("retried").inProgress === false);
    check("the boundary: exactly at the window it is no longer in progress",
      !isRemovalInProgress(cleanupVerdicts([pre("x", 15)]).get("x"), NOW) && isRemovalInProgress(cleanupVerdicts([pre("x", 14.9)]).get("x"), NOW));

    const { candidates, skipped } = selectRetryCandidates(status);
    check("the retry job SKIPS the in-progress item and takes the rest", !candidates.includes("young") && ["aged", "plain", "retried"].every((i) => candidates.includes(i)), { candidates });
    check("…and reports why (skipped.inProgress)", skipped.inProgress === 1, skipped);

    // The whole job, with the real fold as its reader.
    const calls: string[] = [];
    const run = await retryPlaidRemovals({ status: async () => foldCleanupStatus(markers, ["young", "aged", "plain", "retried"].map(item), NOW), disconnect: async (id) => { calls.push(id); } });
    check("the job makes NO provider call for the in-progress item", !calls.includes("young") && calls.length === 3 && run.skipped.inProgress === 1, { calls, run });
    check("the job checks inProgress BEFORE anything else in its selection",
      /for \(const o of status\.owed\) \{\s*if \(o\.inProgress\) \{ skipped\.inProgress\+\+; continue; \}/.test(code("jobs/plaid-removal-retry.ts")));

    // The widget and the list count the same owed set — in-progress INCLUDED.
    const list = queryRemovedConnections(foldRemovedConnections({
      plaidItems: ["young", "aged", "plain", "retried"].map((id) => ({ ...item(id), links: [] })),
      wallets: [], markers, revokedTransitions: [], customerActs: [], operatorActs: [], operatorLabel: () => null, now: NOW,
    }), { owner: null, provider: null, outcome: null, page: 1, pageSize: 25 });
    check("widget owed === list owed (4 — the in-progress removal is genuinely unconfirmed)", list.cleanup.owedCount === status.owedCount && status.owedCount === 4,
      { list: list.cleanup, widget: status.owedCount });
    const young = list.rows.find((r) => r.id === "young")!;
    check("the list shows it CLEANUP_OWED + in progress, and NOT retryable", young.outcome === "CLEANUP_OWED" && young.cleanup?.inProgress === true && young.retryEligible === false);
    check("an interrupted (aged) one is retryable again", list.rows.find((r) => r.id === "aged")!.retryEligible === true);

    const post = code("app/api/platform/platform-ops/provider-cleanup/route.ts");
    check("the operator Retry POST refuses an in-progress item with IN_PROGRESS — before any lookup or provider path",
      /o\.inProgress\)\)\s*\{\s*return NextResponse\.json\(\s*\{ plaidItemId, confirmed: false, stillOwed: true, skipped: "IN_PROGRESS" \}/.test(post)
        && post.indexOf('"IN_PROGRESS"') < post.indexOf("disconnectPlaidItemIfOrphaned(plaidItemId)"));
    check("both UIs hide Retry while in progress", /!o\.itemGone && !o\.inProgress && canWrite/.test(code("components/platform/widgets/OpsProviderCleanupWidget.tsx"))
      && /retryEligible: outcome === "CLEANUP_OWED" && !inProgress/.test(code("lib/platform/connections/removed-connections.core.ts")));
  }

  console.log("\n(b) defence in depth — a second removal is harmless");
  {
    const TOKEN = encryptWithPurpose("access-sandbox-race-token", EncryptionPurpose.PLAID_ACCESS_TOKEN);
    const plaidError = (c: string) => ({ isAxiosError: true, response: { status: 400, data: { error_code: c, error_type: "ITEM_ERROR" } }, message: `Plaid ${c}` });
    const world = () => {
      const audits: MarkerRow[] = [];
      const row = { id: "p1", userId: "u1", encryptedToken: TOKEN, status: "REVOKED", institutionName: "Chase" };
      let tick = 0;
      const db = {
        accountConnection: { count: async () => 0 },
        plaidItem: {
          findUnique: async () => ({ ...row }),
          update: async ({ data }: { data: { encryptedToken?: string } }) => { if (data.encryptedToken !== undefined) row.encryptedToken = data.encryptedToken; return { ...row }; },
        },
        auditLog: { create: async ({ data }: { data: { action: string; metadata: unknown } }) => { audits.push({ action: data.action, metadata: data.metadata, createdAt: new Date(NOW.getTime() + tick++) }); return { id: `a${audits.length}` }; } },
      };
      const healthCalls: string[] = [];
      const setHealth = (async (_id: string, h: { status: string }) => { healthCalls.push(h.status); }) as never;
      return { db, row, audits, healthCalls, setHealth };
    };

    // 1. TRULY CONCURRENT: both read the live token before either scrubs.
    {
      const w = world();
      let removes = 0;
      const plaid = {
        itemRemove: async () => {
          const n = ++removes;
          await new Promise((r) => setTimeout(r, n === 1 ? 10 : 0));
          if (n === 2) throw plaidError("ITEM_NOT_FOUND"); // Plaid already removed it for call 1
          return {};
        },
      } as never;
      const origError = console.error; console.error = () => {};
      await Promise.all([
        disconnectPlaidItemIfOrphaned("p1", { db: w.db as never, plaid, setHealth: w.setHealth }),
        disconnectPlaidItemIfOrphaned("p1", { db: w.db as never, plaid, setHealth: w.setHealth }),
      ]);
      console.error = origError;
      const outcomes = w.audits.map((a) => `${a.action}:${(a.metadata as { outcome?: string }).outcome}`).sort().join();
      check("two concurrent itemRemove calls: the second's ITEM_NOT_FOUND is ALREADY_GONE — both markers CONFIRMED",
        removes === 2 && outcomes === "PLAID_ITEM_REVOCATION_CONFIRMED:ALREADY_GONE,PLAID_ITEM_REVOCATION_CONFIRMED:REMOVED", outcomes);
      check("the verdict is CONFIRMED whichever lands last, and nothing is owed", cleanupVerdicts(w.audits).get("p1")?.verdict === "CONFIRMED"
        && foldCleanupStatus(w.audits, [], NOW).owedCount === 0);
      check("only marker rows were written (no other audit)", w.audits.every((a) => a.action === AuditAction.PLAID_ITEM_REVOCATION_CONFIRMED));
      check("the token ends scrubbed", w.row.encryptedToken === REVOKED_TOKEN_SENTINEL);
    }

    // 2. LATE: the first confirmed and scrubbed; then the retry's stale read arrives.
    {
      const w = world();
      let removes = 0;
      const plaid = { itemRemove: async () => { removes++; return {}; } } as never;
      await disconnectPlaidItemIfOrphaned("p1", { db: w.db as never, plaid, setHealth: w.setHealth });
      const afterFirst = w.audits.length;
      await disconnectPlaidItemIfOrphaned("p1", { db: w.db as never, plaid, setHealth: w.setHealth });
      check("a call after a CONFIRMED removal makes NO second itemRemove", removes === 1);
      check("…and writes NO marker (no spurious UNCONFIRMED reopening the obligation)", w.audits.length === afterFirst && afterFirst === 1);
      check("the item stays confirmed — nothing owed", foldCleanupStatus(w.audits, [], NOW).owedCount === 0);
      check("source pin: the sentinel guard precedes the decrypt and the provider call",
        (() => { const s = code("lib/plaid/disconnect.ts"); const g = s.indexOf("if (item.encryptedToken === REVOKED_TOKEN_SENTINEL) return;"); return g > 0 && g < s.indexOf("decryptWithPurpose(item.encryptedToken") && g < s.indexOf("plaid.itemRemove("); })());
    }

    // 3. Nothing on the retry paths notifies the customer or writes an operator row.
    {
      const job = code("jobs/plaid-removal-retry.ts");
      const prim = code("lib/plaid/disconnect.ts");
      check("the retry job and the revocation path never notify (no createNotification / sendEmail)",
        [job, prim].every((s) => !/createNotification|sendEmail|notifyItem|notification/i.test(s.replace(/plaidItem/g, ""))));
      check("the retry job writes no audit row of its own (the markers are the per-item audit)", !/auditLog\.create|recordOperatorAction/.test(job));
      check("the operator removal notifies exactly once, after its own outcome row (the retry path cannot reach it)",
        (code("lib/platform/connections/operator-removal.ts").match(/await notify\(/g) ?? []).length === 1
          && !/operator-removal/.test(job) && !/operator-removal/.test(code("app/api/platform/platform-ops/provider-cleanup/route.ts")));
      check("a repeated health write is not a second transition row (the chokepoint records only on change)",
        /const changed = prior\.status !== health\.status \|\| errorCodeChanged;\s*if \(!changed\) return;/.test(code("lib/connections/health-transitions.ts")));
    }
  }

  console.log("\n(c) the phantom rule — a pre-existing late-call phantom reads CONFIRMED, with no data repair");
  {
    const confirmedAt = (id: string, m: number, outcome = "REMOVED"): MarkerRow => ({ action: AuditAction.PLAID_ITEM_REVOCATION_CONFIRMED, createdAt: minsAgo(m), metadata: { provider: "PLAID", plaidItemId: id, outcome } });
    // The defect's own signature: no provider code (the decrypt of "" failed).
    const lateFail = (id: string, m: number): MarkerRow => ({ action: AuditAction.PLAID_ITEM_REVOCATION_UNCONFIRMED, createdAt: minsAgo(m), metadata: { provider: "PLAID", plaidItemId: id } });
    const markers = [
      confirmedAt("phantom", 600), lateFail("phantom", 500),                    // confirmed, scrubbed, then the late call
      unconfirmed("never", 600), lateFail("never", 500),                         // never confirmed — genuinely owed
      confirmedAt("relinked", 600, "ALREADY_GONE"), unconfirmed("relinked", 500), // confirmed once, re-linked (live token), owed again
    ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const scrubbedIds = new Set(["phantom", "never"]); // "never" has a sentinel token without a CONFIRMED marker: still owed
    const items = ["phantom", "never", "relinked"].map((id) => ({ ...item(id), tokenScrubbed: scrubbedIds.has(id) }));

    const v = cleanupVerdicts(markers, scrubbedIds);
    check("phantom: newest UNCONFIRMED + earlier CONFIRMED + scrubbed token ⇒ CONFIRMED (outcome of that CONFIRMED marker)",
      v.get("phantom")?.verdict === "CONFIRMED" && v.get("phantom")?.outcome === "REMOVED" && v.get("phantom")?.phantomResolved === true, v.get("phantom"));
    check("CONTROL — no earlier CONFIRMED (even with a scrubbed token) ⇒ still OWED", v.get("never")?.verdict === "OWED" && v.get("never")?.phantomResolved === false);
    check("CONTROL — earlier CONFIRMED but a LIVE token (re-linked) ⇒ still OWED", v.get("relinked")?.verdict === "OWED" && v.get("relinked")?.phantomResolved === false);
    check("CONTROL — without the scrub input the verdict is plain newest-wins (the rule only ever makes an item LESS owed)",
      cleanupVerdicts(markers).get("phantom")?.verdict === "OWED");

    const widget = foldCleanupStatus(markers, items, NOW);
    check("WIDGET: the phantom is not owed; it counts as a confirmed removal; the genuine two stay owed",
      !widget.owed.some((o) => o.plaidItemId === "phantom") && widget.owedCount === 2 && widget.confirmedCount === 1
        && ["never", "relinked"].every((id) => widget.owed.some((o) => o.plaidItemId === id)), widget);
    check("WIDGET: no Retry renders for it (Retry is rendered per OWED row only)",
      /\{data\.owed\.map\(\(o\) =>/.test(code("components/platform/widgets/OpsProviderCleanupWidget.tsx")) && !widget.owed.some((o) => o.plaidItemId === "phantom"));

    const calls: string[] = [];
    const run = await retryPlaidRemovals({ status: async () => foldCleanupStatus(markers, items, NOW), disconnect: async (id) => { calls.push(id); } });
    check("JOB: does not re-attempt the phantom; still attempts the genuinely owed (the canonical path re-counts live links for a re-linked one)",
      !calls.includes("phantom") && calls.includes("never") && calls.includes("relinked") && run.attempted === 2, { calls, run });

    const list = queryRemovedConnections(foldRemovedConnections({
      plaidItems: items.map((i) => ({ ...i, links: [] })),
      wallets: [], markers, revokedTransitions: [], customerActs: [], operatorActs: [], operatorLabel: () => null, now: NOW,
    }), { owner: null, provider: null, outcome: null, page: 1, pageSize: 25 });
    const row = list.rows.find((r) => r.id === "phantom")!;
    check("LIST: the phantom reads Confirmed removed, not retryable", row.outcome === "CONFIRMED_REMOVED" && row.retryEligible === false, row);
    check("LIST == WIDGET: owed 2, confirmed 1", list.cleanup.owedCount === widget.owedCount && list.cleanup.confirmedCount === widget.confirmedCount, { list: list.cleanup });
    check("LIST: the genuinely owed rows stay owed and retryable", ["never", "relinked"].every((id) => { const r = list.rows.find((x) => x.id === id)!; return r.outcome === "CLEANUP_OWED" && r.retryEligible; }));

    // The scrub bit is asked as an ids-only FILTER, in the token's own module.
    let seenArgs: { where: Record<string, unknown>; select: Record<string, unknown> } | null = null;
    const ids = await readScrubbedItemIds(["a", "b"], { plaidItem: { findMany: async (args: never) => { seenArgs = args; return [{ id: "a" }]; } } } as never);
    check("readScrubbedItemIds: filters on the sentinel, selects ids ONLY, returns ids", ids.has("a") && ids.size === 1
      && (seenArgs as unknown as { where: { encryptedToken: string } }).where.encryptedToken === REVOKED_TOKEN_SENTINEL
      && JSON.stringify((seenArgs as unknown as { select: unknown }).select) === JSON.stringify({ id: true }));
    check("…and asks nothing for an empty id list", (await readScrubbedItemIds([], { plaidItem: { findMany: async () => { throw new Error("must not query"); } } } as never)).size === 0);
    check("the widget's reader and the list's reader both feed that bit to the fold",
      /readScrubbedItemIds\(owedIdsForLookup\)/.test(code("lib/platform/plaid/provider-cleanup.ts")) && /tokenScrubbed: scrubbed\.has\(i\.id\)/.test(code("lib/platform/plaid/provider-cleanup.ts"))
        && /readScrubbedItemIds\(plaidIds, client\)/.test(code("lib/platform/connections/removed-connections.ts")) && /tokenScrubbed: scrubbed\.has\(p\.id\)/.test(code("lib/platform/connections/removed-connections.ts")));
  }

  console.log(failures === 0 ? "\n✅ an in-flight operator removal is never raced, and a second removal is harmless." : `\n❌ ${failures} failure(s)`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
