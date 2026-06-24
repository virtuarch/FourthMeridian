# D2 Step 4D-2 — Excel Import Investigation

Status: **read-only investigation. No code, schema, migration, route, or UI change.** `D2_ROADMAP.md` is left untouched, same convention as every prior 4D-series investigation (4D, 4D-1) — any roadmap update reflecting 4D-2's existence is deferred to whenever this slice's own implementation is requested and approved. `lib/transactions/fingerprint.ts` was read but not modified; every reference to it below is a reuse recommendation, not a change.

Branch: `feature/phase-2-architecture`. Baseline: `v2.3.0`. Builds on `D2_STEP4D_IMPORT_PIPELINE_INVESTIGATION.md` §7 (which already named "4D-2 — Excel import. Reuses 4D-1's pipeline; only the Parse stage differs") and on the now-shipped 4D-1 CSV MVP: `ImportBatch.matchedCount`/`failedCount` (migrated), `lib/imports/csv.ts`, `lib/transactions/fingerprint.ts`, `app/api/accounts/[id]/import/route.ts` (all confirmed present and unmodified in this pass — see scope verification at the end).

---

## 1. CSV pipeline reuse analysis

`lib/imports/csv.ts` already separates into two kinds of logic:

- **Source-agnostic** (operates on already-normalized values, doesn't care what produced them): `detectColumns(headers: string[])`, `mapCategory(raw)`, the `CsvColumnMap`/`NormalizedRow`/`FingerprintOutcome` types, and — the one that matters most — `resolveFingerprintOutcome(financialAccountId, date, amount, merchant, externalTransactionId)`. This function is the entire CREATE/MATCH/SKIP decision engine, it touches the DB, and nothing about its signature or body is CSV-specific. It should be called by Excel import exactly as CSV calls it today: same five arguments, same three-outcome contract.
- **CSV-format-specific** (operates on raw file bytes/text): `parseCsvText` (wraps `Papa.parse`), `parseDate`/`parseAmount` (string-based — strip `$`/commas/parens, regex-match ISO/US date forms), `normalizeRow` (glues a raw `Record<string,string>` row + the column map into a `NormalizedRow`).

This split is good news for reuse: an Excel module needs its own Parse stage (reading a workbook instead of CSV text) and its own row-to-string-record bridge, but can lean on `detectColumns`, `mapCategory`, and `resolveFingerprintOutcome` unmodified, and can reuse `parseDate`/`parseAmount` as fallback paths for the subset of Excel cells that come through as plain strings (see §6/§7). `app/api/accounts/[id]/import/route.ts`'s overall shape — resolve account, parse, detect columns, create batch, loop rows sequentially, finalize, respond — is format-agnostic by construction; nothing in it assumes CSV beyond the literal `parseCsvText`/`detectColumns(parsed.headers)` calls.

**Net assessment: high reuse.** The smallest safe Excel slice is a new Parse+row-bridge module plus a small branch in the existing route, not a parallel pipeline.

---

## 2. Recommended Excel parsing dependency

No Excel library is a current dependency (confirmed — `package.json` has none). Three real candidates, checked against the npm registry directly (not just general reputation) because this route's threat model — parsing a file an authenticated-but-untrusted user uploads — turns out to matter a lot here:

| Package | npm registry state (checked live) | Relevant finding |
|---|---|---|
| **xlsx** (SheetJS) | Latest published to npmjs.org is **0.18.5** (confirmed via `registry.npmjs.org/xlsx`, dist-tag `latest`) | Vulnerable to **CVE-2023-30533** (prototype pollution reading crafted files) and **CVE-2024-22363** (ReDoS, **CVSS 7.5 High**, CWE-1333 — network-reachable, no auth beyond submitting input; SheetJS's own advisory describes the exact attack as "attacker uploads... a malicious spreadsheet file... to any endpoint that hands the data to SheetJS for parsing"). Fixed upstream in 0.19.3 and 0.20.2 respectively, but **neither patched version has been published to the npm registry** — SheetJS's own distribution channel for the fix is their CDN (`cdn.sheetjs.com`), installed via a tarball URL instead of a normal `npm install <name>@<range>`. |
| **node-xlsx** | Thin wrapper around SheetJS's xlsx parser | Inherits the same underlying vulnerability profile as above — no advantage over using xlsx directly. |
| **exceljs** | Latest published version **4.4.0**, last published **2023-10-19** (~2.7 years ago as of this report) | No CVE of comparable severity/attack-fit found in this pass. Carries 9 runtime dependencies (`jszip`, `archiver`, `unzipper`, `saxes`, `fast-csv`, `dayjs`, `uuid`, `tmp`, `readable-stream`) — several (`archiver`, write-path) are dead weight for a read-only import use case. Ships its own bundled TypeScript types (`@types/exceljs` on npm is an intentional stub pointing back to the package itself, confirmed via registry) — no separate `@types/` dependency needed, same simplicity as `papaparse`'s own types story. |

**This is not a stylistic choice — `xlsx`'s unpatched-on-registry CVE-2024-22363 is a direct match for this route's exact attack surface** (an unauthenticated-relative-to-the-parser, file-upload-triggered, CPU-exhaustion DoS), and CVE-2023-30533 is a prototype-pollution risk in the same "reads attacker-controlled file content" category. Installing `xlsx` the normal way (`npm install xlsx`, as every other dependency in this project is installed) would pull the vulnerable 0.18.5. Installing the patched version requires a non-standard CDN-tarball dependency source, which is itself a supply-chain/process cost (most internal dependency-scanning and Dependabot-style tooling tracks registry packages by name+semver, not arbitrary tarball URLs) — not a free win even though it is SheetJS's own documented fix path.

**Recommendation: `exceljs`.** Reasoning, in order of weight: (1) it installs the normal way, from the normal registry, consistent with every existing dependency in this project — no special-cased install instructions for one package; (2) no equivalent unpatched-on-registry critical/high CVE was found for it in this pass, against a route whose threat model specifically rewards avoiding xlsx's known one; (3) its ~2.7-year-stale npm publish history is a real but lower-urgency concern (worth monitoring, not a blocker today) compared to a confirmed CVSS-7.5 DoS with no registry-side fix.

**This is flagged as its own explicit checklist line item, not bundled silently into "add a parser" the way `papaparse` was for 4D-1** — papaparse had no comparable CVE for either candidate it was weighed against, so 4D-1's dependency choice was a plain engineering call. This one is a security-relevant call on a file-upload endpoint and should get an explicit sign-off before implementation, the same way 4D-1 §7's fingerprint-helper fork got its own explicit decision point rather than being silently resolved by whichever way the first PR happened to call the helper.

---

## 3. Normalizing `.xlsx` rows into the existing row shape

`normalizeRow()` (csv.ts) takes a `Record<string, string>` — every cell already a string, because `Papa.parse` with `header: true` returns exactly that. exceljs does not return that shape: `worksheet.getRow(n).values` gives **typed** cell values — `string`, `number`, `Date`, `boolean`, or a `{ formula, result }`/rich-text object, depending on the cell's actual stored type and format, not the same string-for-everything shape CSV happens to produce.

Two ways to bridge this, presented as the fork for the implementation checklist:

- **(i) Stringify everything, reuse `normalizeRow` byte-for-byte.** Convert each typed cell to a string (numbers via `.toString()`, dates via an ISO stringify) before building a `Record<string,string>`, then hand that to the *existing* `normalizeRow()` unchanged. Zero new normalization logic, but it's a lossy round-trip: a `Date` cell that exceljs already parsed correctly gets stringified and then re-parsed by `parseDate()`'s regex, which only recognizes `YYYY-MM-DD` or `M/D/YYYY` — an ISO stringify of a JS `Date` (`toISOString()`) produces `YYYY-MM-DDTHH:mm:ss.sssZ`, which `parseDate()`'s ISO regex (anchored, exactly 10 characters) would **reject**, turning a perfectly good date cell into a FAILED row unless the stringify step is written to slice down to just the date portion first. A workable version of (i) exists, but only by being careful about exactly how each type gets stringified — it's not a free conversion.
- **(ii) A small Excel-specific normalizer that produces a `NormalizedRow` directly**, reusing `mapCategory`/`resolveFingerprintOutcome` (and `parseDate`/`parseAmount` only as the string-cell fallback path — see §6/§7) but not routing through `normalizeRow()`'s string-only contract at all. This avoids the round-trip-fragility of (i) and lets each Excel cell type (Date object, number, string) be handled on its own terms — which is also exactly what's needed anyway for the serial-date and formula-result risks in §6/§7.

**Recommendation: (ii).** It's a similar size of new code to (i) once (i) is done carefully, but it avoids a stringify-then-reparse step whose correctness depends on a detail (`parseDate`'s exact regex shape) living in a different file — a future change to `parseDate` could silently break the Excel path under approach (i) without anyone touching Excel code. (ii) keeps the Excel-specific type-handling colocated with the Excel module that needs it.

---

## 4. Should `lib/imports/csv.ts` be renamed/generalized, or left alone with an Excel-specific wrapper?

`csv.ts`'s own module header already anticipates this question: *"A future Excel/QuickBooks source (D2 Step 4D-2+) is expected to get its own sibling module, not a forced shared interface bolted on here."* The 4D pipeline investigation's roadmap note says the same thing from the other direction ("4D-2 ... only the Parse stage differs"). Both pre-existing documents already point at the same answer.

Two options:

- **(i) Leave `csv.ts` completely untouched.** New `lib/imports/excel.ts` imports the source-agnostic exports (`detectColumns`, `mapCategory`, `resolveFingerprintOutcome`, `parseDate`, `parseAmount`, the shared types) directly from `@/lib/imports/csv`. Zero risk to the already-shipped, already-validated CSV pipeline. The one cost is cosmetic: an Excel module importing from a file literally named `csv.ts` reads a little oddly.
- **(ii) Extract the source-agnostic pieces into a new `lib/imports/shared.ts`**, have both `csv.ts` and `excel.ts` import from there. More honestly "generalized," but it requires editing `csv.ts` — removing/re-exporting its current exports — which is a real, mechanical, behavior-preserving change to a file that is already merged and working in production-bound code.

**Recommendation: (i).** This mirrors a call the project has already made once before in this exact area: 4C explicitly declined to re-point `reconcile.ts`'s separate account-level fingerprint matcher onto the new shared helper, on the grounds that doing so was "a smaller win than it sounds" relative to the risk of touching working code. The same logic applies here, more strongly, since `csv.ts` is now also a *route dependency already live in this branch's history* (per the task's own context — the CSV route has already been pushed). The naming oddity is real but purely cosmetic and costs nothing functionally; flag the `shared.ts` extraction as a legitimate future cleanup if/when a third source (QuickBooks, 4D-4) makes "Excel imports from a file called csv.ts" load-bearing rather than cosmetic — not a reason to touch a shipped file now.

---

## 5. Same route or a separate route?

The existing route (`app/api/accounts/[id]/import/route.ts`) is CSV-only today by explicit module-header scope, accepting `file` + optional `signConvention` as multipart fields.

- **Same route, format-sniffed** by `file.name` extension (`.csv` vs `.xlsx`/`.xls`) and/or `file.type` MIME (`text/csv` vs `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` for `.xlsx`, `application/vnd.ms-excel` for legacy `.xls`), branching into `parseCsvText` vs. a new Excel parse call, then converging on the same create-batch/loop/finalize body.
- **Separate route** (e.g. a sibling `excel/route.ts`, or a `format` field forcing a brand-new endpoint) keeps the existing route file at zero diff, but produces two upload endpoints a future UI would need to know about and branch on — pushing a question that's arguably product-level ("is this one upload experience or two") down into the API surface.

**Recommendation: same route, format-sniffed.** `ImportBatch.source: ImportSource` already exists as a `CSV | EXCEL | QUICKBOOKS` enum specifically so one batch concept spans multiple file formats — the schema already models "one logical import, multiple formats," and a route-per-format works against that. The smallest-safe-slice principle also favors minimizing new API surface: one route with an added Parse-stage branch is smaller than a second route duplicating auth/account-resolution/batch-create/loop/finalize. This does mean editing the existing route file (a small, additive branch, not a rewrite) — called out explicitly here so the file list in §"Deliverables" doesn't undercount the diff.

---

## 6. Excel-specific date parsing risks

The central risk, and the one most worth a dedicated checklist item: **a date cell with no date number-format applied comes through as a bare numeric serial, not a `Date`.** exceljs auto-converts a cell to a JS `Date` only when the cell's *number format* is a recognized date/time format; a column that holds dates but was exported/typed without a date format (common in ad hoc bank/QuickBooks Excel exports, or a column built by a formula that doesn't inherit formatting) yields a plain number like `45836` instead. Three distinct cases an Excel date normalizer needs to branch on, by the *typed* cell value (not after stringifying):

1. **Cell value is already a `Date` object** (the common, well-formatted case) — use it directly, no parsing needed at all.
2. **Cell value is a `string`** (a date typed/pasted as text, or a column genuinely formatted as text) — reuse `parseDate()` from `csv.ts` as-is; this is functionally identical to the CSV case.
3. **Cell value is a bare `number`** (unformatted serial) — needs an explicit Excel-serial-to-date conversion (epoch `1899-12-30`, with the well-known Excel/Lotus 1900-leap-year quirk for serials ≥ 60), not a string parse. This is genuinely new logic with no CSV analog — `parseDate()`'s strict regex would simply reject a stringified serial like `"45836"` as unparseable, which is a *safe* failure (a FAILED row, not silent corruption) but a worse user experience than correctly parsing a real date — so case 3 is worth building deliberately rather than leaving to fall through to a FAILED classification by accident.

A secondary, lower-severity risk: exceljs's date handling is timezone-sensitive at the UTC/local boundary depending on how a given cell's date was originally authored — worth a direct fixture check (see §11) rather than an assumption either way, the same "don't guess, verify" posture `csv.ts`'s own header comment already takes toward `Date.UTC()` construction for the US-slash CSV form.

---

## 7. Excel-specific numeric/currency parsing risks

This direction is, perhaps counter-intuitively, **easier** than CSV in the common case: a genuinely numeric Excel cell stores the true signed IEEE-754 value regardless of its display format — a cell formatted as `(1,234.56)` via a custom number format already holds `-1234.56` as its actual value; the parentheses are pure display, not data the way they are in a CSV string. So `parseAmount()`'s `$`/comma/parens-stripping logic, written for CSV's string convention, is largely unnecessary for true numeric Excel cells — but still needed as the fallback for any amount cell that comes through as a `string` (e.g., a column exported/typed as text rather than a real number, or a value with a leading apostrophe forcing text storage — a known technique). Three cases, mirroring §6's structure:

1. **Cell value is a `number`** — use directly; no stripping, no sign-convention ambiguity from formatting (separate Debit/Credit columns vs. a single signed Amount column is still a real, *source-independent* ambiguity — same `signConvention` request field 4D-1 already added covers it identically here).
2. **Cell value is a `string`** — reuse `parseAmount()` from `csv.ts` as-is.
3. **Cell value is a formula result** (`{ formula, result }` shape) — must read `.result`, not the formula text; a formula that itself errored (`#REF!`, `#DIV/0!`, etc.) yields an error-shaped result that should be treated as FAILED, not coerced into a number.

No Excel-specific risk was found beyond standard float-precision behavior, which is not unique to Excel and already applies to `Transaction.amount: Float` regardless of import source.

---

## 8. Required/optional column handling compared to CSV

`detectColumns(headers: string[])` is reusable as-is once Excel's header row is coerced into a `string[]` — the function only cares about header text, not where it came from. Two Excel-specific wrinkles in getting there:

- **Worksheet selection.** A workbook can contain multiple sheets; CSV has no analog to this at all. **Recommendation: default to the first worksheet** (`workbook.worksheets[0]`), matching the smallest-safe-slice posture already used for `signConvention` (one parameter at a time, not a full options surface on Day 1). A file with zero worksheets, or an empty first worksheet, should produce the same file-level 400 error `detectColumns` already returns for "wrong shape," not a new error class.
- **Header-row value coercion.** `worksheet.getRow(1).values` returns positionally-indexed cell values, normally strings for genuine header labels but not guaranteed to be (a header typed as a number, though unusual, is possible) — each value needs a defensive `.toString().trim()` before being handed to `detectColumns`, mirroring `normalizeHeader()`'s existing trim/lowercase logic in `csv.ts`.

One Excel-specific structural risk worth naming: **merged header cells.** exceljs typically populates only the top-left cell of a merged range and leaves the other cells in that range `null`/`undefined` in `getRow(1).values`. As long as column alignment is built by recording *which column index* each recognized header occupies (and every data row is read at that same index), this doesn't actually break anything — it's the same "look up by name, not position" discipline `detectColumns` already requires of CSV headers, just worth flagging explicitly so an Excel implementation doesn't accidentally assume column N always means the same field positionally.

Required/optional column *semantics* (date; merchant-or-description; amount-or-debit/credit; category and reference optional) are unchanged from CSV — these are properties of what data a row needs to become a `Transaction`, not properties of the file format carrying it.

---

## 9. Schema impact

**None required.** `ImportSource.EXCEL` already exists in the enum (added in 4B, unused until now) — confirmed directly in `prisma/schema.prisma`. `Transaction` needs zero new columns: the Option-B discriminator rule from the 4D pipeline investigation (`importBatchId` set only on rows a batch genuinely creates) is already format-agnostic and governs Excel identically to CSV.

One pre-existing, already-documented inconsistency, re-confirmed rather than newly discovered: `ProviderType` (the `Connection`-level enum, Step 1A) has `PLAID | MANUAL | WALLET | CSV | EXCHANGE | BROKERAGE` — no `EXCEL`. This is still harmless: `ImportBatch.connectionId` remains unpopulated for every import source today (CSV included), so the gap has no live consequence. Not a blocker for 4D-2; same future-TODO status the 4D pipeline investigation already gave it.

## 10. Migration impact

**None required**, directly following from §9 — no schema diff means no `npx prisma migrate dev` run for this slice. This is a real difference from 4D-1, which needed `matchedCount`/`failedCount`; 4D-2 needs no analogous schema step.

---

## 11. Validation strategy with sample Excel fixtures

No test framework exists in this project (re-confirmed, consistent with every prior D2 step). Recommend the same fixture-file-based manual validation convention 4D-1 used, extended for Excel's type-handling risks from §6/§7:

- **`fixture-basic.xlsx`** — genuinely new rows, Date-formatted date column, Number-formatted amount column. Expect all CREATED, matching 4D-1's own basic-fixture expectation.
- **`fixture-text-dates.xlsx` / `fixture-text-amounts.xlsx`** — date and amount columns stored as text cells (not formatted as Date/Number) — exercises the `parseDate`/`parseAmount` string-fallback path from §6/§7 case 2.
- **`fixture-serial-dates.xlsx`** — date column with no date format applied, bare numeric serials — exercises §6 case 3, the highest-risk path. Verify the Excel-epoch conversion against a handful of known serial→date pairs by hand, including at least one serial ≥ 60 to confirm the 1900-leap-year adjustment is correct in the actual direction (off-by-one-day errors are the classic failure mode here).
- **`fixture-formula-amounts.xlsx`** — amount column built from a simple formula (e.g., `=B2-C2`) — exercises §7 case 3, confirms `.result` is read correctly and an errored formula cell (`#REF!`) is classified FAILED rather than crashing the row.
- **`fixture-multi-sheet.xlsx`** — more than one worksheet, target data only on the first — confirms the first-worksheet-only default behaves predictably rather than silently reading the wrong sheet or erroring.
- **`fixture-malformed.xlsx`** — missing a required column, and a workbook with zero worksheets / an empty first sheet — confirms the same file-level 400 behavior CSV already has, not a new error class.
- **Cross-format fingerprint check** — upload `fixture-basic.csv` (4D-1's own fixture) first, then upload an `.xlsx` file containing one row that exactly matches a transaction the CSV upload just created. Expect MATCHED, with the existing row's fields and any `plaidTransactionId` confirmed unchanged afterward. This is a genuinely new test case 4D-1 couldn't exercise alone — it proves `resolveFingerprintOutcome`'s source-agnostic design holds true end-to-end across two different formats now that two exist, not just in code review.

Same gate as every prior step: `npx tsc --noEmit` and `npm run lint` clean; DB-dependent paths verified by code trace given the sandbox's confirmed `localhost:5432` unreachability, with a note that live fixture runs need to happen locally (same caveat as 4D-1 §11, restated rather than re-litigated).

---

## 12. Rollback / preview-deployment considerations

**Implementation rollback** (reverting this slice if something's wrong, not import-rollback — which remains 4D-3, still deferred): purely additive — new `lib/imports/excel.ts`, the new `exceljs` dependency, and a small additive branch in the existing route (not a rewrite). Reverting the implementing commit(s) is sufficient, same shape as 4D-1's own rollback section. No data-loss risk: nothing existing is modified.

**Preview-deployment-specific risks worth flagging, distinct from 4D-1's CSV pipeline:**

- `exceljs` depends on `tmp` (used internally for some of its stream-support code paths) — a filesystem-write dependency `papaparse`'s pure in-memory string parsing never needed. Most serverless/edge runtimes provide a writable `/tmp`, but this should be confirmed against the actual deployment target rather than assumed from papaparse's precedent, as its own checklist line item.
- `.xlsx` files are zip containers; loading one decompresses the full workbook into memory. A small-on-disk, large-when-decompressed ("zip bomb"-style) `.xlsx` is a resource-exhaustion vector with no CSV analog (plain text can't decompress-bomb). exceljs has a genuinely streaming reader (`exceljs.stream.xlsx.WorkbookReader`) that would mitigate this, but using it is a meaningfully bigger implementation lift than the synchronous `workbook.xlsx.load(buffer)` call that otherwise mirrors `Papa.parse`'s one-call simplicity and 4D-1's synchronous, single-request precedent. **Recommendation: synchronous load for this MVP slice** (consistent with "smallest safe slice"), with an explicit follow-up hardening item — reject uploads above a defined byte-size ceiling before attempting to parse at all — named here rather than silently inherited as an unstated assumption.
- `exceljs`'s heavier dependency tree (§2) means a larger bundle/cold-start footprint for whatever runtime executes this route than 4D-1's near-zero-dependency `papaparse` did — a real but non-blocking operational cost worth knowing about going in, not discovering after deploy.

---

## Deliverables

### Current CSV pipeline reuse analysis

See §1. High reuse: `detectColumns`, `mapCategory`, `resolveFingerprintOutcome`, and the shared types are source-agnostic and reusable unmodified; `parseDate`/`parseAmount` are reusable as the string-cell fallback path; only the Parse stage (reading a workbook) and a typed-value-aware row normalizer are genuinely new.

### Recommended implementation scope

Smallest safe 4D-2 slice: add `exceljs` (§2); new `lib/imports/excel.ts` providing an Excel-specific Parse stage (worksheet selection, header coercion) and a typed-value-aware row normalizer (§3 option (ii), handling Date/string/number cells per §6/§7) that produces the same `NormalizedRow` shape CSV already uses; reuse `detectColumns`/`mapCategory`/`resolveFingerprintOutcome` from `csv.ts` unmodified (§4 option (i) — no rename/extraction); extend the existing route with a format-sniffing branch (§5), not a new route. No rollback, no UI beyond whatever minimal upload-format affordance the existing CSV upload already needs, no QuickBooks, no Step 5 provider-adapter work, no change to Plaid behavior, no schema change.

### Expected file list

| File | Change |
|---|---|
| `lib/imports/excel.ts` | New — Excel Parse stage + typed-value row normalizer |
| `app/api/accounts/[id]/import/route.ts` | Modified — small additive format-sniffing branch (file extension/MIME → CSV vs. Excel parse path), converging on the existing batch-create/loop/finalize body |
| `lib/imports/csv.ts` | **Untouched** (§4) |
| `lib/transactions/fingerprint.ts` | **Untouched** |
| `prisma/schema.prisma` | **Untouched** (§9) |
| `package.json` / `package-lock.json` | Modified — add `exceljs` |

### Dependency impact

One new production dependency, `exceljs` (§2), with its own bundled TypeScript types — no separate `@types/exceljs` needed (the npm-published `@types/exceljs` is an intentional stub deferring to the package's own types, confirmed via registry). No file-storage/blob-storage dependency needed, same reasoning as 4D-1: this remains a synchronous upload→parse→import→respond flow within one HTTP request.

### Schema impact

None. See §9/§10.

### Validation plan

See §11 — fixture-file-based manual validation extending 4D-1's convention with Excel-specific type-handling fixtures (text-cell fallback, unformatted serial dates, formula-result amounts, multi-sheet, malformed), plus a new cross-format fingerprint-match fixture exercising CSV→Excel match behavior specifically. `tsc --noEmit`/`npm run lint` as the baseline gate, consistent with every prior D2 step.

### Rollout plan

Same route, format-sniffed (§5) — no new endpoint for any future UI to learn about. No feature flag is needed beyond what shipping any additive route change would normally warrant: the format branch only activates for non-CSV uploads, so existing CSV behavior (already validated and pushed) is unaffected by construction as long as the CSV branch itself isn't touched (§4 ensures it isn't). The `exceljs` dependency-security tradeoff (§2) should be confirmed explicitly before this slice's implementation checklist is approved, not assumed.

### Rollback plan

See §12. Purely additive; reverting the implementing commit(s) is sufficient. No destructive migration either way, since none is added.

---

**Stopping here per scope. No implementation. No schema changes. No migrations. No file other than this one touched.**
