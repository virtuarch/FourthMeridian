/**
 * components/transactions/TransactionDetailDrawer.test.ts
 *
 * TI5-3A — source-scan contract tests (repo style: no RTL/Playwright). Asserts
 * the wiring rather than rendering: the drawer reuses OverlaySurface + the
 * existing endpoint + the ?transaction= param, Banking rows call the shared
 * opener, and the drawer pulls in no AI/serializer/export/Brief code.
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
const banking = read('components/dashboard/BankingClient.tsx');
const chrome = read('components/ui/DashboardChrome.tsx');
const spacePanel = read('components/dashboard/widgets/SpaceTransactionsPanel.tsx');
const debt = read('components/dashboard/DebtClient.tsx');

test('drawer reuses the OverlaySurface primitive (no new drawer framework)', () => {
  assert.match(drawer, /from "@\/components\/atlas\/OverlaySurface"/);
  assert.match(drawer, /<OverlaySurface/);
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

test('opening pushes the param (Back closes); close pops it', () => {
  assert.match(hook, /router\.push\(`\$\{pathname\}\?\$\{PARAM\}=/);
  assert.match(hook, /router\.back\(\)/);
});

test('the drawer is mounted exactly once, in DashboardChrome, under Suspense', () => {
  assert.match(chrome, /<TransactionDetailDrawer \/>/);
  assert.match(chrome, /<Suspense fallback=\{null\}>/);
  // No per-surface mount — the shell owns the single instance.
  assert.ok(!banking.includes('<TransactionDetailDrawer'), 'BankingClient must not mount its own drawer');
  assert.ok(!spacePanel.includes('<TransactionDetailDrawer'));
  assert.ok(!debt.includes('<TransactionDetailDrawer'));
});

test('every transaction surface calls the shared opener (openTransaction(tx.id))', () => {
  for (const [name, src] of [['Banking', banking], ['Space', spacePanel], ['Debt', debt]] as const) {
    assert.match(src, /useOpenTransaction/, `${name} must import the shared opener`);
    assert.match(src, /openTransaction\(tx\.id\)/, `${name} rows must call the shared opener`);
  }
});

test('surfaces do not reimplement the drawer/content or fetch logic', () => {
  // The drawer is the ONLY consumer of the detail content + the endpoint.
  assert.match(drawer, /export function TransactionDetailDrawer/);
  for (const [name, src] of [['Banking', banking], ['Space', spacePanel], ['Debt', debt]] as const) {
    assert.ok(!src.includes('TransactionDetailContent'), `${name} must not import the detail content`);
    assert.ok(!src.includes('buildTransactionDetailSections'), `${name} must not build sections`);
    assert.ok(!src.includes('/api/transactions/'), `${name} must not fetch the detail endpoint directly`);
  }
});

test('Banking row is keyboard-accessible (role/button + Enter/Space)', () => {
  assert.match(banking, /role="button"/);
  assert.match(banking, /onKeyDown=/);
});

test('drawer/hook reference no AI, serializer, exports, or Daily Brief code', () => {
  for (const banned of ['assemblers', 'api/ai/chat', '/serialize', 'downloadDataExport', 'components/brief']) {
    assert.ok(!drawer.includes(banned), `drawer must not reference ${banned}`);
    assert.ok(!hook.includes(banned), `hook must not reference ${banned}`);
  }
});
