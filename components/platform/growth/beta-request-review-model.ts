/**
 * components/platform/growth/beta-request-review-model.ts  (PB-6 — pure model)
 *
 * The wiring and the words behind Beta Access request review: which routes each
 * action calls, in what order, and EXACTLY what the operator is told when part
 * of it fails. DOM-free so it is tested directly (beta-request-review.test.ts).
 *
 * DENY vs DENY AND BLOCK. A plain Deny never blocks (unless the request already
 * carries a SUSPICIOUS verdict — then the deny route itself creates the block,
 * and the copy says so). "Deny and block" = the two EXISTING routes in order:
 *   1. POST …/deny                 (status only)
 *   2. POST …/risk-review SUSPICIOUS (on a DENIED request: blocks the hashed mailbox)
 * Deny FIRST, deliberately: if step 2 fails the request is exactly a plain
 * denial — a valid, final-for-now state the operator can finish with "Block
 * now" (the same step-2 call). The other order could leave a PENDING request
 * marked SUSPICIOUS, which silently turns a LATER plain Deny into a block — the
 * very surprise PB-6 removes. Both routes take the mailbox advisory lock then
 * the request row lock, so a concurrent writer serialises with either step.
 */

import type { OperatorReasonFieldCode } from "../widgets/OperatorReasonField";
import type {
  BetaRequestBlockState, BetaRequestStatusValue, BetaRiskReviewStatusValue, BlocklistAvailability,
} from "@/lib/platform/growth/beta-risk-types";

export const REQUESTS_URL = "/api/platform/growth-revenue/requests";
export const denyUrl = (id: string) => `${REQUESTS_URL}/${encodeURIComponent(id)}/deny`;
export const riskReviewUrl = (id: string) => `${REQUESTS_URL}/${encodeURIComponent(id)}/risk-review`;

export interface PostResult { ok: boolean; status: number; body: Record<string, unknown> }
/** Never throws: a network failure is `{ ok: false, status: 0 }`. */
export type Poster = (url: string, body: unknown) => Promise<PostResult>;

export const postJson: Poster = async (url, body) => {
  try {
    const r = await fetch(url, {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
    });
    const parsed = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: r.ok, status: r.status, body: parsed && typeof parsed === "object" ? parsed : {} };
  } catch {
    return { ok: false, status: 0, body: {} };
  }
};

export interface VerdictReason { code: OperatorReasonFieldCode; note?: string }

/** One outcome banner: what happened, in words, and whether "Block now" can finish the job. */
export interface ReviewOutcome {
  tone: "success" | "warning" | "error";
  message: string;
  /** Denied but not blocked, and a retry could block: offer "Block now" (POST SUSPICIOUS). */
  offerBlockNow: boolean;
}

const BLOCKLIST_UNAVAILABLE = "BLOCKLIST_UNAVAILABLE";
const isBlocklistUnavailable = (r: PostResult) => r.status === 409 && r.body.code === BLOCKLIST_UNAVAILABLE;

/** The server's own error, or a status-shaped fallback. */
export function failureText(r: PostResult): string {
  if (r.status === 0) return "the request did not reach the server (network error)";
  const e = typeof r.body.error === "string" && r.body.error.trim() ? r.body.error.trim().replace(/\.$/, "") : null;
  return e ?? `the server answered ${r.status}`;
}

export const BLOCKLIST_UNAVAILABLE_TEXT =
  "the blocklist is unavailable in this environment (its key is not configured), so a block cannot be recorded";

const blockedNow = (b: unknown) => {
  const blocked = (b as { blocked?: unknown } | undefined)?.blocked;
  return blocked === "created" || blocked === "alreadyBlocked";
};

/** Deny (status only) — the existing route, nothing else. */
export async function runDeny(id: string, post: Poster = postJson): Promise<ReviewOutcome> {
  const d = await post(denyUrl(id), {});
  if (!d.ok) {
    if (isBlocklistUnavailable(d)) {
      return { tone: "error", offerBlockNow: false,
        message: `Not denied — this request is already marked Suspicious, so denying it must also block the address, and ${BLOCKLIST_UNAVAILABLE_TEXT}. Nothing was changed.` };
    }
    return { tone: "error", offerBlockNow: false, message: `Not denied — ${failureText(d)}. Nothing was changed.` };
  }
  return d.body.identifierBlocked === true
    ? { tone: "success", offerBlockNow: false, message: "Denied. The address is blocked because this request was already marked Suspicious." }
    : { tone: "success", offerBlockNow: false, message: "Denied. The address is not blocked — it can request access again." };
}

/**
 * Deny and block — deny FIRST, then the SUSPICIOUS verdict (header). Every
 * partial outcome names what committed and what did not.
 */
export async function runDenyAndBlock(id: string, reason: VerdictReason, note: string | null, post: Poster = postJson): Promise<ReviewOutcome> {
  const d = await post(denyUrl(id), {});
  if (!d.ok) {
    if (isBlocklistUnavailable(d)) {
      return { tone: "error", offerBlockNow: false,
        message: `Not denied and not blocked — ${BLOCKLIST_UNAVAILABLE_TEXT}. Nothing was changed.` };
    }
    return { tone: "error", offerBlockNow: false, message: `Not denied and not blocked — ${failureText(d)}. Nothing was changed.` };
  }
  const v = await post(riskReviewUrl(id), { status: "SUSPICIOUS", reason, ...(note ? { note } : {}) });
  if (!v.ok) {
    if (isBlocklistUnavailable(v)) {
      return { tone: "warning", offerBlockNow: true,
        message: `Denied, but NOT blocked — ${BLOCKLIST_UNAVAILABLE_TEXT}. The denial stands; future requests from this address are not dropped until it is blocked.` };
    }
    return { tone: "warning", offerBlockNow: true,
      message: `Denied, but NOT blocked — recording the Suspicious verdict failed (${failureText(v)}). The denial stands; future requests from this address are not dropped until it is blocked.` };
  }
  if (blockedNow(v.body.blocklist) || d.body.identifierBlocked === true) {
    return { tone: "success", offerBlockNow: false, message: "Denied and blocked. Future requests from this address are silently dropped." };
  }
  return { tone: "warning", offerBlockNow: false,
    message: "Denied and marked Suspicious, but no block was written — the blocklist is not configured in this environment (blocks are skipped outside Production)." };
}

/** One verdict through the existing risk-review POST (Block address / Clear block / Mark …). */
export async function runVerdict(
  id: string, status: BetaRiskReviewStatusValue, reason: VerdictReason, note: string | null,
  ctx: { requestStatus: BetaRequestStatusValue }, post: Poster = postJson,
): Promise<ReviewOutcome> {
  const v = await post(riskReviewUrl(id), { status, reason, ...(note ? { note } : {}) });
  const label = VERDICT_LABEL[status];
  if (!v.ok) {
    if (isBlocklistUnavailable(v)) {
      return { tone: "error", offerBlockNow: false, message: `Not recorded — ${BLOCKLIST_UNAVAILABLE_TEXT}. Nothing was changed.` };
    }
    return { tone: "error", offerBlockNow: false, message: `Not recorded — ${failureText(v)}. Nothing was changed.` };
  }
  const bl = (v.body.blocklist ?? {}) as { blocked?: unknown; removed?: unknown };
  if (status === "SUSPICIOUS") {
    if (ctx.requestStatus === "PENDING" || ctx.requestStatus === "APPROVED") {
      return { tone: "success", offerBlockNow: false,
        message: `Marked ${label}. Nothing is blocked yet — only a denied request blocks its address (denying this request now will block it).` };
    }
    if (ctx.requestStatus === "REDEEMED") {
      return { tone: "success", offerBlockNow: false, message: `Marked ${label}. Advisory only — a joined request is never blocked by a verdict.` };
    }
    if (bl.blocked === "created") return { tone: "success", offerBlockNow: false, message: "Marked Suspicious and blocked. Future requests from this address are silently dropped." };
    if (bl.blocked === "alreadyBlocked") return { tone: "success", offerBlockNow: false, message: "Marked Suspicious. The address was already blocked; the block stands." };
    return { tone: "warning", offerBlockNow: false,
      message: "Marked Suspicious, but no block was written — the blocklist is not configured in this environment (blocks are skipped outside Production)." };
  }
  const removed = typeof bl.removed === "number" ? bl.removed : 0;
  return removed > 0
    ? { tone: "success", offerBlockNow: false, message: `Marked ${label}. The block this request caused was removed — the address can request access again.` }
    : { tone: "success", offerBlockNow: false, message: `Marked ${label}. This request had no active block to remove.` };
}

export const VERDICT_LABEL: Record<BetaRiskReviewStatusValue, string> = {
  LEGITIMATE: "Legitimate", SUSPICIOUS: "Suspicious", UNREVIEWED: "Unreviewed",
};

export const STATUS_LABEL: Record<BetaRequestStatusValue, string> = {
  PENDING: "Pending", APPROVED: "Approved (invited)", DENIED: "Denied", REDEEMED: "Joined",
};

/** The two labelled deny actions' explanations (the owner's surprise, answered on the button). */
export const DENY_COPY = "Deny — status only. This does not block this address: it can request access again.";
export const DENY_AND_BLOCK_COPY = "Deny and block — denies the request and marks it Suspicious: future requests from this address are silently dropped.";

/** What a PLAIN deny will do, given the request's latest verdict (a SUSPICIOUS verdict makes the deny route block). */
export function plainDenyEffect(latest: BetaRiskReviewStatusValue | null | undefined): string {
  return latest === "SUSPICIOUS"
    ? "This request is already marked Suspicious, so denying it WILL block this address — future requests from it are silently dropped."
    : "Denying changes the status only. It does not block this address: it can request access again.";
}

/** What recording this verdict will do, said before the operator confirms. */
export function verdictEffect(status: BetaRiskReviewStatusValue, requestStatus: BetaRequestStatusValue, block: BetaRequestBlockState): string {
  if (status === "SUSPICIOUS") {
    if (requestStatus === "DENIED") {
      return block.state === "BLOCKED"
        ? "The address is already blocked; the block stands. The denial stays final for every invitation path."
        : "Blocks this address: future requests from it are silently dropped, and the denial becomes final for every invitation path.";
    }
    if (requestStatus === "REDEEMED") return "Advisory only — a joined request is never blocked by a verdict.";
    return "Blocks nothing now. If this request is later denied (Deny — a Revoke does not block), the deny will block the address.";
  }
  return block.state === "BLOCKED"
    ? "Clears the block this request caused — the address can request access again — and lifts the final denial."
    : "Advisory only — this request causes no active block.";
}

/** The block line in the detail panel. Never an HMAC or an address — the state and two instants. */
export function blockStateText(block: BetaRequestBlockState, availability: BlocklistAvailability): string {
  if (block.state === "BLOCKED") return `Blocked by this request — expires ${block.expiresAt.slice(0, 10)}`;
  if (availability === "NOT_CONFIGURED") return "Not blocked — the blocklist is not configured in this environment";
  if (availability === "UNAVAILABLE") return "Not blocked — the blocklist is unavailable (no usable key)";
  return "Not blocked by this request";
}

export type ReviewAction =
  | "deny" | "denyAndBlock" | "blockAddress" | "clearBlock"
  | "markLegitimate" | "markSuspicious" | "markUnreviewed";

/**
 * UI-001 — the write actions a request offers. A READ holder gets NONE (they
 * see the state as text, never a button that 403s). PENDING: the two labelled
 * denies. DENIED: Block address, or Clear block when it is blocked. Every
 * status: the three verdicts.
 */
export function reviewActions(canWrite: boolean, status: BetaRequestStatusValue, block: BetaRequestBlockState): ReviewAction[] {
  if (!canWrite) return [];
  const out: ReviewAction[] = [];
  if (status === "PENDING") out.push("deny", "denyAndBlock");
  if (status === "DENIED") out.push(block.state === "BLOCKED" ? "clearBlock" : "blockAddress");
  out.push("markLegitimate", "markSuspicious", "markUnreviewed");
  return out;
}

export const VIEW_LABEL = { PENDING: "Pending", APPROVED: "Approved", DENIED: "Denied", REDEEMED: "Joined", ALL: "All" } as const;
