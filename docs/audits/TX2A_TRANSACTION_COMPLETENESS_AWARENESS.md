# TX-2A — Transaction Completeness Awareness

**Type:** Small hardening slice (metadata propagation + honesty surface). No pagination, no loader change, no semantic change.
**Date:** 2026-07-20.
**Follows:** `TX2_TRANSACTION_BOUNDARY_HARDENING.md` + `TX2_POST_IMPLEMENTATION_REVIEW.md` (Finding 1).

---

## Why TX-2 created the boundary

TX-2 bounded the shared transaction read (`getTransactions` / `getDebtTransactions`) to the most-recent `limit` rows (default 5,000) via `take: limit + 1` + `capFetched`, and rode a `truncated` sentinel on the route payload. That removed the unbounded-load reliability/cost cliff (a Space with tens of thousands of transactions could otherwise blow the serverless response ceiling). For any Space **at or under** the cap the read is byte-identical to before — same rows, same folds.

**The gap TX-2A closes:** the route returned `truncated`, but `lib/space/use-space-data.ts` read only `data.transactions` and **silently dropped `truncated`**. So on the workspace path (Cash Flow, Liquidity, Transactions tab) a Space with >5,000 transactions rendered incomplete multi-year history while *appearing* complete — the exact silent-incompleteness the post-implementation review flagged (Finding 1).

## Why TX-2A only surfaces completeness

TX-2A is deliberately **honesty-only**. It does not fetch more, does not paginate, does not touch a single calculation. The only new data flow is:

```
route { truncated, limit }  →  use-space-data.transactionsMeta  →  renderCtx  →  workspace  →  <TransactionCoverageNote/>
```

The charts and totals continue to fold over exactly the rows they were already given (TX-2 semantics). When a population is complete (`truncated=false`) the note renders **nothing** — the surface is visually identical to before TX-2A. Only when the read was capped does a muted caveat appear.

Workspace-safe vocabulary: the hook exposes a `TransactionsCoverage { truncated, limit }` — "coverage incomplete", not "the loader returned limit + 1". No raw loader concern leaks upward.

## Why TX-3 remains separate

TX-2A makes the boundary **honest**; TX-3 makes browsing **complete**. Letting a user actually reach transactions older than the most-recent 5,000 needs a server-paged API (cursor + server-side filter/search) and a client migration off the "one array in React state" model — a larger, higher-risk change to the Transactions UX. TX-2A ships now (tiny blast radius, zero semantic risk) so no heavy user is silently misled in beta; TX-3 is scheduled when real usage confirms browsing (not the intelligence loads TX-2 already fixed) is the bottleneck. TX-2A does not block or complicate TX-3 — the same `truncated` signal it surfaces is what a "load older / see all" affordance would hang off.

---

## Files changed

**New:**
- `lib/transactions/coverage-note.ts` — pure copy resolver `coverageMessage(coverage, variant)` (server-only-free, zero imports). `browse` → "Showing the most recent N transactions."; `history` → "Historical view is based on available transaction history. Some older transactions are not included."; returns **null** when not truncated (⇒ no indicator).
- `components/space/trust/TransactionCoverageNote.tsx` — the ONE presentational surface. Reads the coverage meta + the resolver, renders a muted `role="note"` line, renders nothing when complete. No calculation, no transaction inspection.
- `lib/transactions/coverage-note.test.ts` — proofs (see below).

**Propagation (metadata only):**
- `app/api/spaces/[id]/transactions/route.ts` — payload now carries `limit` alongside `truncated` (so the note names the real cap).
- `lib/space/use-space-data.ts` — new `transactionsMeta: TransactionsCoverage | null` state, set from the tx fetch (`{ truncated, limit }`), cleared on the currency/refresh re-fetch paths, exposed on `SpaceData`. **This is the exact line that previously discarded `truncated`.**
- `components/dashboard/SpaceDashboard.tsx` — destructures `transactionsMeta`, threads it into `renderCtx`, passes it to the Transactions tab.
- `components/space/workspaces/workspaceRenderers.tsx` — `WorkspaceRenderCtx.transactionsMeta`; passed to Cash Flow + Liquidity renderers.

**Surfaces (render the note where meaningful):**
- `components/space/workspaces/TransactionsWorkspace.tsx` — `browse` note above the panel.
- `components/space/widgets/cashflow/CashFlowWorkspace.tsx` — `history` note in the Activity/History block. `buildCashFlowSpaceData` is **not** passed the meta (fold untouched).
- `components/space/widgets/liquidity/LiquidityWorkspace.tsx` — `history` note on the transaction-derived "What changed" block only (Liquidity's present-day balance/runway stats come from snapshots, so the note is scoped to the one transaction-derived panel).

## Surfaces affected

| Surface | Note | Shown when |
|---|---|---|
| Transactions workspace | "Showing the most recent 5,000 transactions." | `truncated` only |
| Cash Flow (Activity/History block) | "Historical view is based on available transaction history…" | `truncated` only |
| Liquidity ("What changed" block) | same history caveat | `truncated` only (transaction-derived block) |

No note is shown anywhere for a complete (`≤ 5,000`) population.

## Proof financial calculations did not change

- **Pure test** (`coverage-note.test.ts`, all green): under the cap `coverageMessage → null` (no indicator); over the cap the honest strings appear; the resolver imports nothing; and `buildCashFlowSpaceData` is asserted **not** to receive `transactionsMeta` (fold input unchanged).
- **Semantic guards unchanged and green:** `financial-doctrine-oracle` (265), `serialize.golden`, `cash-flow`, `cash-flow-space-data`, `transactions-bounding`, `transactions.population` — all pass.
- **Parity/shell green:** `CashFlowWorkspace.test.ts`, `space-shell.test.ts`.
- **tsc + eslint:** clean on all touched files. Full unit suite: clean-env baseline unchanged (only the pre-existing `marketing-boundary` fail from concurrent-session files; the investments/coingecko fails are env-dependent, not TX-2A).
- **Browser:** Transactions tab renders with 3,979 transactions (< cap) → **no coverage note** — visually confirming the "no indicator under the cap" invariant.

## Is TX-2 now fully closed?

**Yes.** TX-2 removed the unbounded-load reliability failure; TX-2A closes its one review residual (Finding 1) by making the boundary honest wherever it can now silently under-report. The remaining items are genuinely TX-3 (server-paged browsing/search + full historical folds) and TX-4 (dead unbounded `getInvestmentTransactions`, stale doc-comments) — neither is a completeness-honesty gap. **No continuation into TX-3.**
