/**
 * lib/crypto/btc-discovery-core.ts
 *
 * Wallet Provider v4 — PURE core of resumable, bounded xpub address discovery.
 * No DB, no network, so the behemoth-wallet resumability logic is unit-tested
 * offline (mirrors the btc-explorer pure / btc-sync impure split). The DB writes
 * + batch lookup that compose these helpers live in lib/crypto/btc-sync.ts.
 *
 * Discovery scans BIP44 receive (0) and change (1) branches. A checkpoint tracks,
 * per branch, the next index to scan and the running consecutive-unused count,
 * plus a done flag once the gap limit is satisfied. Each run advances a BOUNDED
 * number of indices per branch and resumes from the checkpoint — a wallet with
 * hundreds/thousands of used addresses degrades into staged sync, never a
 * one-shot full scan.
 */

export interface DiscoveryCursor {
  r: number;     // next receive index to scan
  c: number;     // next change index to scan
  ur: number;    // running consecutive-unused count, receive
  uc: number;    // running consecutive-unused count, change
  rDone: boolean;
  cDone: boolean;
  used: number;  // cumulative count of USED (on-chain-active) addresses found
}

export interface AddrRef { address: string; branch: number; index: number }

/** Parse the checkpoint from Connection.cursor JSON, or start fresh. */
export function readDiscoveryCursor(raw: string | null): DiscoveryCursor {
  if (raw) {
    try {
      const p = JSON.parse(raw) as Partial<DiscoveryCursor>;
      if (typeof p.r === "number") {
        return {
          r: p.r || 0, c: p.c || 0, ur: p.ur || 0, uc: p.uc || 0,
          rDone: !!p.rDone, cDone: !!p.cDone, used: p.used || 0,
        };
      }
    } catch { /* not a discovery cursor — start fresh */ }
  }
  return { r: 0, c: 0, ur: 0, uc: 0, rDone: false, cDone: false, used: 0 };
}

/**
 * PURE — derive this run's bounded probe window (≤ `step` new indices per
 * not-yet-done branch). `deriveAt(branch, index)` is the caller's address deriver.
 */
export function planXpubStep(
  deriveAt: (branch: number, index: number) => string,
  cursor: DiscoveryCursor,
  step: number,
): AddrRef[] {
  const out: AddrRef[] = [];
  if (!cursor.rDone) for (let k = 0; k < step; k++) out.push({ address: deriveAt(0, cursor.r + k), branch: 0, index: cursor.r + k });
  if (!cursor.cDone) for (let k = 0; k < step; k++) out.push({ address: deriveAt(1, cursor.c + k), branch: 1, index: cursor.c + k });
  return out;
}

/**
 * PURE — walk a planned window in index order applying the gap rule; return the
 * advanced checkpoint, the addresses to persist (used ones), and whether the whole
 * scan is complete. Never re-scans done branches. This is what makes discovery
 * resumable and duplicate-free across runs.
 */
export function applyXpubStep(
  cursor: DiscoveryCursor,
  plan: AddrRef[],
  isUsed: (address: string) => boolean,
  gap: number,
): { cursor: DiscoveryCursor; toPersist: AddrRef[]; complete: boolean } {
  const c: DiscoveryCursor = { ...cursor };
  const toPersist: AddrRef[] = [];

  if (!c.rDone) {
    for (const ref of plan.filter((p) => p.branch === 0)) {
      if (isUsed(ref.address)) { toPersist.push(ref); c.ur = 0; } else c.ur += 1;
      c.r = ref.index + 1;
      if (c.ur >= gap) { c.rDone = true; break; }
    }
  }
  if (!c.cDone) {
    for (const ref of plan.filter((p) => p.branch === 1)) {
      if (isUsed(ref.address)) { toPersist.push(ref); c.uc = 0; } else c.uc += 1;
      c.c = ref.index + 1;
      if (c.uc >= gap) { c.cDone = true; break; }
    }
  }
  c.used = cursor.used + toPersist.length; // cumulative used addresses across runs
  return { cursor: c, toPersist, complete: c.rDone && c.cDone };
}
