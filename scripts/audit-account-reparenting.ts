/**
 * scripts/audit-account-reparenting.ts  (RLS-ACC-FK)
 *
 * EVERY CODE SITE CAPABLE OF CHANGING A FinancialAccount FK IS CLASSIFIED.
 *
 * ── WHAT IS RATCHETED, AND WHAT IS DELIBERATELY NOT ──────────────────────────
 * The ratchet is over THE SET OF SITES CAPABLE OF MOVING AN ACCOUNT FK — not
 * over the set of files that import the guard. That distinction is the whole
 * design. An audit that counted importers would go green the moment somebody
 * wrote a new re-parenting write WITHOUT the guard, which is precisely the event
 * it exists to catch. So the scan finds the capability and the allowlist must
 * then say, for each one, WHY it is safe. A new capable site that nobody
 * classified fails the build and is named.
 *
 * ── THE DEFECT THIS GUARDS ───────────────────────────────────────────────────
 * Under a real `fm_app` role, an ACTIVE member of a shared Space re-pointed SIX
 * of another owner's transactions onto her own account with one `UPDATE`.
 * `Transaction.fm_app_upd` is `fm_account_visible("financialAccountId")` on both
 * arms and both accounts were ACTIVE-linked into that Space, so the write was
 * LEGAL. FULL and BALANCE_ONLY behaved identically. The refusal cannot live in
 * policy (RLS = tenancy; application = product permissions), so it lives in
 * `lib/accounts/account-reparenting.ts` — and this audit is what keeps the
 * eleven-and-counting sites from drifting away from it.
 *
 * It is closed today at most sites only by COINCIDENCE: a `@unique` column that
 * happens to coincide with ownership, Plaid's per-Item id allocation, or the
 * absence of a second writer. A coincidence is not an invariant, which is why
 * each one is written down here with the coincidence named.
 *
 * ── SCANNER DISCIPLINE — EVERY ITEM BELOW IS A FAILURE THIS PROGRAMME PAID FOR ─
 *
 *  1. ENUMERATE, THEN FILTER BY PREFIX. A git pathspec `lib/**\/*.ts` requires
 *     an intervening directory and so matches NOTHING at the top level; it once
 *     hid the entire auth layer from an audit that reported a clean ratchet
 *     (scripts/audit-db-authority.ts:63-67).
 *  2. NEVER `.match()` FOR A SINGLE HIT. It returns only the FIRST match; a file
 *     with two imports had the second ignored. Every scan here is a global
 *     `exec` loop or a full `matchAll`.
 *  3. ESCAPE THE PATTERN. `` `\b${name}\s*\(` `` with `name = "$transaction"`
 *     put an unescaped `$` — end-of-string — into the regex, matched nothing,
 *     and reported clean over zero sites. Every delegate/method name here goes
 *     through `rx()`.
 *  4. STRIP COMMENTS FIRST, PRESERVING LINE NUMBERS. The modules this audit
 *     scans EXPLAIN the hazard at length; a header that documents a dangerous
 *     spelling must not satisfy a scan for it.
 *  5. AN UNRECOGNISED SPELLING COUNTS AS A SITE. Opaque `data` (an identifier,
 *     a spread, a payload this scanner cannot segment) is reported as CAPABLE,
 *     never as nothing — so a novel form fails loudly instead of vanishing
 *     (audit-db-authority.ts:174-176).
 *  6. THE DENOMINATOR IS PRINTED. N sites over M files, both numbers, every run.
 *     An audit that prints only "0 problems" cannot be told from one that
 *     scanned nothing — and this programme has shipped that bug.
 *
 * ── THE PRECISION THAT MATTERS: `data` IS NOT `where` ────────────────────────
 * `updateMany({ where: { financialAccountId: x }, data: { status: 'REVOKED' } })`
 * MENTIONS the FK and cannot possibly change it. Counting it would add twenty
 * link/connection-lifecycle sites whose classification is "it is in the WHERE",
 * and twenty entries nobody can act on is how a gate teaches people to ignore
 * red. So the call's first argument is SEGMENTED and only the WRITE payload
 * (`data`, and an upsert's `update` arm) is examined.
 *
 * ⚠️ AND THE SEGMENTER FAILS CLOSED. If the payload cannot be located or is not
 * a literal this scanner can read, the site COUNTS. Segmentation makes the audit
 * sharper; it is never allowed to make it quieter.
 *
 * ── WHY AN IDENTITY REWRITE IS ALSO A SITE ───────────────────────────────────
 * Re-homing a TENANT-WIDE `@unique` provider identity onto a different row is
 * the mirror image of re-parenting: the row does not move, the identity does,
 * and the next sync that resolves by that identity lands on a row belonging to
 * a different account. That is the `plaidTransactionId` adoption in
 * syncTransactions and the `externalEventId` release/re-take in
 * investment-event-ingest — the two sites whose SOURCE READ was unscoped. So a
 * write that sets one of those columns is a site even when no FK appears.
 *
 *   npx tsx --env-file=.env.local scripts/run-audits.ts --only audit-account-reparenting
 *   npx tsx scripts/audit-account-reparenting.ts          # needs no database
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
}

/** Escape a literal for use inside a RegExp. `$transaction` taught us this. */
const rx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ────────────────────────────────────────────────────────────────────────────
 * 1. THE FK INVENTORY — DERIVED FROM THE SCHEMA, NEVER HAND-COPIED
 *
 * An audit holding its own copy of a rule its authority has outgrown is a
 * recorded failure of this programme. So the FK set is read out of
 * prisma/schema.prisma on every run: a new relation to FinancialAccount joins
 * the scan automatically, and the count below is asserted so a PARSE failure
 * (which would silently empty the inventory and make every scan vacuous) cannot
 * read as "no FKs found, nothing to check".
 * ──────────────────────────────────────────────────────────────────────────── */

interface Fk { model: string; field: string; schemaLine: number }

function readFkInventory(): Fk[] {
  const lines = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8").split("\n");
  const out: Fk[] = [];
  let model = "";
  for (let i = 0; i < lines.length; i++) {
    const m = /^model\s+(\w+)\s*\{/.exec(lines[i]);
    if (m) { model = m[1]; continue; }
    // A relation FIELD whose type is FinancialAccount (optional or not) and
    // which OWNS the foreign key (`fields: [...]`). The inverse side — an array
    // of children on FinancialAccount itself — has no `fields:` and is skipped.
    const rel = /^\s*\w+\s+FinancialAccount\??\s+@relation\((.*)\)\s*$/.exec(lines[i]);
    if (!rel || !model) continue;
    const f = /fields:\s*\[\s*(\w+)\s*\]/.exec(rel[1]);
    if (f) out.push({ model, field: f[1], schemaLine: i + 1 });
  }
  return out;
}

const FKS = readFkInventory();
const FK_FIELDS = [...new Set(FKS.map((f) => f.field))];
const FK_MODELS = [...new Set(FKS.map((f) => f.model))];

/**
 * TENANT-WIDE UNIQUE PROVIDER/EXTERNAL IDENTITY COLUMNS. Writing one of these on
 * an existing row re-homes an identity rather than a row — see the header.
 */
const IDENTITY_COLUMNS = [
  "plaidTransactionId", "externalEventId", "externalAccountId",
  "plaidAccountId", "walletAddress", "externalTransactionId",
];

/* ────────────────────────────────────────────────────────────────────────────
 * 2. THE SOURCE SET
 * ──────────────────────────────────────────────────────────────────────────── */

const ROOT_DIRS = ["app/", "lib/", "jobs/", "components/", "scripts/"];
const FILES = execSync(`git ls-files -- '*.ts' '*.tsx'`, { cwd: ROOT, encoding: "utf8" })
  .trim().split("\n").filter(Boolean)
  .filter((f) => ROOT_DIRS.some((d) => f.startsWith(d)))
  // Tests are excluded for the reason audit-db-authority excludes them: a fake
  // client in a test is not a runtime authority, and a test that deliberately
  // constructs the attack (which the RLS suite does) must not be reported as
  // the attack. `scripts/` IS included, unlike audit-db-authority's set — a
  // backfill or remediation script that re-points rows is exactly a site, and
  // two of them turned up.
  .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
  .sort();

/** Blank out comments WITHOUT moving any line. Line numbers must survive. */
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

/** Index of the `)` matching the `(` at `open`, or -1 when unbalanced. */
function matchParen(s: string, open: number): number {
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") d++;
    else if (s[i] === ")") { d--; if (d === 0) return i; }
  }
  return -1;
}

/**
 * Split the first argument object's TOP-LEVEL keys. Returns null when the
 * argument is not an object literal this scanner can read — which the caller
 * MUST treat as capable, not as empty.
 */
function segmentArgs(callBody: string): Record<string, string> | null {
  const open = callBody.indexOf("{");
  if (open < 0) return null;
  let d = 0, close = -1;
  for (let i = open; i < callBody.length; i++) {
    if ("{[(".includes(callBody[i])) d++;
    else if ("}])".includes(callBody[i])) { d--; if (d === 0) { close = i; break; } }
  }
  if (close < 0) return null;
  const inner = callBody.slice(open + 1, close);
  const out: Record<string, string> = {};
  let depth = 0, keyStart = 0;
  const parts: string[] = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if ("{[(".includes(c)) depth++;
    else if ("}])".includes(c)) depth--;
    else if (c === "," && depth === 0) { parts.push(inner.slice(keyStart, i)); keyStart = i + 1; }
  }
  parts.push(inner.slice(keyStart));
  for (const p of parts) {
    const m = /^\s*(\w+)\s*:([\s\S]*)$/.exec(p);
    if (m) out[m[1]] = m[2];
    else if (p.trim()) out[`__unparsed_${Object.keys(out).length}`] = p;
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. THE SCAN
 * ──────────────────────────────────────────────────────────────────────────── */

type Capability =
  | "FK_IN_PAYLOAD"        // the write payload names an account FK column
  | "IDENTITY_IN_PAYLOAD"  // the write payload re-homes a tenant-wide unique identity
  | "PAYLOAD_OPAQUE"       // this scanner cannot read the payload — counts anyway
  | "RAW_SQL";             // a raw statement that updates one of the columns

interface Site {
  key: string;             // "file:delegate.op" — line-insensitive, see below
  file: string;
  line: number;
  statement: string;       // "transaction.updateMany"
  capability: Capability;
  detail: string;
}

const MUTATIONS = ["update", "updateMany", "upsert"] as const;
const camel = (s: string) => s[0].toLowerCase() + s.slice(1);

function scan(): Site[] {
  const sites: Site[] = [];
  for (const file of FILES) {
    const code = stripComments(readFileSync(join(ROOT, file), "utf8"));
    const lineOf = (i: number) => code.slice(0, i).split("\n").length;

    for (const model of FK_MODELS) {
      for (const op of MUTATIONS) {
        // ⚠️ `\.` on BOTH sides so `tx.transaction.update(` matches and
        // `something.transactionUpdate(` does not. Escaped via rx().
        const re = new RegExp(`\\.\\s*${rx(camel(model))}\\s*\\.\\s*${rx(op)}\\s*\\(`, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(code)) !== null) {
          const open = m.index + m[0].length - 1;
          const close = matchParen(code, open);
          const body = close < 0 ? code.slice(open) : code.slice(open, close + 1);
          const line = lineOf(m.index);
          const statement = `${camel(model)}.${op}`;
          const push = (capability: Capability, detail: string) =>
            sites.push({ key: `${file}:${statement}`, file, line, statement, capability, detail });

          if (close < 0) { push("PAYLOAD_OPAQUE", "call parentheses are unbalanced to end-of-file"); continue; }
          const seg = segmentArgs(body);
          if (!seg) { push("PAYLOAD_OPAQUE", "the first argument is not an object literal this scanner can read"); continue; }

          // The WRITE payload only. `where` can name the FK all it likes.
          const payloadKeys = op === "upsert" ? ["update"] : ["data"];
          const unparsed = Object.keys(seg).filter((k) => k.startsWith("__unparsed_"));
          if (unparsed.length) { push("PAYLOAD_OPAQUE", `a top-level entry is a spread or shorthand: ${unparsed.map((k) => seg[k].trim().slice(0, 40)).join(" | ")}`); continue; }

          const payload = payloadKeys.map((k) => seg[k] ?? "").join("\n");
          if (payloadKeys.every((k) => seg[k] === undefined)) {
            // An upsert with no `update` arm, or an update with no `data`: not a
            // shape we recognise, so it counts.
            push("PAYLOAD_OPAQUE", `no ${payloadKeys.join("/")} key found among {${Object.keys(seg).join(", ")}}`);
            continue;
          }
          if (/\.\.\./.test(payload) || /^\s*[A-Za-z_$][\w$]*\s*$/.test(payload)) {
            push("PAYLOAD_OPAQUE", `the payload is spread or passed as a variable: ${payload.trim().slice(0, 60)}`);
            continue;
          }
          const fkHit = FK_FIELDS.filter((f) => new RegExp(`\\b${rx(f)}\\b`).test(payload));
          if (fkHit.length) { push("FK_IN_PAYLOAD", `writes ${fkHit.join(", ")}`); continue; }
          const idHit = IDENTITY_COLUMNS.filter((f) => new RegExp(`\\b${rx(f)}\\b`).test(payload));
          if (idHit.length) { push("IDENTITY_IN_PAYLOAD", `re-homes ${idHit.join(", ")}`); continue; }
        }
      }
    }

    // RAW SQL. Any raw executor whose surrounding text carries an UPDATE and one
    // of the columns. Deliberately broad: a raw statement is exactly where a
    // novel spelling would hide.
    // ⚠️ ONE PATTERN WITH AN OPTIONAL SUFFIX, not four names. Looping over
    // ["$executeRaw", "$executeRawUnsafe", ...] double-counts every Unsafe call
    // — the short name is a PREFIX of the long one — producing two sites and two
    // allowlist keys for one statement. A ratchet that reports a phantom site is
    // a ratchet nobody trusts.
    //
    // ⚠️ AND `UPDATE` IS WORD-BOUNDED. Without `\b` it matches inside
    // `"updatedAt"`, which made the Daily Brief's digest SELECT read as a raw
    // account-FK update. That is the `failed` inside `0 failed` defect, again.
    {
      const re = /\$(?:execute|query)Raw(?:Unsafe)?/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        const seg = code.slice(m.index, m.index + 800);
        if (!/\bUPDATE\b/i.test(seg)) continue;
        const cols = [...FK_FIELDS, ...IDENTITY_COLUMNS].filter((c) => seg.includes(c));
        if (!cols.length) continue;
        sites.push({
          key: `${file}:${m[0]}`, file, line: code.slice(0, m.index).split("\n").length,
          statement: m[0], capability: "RAW_SQL", detail: `raw UPDATE mentioning ${cols.join(", ")}`,
        });
      }
    }
  }
  return sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. THE CLOSED ALLOWLIST
 *
 * Keyed on `file:statement`, NOT on `file:line` — a line number is a moving
 * target and a ratchet that churns on every unrelated edit gets regenerated
 * instead of read. Two statements of the same shape in one file share an entry;
 * that is accepted, and the `expect` count below is what makes a SECOND one
 * visible rather than absorbed.
 * ──────────────────────────────────────────────────────────────────────────── */

type Verdict =
  /** The re-parenting is real and `assertAccountReparentingAuthorized` proves same-owner. */
  | "SAME_OWNER_PROVEN"
  /** The FK must not move and `assertAccountFkUnchanged` proves it did not. */
  | "FK_UNCHANGED_PROVEN"
  /** The payload's FK is written from the SAME value the statement's own scope
   *  resolved — source and destination are one expression, so no move exists. */
  | "SOURCE_IS_DESTINATION"
  /** The row is created/selected by a key that the caller resolved inside an
   *  owner-scoped read, so the account is the caller's by construction. */
  | "OWNER_SCOPED_RESOLVE"
  /** An upsert whose CREATE arm sets the FK for a brand-new row; the UPDATE arm
   *  cannot reach it. Not a re-parenting at all. */
  | "CREATE_ARM_ONLY"
  /** The payload is opaque to the scanner but provably carries no FK: the
   *  reason is named per site. */
  | "OPAQUE_BUT_FK_FREE"
  /** An operator tool, run deliberately, outside any request. */
  | "OPERATOR_TOOL"
  /** An informational pointer with no authorization meaning. */
  | "INFORMATIONAL_FK"
  /** The payload DOES write an account FK, but from a CONSTANT `null`: it can
   *  only CLEAR a pointer, never create or move a relationship. Pinned, because
   *  the day that literal becomes an expression the site is a real one. */
  | "FK_CLEARED_ONLY"
  /** A pass-through hook inside an RLS acceptance suite, which CONSTRUCTS the
   *  attack on purpose and asserts that the database refuses it. Classified
   *  rather than path-excluded, so the detector stays broad over scripts/. */
  | "ADVERSARIAL_SUITE";

interface Entry {
  key: string;
  verdict: Verdict;
  /** How many statements of this shape are expected in this file. */
  expect: number;
  /** WHY this is safe, in a sentence an operator can check. */
  why: string;
  /** A substring that must be present in the file for the verdict to hold. */
  pin?: string;
}

/** The file half of an allowlist key. Keys are "path:statement". */
const fileOf = (key: string) => key.slice(0, key.lastIndexOf(":"));

const ALLOWLIST: readonly Entry[] = [
  // ── THE TWO UNSCOPED-SOURCE SITES — THE WORST TWO, NOW REFUSABLE ──────────
  {
    key: "lib/plaid/syncTransactions.ts:transaction.update", verdict: "FK_UNCHANGED_PROVEN", expect: 2,
    pin: "assertAccountFkUnchanged(",
    why: "the plaidTransactionId arm locates by a TENANT-WIDE @unique key that names a row without naming an account; " +
         "`financialAccountId` now joins that select and assertAccountFkUnchanged refuses a row on another account (recorded, non-cursor-blocking, skipped). " +
         "The second statement is the fingerprint arm, whose source read findByFingerprint() is account-scoped, so its destination IS its source.",
  },

  {
    key: "lib/investments/investment-event-ingest.ts:investmentEvent.update", verdict: "FK_UNCHANGED_PROVEN", expect: 2,
    pin: "assertAccountFkUnchanged(",
    why: "the correction path releases and re-takes [source, externalEventId], a TENANT-WIDE unique key; `financialAccountId` now joins the select and " +
         "assertAccountFkUnchanged RAISES when the resolved row belongs to another account, before the append/supersede pair can move the live event.",
  },

  // ── THE MERGE — THE ONLY DELIBERATE RE-PARENTING IN THE CODEBASE ──────────
  {
    key: "lib/accounts/reconcile.ts:transaction.updateMany", verdict: "SAME_OWNER_PROVEN", expect: 1,
    pin: "assertAccountReparentingAuthorized(",
    why: "the archived-duplicate fold genuinely moves rows between accounts; both accounts are resolved through the writer's own client and must share a non-null owner, " +
         "and the population is observed before the write and compared after it (assertEveryObservedRowWasWritten).",
  },
  {
    key: "lib/accounts/reconcile.ts:debtProfile.updateMany", verdict: "SAME_OWNER_PROVEN", expect: 1,
    pin: "assertAccountReparentingAuthorized(",
    why: "same fold, same guard, same observation. DebtProfile is 1:1 and its APR/minimum are USER-ENTERED and exist nowhere else, so a silent shortfall would strand the only copy.",
  },


  // ── LINK / CONNECTION LIFECYCLE — FK IN THE `where`, NEVER IN THE PAYLOAD ──
  // These do not appear below as sites at all: the segmenter reads their
  // payloads (status / deletedAt / revokedAt) and finds no FK. They are listed
  // in the report's SEGMENTED-OUT line so the absence is visible, not implied.

  // ── UPSERTS WHOSE CREATE ARM SETS THE FK FOR A NEW ROW ────────────────────
  {
    key: "app/api/accounts/[id]/debt-profile/route.ts:debtProfile.upsert", verdict: "CREATE_ARM_ONLY", expect: 1,
    why: "the update arm writes apr/minimumPayment only; financialAccountId appears in `where` and in the create arm, for the account the route already authorized.",
  },
  {
    key: "lib/accounts/space-account-link.ts:spaceAccountLink.upsert", verdict: "CREATE_ARM_ONLY", expect: 2,
    why: "the dual-write's update arms carry status/kind/visibility; the FK is in the composite `where` and the create arm. A link's account is its identity — moving it would be creating a different link.",
  },

  {
    key: "lib/crypto/position-coverage.ts:positionCoverage.upsert", verdict: "SOURCE_IS_DESTINATION", expect: 1,
    why: "the FK is the function's own financialAccountId parameter in both the where and the create arm — one expression, so no move is expressible.",
  },
  {
    key: "lib/crypto/wallet-position-capture.ts:positionObservation.upsert", verdict: "SOURCE_IS_DESTINATION", expect: 1,
    why: "same shape: the capture's own account id in the composite key and the create arm.",
  },
  {
    key: "lib/investments/brokerage-cash.ts:positionObservation.upsert", verdict: "SOURCE_IS_DESTINATION", expect: 1,
    why: "same shape: the brokerage account whose cash sweep is being recorded.",
  },


  {
    key: "lib/investments/position-capture.ts:positionObservation.upsert", verdict: "SOURCE_IS_DESTINATION", expect: 1,
    why: "the capture's own account id in the composite key and the create arm.",
  },
  {
    key: "lib/investments/reconstruction-runner.ts:positionReconstruction.upsert", verdict: "SOURCE_IS_DESTINATION", expect: 1,
    why: "the reconstruction's own account id in the composite key and the create arm.",
  },

  // ── OPAQUE PAYLOADS — EACH ONE READ BY HAND, EACH REASON NAMED ────────────
  {
    key: "app/api/accounts/[id]/import/route.ts:transaction.update", verdict: "FK_CLEARED_ONLY", expect: 1,
    pin: "computeFlowFields(",
    why: "⚠️ CORRECTED DURING THIS SLICE — the first classification of this site was WRONG. The CSV import's per-row patch spreads `computeFlowFields(...)`, which is " +
         "`buildFlowWriteFields`, and that builder's returned object ALWAYS contains `counterpartyAccountId: null` as a LITERAL. So this update does write an " +
         "account FK on an existing row. It can only CLEAR one — never point it somewhere — and what stops it clearing a CRYPTO_LEDGER row's counterparty is the " +
         "flow-AUTHORITY rule (mayWriteFlow), not RLS and not this guard. The pin below is on the builder's literal.",
  },
  {
    key: "lib/accounts/persist-account-spine.ts:accountConnection.update", verdict: "OPAQUE_BUT_FK_FREE", expect: 1,
    why: "the spine's connection patch (syncStatus/lastSync/deletedAt), keyed by the connection id it just resolved for this account. PEER-OWNED FILE — read, not edited, by this slice.",
  },
  {
    key: "lib/accounts/provider-identity.ts:providerAccountIdentity.update", verdict: "OPAQUE_BUT_FK_FREE", expect: 1,
    why: "the dual-write repoints externalAccountId/connectionId on a row found by (financialAccountId, provider); the FK is in the `where`, never the patch. " +
         "⚠️ ROUTED FINDING: this site SWALLOWS a unique-constraint collision meaning 'another FinancialAccount already owns this provider identity' and logs it as a non-fatal warn — " +
         "the exact event that makes syncTransactions' plaidTransactionId lookup resolve a different destination. PEER-OWNED FILE; the edit is reported, not made.",
  },

  {
    key: "lib/investments/investment-import-commit.ts:importBatch.update", verdict: "OPAQUE_BUT_FK_FREE", expect: 1,
    why: "the batch's own status/counters patch, keyed by the batch id this commit created.",
  },
  {
    key: "lib/transactions/merchant-corrections.ts:transaction.update", verdict: "FK_CLEARED_ONLY", expect: 2,
    pin: "recomputeFlowFields(",
    why: "same correction: both arms spread `recomputeFlowFields(...)` → `buildFlowWriteFields`, whose literal `counterpartyAccountId: null` rides along. " +
         "`recomputeFlowFields` returns {} outright when mayWriteFlow(row.flowAuthority, \"CLASSIFIER\") is disallowed, so a CRYPTO_LEDGER-owned row keeps its pointer. " +
         "The rows are keyed by id inside an owner-scoped correction sweep, so no FK can be pointed anywhere.",
  },

  // ── THE ADVERSARIAL SUITES — THEY BUILD THE ATTACK ON PURPOSE ─────────────
  // These are pass-through hooks (`(a: never) => tx.x.update(a)`) that let a
  // case observe a write mid-flight. The argument is a variable, so the
  // fail-closed segmenter reports them as CAPABLE — correctly. They are
  // classified rather than path-excluded: excluding `scripts/rls-*` would also
  // have excluded the two OPERATOR TOOLS below, and a path exclusion is exactly
  // the kind of quiet narrowing this audit's header refuses.
  {
    key: "scripts/rls-app-acceptance.ts:holding.update", verdict: "ADVERSARIAL_SUITE", expect: 1,
    why: "case 71's mid-write hook on syncCurrentHoldings; it forwards the real arguments unchanged and asserts the transaction rolls back when RLS refuses the insert leg.",
  },
  {
    key: "scripts/rls-app-acceptance.ts:investmentEvent.updateMany", verdict: "ADVERSARIAL_SUITE", expect: 1,
    why: "case 68's hook that deletes a row BETWEEN the observation and the write, to prove PartialBulkWriteError fires on a real shortfall.",
  },
  {
    key: "scripts/rls-app-acceptance.ts:positionObservation.updateMany", verdict: "ADVERSARIAL_SUITE", expect: 1,
    why: "the same case's second leg, forwarded unchanged.",
  },

  // ── RAW SQL ───────────────────────────────────────────────────────────────

  {
    key: "scripts/backfill-flowtype.ts:$executeRaw", verdict: "OPERATOR_TOOL", expect: 1,
    why: "a classified OPERATIONAL backfill (scripts/audit-registry.ts), dry-run by default, run by an operator on purpose; it writes flow columns and its `where` is id-keyed.",
  },

];

/* ────────────────────────────────────────────────────────────────────────────
 * 4b. SITES THIS SLICE ELIMINATED — RECORDED SO THEY CANNOT RETURN QUIETLY
 *
 * A site removed by deleting its FK write disappears from the scan entirely,
 * which is the right outcome and also means the allowlist can no longer carry
 * its reasoning. Without this record, re-adding the clause would simply create a
 * "new unclassified site" with no memory of why it was removed — and the natural
 * fix would be to classify it back in. So the elimination is pinned directly:
 * `absent` must NOT appear in the file.
 * ──────────────────────────────────────────────────────────────────────────── */

const REMOVED_SITES: ReadonlyArray<{ file: string; absent: RegExp; required: string; why: string }> = [
  {
    file: "lib/investments/sync-current-holdings.ts",
    absent: /holding\.update\([^)]*financialAccountId/,
    required: "data: u.row",
    why: "the holdings reconciliation re-stated financialAccountId from the same expression its own read had filtered on — a NO-OP today and a silent relocation " +
         "path the moment Holding joins reconcile.ts's merge (today Holding, PositionObservation, InvestmentEvent, ImportBatch, PositionReconstruction and " +
         "PositionCoverage are all STRANDED on the soft-deleted loser). Dropping the clause was behaviour-preserving and removed the site.",
  },
];

/* ────────────────────────────────────────────────────────────────────────────
 * 5. Transaction.counterpartyAccountId — THE SECOND FK NO PREDICATE MENTIONS
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `Transaction.counterpartyAccountId` (prisma/schema.prisma:2387) is a second FK
 * to FinancialAccount on a table whose RLS policies name `financialAccountId`
 * and NOTHING ELSE. No `USING`, no `WITH CHECK`, no predicate anywhere mentions
 * it, so a cross-owner value in that column is invisible to tenancy
 * enforcement. Its semantics, measured:
 *
 *  · INFORMATIONAL. It is "the other side of the movement when it is a known
 *    owned account" — the destination-aware seam that makes per-liability debt
 *    attribution deterministic. `onDelete: SetNull`, so deleting the referenced
 *    account degrades the pointer rather than the transaction.
 *  · IT GRANTS NO READ. Exposure is gated by the APPLICATION, independently of
 *    RLS: `gatedCounterpartyId` (lib/transactions/counterparty-visibility.ts)
 *    returns the id only when the counterparty account has an ACTIVE,
 *    TRANSACTION_DETAIL-granting (FULL) link into the READING Space, and fails
 *    closed on a missing id, a deleted counterparty or no visible link. So it
 *    confers no navigation and cannot disclose the existence of an unshared
 *    account.
 *  · ONE CONSUMER DOES TREAT IT AS AUTHORITATIVE, and it is named rather than
 *    waved away: `attributeCreditor`
 *    (lib/transactions/debt-payment-authority.ts:198) returns ACCOUNT_CERTAIN
 *    and attributes the payment when the counterparty is a debt account. Its
 *    lookup is a `ReadonlyMap` of accounts the caller could already see, so a
 *    cross-owner id MISSES the map and degrades to NONE — it fails closed, but
 *    it IS an authorization-adjacent input and that is why this column is in the
 *    inventory rather than dismissed as decoration.
 *  · ONE PRODUCTION WRITER, AT CREATE TIME ONLY: lib/crypto/btc-sync.ts:413,
 *    from `ownByAddress` — a map of the OWNER'S OWN wallet addresses — so the
 *    value is owner-scoped at the moment it is written. 353 of 4933 live rows
 *    carry one and 0 are cross-owner. `transfer-maturation.ts` and
 *    `plaid-flow-input.ts` COMPUTE it into a DTO and explicitly do not persist
 *    it; syncTransactions STRIPS it from any patch the classifier may not write.
 *  · CAN A WRITER CHANGE IT ON AN EXISTING ROW? YES — TO NULL, AND THIS SLICE
 *    GOT IT WRONG ONCE BEFORE CHECKING. `buildFlowWriteFields`
 *    (lib/transactions/plaid-flow-input.ts:357) returns
 *    `counterpartyAccountId: null` in EVERY classifier patch, so the CSV import
 *    and the merchant corrections both write this FK on existing rows. They can
 *    only CLEAR it — the value is a literal — and a CRYPTO_LEDGER row is spared
 *    by the flow-AUTHORITY rule (`mayWriteFlow`), not by RLS and not by this
 *    guard. Nothing anywhere writes a NON-NULL value onto an existing row. The
 *    literal is pinned by this audit, because the payloads are spreads and the
 *    site scan cannot see inside them.
 *  · CAN IT CREATE A CROSS-OWNER RELATIONSHIP? Structurally yes, which is the
 *    finding. Nothing in the database prevents it and no policy would notice.
 *    The ratchet below is what makes a new participant visible.
 *
 * THE RATCHET: the closed set of files that reference the column at all, each
 * with its role. It may SHRINK freely; a new entry must be classified. A
 * file-level ratchet rather than a write-detector on purpose — every regex that
 * tries to tell "a property being assigned into a Prisma payload" from "the same
 * property in a DTO, a select, a type or a destructuring" is a guess, and a
 * guess here fails SILENTLY. Membership is not a guess.
 */
type CpRole =
  | "WRITE"      // persists a NON-NULL value to the database
  | "WRITE_NULL" // puts the column in a write payload, always as a literal null
  | "DTO"       // computes it into a response/projection, never persists
  | "GATE"      // the visibility gate itself
  | "AUTHORITY" // consumes it as evidence for a product verdict
  | "READ"      // selects/serializes it
  | "UI"        // renders what a read already gated
  | "AUDIT"       // an audit/backfill/verify script
  | "DESCRIPTION";// names the column in prose that survives comment-stripping

// ⚠️ THREE FILES THAT GREP FOR THIS COLUMN ARE NOT IN THIS LIST, AND THAT IS
// THE COMMENT-STRIPPING RULE WORKING: app/api/accounts/[id]/import/route.ts,
// components/space/widgets/CashFlowSummaryWidget.tsx and the re-parenting guard
// itself mention `counterpartyAccountId` ONLY INSIDE A COMMENT. A header that
// explains a hazard must not count as a participant in it.
const COUNTERPARTY_REFERENCES: Readonly<Record<string, CpRole>> = {
  "lib/crypto/btc-sync.ts":                              "WRITE",
  "lib/transactions/counterparty-visibility.ts":         "GATE",
  "lib/transactions/debt-payment-authority.ts":          "AUTHORITY",
  "lib/transactions/transfer-maturation.ts":             "DTO",
  "lib/transactions/transfer-resolution.ts":             "DTO",
  "lib/transactions/plaid-flow-input.ts":                "WRITE_NULL",
  "lib/transactions/RelationshipResolver.ts":            "DTO",
  "lib/transactions/detail-sections.ts":                 "READ",
  "lib/transactions/serialize.ts":                       "READ",
  "lib/transactions/liquidity.ts":                       "READ",
  "lib/plaid/syncTransactions.ts":                       "WRITE_NULL",
  "lib/data/transactions.ts":                            "READ",
  "lib/export/csv.ts":                                   "READ",
  "lib/ai/assemblers/transactions.ts":                   "READ",
  "lib/ai/brief/recent-activity.ts":                     "READ",
  "lib/ai/conversation/tools.ts":                        "READ",
  "components/dashboard/DebtClient.tsx":                 "UI",
  "components/dashboard/widgets/SpaceTransactionsPanel.tsx": "UI",
  "components/space/widgets/TransactionSliceDrawer.tsx": "UI",
  "components/transactions/TransactionDetailDrawer.tsx": "UI",
  "scripts/audit-cashflow-debt-defect.ts":               "AUDIT",
  "scripts/audit-crypto-banking-leak.ts":                "AUDIT",
  "scripts/audit-debt-payment-attestation.ts":           "AUDIT",
  "scripts/audit-economic-date-calibration.ts":          "AUDIT",
  "scripts/audit-lifecycle-identity.ts":                 "AUDIT",
  "scripts/audit-seed-coverage.ts":                      "AUDIT",
  "scripts/audit-transfer-authority.ts":                 "AUDIT",
  "scripts/audit-transfer-identification.ts":            "AUDIT",
  "scripts/audit-ui-truth-convergence.ts":               "AUDIT",
  "scripts/audit-unattested-debt-payments.ts":           "AUDIT",
  "scripts/backfill-flowtype.ts":                        "AUDIT",
  "scripts/verify-flow-ownership.ts":                    "AUDIT",
  // ⚠️ THESE TWO ARE HERE BECAUSE THE AUDIT CAUGHT THEM, WHICH IS THE POINT.
  // Both name the column inside a STRING LITERAL — this file's own allowlist
  // reasons, and the registry's `what:` sentence — and a string survives
  // comment-stripping. Listing them is the honest fix: a rule that skipped
  // string literals would also skip a raw SQL fragment, which is exactly where
  // a real participant would hide.
  "scripts/audit-registry.ts":                           "DESCRIPTION",
  "scripts/audit-account-reparenting.ts":                "DESCRIPTION",
};



/* ────────────────────────────────────────────────────────────────────────────
 * 6. RUN
 * ──────────────────────────────────────────────────────────────────────────── */

console.log("\naudit-account-reparenting — every code site capable of changing a FinancialAccount FK is classified\n");

// The denominator, first and unconditionally.
const sites = scan();
console.log(`  [source] ${sites.length} capable site(s) found over ${FILES.length} scanned file(s); ` +
            `${FKS.length} FK relation(s) across ${FK_MODELS.length} model(s) read from prisma/schema.prisma\n`);

// ── 6a. the inventory itself cannot be vacuous ───────────────────────────────
// ⚠️ 17 FKs across FIFTEEN models, not sixteen: `DuplicateAccountCandidate`
// carries TWO (accountAId/accountBId) and so does `Transaction`
// (financialAccountId/counterpartyAccountId). Counted, not assumed.
check(`the FK inventory parsed: ${FKS.length} relations across ${FK_MODELS.length} models`,
  FKS.length >= 17 && FK_MODELS.length >= 15,
  `parsed ${FKS.length}/${FK_MODELS.length} — a parse failure would empty the scan and make every check below vacuous`);
check("Transaction.counterpartyAccountId is IN the inventory (the second FK no RLS predicate mentions)",
  FKS.some((f) => f.model === "Transaction" && f.field === "counterpartyAccountId"));
check("the scan found a non-zero population (an empty scan is indistinguishable from a clean one)",
  sites.length > 0, `${sites.length} sites`);
check(`the scanned file set is the enumerate-then-filter form, not a git pathspec glob (${FILES.length} files)`,
  FILES.length > 500 && FILES.some((f) => f === "lib/auth.ts"),
  "lib/auth.ts missing — the `lib/**/*.ts` pathspec defect has returned");

// ── 6b. every site is classified ─────────────────────────────────────────────
const byKey = new Map<string, Site[]>();
for (const s of sites) byKey.set(s.key, [...(byKey.get(s.key) ?? []), s]);
const allowed = new Map(ALLOWLIST.map((e) => [e.key, e]));

const unclassified = [...byKey.keys()].filter((k) => !allowed.has(k)).sort();
check("every capable site is CLASSIFIED in the closed allowlist",
  unclassified.length === 0,
  unclassified.length
    ? `UNCLASSIFIED RE-PARENTING-CAPABLE SITE(S) — add an entry to ALLOWLIST in this file, with a reason, or guard the site:\n      ` +
      unclassified.map((k) => {
        const g = byKey.get(k)!;
        return `${k}  (line${g.length > 1 ? "s" : ""} ${g.map((s) => s.line).join(", ")})  [${g[0].capability}] ${g[0].detail}`;
      }).join("\n      ")
    : "");

const stale = ALLOWLIST.filter((e) => !byKey.has(e.key)).map((e) => e.key);
check("no allowlist entry describes a site that no longer exists (the ratchet may SHRINK, by deleting the entry)",
  stale.length === 0,
  stale.length ? `stale entr${stale.length === 1 ? "y" : "ies"}: ${stale.join(", ")} — the site is gone; delete the entry` : "");

for (const e of ALLOWLIST) {
  const g = byKey.get(e.key);
  if (!g) continue;
  check(`${e.key} — ${g.length} statement(s), expected ${e.expect} [${e.verdict}]`,
    g.length === e.expect,
    `found ${g.length} at line(s) ${g.map((s) => s.line).join(", ")}; a NEW statement of this shape must be classified on purpose, not absorbed`);
  if (e.pin) {
    const code = stripComments(readFileSync(join(ROOT, fileOf(e.key)), "utf8"));
    check(`${e.key} — its stated guard is still present (${e.pin})`,
      code.includes(e.pin), `"${e.pin}" is gone from ${fileOf(e.key)}, so the verdict ${e.verdict} no longer holds`);
  }
}

// ── 6b2. the eliminated sites stay eliminated ───────────────────────────────
for (const r of REMOVED_SITES) {
  const code = stripComments(readFileSync(join(ROOT, r.file), "utf8"));
  check(`${r.file} — the removed FK write has NOT returned`,
    !r.absent.test(code), `${r.absent} matched again — re-adding this clause re-creates a relocation path; see REMOVED_SITES in this file`);
  check(`${r.file} — its replacement payload is still ${r.required}`,
    code.includes(r.required), `"${r.required}" is gone, so the elimination can no longer be verified`);
}

// ── 6b3. THE LITERAL THAT KEEPS TWO SITES HARMLESS ──────────────────────────
// `buildFlowWriteFields` is the single builder every CLASSIFIER write path
// spreads, and it puts `counterpartyAccountId` into every one of those patches.
// It is a LITERAL `null` today, which is why those patches can only clear a
// pointer. The day it becomes an expression, two FK_CLEARED_ONLY sites become
// real re-parenting sites — on a column NO RLS predicate mentions — and nothing
// else in this audit would notice, because the payloads are spreads.
{
  const b = stripComments(readFileSync(join(ROOT, "lib/transactions/plaid-flow-input.ts"), "utf8"));
  // ⚠️ THE INTERFACE MEMBER IS NOT AN ASSIGNMENT. `FlowWriteFields` declares
  // `counterpartyAccountId: string | null;` and a naive scan read that as a
  // non-null write and failed. A TypeScript interface member ends in `;`; an
  // object-literal property ends in `,` or a newline. Discriminating on the
  // terminator is what tells a TYPE from a VALUE here — the same class of error
  // as matching `failed` inside `0 failed`.
  const all = [...b.matchAll(/counterpartyAccountId:\s*([^,\n]+)/g)].map((m) => m[1].trim());
  const assignments = all.filter((v) => !v.endsWith(";"));
  check(`buildFlowWriteFields still assigns counterpartyAccountId the literal null (${assignments.length} assignment(s) of ${all.length} mention(s))`,
    assignments.length > 0 && assignments.every((v) => v === "null"),
    `found ${JSON.stringify(assignments)} — a non-null value here turns the CSV-import and merchant-correction patches into real counterparty re-parenting writes`);
}

// ── 6c. the guard module is the single authority ─────────────────────────────
{
  const guard = stripComments(readFileSync(join(ROOT, "lib/accounts/account-reparenting.ts"), "utf8"));
  check("the guard module exists and exports BOTH halves (a destination-only check is insufficient)",
    /export function assertAccountFkUnchanged\(/.test(guard)
      && /export async function assertAccountReparentingAuthorized\(/.test(guard));
  check("the guard never learns visibilityLevel (RLS = tenancy; the tier is lib/account-privacy.ts's)",
    !/visibilityLevel|BALANCE_ONLY/.test(guard));
  check("the guard imports no client — the probe issues through the writer's own authority",
    !/from\s+["']@\/lib\/db["']/.test(guard));

  // There must be exactly one guard module, not a second copy under a second
  // name. The primitive this programme already wrote twice is the reason.
  // ⚠️ THE AUDIT AND ITS SUITE NAME THESE TYPES IN THEIR OWN STRINGS AND
  // IMPORTS, and a scan that flagged them would be reporting itself.
  const SELF = new Set(["lib/accounts/account-reparenting.ts", "scripts/audit-account-reparenting.ts"]);
  const copies = FILES.filter((f) => !SELF.has(f))
    .filter((f) => /ReparentingRefusedError|UnintendedReparentingError/.test(
      stripComments(readFileSync(join(ROOT, f), "utf8"))))
    .filter((f) => !/\bimport\b/.test(
      stripComments(readFileSync(join(ROOT, f), "utf8")).split("\n")
        .filter((l) => /ReparentingRefusedError|UnintendedReparentingError/.test(l)).join("\n")));
  check("no SECOND copy of the refusal types exists under another name",
    copies.length === 0, copies.join(", "));
}

// ── 6d. counterpartyAccountId — the closed reference inventory ──────────────
{
  const refs = FILES.filter((f) => /\bcounterpartyAccountId\b/.test(stripComments(readFileSync(join(ROOT, f), "utf8")))).sort();
  const known = Object.keys(COUNTERPARTY_REFERENCES).sort();
  const added = refs.filter((f) => !(f in COUNTERPARTY_REFERENCES));
  const gone  = known.filter((f) => !refs.includes(f));
  check(`Transaction.counterpartyAccountId — ${refs.length} referencing file(s), all with a recorded role`,
    added.length === 0,
    added.length
      ? `UNCLASSIFIED PARTICIPANT(S) in the counterparty FK — it is in NO RLS predicate, so a cross-owner value is invisible to tenancy enforcement. ` +
        `Add each to COUNTERPARTY_REFERENCES with its role (WRITE/DTO/GATE/AUTHORITY/READ/UI/AUDIT):\n      ${added.join("\n      ")}`
      : "");
  check("no recorded counterparty participant has disappeared (the inventory may SHRINK, by deleting the entry)",
    gone.length === 0, gone.length ? `stale: ${gone.join(", ")}` : "");
  const writers = refs.filter((f) => COUNTERPARTY_REFERENCES[f] === "WRITE");
  check("exactly ONE file persists the counterparty FK, and it resolves the value from the owner's own wallet map",
    writers.length === 1 && writers[0] === "lib/crypto/btc-sync.ts", `writers: ${writers.join(", ") || "(none)"}`);
  const gate = stripComments(readFileSync(join(ROOT, "lib/transactions/counterparty-visibility.ts"), "utf8"));
  check("reading it is gated by the APPLICATION (gatedCounterpartyId), independently of RLS",
    /export function gatedCounterpartyId\(/.test(gate) && /spaceAccountLinks\.length > 0/.test(gate));
  const roles = new Map<CpRole, number>();
  for (const f of refs) roles.set(COUNTERPARTY_REFERENCES[f], (roles.get(COUNTERPARTY_REFERENCES[f]) ?? 0) + 1);
  console.log(`  [counterparty] ${refs.length} participants — ${[...roles.entries()].sort().map(([r, n]) => `${r}=${n}`).join(" ")}`);
}

// ── 6e. the report ───────────────────────────────────────────────────────────
console.log("\n  classification of every capable site:\n");
for (const [key, group] of [...byKey.entries()].sort()) {
  const e = allowed.get(key);
  console.log(`    ${e ? e.verdict.padEnd(21) : "UNCLASSIFIED".padEnd(21)} ${key}  line(s) ${group.map((s) => s.line).join(",")}  [${group[0].capability}]`);
}
const tally = new Map<string, number>();
for (const [key, group] of byKey) {
  const v = allowed.get(key)?.verdict ?? "UNCLASSIFIED";
  tally.set(v, (tally.get(v) ?? 0) + group.length);
}
console.log(`\n  by verdict: ${[...tally.entries()].sort().map(([v, n]) => `${v}=${n}`).join("  ")}`);

console.log(failures === 0
  ? `\naudit-account-reparenting: ${sites.length} capable site(s) over ${FILES.length} file(s), all classified.\n`
  : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
