/**
 * lib/debt/user-terms.ts
 *
 * The CLIENT half of the user-declared debt-facts write path. Two facts, two
 * existing server authorities, no new store:
 *
 *   APR           → PATCH /api/accounts/[id]/debt-profile  { apr }
 *                   (DebtProfile.apr — the source `resolveEffectiveDebtTerms`
 *                   ranks FIRST, so a saved value is the value every consumer
 *                   reads: Space widgets, the AI account assembler, the L1
 *                   scenario ledger's liability lines, the forecast obligation.)
 *   credit limit  → PATCH /api/accounts/[id]               { creditLimit }
 *   credit score  → PATCH /api/credit/update-fico          { score }
 *                   (append-only CreditScore time series, user-scoped.)
 *
 * Pure parsing + a fetch-injected save, so both are testable without a DOM and
 * the widgets hold no validation rule of their own. Nothing here caches a saved
 * value: after a save the caller broadcasts the refresh and re-reads the truth.
 *
 * ⚠️ A blank APR is REJECTED, not read as 0. Unknown is a state a user leaves by
 * typing a number; "0" is a real rate and is accepted as one.
 */

export type ParsedNumber = { ok: true; value: number } | { ok: false; error: string };

function parseDecimal(raw: string): number | null {
  const t = raw.trim().replace(/[%$,\s]/g, "");
  if (t === "" || !/^\d*\.?\d+$|^\d+\.?\d*$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** "24.99", "24.99%", " 0 " → a percent in 0–100. Blank / text / out of range → error. */
export function parseAprInput(raw: string): ParsedNumber {
  const n = parseDecimal(raw);
  if (n === null) return { ok: false, error: "Enter an APR as a number, e.g. 24.99" };
  if (n < 0 || n > 100) return { ok: false, error: "APR must be between 0 and 100" };
  return { ok: true, value: Math.round(n * 1000) / 1000 };
}

/** "$5,000" → 5000. Must be > 0 (the route's own rule). */
export function parseCreditLimitInput(raw: string): ParsedNumber {
  const n = parseDecimal(raw);
  if (n === null || !(n > 0)) return { ok: false, error: "Enter a credit limit above 0" };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

/** A whole FICO score, 300–850 (the route's own rule). */
export function parseCreditScoreInput(raw: string): ParsedNumber {
  const t = raw.trim();
  if (!/^\d{3}$/.test(t)) return { ok: false, error: "Enter a score between 300 and 850" };
  const n = Number(t);
  if (n < 300 || n > 850) return { ok: false, error: "Enter a score between 300 and 850" };
  return { ok: true, value: n };
}

export type SaveResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function patchJson(url: string, body: unknown, fetchImpl: FetchLike): Promise<SaveResult<Record<string, unknown>>> {
  try {
    const res = await fetchImpl(url, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const error = res.status === 403
        ? "Only the account's owner can change this"
        : typeof json.error === "string" ? json.error : "Couldn't save — try again";
      return { ok: false, error };
    }
    return { ok: true, data: json };
  } catch {
    return { ok: false, error: "Network error — try again" };
  }
}

/** Persist a user-declared APR to the canonical liability authority (DebtProfile.apr). */
export async function saveAccountApr(accountId: string, aprPct: number, fetchImpl: FetchLike = fetch): Promise<SaveResult> {
  const r = await patchJson(`/api/accounts/${encodeURIComponent(accountId)}/debt-profile`, { apr: aprPct }, fetchImpl);
  return r.ok ? { ok: true, data: undefined } : r;
}

/** Persist a user-declared credit limit (FinancialAccount.creditLimit). */
export async function saveAccountCreditLimit(accountId: string, limit: number, fetchImpl: FetchLike = fetch): Promise<SaveResult> {
  const r = await patchJson(`/api/accounts/${encodeURIComponent(accountId)}`, { creditLimit: limit }, fetchImpl);
  return r.ok ? { ok: true, data: undefined } : r;
}

/** Append a user-reported credit score. Returns the row the server recorded. */
export async function saveCreditScore(
  score: number,
  fetchImpl: FetchLike = fetch,
): Promise<SaveResult<{ score: number; recordedAt: string | null }>> {
  const r = await patchJson("/api/credit/update-fico", { score, source: "manual" }, fetchImpl);
  if (!r.ok) return r;
  return {
    ok: true,
    data: {
      score:      typeof r.data.score === "number" ? r.data.score : score,
      recordedAt: typeof r.data.recordedAt === "string" ? r.data.recordedAt : null,
    },
  };
}
