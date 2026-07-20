# V25-CLOSE-3 — Honesty Polish

**Status:** IMPLEMENTED.
**Date:** 2026-07-20.
**Scope:** truthfulness / readiness only — no architecture redesign, no new authorities, no v2.6 work, no provider expansion, no UX-CLOSE interaction changes.
**Baseline:** `feature/v2.5-spaces-completion`, on top of the closed v2.5 architecture boundary (V25-CLOSE-2 `6490975`) and the concurrent UX-CLOSE arc (`eec35b4`).

> Goal: the product never presents uncertain, incomplete, or unaudited information as authoritative.

**Verification:** 321/321 tests, `npm run lint` exit 0, `tsc --noEmit` exit 0. Every guard added was mutation-tested. No TX (`flow-classifier.ts` untouched), Timeline, or UX-CLOSE interaction file was modified.

---

## Part 1 — FX unavailable disclosure

### The gap

`convertMoney` (`lib/money/convert.ts`) already distinguished two very different "estimated" cases in its return value, but the single `estimated: boolean` collapsed them at every surface:

- **estimated (stale):** a real rate was applied but walked back in time — value is roughly right. `conversion !== null`.
- **unavailable:** NO rate applied; the amount is **native units passed through, labelled as the display currency** (rate missing, or null-residue currency). `conversion === null && estimated`. `¥1,000,000` renders as `$1,000,000` — wrong by ~150×.

Both showed the same quiet `≈ / est.` marker. That marker reads as *rounding*, not *"this is not a converted value."*

### What changed (no math touched)

1. **`fxDisclosureOf(c: ConvertedMoney): "exact" | "estimated" | "unavailable"`** (`lib/money/convert.ts`) — a pure classifier derived entirely from the fields `convertMoney` already sets. No new FX authority; it reads the existing signal more precisely.
2. **`ConvertedTotal.unconverted: boolean`** (`lib/money/types.ts`, set in `convertAndSum`) — preserves the "at least one member had no rate" fact through the aggregate fold, which the `estimated` OR previously lost. Additive; `estimated` unchanged; amounts byte-identical.
3. **`components/ui/FxUnavailableNote.tsx`** — the unmistakable disclosure, in the existing quiet money/trust visual language: *"Exchange rate unavailable — showing native amounts, not a converted value."* A note **below** the value, because the inline glyph is exactly what proved insufficient.
4. **`components/charts/NetWorthChartModal.tsx`** — the primary headline surface now renders `FxUnavailableNote` when any point was *unavailable*, and keeps the quiet `≈ estimated (older) rate` marker only for the softer walked-back case. (The old copy said "no FX rate available" even for walked-back values, which was imprecise in the other direction; both are now honest.)

### Deliberately unchanged

- **Conversion math** — amounts are identical; only the disclosure derived from them is finer.
- **The perspective/lens aggregate surfaces (`PerspectivesWidget`)** keep `est.` The lens layer carries only a boolean `estimated`; threading the finer signal through the perspective engine is an engine change, i.e. architecture — out of scope. Documented as the honest boundary rather than half-threaded.

### Tests (mutation-verified)

- `lib/money/fx-disclosure.test.ts` (19 checks): classifier for identity/exact/walked-back/miss/null-residue; `convertAndSum.unconverted` propagation; and **"successful conversions unchanged"** — an exact-rate conversion classifies `exact`, converts the amount, and an all-exact total is neither estimated nor unconverted.
- `components/charts/fx-disclosure-surface.test.ts` (6 checks): **"missing FX cannot render without disclosure"** — the surface must consult `fxDisclosureOf`, derive the unavailable signal, and *render* `FxUnavailableNote` gated on it. Mutation: replacing the note with `null` fails the guard.

---

## Part 2 — BTC classification exception guard

### The gap

The architecture-closure investigation named `lib/crypto/btc-sync.ts` a *second* classification writer: it hand-authors `flowType`/`category`/`classificationReason` and writes NULL `classifierVersion`, never calling `classifyFlow`. This is correct — on-chain movements carry no PFC, descriptor, or counterparty name, so the classifier's evidence ladder has nothing to stand on. But the exception lived only in prose. v2.5 doctrine: **exceptions become executable policy.**

### What changed

1. **A sentinel in `btc-sync.ts`** — `buildTransactionRow` now carries a `FLOW-CLASSIFIER-EXCEPTION (btc-sync)` marker stating precisely why it is off-classifier and pointing at the guard.
2. **`lib/transactions/flow-classifier-authority.test.ts`** — scans `lib/` + `app/` for files that hand-write a literal `flowType:` next to a Transaction write. Each must **either** route through the classifier authority (`buildFlowWriteFields` / `recomputeFlowFields` / `computeFlowFields` / `classifyFlow`) **or** be the single approved exception, which must (a) carry its sentinel and (b) genuinely be off-classifier. Canonical writers that spread `buildFlowWriteFields()` correctly aren't flagged — they delegate, not hand-write.

Does **not** force BTC through the classifier and does **not** remove the special path — it fences it.

### Tests (mutation-verified)

`flow-classifier-authority.test.ts` (9 checks). Mutations, both required by the brief:
- **Remove the exception boundary** (delete the btc-sync sentinel) → **FAIL** (`carries its documented sentinel`).
- **Add a new unapproved classification writer** (a file hand-writing `flowType` off-classifier) → **FAIL** (`routes ... through the classifier authority, or is an approved exception`).

---

## Part 3 — Admin Plaid audit logging

### The gap

Three SYSTEM_ADMIN Expand-History routes mutate real customer infrastructure with **zero** forensic record (the security audit found this; it is four routes counting `diagnostics`, but the three *mutating* ones are the target here):

- `retire-superseded-item` — soft-deletes connections + `/item/remove`.
- `exchange-expanded-history-token` — exchanges a `public_token` into a **new PlaidItem under the owner's context** (highest impact).
- `expand-history-token` — creates a fresh Plaid Link token.

### What changed

Each route now writes one audit row **on the success path**, following the established operator-audit sibling pattern (`app/api/platform/platform-ops/.../request-reauth`): `db.auditLog.create({ data: { performedByAdminId, action, metadata } })`.

- **Actor** — `admin.id` (captured from `requireSystemAdmin`, previously discarded) as `performedByAdminId`.
- **Action** — three new typed constants in `lib/audit-actions.ts`: `ADMIN_PLAID_ITEM_RETIRED`, `ADMIN_PLAID_HISTORY_TOKEN_EXCHANGED`, `ADMIN_PLAID_HISTORY_TOKEN_CREATED`.
- **Target / metadata** — item ids, owner user id, institution id, outcome counts. **No `public_token`, `access_token`, or `link_token` — ever.**
- **Timestamp** — `AuditLog.createdAt` default.

Authorization is unchanged and unweakened. The guard returns **before** any state change, so a rejected caller cannot reach the audit write — no misleading record for a failed authorization.

### Tests (mutation-verified)

`lib/admin-plaid-audit.test.ts` (33 checks): each route writes an audit row, uses the typed action, attributes the admin, **authorizes before it audits** (source-order: `if (err) return err` precedes the create), and **logs no token** (checked against the exact balanced `auditLog.create(...)` argument). Mutations: removing a write → FAIL; injecting `linkToken` into the payload → FAIL.

---

## Part 4 — recordAuditEvent decision

### Decision: **B) Remove** the unused adapter; keep `buildAuditData` as the one shape authority.

The investigation found `recordAuditEvent` had **zero** production callers while ~80 sites wrote `db.auditLog.create` directly. Applying the same doctrine used throughout v2.5 — *one authority, one path*, and *never ship an authority without a clear consumer* (TX-3):

- **Full promotion (A)** would mean migrating every direct writer to route through `recordAuditEvent` — an audit-layer **architecture migration** across ~80 sites, explicitly out of scope for an honesty slice, and a large blast radius across concurrent sessions.
- Leaving it in place presented a **false "adopted authority"** — the exact ambiguity Part 4 forbids.
- **`buildAuditData`** (the pure shape helper it wrapped) has real consumers — `lib/auth.ts`, pinned by `lib/security-surface.test.ts` — and stays as the single shape authority. Part 3's new writes use the established operator pattern, consistent with their direct siblings (`platform-grants`, `request-reauth`), which is what keeps this **non-partial**: after the change there is exactly one shape authority with consumers and zero do-nothing adapters.

This is not a half state: the ambiguity was *only* the zero-consumer adapter, which is gone. The two existing internally-consistent conventions (auth/security family via `buildAuditData`; operator family via raw create) are unchanged and untouched.

### Tests (mutation-verified)

`lib/audit-authority.test.ts` (5 checks): `buildAuditData` works and folds actorType/result; `recordAuditEvent` is **not defined** and **not referenced** anywhere; `buildAuditData` retains ≥1 consumer (so the kept authority never becomes the same anti-pattern). Mutation: reintroducing `recordAuditEvent` → FAIL.

---

## What remained intentionally unchanged

- **All conversion math** and the `never exclude / never throw` FX doctrine.
- **The btc-sync special path** — fenced, not removed or rerouted.
- **Authorization** on the admin routes — audit was added *around* it, nothing weakened.
- **The ~80 direct `auditLog.create` sites** — migrating them is architecture, not honesty polish. `buildAuditData` remains available for a future consolidation slice.
- **Perspective/lens aggregate FX disclosure** — the finer signal isn't threaded through the engine (architecture); the honest boundary is documented.

---

## Remaining v2.5 items

**Architecture: complete (class A empty)** — unchanged by this slice. Everything below is polish / readiness / evolution.

- **Beta readiness (unchanged):** LLM/provider disclosure in `/legal/ai`; Sentry; uptime monitor; backup-restore drill; `invite_only` verification; Turnstile keys; Plaid environment; Resend/domain; published support address. The `admin/plaid/diagnostics` route (read-only, non-mutating) may still warrant an audit line — noted, not done here.
- **Product evolution (v2.6+):** `SpaceSnapshot` rule-version stamp + formula-migration mode (the highest-leverage evolution fix); thread the FX `unavailable` signal through the perspective engine so lens aggregates can disclose it too; conversation state; `AiAdvice` write path.
- **V25-CLOSE-4 (template truthfulness):** not started, per instruction.
- **Cleanup:** dead exports (`getHoldings`, `legacyTabPerspective`, `lib/providers/catalog.ts`); `.fuse_hidden*` orphans; move `lib/ai/visibility.ts` → `lib/visibility.ts`.

---

## Doctrine decisions recorded

1. **FX honesty is a classification, not a boolean.** `unavailable` (native pass-through) is categorically different from `estimated` (stale rate) and gets categorically stronger disclosure. Derived from existing signal — no new authority.
2. **Exceptions are executable policy.** The btc-sync off-classifier path is now fenced by a test, not a comment.
3. **High-impact operator actions are always attributable.** Every admin mutation of customer infra records actor + action + target, never secrets.
4. **No authority without a consumer.** The zero-consumer audit adapter was removed rather than left as false-signal; the consumed shape helper stays.
