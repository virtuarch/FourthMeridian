# Merchant Intelligence (MI1) — M0 Ratification

**Date:** 2026-07-07
**Track / ID:** `MI` prefix allocated, first member **MI1** (folder `docs/initiatives/mi1/`).
**Source of truth:** `docs/investigations/MERCHANT_INTELLIGENCE_READINESS_INVESTIGATION_2026-07-07.md`.
**Type:** Decision record (doc-only). No code, no schema in this document — M1 carries the schema.

This is the M0 ratification ruling that opens Merchant Intelligence. It records the
decisions required to begin, and nothing more. It does **not** authorize M2–M6.

---

## 1. Ratified decisions

1. **Merchant Intelligence is ready to begin.** Every architectural prerequisite named
   by MI's own entry gates has landed (FlowType single authority, MC1 provenance-column
   doctrine, desync corpus certified 2026-07-06, `merchantEntityId` seed accumulating,
   TI Phase 1 serializer/endpoint, D-TEST runner + CI). What remained was procedural:
   this ratification and the additive schema (M1). See investigation §0, §13.

2. **MI M0–M4 may run as a bounded product track in parallel with OPS-4.** MI is the next
   major *product* initiative, not a serialized successor. M1–M4 are additive,
   behavior-neutral, and file-disjoint from the OPS/PO platform lane. OPS-4 remains the
   platform lane. **Merchant Intelligence must not block OPS-4**, and OPS-4 does not block
   MI M0–M4 (only MI's deferred enrichment tier wants OPS-4's dispatcher). See §13.1–§13.2.

3. **MI owns merchant identity schema and writes.** All merchant/category schema and all
   write-time resolution belong to MI.

4. **TI owns transaction-detail read/presentation surfaces.** The relationship is a
   bounded parallel with a designed join, not a chain (TI P1 shipped before MI's persisted
   tier). See §13.1.

5. **MI M5 waits for TI P2 as its host.** The correction loop (overrides / user rules /
   provenance badge) ships *into* TI's detail surface. M5 is hard-gated on TI P2 existing;
   an M5-into-a-list-row stopgap is the one proven rework path and is disallowed.

6. **Merchant assets are NOT a separate table yet.** No `MerchantAsset` model. Enrichment
   is captured as nullable columns directly on `Merchant` (M1 storage shape only). A
   dedicated asset model now would repeat the ProviderAdapter premature-generalization
   mistake — no consumer, no storage substrate, no fetch pipeline exists. See §3.1, §12.

7. **Plaid counterparty `website` / `logo_url` should be captured, not discarded.** Plaid
   already sends `counterparties[].website` / `.logo_url` on every synced transaction and
   the platform throws them away at persistence today. M1 creates the storage shape so a
   later slice can stop discarding this. **M1 does not wire Plaid capture** — capture is a
   later slice (M4 passthrough per §6.1). See §2.1, §6.

8. **Future providers may supply equivalent enrichment through a provider-neutral
   enrichment contract.** The enrichment columns are provider-neutral: `website`,
   `logoUrl`, `enrichmentSource` (enum), `enrichmentConfidence`, `enrichedAt`. Plaid
   counterparty is the first source; Coinbase metadata, Schwab/security metadata, and a
   future external enrichment provider may later populate the same fields through a
   provider-neutral enrichment adapter. No provider-specific columns are added
   (`plaidEntityId` on `Merchant` is the sole approved provider id, mirroring the existing
   `Transaction.merchantEntityId` seed). External enrichment fetchers belong to a later
   enrichment slice **after** the OPS-4 dispatcher exists. See §6, §7.

---

## 2. Track allocation

- **`MI` track prefix** allocated in STATUS §4 (per the namespace rule: prefix + number,
  allocated only in STATUS, with a `docs/initiatives/<id>/` folder created at allocation
  time). First member **MI1**, folder `docs/initiatives/mi1/`.
- MI1 is added to the STATUS §3 initiative ledger as **Active** with M0 complete / M1 in
  scope.

---

## 3. Scope boundary for this track opening

**In scope now (M1, additive schema only):** the `Merchant`, `MerchantAlias`,
`MerchantRule` models; the `Transaction.merchantId` / `categorySource` / `categoryRuleId`
columns; the `CategorySource` / `MerchantRuleScope` / `MerchantAliasSource` /
`MerchantEnrichmentSource` enums; the six committed `TransactionCategory` additions
(Medical, Entertainment, Transport, PersonalCare, Services, Education); the nullable
`Merchant` enrichment fields; indexes and relations. Nothing reads or writes the new
schema — additive-neutrality is the M1 gate.

**Explicitly NOT authorized by this ratification:** M2 category resolver, M3 backfill,
M4 merchant resolver / Plaid-counterparty passthrough, M5 corrections, M6 read cutover,
any Plaid logo-capture wiring, import wiring, category-rewrite helper, user corrections,
transaction-detail UI, merchant logos in UI, external logo fetching, blob storage, a
`MerchantAsset` table, AI changes, notification changes, and any OPS-4 work.

**Stop after M1.** M2 does not begin under this ratification.
