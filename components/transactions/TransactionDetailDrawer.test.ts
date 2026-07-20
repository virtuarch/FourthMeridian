/**
 * components/transactions/TransactionDetailDrawer.test.ts
 *
 * TI5-3A — source-scan contract tests (repo style: no RTL/Playwright). Asserts
 * the wiring rather than rendering: the drawer reuses the Atlas RightPanel + the
 * existing endpoint + the ?transaction= param, transaction-list rows call the
 * shared opener, and the drawer pulls in no AI/serializer/export/Brief code.
 * (Editorial convergence: the detail is a contextual RightPanel — inspect while
 * the ledger stays put — not the centered OverlaySurface modal it began as.)
 * (The standalone Banking surface was retired with /dashboard/banking; the live
 * transaction surfaces are the Space Transactions panel and the Debt client.)
 *
 *   npx tsx --test components/transactions/TransactionDetailDrawer.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const drawer = read('components/transactions/TransactionDetailDrawer.tsx');
const hook = read('components/transactions/useTransactionDrawer.ts');
const chrome = read('components/ui/DashboardChrome.tsx');
const spacePanel = read('components/dashboard/widgets/SpaceTransactionsPanel.tsx');
const debt = read('components/dashboard/DebtClient.tsx');

test('drawer uses the Atlas RightPanel primitive (contextual detail, not a modal)', () => {
  assert.match(drawer, /from "@\/components\/atlas\/panels"/);
  assert.match(drawer, /<RightPanel/);
});

test('drawer reuses the existing GET /api/transactions/[id] endpoint (no new endpoint)', () => {
  assert.match(drawer, /fetch\(`\/api\/transactions\/\$\{id\}`/);
});

test('drawer is driven by the ?transaction= param through the shared hook', () => {
  assert.match(hook, /const PARAM = "transaction"/);
  assert.match(drawer, /useTransactionDrawer/);
});

test('drawer handles loading / notfound / error / success and aborts', () => {
  for (const s of ['loading', 'notfound', 'error', 'loaded']) {
    assert.match(drawer, new RegExp(`"${s}"`));
  }
  assert.match(drawer, /AbortController/);
  assert.match(drawer, /ac\.abort\(\)/);
});

test('opening navigates via the shared Space URL authority (Back closes); close pops it', () => {
  // SD-0A: the opener serializes through the shared Space URL core so it
  // PRESERVES the active tab/perspective/time params instead of clobbering them
  // with a pathname-only push. Durable contract: it delegates to buildSpaceUrl
  // (the one URL authority) and pushes (not replaces) so Back closes it — not the
  // exact argument spelling, which is free to change.
  assert.match(hook, /from "@\/lib\/space\/space-url"/);
  assert.match(hook, /router\.push\(buildSpaceUrl\(/);
  assert.match(hook, /router\.back\(\)/);
});

test('the drawer is mounted exactly once, in DashboardChrome, under Suspense', () => {
  assert.match(chrome, /<TransactionDetailDrawer \/>/);
  assert.match(chrome, /<Suspense fallback=\{null\}>/);
  // No per-surface mount — the shell owns the single instance.
  assert.ok(!spacePanel.includes('<TransactionDetailDrawer'));
  assert.ok(!debt.includes('<TransactionDetailDrawer'));
});

test('every transaction surface calls the shared opener (openTransaction(tx.id))', () => {
  for (const [name, src] of [['Space', spacePanel], ['Debt', debt]] as const) {
    assert.match(src, /useOpenTransaction/, `${name} must import the shared opener`);
    assert.match(src, /openTransaction\(tx\.id\)/, `${name} rows must call the shared opener`);
  }
});

test('surfaces do not reimplement the drawer/content or fetch logic', () => {
  // The drawer is the ONLY consumer of the detail content + the endpoint.
  assert.match(drawer, /export function TransactionDetailDrawer/);
  for (const [name, src] of [['Space', spacePanel], ['Debt', debt]] as const) {
    assert.ok(!src.includes('TransactionDetailContent'), `${name} must not import the detail content`);
    assert.ok(!src.includes('buildTransactionDetailSections'), `${name} must not build sections`);
    assert.ok(!src.includes('/api/transactions/'), `${name} must not fetch the detail endpoint directly`);
  }
});

test('Space transaction row is keyboard-accessible (role/button + Enter/Space)', () => {
  assert.match(spacePanel, /role="button"/);
  assert.match(spacePanel, /onKeyDown=/);
});

test('drawer/hook reference no AI, serializer, exports, or Daily Brief code', () => {
  for (const banned of ['assemblers', 'api/ai/chat', '/serialize', 'downloadDataExport', 'components/brief']) {
    assert.ok(!drawer.includes(banned), `drawer must not reference ${banned}`);
    assert.ok(!hook.includes(banned), `hook must not reference ${banned}`);
  }
});

// ── TX-3.4 — the ACT step of find → inspect → act ────────────────────────────

const correction = read('components/transactions/TransactionCorrection.tsx');
const signal = read('components/transactions/transaction-mutation-signal.ts');
const explorerHook = read('components/dashboard/widgets/transactions/useTransactionExplorer.ts');

test('correction surfaces the PRE-EXISTING endpoint (no new mutation endpoint)', () => {
  assert.match(correction, /fetch\(`\/api\/transactions\/\$\{detail\.id\}\/correct`/);
  assert.match(correction, /method: "POST"/);
});

test('correction sends only the two CATEGORY paths the endpoint implements', () => {
  // "override" = this row only; "category" = mint a USER MerchantRule. The third
  // endpoint path (merchant identity, with its 409 confirm round-trip) is
  // deliberately not driven from here — see the component header.
  assert.match(correction, /\["override", "category"\]/);
  assert.ok(!correction.includes('correction: "merchant"'),
    'merchant identity correction needs a candidate/confirm flow — not surfaced in TX-3.4');
});

test('correction derives NO truth of its own — it renders what the server returns', () => {
  // The endpoint responds with the fresh TransactionDetail; the drawer adopts it
  // verbatim. No local recomputation of category/flow/amount anywhere.
  assert.match(correction, /onCorrected\(data\.transaction\)/);
  for (const banned of ['recomputeFlow', 'sumByFlowType', 'convertMoney', 'bankingTransactionWhere']) {
    assert.ok(!correction.includes(banned), `correction must not compute ${banned}`);
  }
});

test('drawer adopts the returned detail in place (no refetch, no stale panel)', () => {
  assert.match(drawer, /onCorrected=\{\(fresh\) => setState\(\{ status: "loaded", detail: fresh \}\)\}/);
});

test('a correction notifies the sibling list so it re-asks its question', () => {
  assert.match(correction, /notifyTransactionMutated\(\)/);
  assert.match(explorerHook, /subscribeTransactionMutations/);
  // The version must actually drive the fetch effect — otherwise the signal is
  // decorative and a corrected row would linger in a list it no longer matches.
  assert.match(explorerHook, /\}, \[key, spaceId, mutationVersion\]\)/);
});

test('the mutation signal is a notification, never a data store or authority', () => {
  // It carries a version and nothing else. If transaction data ever appears here,
  // a second client-side truth model has been created.
  assert.ok(!/Transaction\b/.test(signal.replace(/notifyTransactionMutated|TransactionMutation\w*|transaction/gi, '')),
    'signal must not carry transaction data');
  for (const banned of ['fetch(', 'useState', 'db.', 'filter(', 'sort(']) {
    assert.ok(!signal.includes(banned), `signal must not contain ${banned}`);
  }
});

test('URL-driven selection is unchanged by the act step', () => {
  // The correction must not navigate, replace, or otherwise touch the param that
  // owns which transaction is open.
  for (const banned of ['router.push', 'router.replace', 'useSearchParams', 'transaction=']) {
    assert.ok(!correction.includes(banned), `correction must not touch routing (${banned})`);
  }
});

test('correction respects the TI DTO boundary (no undisclosed fields rendered)', () => {
  // categorySource / raw provider ids are deliberately NOT on the DTO
  // (lib/transactions/detail-sections.ts). The correction UI must not assume them.
  for (const banned of ['categorySource', 'pfcPrimary', 'plaidTransactionId', 'merchantEntityId']) {
    assert.ok(!correction.includes(banned), `correction must not read ${banned} (not on the DTO)`);
  }
});
