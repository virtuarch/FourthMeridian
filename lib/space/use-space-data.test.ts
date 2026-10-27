/**
 * lib/space/use-space-data.test.ts  (UI-006)
 *
 * A failed read is never an empty one. Pinned:
 *   1. settleSpaceRead: 401 / 403 / 500 / network / bad JSON are FAILURES with a
 *      status-specific sentence; only a 2xx with a body is data
 *   2. the reducers map a failure to an error state and KEEP the previous value
 *      (null stays null) — never to `[]`
 *   3. the hook no longer contains any coerce-to-empty fallback
 *   4. the consumers route the error to SpaceReadFailure (with Retry) BEFORE any
 *      empty state, and SpacesClient reports a refused invite / switch
 *   5. SpaceReadFailure renders an alert with the message and a Retry button
 *
 *   npx tsx lib/space/use-space-data.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  nextSnapshotState, nextStructureState, nextTransactionsState, settleSpaceRead, spaceReadError,
  type SpaceReadOutcome,
} from "./use-space-data";
import { SpaceReadFailure } from "@/components/space/SpaceReadFailure";
import type { Snapshot, Transaction } from "@/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const code = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

async function main() {
  console.log("1. settleSpaceRead — failures are failures");
  for (const status of [401, 403, 404, 429, 500, 503]) {
    const out = await settleSpaceRead<unknown[]>(json(status, { error: "x" }));
    check(`${status} ⇒ ok:false with status ${status}`, !out.ok && out.error.status === status);
  }
  {
    const net = await settleSpaceRead<unknown[]>(Promise.reject(new TypeError("Failed to fetch")));
    check("network rejection ⇒ ok:false, status null", !net.ok && net.error.status === null);
    const bad = await settleSpaceRead<unknown[]>(Promise.resolve(new Response("<html>", { status: 200 })));
    check("unparseable 200 ⇒ ok:false (not data)", !bad.ok);
    const good = await settleSpaceRead<number[]>(json(200, [1, 2]));
    check("2xx JSON ⇒ ok:true with the body", good.ok && good.data.length === 2);
    const empty = await settleSpaceRead<number[]>(json(200, []));
    check("a REAL empty list is still data", empty.ok && empty.data.length === 0);
  }
  check("401 sentence says the session expired", /session has expired/i.test(spaceReadError(401).message));
  check("403 sentence says no access", /don't have access/i.test(spaceReadError(403).message));
  check("500 sentence says it is not missing data", /not a sign your data is gone/i.test(spaceReadError(500).message));
  check("network sentence says connection", /connection/i.test(spaceReadError(null).message));

  console.log("2. Reducers — failure ⇒ error state, previous value kept, never []");
  const fail = <T,>(status: number | null): SpaceReadOutcome<T> => ({ ok: false, error: spaceReadError(status) });
  {
    const s0 = nextSnapshotState(null, fail(500));
    check("snapshots: first-load 500 ⇒ snapshots stay null", s0.snapshots === null);
    check("snapshots: first-load 500 ⇒ error recorded", s0.error?.status === 500);
    check("snapshots: failure is NOT an empty array", !Array.isArray(s0.snapshots));
    const prev = [{ id: "s1" }] as unknown as Snapshot[];
    const s1 = nextSnapshotState(prev, fail(403));
    check("snapshots: refresh 403 keeps the previous rows", s1.snapshots === prev && s1.error?.status === 403);
    const ok = nextSnapshotState(prev, { ok: true, data: { snapshots: [], backfillInProgress: true } });
    check("snapshots: success clears the error and applies the data", ok.error === null && ok.snapshots?.length === 0 && ok.backfilling);

    const t0 = nextTransactionsState(null, fail(401));
    check("transactions: 401 ⇒ transactions stay null + error", t0.transactions === null && t0.error?.status === 401);
    const t1 = nextTransactionsState(null, { ok: true, data: { transactions: [] as Transaction[], truncated: true, limit: 5000 } });
    check("transactions: success ⇒ data + coverage meta", t1.error === null && t1.transactions?.length === 0 && t1.meta?.truncated === true);

    const prevS = { sections: [{ id: "a" }], accounts: [{ id: "b" }] } as never;
    const st = nextStructureState(prevS, fail(500), { ok: true, data: [] });
    check("structure: sections 500 ⇒ previous lists kept + error", st.error?.status === 500 && st.sections.length === 1 && st.accounts.length === 1);
    const st2 = nextStructureState(prevS, { ok: true, data: [] }, fail(null));
    check("structure: accounts network failure ⇒ error (not [])", st2.error?.status === null && st2.accounts.length === 1);
  }

  console.log("3. The hook contains no coerce-to-empty fallback");
  {
    const hook = code("lib/space/use-space-data.ts");
    check("no `r.ok ? r.json() : []`", !/r\.ok\s*\?\s*r\.json\(\)\s*:\s*\[\]/.test(hook));
    check("no `{ snapshots: [] }` fallback", !/:\s*\{\s*snapshots:\s*\[\]\s*\}/.test(hook));
    check("no `{ transactions: [] }` fallback", !/:\s*\{\s*transactions:\s*\[\]\s*\}/.test(hook));
    check("no setSnapshots([]) / setTransactions([]) in a catch", !/setSnapshots\(\[\]\)|setTransactions\(\[\]\)/.test(hook));
    check("every structural read goes through settleSpaceRead", (hook.match(/settleSpaceRead</g) ?? []).length >= 5);
    check("hook returns readErrors + retryRead", /readErrors,\s*\n\s*retryRead,/.test(hook));
  }

  console.log("4. Consumers say the failure, with Retry, before any empty state");
  {
    const wealth = code("components/space/widgets/wealth/WealthWorkspace.tsx");
    const failIdx = wealth.indexOf("if (snapshotsError && !result.hasHistory)");
    const emptyIdx = wealth.indexOf("No wealth history yet");
    check("Wealth: failure branch precedes 'No wealth history yet'", failIdx > 0 && emptyIdx > failIdx);
    check("Wealth: failure branch renders SpaceReadFailure with retry",
      /if \(snapshotsError && !result\.hasHistory\)[\s\S]{0,200}<SpaceReadFailure what="wealth history" message=\{snapshotsError\} onRetry=\{onRetrySnapshots\}/.test(wealth));
    const cf = code("components/space/widgets/cashflow/CashFlowWorkspace.tsx");
    check("CashFlow: a failed read with nothing loaded renders SpaceReadFailure",
      /const what = spendingView \? "spending" : "cash flow activity";/.test(cf)
        && /if \(transactionsError && transactions == null\)[\s\S]{0,200}<SpaceReadFailure what=\{what\}/.test(cf));
    const rend = code("components/space/workspaces/workspaceRenderers.tsx");
    check("renderers thread snapshots + transactions errors and retry",
      rend.includes('snapshotsError={ctx.readErrors?.snapshots?.message ?? null}') &&
      rend.includes('transactionsError={ctx.readErrors?.transactions?.message ?? null}') &&
      rend.includes('ctx.onRetryRead?.("snapshots")') && rend.includes('ctx.onRetryRead?.("transactions")'));
    const dash = code("components/dashboard/SpaceDashboard.tsx");
    check("SpaceDashboard: first structural failure ⇒ SpaceReadFailure before the spinner",
      dash.indexOf("readErrors.structure && sections.length === 0") > 0 &&
      dash.indexOf("readErrors.structure && sections.length === 0") < dash.indexOf("if (loading || !activeTab)"));
    check("SpaceDashboard passes readErrors + retry to the render ctx", dash.includes("readErrors,\n    onRetryRead: retryRead,"));
    const sc = code("components/dashboard/SpacesClient.tsx");
    check("SpacesClient: refused invite accept/decline is shown", sc.includes("setError(d.error ?? `Couldn't ${action} this invite. Try again.`)") && sc.includes('{error && <p role="alert"'));
    check("SpacesClient: refused Space switch is shown", sc.includes("setSwitchError(d.error ??") && sc.includes("{switchError && ("));
    const fin = code("components/space/manage/FinancesPanel.tsx");
    check("FinancesPanel: a failed list read is an error, not 'No accounts shared'", fin.includes("if (!r.ok) throw new Error") && fin.includes("if (loadError)"));
  }

  console.log("5. SpaceReadFailure renders");
  {
    const card = renderToStaticMarkup(createElement(SpaceReadFailure, { what: "wealth history", message: spaceReadError(500).message, onRetry: () => {} }));
    check("card: role=alert", card.includes('role="alert"'));
    check("card: names what failed", card.includes("Couldn’t load wealth history") || card.includes("Couldn&rsquo;t load wealth history") || card.includes("load wealth history"));
    check("card: carries the status sentence", card.includes("error 500"));
    check("card: Retry button", />\s*Retry\s*<|<\/svg> Retry/.test(card) && card.includes("<button"));
    check("card: is not an empty-state sentence", !/No wealth history yet/.test(card));
    const inline = renderToStaticMarkup(createElement(SpaceReadFailure, { variant: "inline", what: "wealth history", message: "m" }));
    check("inline: says the content is stale", inline.includes("showing what was last loaded"));
    check("inline: no Retry without a handler", !inline.includes("<button"));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll UI-006 checks passed.");
}

void main();
