/**
 * lib/plaid/reauth-codes.test.ts
 *
 * The update-mode-fixable item-error set is ONE list, and every consumer agrees
 * on it:
 *   1. the sync classifier (errors.ts) maps it to NEEDS_REAUTH;
 *   2. the member Connections UI offers Reconnect for NEEDS_REAUTH and for an
 *      ERROR item whose code is in it — and for no other ERROR;
 *   3. the webhook ITEM/ERROR path writes the same status as the sync path;
 *   4. the provider-connection verdict calls every code in it customer-actionable;
 *   5. no consumer keeps a literal copy;
 *   6. relink heals an ERROR item (the health chokepoint, with allowReactivation);
 *   7. an item-level error opens ONE incident, re-affirmation opens nothing, and
 *      a completed sync resolves it — through the existing lifecycle authority.
 *
 * DB-free, Plaid-free.
 * Run:  npx tsx lib/plaid/reauth-codes.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { PlaidItemStatus } from "@prisma/client";
import {
  UPDATE_MODE_FIXABLE_CODES, NEEDS_REAUTH_CODES, canReconnectViaUpdateMode, isUpdateModeFixable,
} from "./reauth-codes";
import { classifyPlaidErrorForHealth } from "./errors";
import { webhookHealthTransition, WEBHOOK_REAUTH_ERROR_CODES } from "./webhook-receiver";
import { CUSTOMER_REAUTH_CODES, connectionTrustState } from "@/lib/platform/verdicts/provider-connection";
import { offersReconnect, summarizeConnection } from "@/lib/connections/connection-summary";
import { setPlaidItemHealth } from "@/lib/connections/health-transitions";
import type { SyncIssueInput } from "./syncIssues";
import { recordIncidentObservation, resolveByAutomaticRecovery, type IncidentClient } from "@/lib/platform/incidents/lifecycle";
import { classifySyncIssue } from "@/lib/platform/sync-issue-semantics";
import type { SyncConnection } from "@/lib/sync/status";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const strip = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** An Axios-shaped Plaid error, as the SDK throws it. */
const plaidErr = (code: string, status = 400) =>
  Object.assign(new Error("plaid"), { isAxiosError: true, response: { status, data: { error_code: code } } });

const conn = (over: Partial<SyncConnection> = {}): SyncConnection => ({
  id: "c1", provider: "PLAID", institution: "Example Bank", state: "error", lastSyncedAt: null,
  errorCode: null, importedCount: null, historyBuild: null, deferredReason: null, investments: null, ...over,
});

// ── Fakes ─────────────────────────────────────────────────────────────────────
function itemClient(initial: { status: PlaidItemStatus; errorCode: string | null }) {
  const row = { userId: "u1", ...initial };
  const audits: Record<string, unknown>[] = [];
  const client = {
    plaidItem: {
      findUnique: async () => ({ ...row }),
      update: async ({ data }: { data: { status?: PlaidItemStatus; errorCode?: string | null } }) => {
        if (data.status !== undefined) row.status = data.status;
        if (data.errorCode !== undefined) row.errorCode = data.errorCode;
        return row;
      },
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return data; } },
  };
  return { client: client as unknown as Parameters<typeof setPlaidItemHealth>[3], row, audits };
}

type IssueRow = Record<string, unknown> & { id: string; incidentKey: string | null; resolved: boolean };
function incidentClient() {
  const issues: IssueRow[] = [];
  let n = 0;
  const match = (row: IssueRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (row[k] ?? null) === v);
  const syncIssue = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (data.incidentKey !== null && data.resolved === false &&
          issues.some((r) => r.incidentKey === data.incidentKey && r.resolved === false)) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      const row = { ...data, id: `i${++n}` } as IssueRow;
      issues.push(row);
      return row;
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) => issues.find((r) => match(r, where)) ?? null,
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => issues.filter((r) => (where ? match(r, where) : true)),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = issues.find((r) => r.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hits = issues.filter((r) => match(r, where));
      hits.forEach((r) => Object.assign(r, data));
      return { count: hits.length };
    },
  };
  const client = {
    syncIssue,
    syncIssueOccurrence: { create: async ({ data }: { data: Record<string, unknown> }) => ({ ...data, id: `o${++n}` }) },
    syncIssueEvent: { create: async ({ data }: { data: Record<string, unknown> }) => ({ ...data, id: `e${++n}` }) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ syncIssue, syncIssueEvent: client.syncIssueEvent }),
  };
  return { client: client as unknown as IncidentClient, issues };
}

async function main() {
  console.log("0. the set itself (Plaid-documented update-mode fixes only)");
  {
    check("ITEM_LOGIN_REQUIRED and ACCESS_NOT_GRANTED are update-mode-fixable",
      isUpdateModeFixable("ITEM_LOGIN_REQUIRED") && isUpdateModeFixable("ACCESS_NOT_GRANTED"));
    for (const c of ["NO_ACCOUNTS", "ITEM_LOCKED", "USER_SETUP_REQUIRED"]) {
      check(`${c} is NOT in the set (Plaid's docs do not name update mode as its fix)`, !isUpdateModeFixable(c));
    }
    for (const c of ["USER_PERMISSION_REVOKED", "PENDING_EXPIRATION", "PENDING_DISCONNECT",
                     "INVALID_CREDENTIALS", "INVALID_MFA", "INSUFFICIENT_CREDENTIALS", "MFA_NOT_SUPPORTED", "INVALID_ACCESS_TOKEN"]) {
      check(`${c} is excluded from the update-mode-fixable set`, !isUpdateModeFixable(c));
    }
    check("INVALID_ACCESS_TOKEN stays NEEDS_REAUTH (unchanged; not claimed update-mode-fixable)",
      NEEDS_REAUTH_CODES.has("INVALID_ACCESS_TOKEN"));
    check("NEEDS_REAUTH = update-mode-fixable + INVALID_ACCESS_TOKEN, nothing else",
      NEEDS_REAUTH_CODES.size === UPDATE_MODE_FIXABLE_CODES.size + 1 && [...UPDATE_MODE_FIXABLE_CODES].every((c) => NEEDS_REAUTH_CODES.has(c)));
  }

  console.log("1. sync classifier (errors.ts)");
  {
    for (const c of NEEDS_REAUTH_CODES) {
      check(`${c} → NEEDS_REAUTH`, classifyPlaidErrorForHealth(plaidErr(c))?.status === PlaidItemStatus.NEEDS_REAUTH);
    }
    check("ACCESS_NOT_GRANTED now → NEEDS_REAUTH (was ERROR: a lockout with no action)",
      classifyPlaidErrorForHealth(plaidErr("ACCESS_NOT_GRANTED"))?.status === PlaidItemStatus.NEEDS_REAUTH);
    check("ITEM_LOCKED stays transient → null (status unchanged, never ERROR)",
      classifyPlaidErrorForHealth(plaidErr("ITEM_LOCKED")) === null);
    check("INSTITUTION_DOWN stays transient → null", classifyPlaidErrorForHealth(plaidErr("INSTITUTION_DOWN")) === null);
    check("NO_ACCOUNTS (unverified) stays ERROR", classifyPlaidErrorForHealth(plaidErr("NO_ACCOUNTS"))?.status === PlaidItemStatus.ERROR);
    check("INSTITUTION_NO_LONGER_SUPPORTED stays ERROR",
      classifyPlaidErrorForHealth(plaidErr("INSTITUTION_NO_LONGER_SUPPORTED"))?.status === PlaidItemStatus.ERROR);
  }

  console.log("2. member Connections UI");
  {
    check("ERROR + ACCESS_NOT_GRANTED → Reconnect offered", offersReconnect(conn({ errorCode: "ACCESS_NOT_GRANTED" })));
    check("ERROR + ITEM_LOGIN_REQUIRED (legacy row) → Reconnect offered", offersReconnect(conn({ errorCode: "ITEM_LOGIN_REQUIRED" })));
    check("ERROR + INSTITUTION_DOWN → NO Reconnect", !offersReconnect(conn({ errorCode: "INSTITUTION_DOWN" })));
    check("ERROR + NO_ACCOUNTS → NO Reconnect (excluded until Plaid documents update mode for it)",
      !offersReconnect(conn({ errorCode: "NO_ACCOUNTS" })));
    check("ERROR + no code → NO Reconnect", !offersReconnect(conn({ errorCode: null })));
    check("needs_reauth → Reconnect offered (any code)", offersReconnect(conn({ state: "needs_reauth", errorCode: "INVALID_ACCESS_TOKEN" })));
    check("ready → no Reconnect", !offersReconnect(conn({ state: "ready" })));
    check("a wallet never reconnects through Plaid", !offersReconnect(conn({ provider: "WALLET", errorCode: "ACCESS_NOT_GRANTED" })));
    check("row: ERROR + fixable code reads 'Reconnect needed'",
      summarizeConnection(conn({ errorCode: "ACCESS_NOT_GRANTED" }), undefined, 1).status === "Reconnect needed");
    check("row: ERROR + INSTITUTION_DOWN still reads 'Sync issue'",
      summarizeConnection(conn({ errorCode: "INSTITUTION_DOWN" }), undefined, 1).status === "Sync issue");
    check("canReconnectViaUpdateMode on raw statuses",
      canReconnectViaUpdateMode("NEEDS_REAUTH", null) && canReconnectViaUpdateMode("ERROR", "ACCESS_NOT_GRANTED")
      && !canReconnectViaUpdateMode("ERROR", "INSTITUTION_DOWN") && !canReconnectViaUpdateMode("ACTIVE", "ITEM_LOGIN_REQUIRED")
      && !canReconnectViaUpdateMode("REVOKED", "ITEM_LOGIN_REQUIRED"));
    const card = strip("components/connections/ConnectionCard.tsx");
    const errArm = card.slice(card.indexOf('case "error":'), card.indexOf("break;", card.indexOf('case "error":')));
    check("drawer: the error arm renders the Reconnect content when offersReconnect",
      /offersReconnect\(connection\)\s*\?\s*<NeedsReauthContent/.test(errArm), errArm);
    const reauth = card.slice(card.indexOf("function NeedsReauthContent"), card.indexOf("function NeedsReauthContent") + 900);
    check("…and that content carries the update-mode Reconnect button", /<ReconnectAccountButton plaidItemId=\{connection\.id\}/.test(reauth));
  }

  console.log("3. webhook ITEM/ERROR path agrees with the sync path");
  {
    check("the webhook reauth set IS the shared set", WEBHOOK_REAUTH_ERROR_CODES === NEEDS_REAUTH_CODES);
    for (const c of NEEDS_REAUTH_CODES) {
      check(`ITEM/ERROR ${c} → NEEDS_REAUTH`, webhookHealthTransition("ITEM", "ERROR", c)?.status === "NEEDS_REAUTH");
    }
    check("ITEM/ERROR NO_ACCOUNTS → no transition (status unchanged; not update-mode-fixable per Plaid docs)",
      webhookHealthTransition("ITEM", "ERROR", "NO_ACCOUNTS") === null);
    check("ITEM/ERROR INSTITUTION_DOWN → no transition", webhookHealthTransition("ITEM", "ERROR", "INSTITUTION_DOWN") === null);
    check("ITEM/USER_PERMISSION_REVOKED → REVOKED (unchanged)",
      webhookHealthTransition("ITEM", "USER_PERMISSION_REVOKED", null)?.status === "REVOKED");
  }

  console.log("4. provider verdict and member UI agree on every code in the set");
  {
    for (const c of UPDATE_MODE_FIXABLE_CODES) {
      const sync = classifyPlaidErrorForHealth(plaidErr(c))?.status;
      check(`${c}: verdict NEEDS_REAUTH ⇔ UI Reconnect ⇔ sync NEEDS_REAUTH ⇔ webhook NEEDS_REAUTH`,
        connectionTrustState("ERROR", c) === "NEEDS_REAUTH" && CUSTOMER_REAUTH_CODES.has(c)
        && offersReconnect(conn({ errorCode: c })) && sync === PlaidItemStatus.NEEDS_REAUTH
        && webhookHealthTransition("ITEM", "ERROR", c)?.status === "NEEDS_REAUTH");
    }
    check("every NEEDS_REAUTH code is customer-actionable in the verdict",
      [...NEEDS_REAUTH_CODES].every((c) => CUSTOMER_REAUTH_CODES.has(c)));
  }

  console.log("5. one list — no literal copies in the consumers");
  {
    for (const f of ["lib/plaid/errors.ts", "lib/plaid/webhook-receiver.ts", "lib/platform/verdicts/provider-connection.ts",
                     "lib/connections/connection-summary.ts", "components/connections/ConnectionCard.tsx"]) {
      const s = strip(f);
      check(`${f}: no literal ITEM_LOGIN_REQUIRED / ACCESS_NOT_GRANTED`, !/"ITEM_LOGIN_REQUIRED"|"ACCESS_NOT_GRANTED"/.test(s));
    }
    check("errors.ts imports the shared set", /from "@\/lib\/plaid\/reauth-codes"/.test(strip("lib/plaid/errors.ts")));
    check("the verdict spreads the shared set", /\.\.\.NEEDS_REAUTH_CODES/.test(strip("lib/platform/verdicts/provider-connection.ts")));
  }

  console.log("6. relink heals an ERROR item");
  {
    const { client, row, audits } = itemClient({ status: PlaidItemStatus.ERROR, errorCode: "ACCESS_NOT_GRANTED" });
    const recorded: SyncIssueInput[] = [];
    // Exactly the call exchangeToken makes after a successful (update-mode) exchange.
    await setPlaidItemHealth("pi_1", { status: PlaidItemStatus.ACTIVE, errorCode: null }, undefined, client,
      { allowReactivation: true, recordItemIncident: async (i) => { recorded.push(i); } });
    check("ERROR item → ACTIVE, code cleared", row.status === PlaidItemStatus.ACTIVE && row.errorCode === null);
    check("one ERROR → ACTIVE transition row", audits.length === 1
      && (audits[0].metadata as Record<string, unknown>).from === "ERROR" && (audits[0].metadata as Record<string, unknown>).to === "ACTIVE");
    check("healing opens no incident", recorded.length === 0);
    const ex = strip("lib/plaid/exchangeToken.ts");
    check("exchangeToken heals through the chokepoint: ACTIVE, errorCode null, allowReactivation",
      /setPlaidItemHealth\(\s*plaidItem\.id,\s*\{\s*status:\s*PlaidItemStatus\.ACTIVE,\s*errorCode:\s*null\s*\},\s*undefined,\s*undefined,\s*\{\s*allowReactivation:\s*true\s*\}/.test(ex));
    check("…and the link-token route opens update mode for ANY of the user's items (no ACTIVE filter)",
      /where:\s*\{\s*id:\s*reconnectItemId,\s*userId:\s*user\.id\s*\}/.test(strip("app/api/plaid/link-token/route.ts")));
  }

  console.log("7. item-level incident: opened once, resolved by a completed sync");
  {
    const inc = incidentClient();
    const recorded: SyncIssueInput[] = [];
    const seam = async (i: SyncIssueInput) => {
      recorded.push(i);
      await recordIncidentObservation({ ...i, provider: i.provider ?? null, plaidItemId: i.plaidItemId ?? null, runId: null }, inc.client, async () => null);
    };
    const it = itemClient({ status: PlaidItemStatus.ACTIVE, errorCode: null });
    await setPlaidItemHealth("pi_1", { status: PlaidItemStatus.ERROR, errorCode: "NO_ACCOUNTS" }, undefined, it.client, { recordItemIncident: seam });
    await setPlaidItemHealth("pi_1", { status: PlaidItemStatus.ERROR, errorCode: "NO_ACCOUNTS" }, undefined, it.client, { recordItemIncident: seam });
    check("a re-affirmed failure records once", recorded.length === 1);
    check("existing kind only (UPSERT_ERROR), stage plaid-item-error, code in detail",
      recorded[0]?.kind === "UPSERT_ERROR" && (recorded[0]?.detail as Record<string, unknown>).stage === "plaid-item-error"
      && (recorded[0]?.detail as Record<string, unknown>).errorCode === "NO_ACCOUNTS");
    const open = inc.issues.filter((r) => r.resolved === false);
    check("ONE open condition for the item", open.length === 1, JSON.stringify(inc.issues.map((r) => r.incidentKey)));
    check("keyed per item on the registered operation",
      open[0]?.incidentKey === "v1::PLAID::pi_1::transactions::plaid-item-error", String(open[0]?.incidentKey));
    check("open condition leaves lifecycleState NULL (B9-rollback constraint)", (open[0]?.lifecycleState ?? null) === null);
    const cls = classifySyncIssue({ kind: "UPSERT_ERROR", provider: "PLAID", detail: recorded[0]?.detail, plaidTransactionId: null });
    check("classified: transactions CONDITION, severity error (never critical), not member-actionable, cursor-blocking",
      cls.domain === "transactions" && cls.nature === "condition" && cls.severity === "error"
      && !cls.customerActionable && cls.cursorBlocking, JSON.stringify(cls));
    check("detail carries codes only (no message, no institution)",
      Object.keys(recorded[0]?.detail as object).sort().join(",") === "cursorBlocking,errorCode,from,stage,to");

    // An operator's code-less request-reauth is not a provider error.
    const op = itemClient({ status: PlaidItemStatus.ACTIVE, errorCode: null });
    const opRec: SyncIssueInput[] = [];
    await setPlaidItemHealth("pi_2", { status: PlaidItemStatus.NEEDS_REAUTH }, undefined, op.client, { recordItemIncident: async (i) => { opRec.push(i); } });
    check("code-less NEEDS_REAUTH (operator request) opens no incident", opRec.length === 0);

    // An injected client without a seam never reaches the real facade.
    const quiet = itemClient({ status: PlaidItemStatus.ACTIVE, errorCode: null });
    await setPlaidItemHealth("pi_3", { status: PlaidItemStatus.ERROR, errorCode: "NO_ACCOUNTS" }, undefined, quiet.client);
    check("injected client + no seam → no real incident write attempted (no throw)", quiet.row.status === PlaidItemStatus.ERROR);

    // The first completed sync: resolveCursorBlockingIssues → this authority call.
    const res = await resolveByAutomaticRecovery({ plaidItemId: "pi_1", domain: "transactions" }, inc.client, async () => null);
    check("a completed sync resolves the item condition", res.resolved === 1);
    const row = inc.issues[0];
    check("…as RESOLVED, automatic, with the transactions-sync reason",
      row?.resolved === true && row?.lifecycleState === "RESOLVED" && row?.resolutionReasonCode === "TRANSACTIONS_SYNC_SUCCEEDED");
    const again = await resolveByAutomaticRecovery({ plaidItemId: "pi_1", domain: "transactions" }, inc.client, async () => null);
    check("a second sync resolves nothing more (never reopens)", again.resolved === 0 && row?.resolved === true);

    // Code rollback: without the plaid-item-error arm the generic UPSERT_ERROR arm
    // classifies the row — it must still be cursor-blocking so a sync resolves it.
    const legacy = classifySyncIssue({ kind: "UPSERT_ERROR", provider: "PLAID",
      detail: { ...(recorded[0]?.detail as object), stage: "some-stage-old-code-does-not-know" }, plaidTransactionId: null });
    check("rollback-safe: the generic arm still reads it as a cursor-blocking condition", legacy.cursorBlocking && legacy.nature === "condition");
  }

  if (failures > 0) { console.error(`\nreauth-codes: ${failures} check(s) failed.`); process.exit(1); }
  console.log("\nreauth-codes: all checks passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
