/**
 * lib/platform/wallet-history-recovery.test.ts  (OPS — audited per-wallet history recovery)
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/wallet-history-recovery.test.ts
 *
 * Deterministic and offline: every database and provider touch is a fake.
 * Pinned:
 *   1. permission — both verbs at FRESH CONTROL, before any read; WRITE does not satisfy it
 *   2. explicit target — non-wallet / inactive / unsupported chain / foreign history link refused
 *   3. state — only RECOVERY_REQUIRED and FAILED (QUEUED / IMPORTING / COMPLETE refused)
 *   4. worker flag off ⇒ "worker disabled for <chain>", nothing run
 *   5. admission denied ⇒ 503 NOT_ADMITTED, nothing run
 *   6. budget exhausted (SOL, BTC, ETH) ⇒ refused before the lock, nothing touched
 *   7. lock held ⇒ 409 ALREADY_RUNNING, no pass, no release, no usage
 *   8. a pass: resume runs bounded, usage flushed, regeneration marked, lock released only as ours
 *   9. audit on success, on failure and on every refusal — no address, reason carried
 *  10. resume preserves checkpoints (real runners: SOL, ETH-in-its-own-test; no reset anywhere)
 *  11. customer surfaces cannot reach it
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { hasPlatformAccess } from "./policy";
import { buildOperatorActionData, REASON_REQUIRED_ACTIONS, type OperatorActionInput } from "@/lib/audit";
import { AuditAction, OPERATOR_ACTION_FEED_ACTIONS } from "@/lib/audit-actions";
import { PLATFORM_OPS_FEED_RULES } from "@/lib/platform/activity/operator-feed-core";
import { WALLET_LOCK_TTL_MS } from "@/lib/refresh/wallet-lock";
import {
  resumeWalletHistory, previewWalletHistoryResume, limitsFor, RECOVERY_LOCK_TTL_MS,
  type WalletHistoryRecoveryDeps,
} from "./wallet-history-recovery";
import { decideEligibility, passBudget, summarizePass, OPERATOR_ETH_PROBE_CAP, type WalletHistoryTarget, type PassResult, type ResumableChain } from "./wallet-history-recovery.core";
import { emptyCheckpoint as emptySol, serializeCheckpoint as serSol, MAX_CONSECUTIVE_FAILURES } from "@/lib/crypto/sol-history-backfill.core";
import { emptyCheckpoint as emptyBtc, serializeCheckpoint as serBtc } from "@/lib/crypto/btc-history-backfill.core";
import { queuedCheckpoint, serializeCheckpoint as serEth, probeBudgetFor } from "@/lib/crypto/eth-history-backfill.core";
import { runSolHistoryBackfill, type SolBackfillStore } from "@/lib/crypto/sol-history-backfill";
import { resultLines, previewLines, refusalNotice } from "@/components/platform/widgets/wallet-history-recovery-view";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const code = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();
const TODAY = NOW_ISO.slice(0, 10);
const ADDRESS = "So11111111111111111111111111111111111111112";
const CONN = "conn_target_000001";

// ── Checkpoints in each state (facts only) ───────────────────────────────────
const solPoint = (sig: string, slot: number, dateISO: string) => ({ signature: sig, slot, blockTime: 1, dateISO, preLamports: "0", postLamports: "5" });
const solProgress = { ...emptySol("acc1", ADDRESS, NOW_ISO), top: solPoint("sigTop", 200, "2026-10-01"), bottom: solPoint("sigBottom", 100, "2025-01-01"),
  licensedFromISO: "2025-01-01", licensedToISO: "2026-10-01", signaturesProcessed: 4_321, lastProgressAtISO: "2026-10-20T00:00:00.000Z" };
const SOL_FAILED = serSol({ ...solProgress, failures: MAX_CONSECUTIVE_FAILURES, lastFailure: { code: "PROVIDER_TIMEOUT", atISO: NOW_ISO, detail: "timeout" } });
const SOL_RECOVERY = serSol({ ...solProgress, gap: { fromSlot: 120, toSlot: 140, detectedAtISO: NOW_ISO } as never });
const SOL_IMPORTING = serSol({ ...solProgress });
const BTC_FAILED = serBtc({ ...emptyBtc("acc1", NOW_ISO), failures: MAX_CONSECUTIVE_FAILURES, lastFailure: { code: "PROVIDER_THROTTLED", atISO: NOW_ISO, detail: "429" } } as never);
// A reconcile-failure recovery: resumable (the data may have been transient).
const ETH_RECOVERY = serEth({ ...queuedCheckpoint("acc1", "NO_COVERAGE", NOW_ISO), failures: 6, reconcileFailures: 3, lastFailure: { code: "LEDGER_DOES_NOT_RECONCILE", atISO: NOW_ISO },
  recovery: { code: "LEDGER_DOES_NOT_RECONCILE", atISO: NOW_ISO } });
// A deterministic one: the address held ETH before the provable floor — a resume would fail the same way.
const ETH_FLOOR = serEth({ ...queuedCheckpoint("acc1", "NO_COVERAGE", NOW_ISO), failures: 6, lastFailure: { code: "BALANCE_BEFORE_PROVABLE_FLOOR", atISO: NOW_ISO },
  recovery: { code: "BALANCE_BEFORE_PROVABLE_FLOOR", atISO: NOW_ISO } });

function target(over: Partial<WalletHistoryTarget> = {}): WalletHistoryTarget {
  return { connectionId: CONN, provider: "WALLET", status: "ACTIVE", accountIds: ["acc1"], chain: "SOL", historyLinkConnectionId: CONN,
    cursor: SOL_FAILED, historyCheckpoint: null, lockedAt: null, ...over };
}

/** A fake world: one target connection, a lock, a ledger, an audit log. */
function world(t: WalletHistoryTarget | null, opts: {
  enabled?: boolean; admitted?: boolean; ledger?: { solana: number; other: number } | null; cap?: number;
  lockHeld?: boolean; pass?: PassResult | "UNBOUND" | "THROW"; after?: Partial<WalletHistoryTarget>; spend?: number;
  perPass?: number; auditThrowsAfterPass?: boolean; loadThrows?: boolean;
  /** BETA LIFECYCLE L2 — the owner's billable decision (default allowed). */
  billable?: import("@/lib/entitlements/billable-gate-core").BillableDecision;
  /** What changes on the connection at the instant the lock is claimed (a racing sync/worker). */
  onClaim?: Partial<WalletHistoryTarget>;
} = {}) {
  const log = { audits: [] as OperatorActionInput[], passes: [] as Array<{ chain: ResumableChain; requestBudget: number; probeBudget: number }>,
    claims: 0, releases: [] as number[], usage: [] as Array<Record<string, number>>, pending: [] as string[] };
  let current = t;
  let lockedBy: number | null = opts.lockHeld ? NOW - 1_000 : null;
  const deps: WalletHistoryRecoveryDeps = {
    now: () => NOW,
    workerEnabled: () => opts.enabled ?? true,
    loadTarget: async (id) => {
      if (opts.loadThrows) throw new Error("db down");
      return current && id === current.connectionId ? { ...current, lockedAt: lockedBy === null ? null : new Date(lockedBy) } : null;
    },
    billable: async () => (opts.billable ?? { allowed: true }),
    admit: async () => (opts.admitted ?? true) ? { admitted: true } : { admitted: false, reason: "MAINTENANCE_MODE", label: "Maintenance mode is on." },
    limits: (chain) => ({ dailyRequestCap: opts.cap ?? 1_000, perPassRequestCap: opts.perPass ?? 10_000, ...(chain === "ETH" ? { probeBudget: 4_000 } : {}) }),
    probeBudgetFor,
    providerUsageToday: async () => (opts.ledger === undefined ? { solana: 0, other: 0 } : opts.ledger),
    claimLock: async (_id, stamp) => { log.claims++; if (lockedBy !== null && stamp - lockedBy < RECOVERY_LOCK_TTL_MS) return false; lockedBy = stamp; if (opts.onClaim && current) current = { ...current, ...opts.onClaim }; return true; },
    releaseLock: async (_id, stamp) => { log.releases.push(stamp); if (lockedBy === stamp) lockedBy = null; },
    runPass: async ({ chain, budget, meter }) => {
      log.passes.push({ chain, requestBudget: budget.requestBudget, probeBudget: budget.probeBudget });
      meter.getTransaction = opts.spend ?? 42;
      if (opts.pass === "THROW") throw new Error("boom");
      if (opts.after && current) current = { ...current, ...opts.after };
      return opts.pass ?? { stoppedBecause: "BUDGET", rowsWritten: 7, impactedFromISO: "2025-03-01", failureCode: null };
    },
    recordUsage: async (_chain, meter) => { log.usage.push({ ...meter }); },
    markRegenerationPending: async (_chain, _acc, fromISO) => { log.pending.push(fromISO); return true; },
    audit: async (input) => {
      buildOperatorActionData(input); // the envelope's own validation runs
      if (opts.auditThrowsAfterPass && input.result !== "REFUSED") throw new Error("audit insert failed");
      log.audits.push(input);
    },
  };
  return { deps, log, lockedBy: () => lockedBy };
}

const ACTOR = { actor: { userId: "op_1", via: "PLATFORM_GRANT" as const, area: "PLATFORM_OPS" }, ipAddress: "10.0.0.1", userAgent: "test" };
const REASON = { code: "SUPPORT_REQUEST" as const, note: "customer reports missing SOL history" };
const resume = (deps: WalletHistoryRecoveryDeps, connectionId = CONN) => resumeWalletHistory({ connectionId, reason: REASON, ...ACTOR }, deps);

async function main() {
  // ── 1. Permission ──────────────────────────────────────────────────────────
  console.log("1. permission — fresh CONTROL on both verbs, before any read");
  {
    const ROUTE = "app/api/platform/platform-ops/connections/[id]/history-resume/route.ts";
    const r = code(ROUTE);
    check("GET and POST both require FRESH CONTROL on PLATFORM_OPS (never the cached check)",
      (r.match(/requireFreshPlatformAccess\("PLATFORM_OPS", "CONTROL"\)/g) ?? []).length === 2 && !/requirePlatformAccess\(/.test(r));
    const post = r.slice(r.indexOf("export async function POST"));
    check("POST authorizes before reading the body or the connection",
      post.indexOf("requireFreshPlatformAccess") < post.indexOf("req.json") && post.indexOf("requireFreshPlatformAccess") < post.indexOf("resumeWalletHistory"));
    const get = r.slice(r.indexOf("export async function GET"), r.indexOf("export async function POST"));
    check("GET authorizes before the preview read", get.indexOf("requireFreshPlatformAccess") < get.indexOf("previewWalletHistoryResume"));
    check("a READ or WRITE grant does not satisfy CONTROL (403 from the shared guard)",
      !hasPlatformAccess("PLATFORM_OPS", "CONTROL", [{ area: "PLATFORM_OPS", level: "WRITE", status: "ACTIVE" }])
        && !hasPlatformAccess("PLATFORM_OPS", "CONTROL", [{ area: "PLATFORM_OPS", level: "READ", status: "ACTIVE" }])
        && hasPlatformAccess("PLATFORM_OPS", "CONTROL", [{ area: "PLATFORM_OPS", level: "CONTROL", status: "ACTIVE" }]));
    check("a CONTROL grant in another area does not reach it",
      !hasPlatformAccess("PLATFORM_OPS", "CONTROL", [{ area: "CUSTOMER_SUCCESS", level: "CONTROL", status: "ACTIVE" }]));
    check("the route requires a structured reason AND a note (400 otherwise)", /parseOperatorReason\(body\.reason\)/.test(r) && /if \(!reason\.note\)/.test(r));
    check("the route acts on systemDb, never the migration principal", /import \{ systemDb \} from "@\/lib\/db"/.test(r) && !/import \{ db \}/.test(r));
    check("WALLET_HISTORY_RESUMED requires a reason in the envelope", REASON_REQUIRED_ACTIONS.has(AuditAction.WALLET_HISTORY_RESUMED));
    let threw = false;
    try { buildOperatorActionData({ actor: ACTOR.actor, action: AuditAction.WALLET_HISTORY_RESUMED, target: { kind: "CONNECTION", id: CONN }, result: "SUCCESS" }); }
    catch { threw = true; }
    check("…so an un-reasoned row cannot be written", threw);
  }

  // ── 2. Explicit target ─────────────────────────────────────────────────────
  console.log("2. explicit target — the server re-reads ONE connection and refuses anything else");
  {
    const cases: Array<[string, WalletHistoryTarget | null, string, number]> = [
      ["unknown connection", null, "NOT_FOUND", 404],
      ["a Plaid connection", target({ provider: "PLAID" }), "NOT_A_WALLET", 422],
      ["a revoked wallet", target({ status: "REVOKED" }), "NOT_ACTIVE", 409],
      ["a wallet with no live account", target({ accountIds: [] }), "NO_WALLET_ACCOUNT", 422],
      ["an unsupported chain", target({ chain: "DOGE" }), "UNSUPPORTED_CHAIN", 422],
      ["a wallet whose history lives on another connection", target({ historyLinkConnectionId: "conn_other" }), "NOT_HISTORY_LINK", 422],
      ["a SOL wallet with no SOL checkpoint", target({ cursor: '{"kind":"btc-discovery"}' }), "NO_CHECKPOINT", 409],
      ["a BTC wallet whose checkpoint column holds nothing", target({ chain: "BTC", cursor: SOL_FAILED, historyCheckpoint: null }), "NO_CHECKPOINT", 409],
    ];
    for (const [name, t, codeWanted, status] of cases) {
      const w = world(t);
      const o = await resume(w.deps);
      check(`${name} ⇒ ${codeWanted} (${status}), no lock, no pass`,
        !o.ok && o.refusal.code === codeWanted && o.status === status && w.log.claims === 0 && w.log.passes.length === 0,
        JSON.stringify(o));
      if (codeWanted === "NOT_FOUND") check("…and NO audit row for an id that names no connection (logged instead)", w.log.audits.length === 0);
      else check(`…and audited REFUSED on the named connection`, w.log.audits.length === 1 && w.log.audits[0].result === "REFUSED"
        && w.log.audits[0].target.id === CONN && w.log.audits[0].detail?.refusal === codeWanted);
    }
  }

  // ── 3. State ───────────────────────────────────────────────────────────────
  console.log("3. state — only RECOVERY_REQUIRED and FAILED");
  {
    const w = world(target({ cursor: SOL_IMPORTING }));
    const o = await resume(w.deps);
    check("IMPORTING ⇒ WRONG_STATE 409, nothing run", !o.ok && o.refusal.code === "WRONG_STATE" && o.status === 409 && w.log.passes.length === 0);
    const done = serSol({ ...solProgress, completedAtISO: NOW_ISO, reachedBeginning: true });
    const w2 = world(target({ cursor: done }));
    const o2 = await resume(w2.deps);
    check("COMPLETE ⇒ WRONG_STATE", !o2.ok && o2.refusal.code === "WRONG_STATE");
    for (const [name, t] of [["SOL FAILED", target()], ["SOL RECOVERY_REQUIRED", target({ cursor: SOL_RECOVERY })],
      ["BTC FAILED", target({ chain: "BTC", cursor: null, historyCheckpoint: BTC_FAILED })],
      ["ETH RECOVERY_REQUIRED", target({ chain: "ETH", cursor: null, historyCheckpoint: ETH_RECOVERY })]] as const) {
      const el = decideEligibility(t, { todayISO: TODAY, workerEnabled: () => true });
      check(`${name} is eligible`, el.ok, JSON.stringify(el.ok ? null : el.refusal));
    }
    const wf = world(target({ chain: "ETH", cursor: null, historyCheckpoint: ETH_FLOOR }));
    const of = await resume(wf.deps);
    check("ETH RECOVERY_REQUIRED for BALANCE_BEFORE_PROVABLE_FLOOR ⇒ NEEDS_INVESTIGATION 409 naming the cause, nothing run",
      !of.ok && of.refusal.code === "NEEDS_INVESTIGATION" && of.status === 409 && /BALANCE_BEFORE_PROVABLE_FLOOR/.test(of.refusal.message)
        && wf.log.claims === 0 && wf.log.passes.length === 0 && wf.log.audits[0]?.result === "REFUSED");
    const pf = await previewWalletHistoryResume(CONN, wf.deps);
    const notice = refusalNotice(pf as never);
    check("…and the panel shows it as a WARNING with the recovery reason", notice?.warn === true && /Needs investigation/.test(notice.text)
      && pf.history?.recoveryCode === "BALANCE_BEFORE_PROVABLE_FLOOR");
    const premises = serEth({ ...queuedCheckpoint("acc1", "NO_COVERAGE", NOW_ISO), failures: 6, lastFailure: { code: "PROOF_PREMISES_UNMET", atISO: NOW_ISO } });
    const op = await resume(world(target({ chain: "ETH", cursor: null, historyCheckpoint: premises })).deps);
    check("ETH FAILED for PROOF_PREMISES_UNMET (contract wallet) ⇒ NEEDS_INVESTIGATION", !op.ok && op.refusal.code === "NEEDS_INVESTIGATION");
    const solNoProvider = serSol({ ...solProgress, failures: MAX_CONSECUTIVE_FAILURES, lastFailure: { code: "NO_PROVIDER_CONFIGURED", atISO: NOW_ISO, detail: "x" } });
    const on = await resume(world(target({ cursor: solNoProvider })).deps);
    check("SOL with no provider configured reads UNAVAILABLE and is refused (never resumed)", !on.ok && on.refusal.code === "WRONG_STATE" && /UNAVAILABLE/.test(on.refusal.message));
  }

  // ── 4. Worker flag ─────────────────────────────────────────────────────────
  console.log("4. worker flag off ⇒ refused, nothing run");
  {
    const w = world(target({ chain: "BTC", cursor: null, historyCheckpoint: BTC_FAILED }), { enabled: false });
    const o = await resume(w.deps);
    check("flag off ⇒ WORKER_DISABLED naming the chain", !o.ok && o.refusal.code === "WORKER_DISABLED" && /disabled for BTC/.test(o.refusal.message));
    check("…no lock claimed, no pass, no usage", w.log.claims === 0 && w.log.passes.length === 0 && w.log.usage.length === 0);
    check("…audited REFUSED", w.log.audits[0]?.result === "REFUSED");
  }

  // ── 5. Admission ───────────────────────────────────────────────────────────
  console.log("5. admission denied ⇒ 503, nothing run");
  {
    const w = world(target(), { admitted: false });
    const o = await resume(w.deps);
    check("maintenance ⇒ NOT_ADMITTED 503", !o.ok && o.refusal.code === "NOT_ADMITTED" && o.status === 503);
    check("…no lock, no pass; reason code recorded", w.log.claims === 0 && w.log.passes.length === 0 && w.log.audits[0]?.detail?.admissionReason === "MAINTENANCE_MODE");
  }

  // ── 5b. BETA LIFECYCLE L2 — the wallet owner's plan ─────────────────────────
  console.log("5b. the owner's plan refuses paid work ⇒ 403 PLAN_RESTRICTED, nothing run");
  for (const reason of ["COST_FREEZE", "NO_OWNER", "POLICY_UNAVAILABLE"] as const) {
    const w = world(target(), { billable: { allowed: false, reason } });
    const o = await resume(w.deps);
    check(`${reason} ⇒ PLAN_RESTRICTED 403`, !o.ok && o.refusal.code === "PLAN_RESTRICTED" && o.status === 403);
    check(`…${reason}: no lock, no pass (no provider call), no usage, no regeneration marker; audited REFUSED with the reason`,
      w.log.claims === 0 && w.log.passes.length === 0 && w.log.usage.length === 0 && w.log.pending.length === 0
        && w.log.audits[0]?.result === "REFUSED" && w.log.audits[0]?.detail?.billableReason === reason);
  }

  // ── 6. Budget ──────────────────────────────────────────────────────────────
  console.log("6. budget exhausted ⇒ refused before the lock, nothing touched");
  {
    const w = world(target(), { ledger: { solana: 600, other: 400 }, cap: 1_000 });
    const o = await resume(w.deps);
    check("SOL: Alchemy ledger (Solana + Ethereum) at the cap ⇒ BUDGET_EXHAUSTED", !o.ok && o.refusal.code === "BUDGET_EXHAUSTED" && /Alchemy/.test(o.refusal.message));
    check("…no lock claimed, no pass, no usage recorded", w.log.claims === 0 && w.log.passes.length === 0 && w.log.usage.length === 0);
    check("…audited REFUSED with the cap and the usage", w.log.audits[0]?.result === "REFUSED" && w.log.audits[0]?.detail?.usedToday === 1_000);
    const wb = world(target({ chain: "BTC", cursor: null, historyCheckpoint: BTC_FAILED }), { ledger: { solana: 0, other: 1_000 }, cap: 1_000 });
    const ob = await resume(wb.deps);
    check("BTC: Esplora ledger at the cap ⇒ BUDGET_EXHAUSTED (Esplora)", !ob.ok && ob.refusal.code === "BUDGET_EXHAUSTED" && /Esplora/.test(ob.refusal.message));
    const we = world(target({ chain: "ETH", cursor: null, historyCheckpoint: ETH_RECOVERY }), { ledger: { solana: 990, other: 0 }, cap: 1_000 });
    const oe = await resume(we.deps);
    check("ETH: too little Alchemy left for one probe ⇒ BUDGET_EXHAUSTED", !oe.ok && oe.refusal.code === "BUDGET_EXHAUSTED" && we.log.passes.length === 0);
    // The checkpoint is never below its own usage, and an unreadable ledger falls back to it.
    const b = passBudget("SOL", { dailyRequestCap: 1_000, perPassRequestCap: 10_000 }, null, 950);
    check("an unreadable ledger falls back to the wallet's checkpoint usage", b.usedToday === 950 && b.remaining === 50 && !b.exhausted && b.requestBudget === 50);
    const b2 = passBudget("SOL", { dailyRequestCap: 1_000, perPassRequestCap: 10_000 }, { solana: 100, other: 300 }, 500);
    check("SOL usage = other networks + max(Solana ledger, checkpoint)", b2.usedToday === 800);
    const b3 = passBudget("ETH", { dailyRequestCap: 10_000, perPassRequestCap: 0, probeBudget: 4_000 }, { solana: 2_000, other: 100 }, 400, probeBudgetFor);
    check("ETH usage = Solana ledger + max(other, checkpoint); probe budget clamped to the operator cap", b3.usedToday === 2_400 && b3.probeBudget === OPERATOR_ETH_PROBE_CAP);
    check("the limits are the worker's own caps (ETH shares the Solana/Alchemy cap)",
      limitsFor("ETH", { SOL_BACKFILL_DAILY_REQUEST_CAP: "1234" }).dailyRequestCap === 1_234
        && limitsFor("SOL", { SOL_BACKFILL_DAILY_REQUEST_CAP: "1234" }).dailyRequestCap === 1_234
        && limitsFor("BTC", { BTC_BACKFILL_DAILY_REQUEST_CAP: "777" }).dailyRequestCap === 777);
  }

  // ── 7. Lock held ───────────────────────────────────────────────────────────
  console.log("7. lock held ⇒ 409 already running, no side effects");
  {
    const w = world(target(), { lockHeld: true });
    const o = await resume(w.deps);
    check("ALREADY_RUNNING 409", !o.ok && o.refusal.code === "ALREADY_RUNNING" && o.status === 409);
    check("…no pass, no release of the other holder's lock, no usage, no regeneration marker",
      w.log.passes.length === 0 && w.log.releases.length === 0 && w.log.usage.length === 0 && w.log.pending.length === 0 && w.lockedBy() === NOW - 1_000);
    const p = await previewWalletHistoryResume(CONN, w.deps);
    check("…and the preview says it is running (not allowed now)", p.running && !p.allowed && p.refusal?.code === "ALREADY_RUNNING");
    check("the lock TTL is the wallet sync lock's", RECOVERY_LOCK_TTL_MS === WALLET_LOCK_TTL_MS);
    const raced = world(target(), { onClaim: { cursor: SOL_IMPORTING } });
    const ro = await resume(raced.deps);
    check("re-decided UNDER the lock: a checkpoint that moved to IMPORTING meanwhile ⇒ WRONG_STATE, released, no pass",
      !ro.ok && ro.refusal.code === "WRONG_STATE" && raced.lockedBy() === null && raced.log.passes.length === 0 && raced.log.audits.at(-1)?.detail?.recheckedUnderLock === true);
  }

  // ── 8. A pass ──────────────────────────────────────────────────────────────
  console.log("8. a pass — bounded, metered, regeneration marked, lock released");
  {
    const afterCursor = serSol({ ...solProgress, licensedFromISO: "2024-06-01" }); // IMPORTING again, verified further back
    const w = world(target(), { after: { cursor: afterCursor }, ledger: { solana: 100, other: 0 }, cap: 1_000, perPass: 300 });
    const pre = await previewWalletHistoryResume(CONN, w.deps);
    check("the preview shows the failure, the verified range, progress and the budget before confirming",
      pre.allowed && pre.history?.state === "FAILED" && pre.history.lastFailureCode === "PROVIDER_TIMEOUT"
        && pre.history.verifiedFromISO === "2025-01-01" && pre.history.processed.count === 4_321 && pre.budget?.remaining === 900);
    check("…and the preview never carries an address", !JSON.stringify(pre).includes(ADDRESS));
    const lines = previewLines(pre as never).join("\n");
    check("…rendered as sentences (state, failure, verified, budget, worker)", /FAILED — PROVIDER_TIMEOUT/.test(lines) && /900 of 1000/.test(lines) && /Worker for SOL: on/.test(lines));
    const o = await resume(w.deps);
    check("the pass ran once, its allowance capped PER PASS (300), not the 900 left today", o.ok && w.log.passes.length === 1 && w.log.passes[0].requestBudget === 300);
    const big = world(target(), { cap: 1_000, perPass: 5_000 });
    await resume(big.deps);
    check("…and never above what is left today", big.log.passes[0]?.requestBudget === 1_000);
    const eth = world(target({ chain: "ETH", cursor: null, historyCheckpoint: ETH_RECOVERY }), { cap: 1_000_000 });
    await resume(eth.deps);
    check("ETH: an operator pass probes at most OPERATOR_ETH_PROBE_CAP even when the env allows 4,000", eth.log.passes[0]?.probeBudget === OPERATOR_ETH_PROBE_CAP);
    check("the per-pass cap is the worker's per-wallet share (wallet budget × rate)",
      limitsFor("SOL", {}).perPassRequestCap === 600 && limitsFor("BTC", {}).perPassRequestCap === 240 && limitsFor("ETH", {}).perPassRequestCap === 600);
    check("…usage flushed to the shared ledger", w.log.usage.length === 1 && w.log.usage[0].getTransaction === 42);
    check("…the regeneration it owes is marked for the worker", w.log.pending.join() === "2025-03-01");
    check("…and the lock released (only as ours)", w.log.releases.length === 1 && w.lockedBy() === null);
    if (o.ok) {
      check("the result names the new state, verified-back-to date, requests, and that work continues automatically",
        o.result === "SUCCESS" && o.after?.state === "IMPORTING" && o.after.verifiedFromISO === "2024-06-01" && o.requests === 42
          && o.rowsWritten === 7 && o.moreWorkRemains && o.continuesAutomatically && o.regenerationPending);
      check("…rendered for the operator", /FAILED → IMPORTING/.test(resultLines(o as never).join("\n")) && /continue automatically/.test(resultLines(o as never).join("\n")));
    }
    const a = w.log.audits.at(-1)!;
    check("audited SUCCESS: who, which connection, chain, reason, prior and resulting state, requests consumed",
      a.result === "SUCCESS" && a.actor.userId === "op_1" && a.target.kind === "CONNECTION" && a.target.id === CONN && a.detail?.chain === "SOL"
        && a.reason?.note === REASON.note && a.change?.before?.state === "FAILED" && a.change?.after?.state === "IMPORTING" && a.detail?.requests === 42);
    check("…and the audit row carries no address", !JSON.stringify(buildOperatorActionData(a)).includes(ADDRESS));
  }

  // ── 9. Failure is audited too ──────────────────────────────────────────────
  console.log("9. failure — audited FAILURE; a thrown pass still releases and records usage");
  {
    const w = world(target(), { pass: { stoppedBecause: "FAILURE", rowsWritten: 0, impactedFromISO: null, failureCode: "PROVIDER_TIMEOUT" },
      after: { cursor: serSol({ ...solProgress, failures: 1, lastFailure: { code: "PROVIDER_TIMEOUT", atISO: NOW_ISO, detail: "t" } }) } });
    const o = await resume(w.deps);
    check("a pass that failed again ⇒ ok:true result FAILURE with its code", o.ok && o.result === "FAILURE" && o.failureCode === "PROVIDER_TIMEOUT");
    check("…audited FAILURE with requests consumed", w.log.audits.at(-1)?.result === "FAILURE" && w.log.audits.at(-1)?.detail?.requests === 42);
    check("…no regeneration marked (no rows)", w.log.pending.length === 0);
    const w2 = world(target(), { pass: "THROW" });
    const o2 = await resume(w2.deps);
    check("a pass that throws ⇒ FAILURE (PASS_ERROR), lock released, usage still flushed, audited",
      o2.ok && o2.result === "FAILURE" && o2.failureCode === "PASS_ERROR" && w2.lockedBy() === null && w2.log.usage.length === 1 && w2.log.audits.at(-1)?.result === "FAILURE");
    const w3 = world(target(), { pass: "UNBOUND" });
    const o3 = await resume(w3.deps);
    check("a store binding another connection under the lock ⇒ NOT_HISTORY_LINK, released, audited REFUSED",
      !o3.ok && o3.refusal.code === "NOT_HISTORY_LINK" && w3.lockedBy() === null && w3.log.audits.at(-1)?.result === "REFUSED");
    const wa = world(target(), { auditThrowsAfterPass: true, after: { cursor: SOL_IMPORTING } });
    const oa = await resume(wa.deps);
    check("an audit write that fails AFTER a real pass returns the real outcome flagged auditFailed (no 500), lock released",
      oa.ok && oa.auditFailed === true && oa.result === "SUCCESS" && wa.lockedBy() === null && wa.log.usage.length === 1
        && /audit record could not be written/.test(resultLines(oa as never).join("\n")));
    const wl = world(target(), { loadThrows: true });
    let threwLoad = false;
    try { await resume(wl.deps); } catch { threwLoad = true; }
    check("a target read that throws BEFORE the lock propagates with nothing claimed, run or audited",
      threwLoad && wl.log.claims === 0 && wl.log.passes.length === 0 && wl.log.audits.length === 0);
    const s = summarizePass(null, { stoppedBecause: "X", rowsWritten: 0, impactedFromISO: null, failureCode: null }, { workerEnabled: true, regenerationPending: false });
    check("an unreadable after-state is never reported as success", s.result === "FAILURE" && s.moreWorkRemains);
    check("the audit action is on both operator feeds, under Platform Ops' providers workspace",
      OPERATOR_ACTION_FEED_ACTIONS.includes(AuditAction.WALLET_HISTORY_RESUMED) && PLATFORM_OPS_FEED_RULES[AuditAction.WALLET_HISTORY_RESUMED]?.kinds.join() === "CONNECTION");
  }

  // ── 10. Resume preserves checkpoints ───────────────────────────────────────
  console.log("10. resume preserves checkpoints — no reset anywhere");
  {
    // The REAL Solana runner with resume on a FAILED wallet with progress, and a
    // store with no anchor: it clears the pause and records the new failure on
    // the SAME checkpoint — progress, licence and bounds are kept.
    let stored: string | null = SOL_FAILED;
    const commits: string[] = [];
    const store: SolBackfillStore = {
      readCursor: async () => stored,
      anchor: async () => null,
      commit: async (c) => { if (c.rows.length || c.replaceAll || c.deleteFromISO) throw new Error("a resume must not write rows here"); commits.push(c.nextCursor); stored = c.nextCursor; },
    };
    const o = await runSolHistoryBackfill({ accountId: "acc1", address: ADDRESS, store, resume: true }, { call: async () => { throw new Error("no provider call expected"); }, now: () => NOW, budgetMs: 1_000 });
    const after = JSON.parse(stored!) as typeof solProgress & { failures: number; gap: unknown };
    check("SOL resume on FAILED: the pause is cleared (failures 6 → 0, then this run's 1)", o.failure?.code === "NO_OBSERVED_ANCHOR" && after.failures === 1);
    check("…top, bottom, licence and signatures processed are exactly as before",
      after.top?.signature === "sigTop" && after.bottom?.signature === "sigBottom" && after.licensedFromISO === "2025-01-01"
        && after.licensedToISO === "2026-10-01" && after.signaturesProcessed === 4_321);
    const sol = code("lib/crypto/sol-history-backfill.ts");
    const btc = code("lib/crypto/btc-history-backfill.ts");
    check("SOL resume keeps the checkpoint (clears only gap + failure streak)", /if \(args\.resume && cp\) cp = \{ \.\.\.cp, gap: null, failures: 0, lastFailure: null \};/.test(sol));
    check("BTC resume on FAILED keeps the checkpoint; on RECOVERY it keeps rows, licence, legacy and usage",
      /: \{ \.\.\.cp, failures: 0, lastFailure: null, mismatchStreak: 0 \};/.test(btc) && /licensedFromISO: cp\.licensedFromISO, licensedToISO: cp\.licensedToISO/.test(btc));
    const mod = code("lib/platform/wallet-history-recovery.ts") + code("lib/platform/wallet-history-recovery.core.ts")
      + code("app/api/platform/platform-ops/connections/[id]/history-resume/route.ts");
    check("the recovery MODULE builds no reset of its own (the runners' resume semantics are pinned above): no restartGeneration, no emptyCheckpoint, no delete, no replaceAll, no checkpoint write of its own",
      !/restartGeneration|emptyCheckpoint|deleteMany|\.delete\(|replaceAll|casHistoryCheckpoint|historyCheckpoint"\s*=|cursor:\s*null/.test(mod));
    check("every runner call passes resume: true and nothing else in the module does",
      (mod.match(/resume: true/g) ?? []).length === 3);
    check("the regeneration marker only ever LOWERS snapshotPendingFromISO (the worker's own helper)",
      /snapshotPendingFromISO: earlier\(cp\.snapshotPendingFromISO\)/.test(mod) && /job\.setPending\(|job\.setBtcPending\(|job\.setEthPending\(/.test(mod));
  }

  // ── 11. Customer isolation ─────────────────────────────────────────────────
  console.log("11. customer surfaces cannot reach it");
  {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel, out); else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
      }
      return out;
    };
    const REACH = /history-resume|WalletHistoryRecoveryPanel|wallet-history-recovery|resumeWalletHistory/;
    const customer = [...walk("components/connections"), ...walk("components/space"), ...walk("app/(shell)"), ...walk("app/(public)"), ...walk("app/api/connections"), ...walk("app/api/accounts")].filter((f) => REACH.test(code(f)));
    check("no customer Connections / Space component or page mentions the resume route or panel", customer.length === 0, customer.join(", "));
    const reachers = [...walk("components"), ...walk("app")].filter((f) => REACH.test(code(f))).sort();
    check("only the Platform Ops diagnostics widget, the panel, its view and the route reach it",
      reachers.join() === [
        "app/api/platform/platform-ops/connections/[id]/history-resume/route.ts",
        "components/platform/widgets/OpsConnectionDiagnosticsWidget.tsx",
        "components/platform/widgets/WalletHistoryRecoveryPanel.tsx",
        "components/platform/widgets/wallet-history-recovery-view.ts",
      ].sort().join(), reachers.join(", "));
    const menu = code("components/connections/ConnectionMenu.tsx");
    check("the customer ConnectionMenu has no resume-history item", !/resume history|history-resume|historyResume/i.test(menu));
    const widget = code("components/platform/widgets/OpsConnectionDiagnosticsWidget.tsx");
    check("the panel renders only behind canControl, for a WALLET with a history checkpoint",
      /\{offerRecovery && selected\.provider === "WALLET" && selected\.historyBackfill && \(/.test(widget));
    const panel = code("components/platform/widgets/WalletHistoryRecoveryPanel.tsx");
    check("the panel never names the access level and never reads an address", !/\bCONTROL\b|canControl|walletAddress|address/.test(panel));
  }

  console.log(`\nwallet-history-recovery: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
