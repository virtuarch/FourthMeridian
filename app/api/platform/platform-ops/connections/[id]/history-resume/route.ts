/**
 * GET  /api/platform/platform-ops/connections/[id]/history-resume   — preview
 * POST /api/platform/platform-ops/connections/[id]/history-resume   — resume ONE wallet
 *
 * The audited operator lever for a self-custody wallet whose resumable history
 * (SOL / BTC / ETH) is RECOVERY_REQUIRED or FAILED — states the background
 * worker deliberately does not retry on its own. Every rule lives in
 * lib/platform/wallet-history-recovery(.core).ts; this route authorizes, parses
 * and maps the outcome to a status.
 *
 *   GET   what the operator reviews before confirming: state, failure code,
 *         proven range, progress, today's budget left, whether a sync holds the
 *         lock, and whether resume is allowed (or why not). Reads only.
 *   POST  { reason: { code, note } } — one bounded pass with the chain's
 *         existing operator `resume` option, under the wallet's sync lock and
 *         the shared provider budget. Checkpoints are kept; nothing is reset.
 *
 *   200  { ok: true, … }              the pass ran (result SUCCESS or FAILURE)
 *   400  { error }                    malformed body / missing reason or note
 *   404  { error, code: NOT_FOUND }
 *   409  { error, code }              WRONG_STATE · WORKER_DISABLED · ALREADY_RUNNING
 *                                     · BUDGET_EXHAUSTED · NOT_ACTIVE · NO_CHECKPOINT
 *   422  { error, code }              NOT_A_WALLET · UNSUPPORTED_CHAIN · NO_WALLET_ACCOUNT · NOT_HISTORY_LINK
 *   503  { error, code: NOT_ADMITTED } maintenance / ingestion paused
 *   Every refusal past the reason is audited REFUSED and changes nothing.
 *
 * AUTHORITY: systemDb (fm_system) — an operator acts across tenants, on the ONE
 * connection named in the path, re-read server-side; never `db`.
 * AUTHORIZATION: fresh (live revocation) CONTROL on PLATFORM_OPS for BOTH verbs:
 * the pass spends a shared provider budget on a customer's wallet outside its
 * automatic schedule, which is control-plane work, not routine WRITE.
 * AUDIT: WALLET_HISTORY_RESUMED (reason required) — who, which connection,
 * chain, reason, prior and resulting state, requests consumed. Never an address,
 * a balance, or provider text. Not reachable from any customer surface.
 */

import { NextRequest, NextResponse } from "next/server";
import { systemDb } from "@/lib/db";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { OperatorActionValidationError, parseOperatorReason } from "@/lib/audit";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { limitByUser } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api";
import {
  previewWalletHistoryResume, productionWalletHistoryRecoveryDeps, resumeWalletHistory,
  type ResumeOutcome, type WalletHistoryPreview,
} from "@/lib/platform/wallet-history-recovery";
import { RESUME_NOTE_REQUIRED } from "@/lib/platform/wallet-history-recovery.core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** One bounded pass (≤ 90 s) plus the reads around it. */
export const maxDuration = 120;

const NO_STORE = { "Cache-Control": "no-store" } as const;

export type HistoryResumePreviewResponse = WalletHistoryPreview;
export type HistoryResumeResponse = Extract<ResumeOutcome, { ok: true }>;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL");
  if (err) return err;
  const { id } = await ctx.params;
  const preview = await previewWalletHistoryResume(id, productionWalletHistoryRecoveryDeps(systemDb));
  if (preview.refusal?.code === "NOT_FOUND") return NextResponse.json({ error: preview.refusal.message, code: "NOT_FOUND" }, { status: 404, headers: NO_STORE });
  return NextResponse.json(preview satisfies HistoryResumePreviewResponse, { headers: NO_STORE });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL");
  if (err) return err;
  const limited = await limitByUser(auth.user.id, "platform-wallet-history-resume", { limit: 10, windowSec: 60 });
  if (limited) return limited;
  const { id } = await ctx.params;

  const body = await req.json().catch(() => null) as { reason?: unknown } | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Body must be { reason: { code, note } }." }, { status: 400, headers: NO_STORE });
  let reason;
  try { reason = parseOperatorReason(body.reason); }
  catch (e) { return NextResponse.json({ error: e instanceof OperatorActionValidationError ? e.message : "A reason is required." }, { status: 400, headers: NO_STORE }); }
  if (!reason.note) return NextResponse.json({ error: RESUME_NOTE_REQUIRED }, { status: 400, headers: NO_STORE });

  const outcome = await resumeWalletHistory({
    connectionId: id, reason,
    actor: operatorActorFrom(auth, "PLATFORM_OPS"),
    ipAddress: getClientIp(req), userAgent: req.headers.get("user-agent"),
  }, productionWalletHistoryRecoveryDeps(systemDb));
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.refusal.message, code: outcome.refusal.code, chain: outcome.chain, before: outcome.before }, { status: outcome.status, headers: NO_STORE });
  }
  return NextResponse.json(outcome satisfies HistoryResumeResponse, { headers: NO_STORE });
}
