/**
 * lib/accounts/account-spine-s4.authority.test.ts  (RLS-ACC-S4)
 *
 * THE SHARED SPINE WRITER WRITES IN THE ONLY ORDER THE POLICIES PERMIT, AND THE
 * MIRROR-TABLE HELPER NO LONGER SWALLOWS A REFUSAL IT CANNOT RECOGNISE.
 *
 * ── THE ORDERING IS PROVED BY RUNNING, NOT BY READING ────────────────────────
 * `persistAccountSpine` takes a client, so it can be driven. A RECORDING client
 * logs every statement in sequence, and the assertion is on the ORDER of the log.
 * That is the strongest available proof short of a live role, because the thing a
 * later "tidy-up" would do — move the connection read back to the top, where it
 * reads more naturally — changes the log and nothing else.
 *
 * Measured against a real provisioned `fm_app` role on a throwaway Postgres
 * (not reproduced here, because this suite must stay docker-free):
 *
 *   AccountConnection.create      with no ACTIVE link  → 42501, RAISES
 *   ProviderAccountIdentity.create with no ACTIVE link → 42501, RAISES
 *   FinancialAccount.findUnique    with no ACTIVE link → VISIBLE (owner arm)
 *   FA.create → SAL.create → AC.create → PAI.create    → ALL SUCCEED
 *   with the link REVOKED: AccountConnection.findFirst → NULL for a row that is
 *     genuinely there (owner count 1), and a second identical row then LANDS,
 *     because that table has no unique constraint — count 1 → 2, nothing raised.
 *
 * That last one is why the SAL write had to move above the connection READ and
 * not merely above the connection WRITE: a refused write is loud, a blinded read
 * is a silent duplicate.
 *
 * ── THE REFUSAL PREDICATE IS TESTED AGAINST THE REAL MESSAGE ────────────────
 * `isAuthorityRefusal` is driven with the VERBATIM tail Prisma produced on that
 * real run, plus the negative controls that matter: a P2002 collision (the
 * condition the catch was actually written for) must NOT be treated as a
 * refusal, and a P2010 raw-query grant denial must be.
 *
 * ⚠️ Every absence claim has a denominator asserted first, and each scan needle
 * is shown to MATCH before any zero is read.
 *
 *   npx tsx lib/accounts/account-spine-s4.authority.test.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ShareStatus, VisibilityLevel, ProviderType } from "@prisma/client";

import { persistAccountSpine } from "@/lib/accounts/persist-account-spine";
import {
  isAuthorityRefusal,
  ProviderIdentityAuthorityRefusedError,
} from "@/lib/accounts/provider-identity";
import type { DbClient } from "@/lib/accounts/space-account-link";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = join(__dirname, "..", "..");
const raw = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
/** Comments stripped, so a header EXPLAINING a hazard never satisfies a scan for it. */
const code = (rel: string) => raw(rel).replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const SPINE  = "lib/accounts/persist-account-spine.ts";
const IDENT  = "lib/accounts/provider-identity.ts";
const WALLET = "lib/accounts/wallet-connection.ts";

// ═════════════════════════════════════════════════════════════════════════════
// PART A — THE WRITE ORDER, BY EXECUTION
// ═════════════════════════════════════════════════════════════════════════════

/** Records every statement persistAccountSpine issues, in sequence. */
function recordingClient(existingConnectionId: string | null) {
  const log: string[] = [];
  const client = {
    accountConnection: {
      findFirst: async () => { log.push("accountConnection.findFirst"); return existingConnectionId ? { id: existingConnectionId, connectionId: null } : null; },
      create:    async () => { log.push("accountConnection.create"); return { id: "ac-new" }; },
      update:    async () => { log.push("accountConnection.update"); return { id: existingConnectionId }; },
    },
    spaceAccountLink: {
      count:     async () => { log.push("spaceAccountLink.count"); return 0; },
      findFirst: async () => { log.push("spaceAccountLink.findFirst"); return null; },
      upsert:    async () => { log.push("spaceAccountLink.upsert"); return { id: "sal-1" }; },
      update:    async () => { log.push("spaceAccountLink.update"); return { id: "sal-1" }; },
      create:    async () => { log.push("spaceAccountLink.create"); return { id: "sal-1" }; },
    },
    financialAccount: {
      findUnique: async () => { log.push("financialAccount.findUnique"); return { createdByUserId: "u1", ownerUserId: "u1" }; },
    },
  } as unknown as DbClient;
  return { client, log };
}

async function main(): Promise<void> {
  console.log("A1. persistAccountSpine — THE LINK IS WRITTEN BEFORE THE CONNECTION IS EVEN READ");
  {
    const fresh = recordingClient(null);
    await persistAccountSpine({
      financialAccountId: "fa-1",
      spaceId: "sp-1",
      addedByUserId: "u1",
      creatorUserId: "u1",
      connection: { connectedByUserId: "u1", syncStatus: "manual" },
      client: fresh.client,
    });
    check("FIXTURE IS NON-EMPTY: the writer issued statements at all", fresh.log.length > 0,
      `${fresh.log.length} statement(s)`);
    check("…including BOTH a link write and a connection write (so the ordering claim is real)",
      fresh.log.some((s) => s.startsWith("spaceAccountLink.")) &&
      fresh.log.some((s) => s.startsWith("accountConnection.")),
      fresh.log.join(" → "));

    const firstLinkWrite = fresh.log.findIndex((s) => /^spaceAccountLink\.(upsert|create|update)$/.test(s));
    const connRead  = fresh.log.indexOf("accountConnection.findFirst");
    const connWrite = fresh.log.findIndex((s) => /^accountConnection\.(create|update)$/.test(s));

    check("the link write happens", firstLinkWrite !== -1, fresh.log.join(" → "));
    check("the connection existence PROBE happens", connRead !== -1, fresh.log.join(" → "));
    check("the connection write happens", connWrite !== -1, fresh.log.join(" → "));
    check("THE LINK IS WRITTEN BEFORE THE CONNECTION IS READ — a blinded probe duplicates a row",
      firstLinkWrite < connRead, fresh.log.join(" → "));
    check("…and therefore before the connection is WRITTEN — a 42501 would roll the whole thing back",
      firstLinkWrite < connWrite, fresh.log.join(" → "));
    check("a fresh account takes the CREATE branch, as before", fresh.log.includes("accountConnection.create"));
  }

  console.log("\nA2. …and the RE-LINK path keeps the same order and still UPDATES");
  {
    const relink = recordingClient("ac-existing");
    await persistAccountSpine({
      financialAccountId: "fa-1",
      spaceId: "sp-1",
      addedByUserId: "u1",
      creatorUserId: "u1",
      connection: { connectedByUserId: "u1", plaidItemDbId: "pi-1", connectionId: "c-1", syncStatus: "synced" },
      client: relink.client,
    });
    const firstLinkWrite = relink.log.findIndex((s) => /^spaceAccountLink\.(upsert|create|update)$/.test(s));
    const connRead = relink.log.indexOf("accountConnection.findFirst");
    check("an existing connection is UPDATED, not duplicated",
      relink.log.includes("accountConnection.update") && !relink.log.includes("accountConnection.create"),
      relink.log.join(" → "));
    check("the link still precedes the probe — which is the ONLY reason the probe found it",
      firstLinkWrite !== -1 && connRead !== -1 && firstLinkWrite < connRead, relink.log.join(" → "));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\nB1. isAuthorityRefusal — against the REAL message, and the controls that matter");
  // ═══════════════════════════════════════════════════════════════════════════
  {
    // Captured VERBATIM from a refused `tx.providerAccountIdentity.create()` on a
    // real provisioned fm_app role. Prisma gives this NO `code` at all.
    const realTail =
      'Error occurred during query execution: ConnectorError(ConnectorError { user_facing_error: None, ' +
      'kind: QueryError(PostgresError { code: "42501", message: "new row violates row-level security policy ' +
      'for table \\"ProviderAccountIdentity\\"", severity: "ERROR", detail: None, column: None, hint: None }), ' +
      'transient: false })';
    const measured = new Error(
      'Invalid `tx.providerAccountIdentity.create()` invocation in /x/y.ts:1:1\n\n' + realTail);
    check("the measured refusal has NO typed Prisma code (which is why e.code === \"P2002\" never saw it)",
      (measured as { code?: unknown }).code === undefined);
    check("THE REAL REFUSAL IS RECOGNISED", isAuthorityRefusal(measured));

    // The two wordings the policies and the grants produce are both covered.
    check("a WITH CHECK refusal is recognised by its wording alone",
      isAuthorityRefusal(new Error('new row violates row-level security policy for table "AccountConnection"')));
    check("a missing GRANT is recognised too",
      isAuthorityRefusal(new Error('permission denied for table "SyncIssue"')));
    check("a bare SQLSTATE is recognised",
      isAuthorityRefusal(new Error("ERROR: 42501 something")));

    // NEGATIVE CONTROLS — the whole point is the DISTINCTION, so these carry
    // as much weight as the positives.
    const p2002 = Object.assign(
      new Error("Unique constraint failed on the fields: (`provider`,`externalAccountId`,`financialAccountId`)"),
      { code: "P2002" });
    check("the UNIQUE COLLISION the catch was written for is NOT a refusal", !isAuthorityRefusal(p2002));
    check("a foreign-key error is not a refusal",
      !isAuthorityRefusal(Object.assign(new Error("Foreign key constraint failed"), { code: "P2003" })));
    check("a not-found is not a refusal",
      !isAuthorityRefusal(Object.assign(new Error("Record to update not found"), { code: "P2025" })));
    check("an ordinary provider failure is not a refusal",
      !isAuthorityRefusal(new Error("explorer request timed out after 10000ms")));
    check("a non-Error is not a refusal", !isAuthorityRefusal("42501") && !isAuthorityRefusal(null));
    check("P2010 IS admitted — a refused RAW query is the one typed code that carries a SQLSTATE",
      isAuthorityRefusal(Object.assign(
        new Error('Raw query failed. Code: `42501`. Message: `permission denied for table "SyncIssue"`'),
        { code: "P2010" })));
    check("…but P2010 alone is not enough — the SQLSTATE still has to be there",
      !isAuthorityRefusal(Object.assign(
        new Error("Raw query failed. Code: `22P02`. Message: `invalid input syntax`"), { code: "P2010" })));
    check("the error type carries the account and the provider for an operator, and no identifier",
      (() => {
        const e = new ProviderIdentityAuthorityRefusedError("fa-9", ProviderType.PLAID, measured);
        return e.financialAccountId === "fa-9" && e.provider === ProviderType.PLAID &&
               e.message.includes("fa-9") && !e.message.includes("addr") && /ORDER/.test(e.message);
      })());
  }

  console.log("\nB2. …and the helper THROWS it rather than warning past it");
  {
    const c = code(IDENT);
    check("the catch consults the predicate", /if \(isAuthorityRefusal\(e\)\)/.test(c));
    check("…and THROWS", /throw new ProviderIdentityAuthorityRefusedError\(/.test(c));
    const throwAt = c.indexOf("throw new ProviderIdentityAuthorityRefusedError(");
    const warnAt  = c.indexOf("console.warn(");
    check("both the throw and the warn exist (so the ordering claim is not vacuous)",
      throwAt !== -1 && warnAt !== -1, `throw@${throwAt} warn@${warnAt}`);
    check("THE THROW PRECEDES THE WARN — otherwise the refusal is logged and returned as success",
      throwAt < warnAt);
    check("the collision path is UNCHANGED: it still warns and returns normally",
      /non-fatal/.test(c) && !/throw;/.test(c));
    check("the module no longer declares the swallow as unconditional",
      !/catch \(e\) \{\s*console\.warn/.test(c));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\nC1. wallet-connection — THE DEAD EXPORTS, AND THE COUNT WAS ONE SHORT");
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const w = code(WALLET);
    check(`${WALLET} exists and is substantial`, existsSync(join(ROOT, WALLET)) && w.length > 2000);

    // The needle must MATCH a live export before any absence is read.
    check("CONTROL: the export needle matches a LIVE export",
      /export async function alignWalletProviderSpine/.test(w));

    check("the duplicate `DbClient` type export is GONE", !/export type DbClient/.test(w));
    check("…and the shared one is imported instead",
      /import type \{ DbClient \} from "@\/lib\/accounts\/space-account-link"/.test(w));
    check("the formatter re-export is GONE",
      !/export \{ walletConnectionCredential, walletExternalConnectionId \}/.test(w));
    check("…but both are still USED internally, so removing the re-export was not removing the call",
      /walletConnectionCredential\(params\.address, params\.chain\)/.test(w) &&
      /walletExternalConnectionId\(params\.chain, params\.address\)/.test(w));

    check("ensureWalletConnection is module-private now",
      /\nasync function ensureWalletConnection\(/.test(w) &&
      !/export async function ensureWalletConnection\(/.test(w));
    check("linkAccountConnectionToWalletConnection is module-private now",
      /\nasync function linkAccountConnectionToWalletConnection\(/.test(w) &&
      !/export async function linkAccountConnectionToWalletConnection\(/.test(w));
    check("…and both are still CALLED, so un-exporting was not deleting live code",
      /await ensureWalletConnection\(client, \{/.test(w) &&
      /await linkAccountConnectionToWalletConnection\(client, \{/.test(w));

    check("the two privates take their client REQUIRED and LEADING",
      /function ensureWalletConnection\(client: DbClient, params: \{/.test(w) &&
      /function linkAccountConnectionToWalletConnection\(client: DbClient, params: \{/.test(w));
    check("neither private has a `?? db` of its own any more",
      (w.match(/\?\? db/g) ?? []).length === 4,
      `${(w.match(/\?\? db/g) ?? []).length} remain — expected the four OPEN ones, named in the header`);
    check("every remaining resolution is annotated as UNRESOLVED rather than silent",
      (raw(WALLET).match(/UNRESOLVED, AND/g) ?? []).length === 4,
      `${(raw(WALLET).match(/UNRESOLVED, AND/g) ?? []).length} marker(s)`);
    check("alignWalletProviderSpine resolves the authority EXACTLY ONCE and threads it",
      (w.match(/const client: DbClient = params\.client \?\? db;/g) ?? []).length === 4 &&
      !/client:\s*params\.client/.test(w));
    check("the header names the five blocked call sites, so the ask is not a shrug",
      /btc-sync\.ts/.test(raw(WALLET)) && /sol-sync\.ts/.test(raw(WALLET)) &&
      /evm-native\.ts/.test(raw(WALLET)) && /wallet-sync-dispatch\.ts/.test(raw(WALLET)) &&
      /FENCED/.test(raw(WALLET)));
    check("the authority refusal is DISTINGUISHED here too, without breaking the non-fatal contract",
      /isAuthorityRefusal\(e\)/.test(w) && /AUTHORITY REFUSED/.test(w) && /return null/.test(w));
  }

  console.log("\nC2. REACHABILITY — the live import surface is EXACTLY the six symbols");
  {
    // A pin, not a search: if a dead export comes back, or a new consumer appears,
    // this goes red and somebody has to redo the reachability work deliberately.
    const LIVE = [
      "alignWalletProviderSpine", "touchWalletConnectionStatus", "clearWalletConnectionError",
      "markWalletAccountConnectionSynced", "recordWalletSyncRefusal", "recordWalletFacetSuccess",
    ].sort();
    const IMPORTERS = [
      "app/api/accounts/wallet/route.ts",
      "lib/crypto/wallet-sync-dispatch.ts",
      "lib/crypto/sol-sync.ts",
      "lib/crypto/evm-native.ts",
      "lib/crypto/btc-sync.ts",
    ];
    const found = new Set<string>();
    let importStatements = 0;
    for (const rel of IMPORTERS) {
      check(`${rel} exists`, existsSync(join(ROOT, rel)));
      const src = raw(rel);
      for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"@\/lib\/accounts\/wallet-connection"/g)) {
        importStatements++;
        for (const sym of m[1].split(",").map((s) => s.trim()).filter(Boolean)) found.add(sym.replace(/^type\s+/, ""));
      }
    }
    check("the five importers were all parsed (so the symbol set is not empty by accident)",
      importStatements === 5, `${importStatements} import statement(s)`);
    check("the imported symbol set is EXACTLY the six live exports",
      JSON.stringify([...found].sort()) === JSON.stringify(LIVE),
      `found: ${[...found].sort().join(", ")}`);
    check("no importer asks for a symbol this slice made private or deleted",
      !found.has("ensureWalletConnection") && !found.has("linkAccountConnectionToWalletConnection") &&
      !found.has("DbClient") && !found.has("walletConnectionCredential") &&
      !found.has("walletExternalConnectionId"));
  }

  console.log("\nC3. THE SPINE WRITER'S HEADER KEEPS THE TWO MEASUREMENTS");
  {
    const h = raw(SPINE);
    check("it records the 42501 refusal", /42501/.test(h));
    check("it records the BLINDED PROBE and the missing unique constraint",
      /BLINDED/.test(h) && /unique constraint/i.test(h));
    check("it records that FinancialAccount's owner arm is what makes the inversion possible",
      /ownerUserId/.test(h));
    check("it warns against tidying the order back", /DO NOT "TIDY"/.test(h));
  }

  if (failures > 0) {
    console.error(`\nRLS-ACC-S4 account-spine authority: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nRLS-ACC-S4 account-spine authority: all passed.");
}

// Referenced so the enum imports are not unused — the spine writer's own
// constants, asserted present rather than re-declared.
void ShareStatus.ACTIVE;
void VisibilityLevel.FULL;

void main();
