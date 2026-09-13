/**
 * lib/space-nav.test.ts
 *
 * The primary navigation — ONE definition (PRIMARY_NAV), two presentations
 * (desktop rail + mobile bar). Standalone tsx (house pattern), exits 0/1. The
 * order, labels and routes are pinned as the product decision: Brief · My Space ·
 * AI · Spaces · Connections, Settings in the account menu only.
 */

import {
  PRIMARY_NAV, MY_SPACE_HREF, isPrimaryDestActive,
  type PrimaryDestId,
} from '@/lib/space-nav';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const dump = (x: unknown) => JSON.stringify(x);

console.log('primary nav: order, labels, routes');
{
  check('exact order', dump(PRIMARY_NAV.map((d) => d.label)) === dump(['Brief', 'My Space', 'AI', 'Spaces', 'Connections']),
    dump(PRIMARY_NAV.map((d) => d.label)));
  const href = Object.fromEntries(PRIMARY_NAV.map((d) => [d.id, d.href]));
  check('Brief → /dashboard/brief', href.brief === '/dashboard/brief');
  check('My Space → /dashboard (the active Space dashboard)', href.myspace === '/dashboard' && MY_SPACE_HREF === '/dashboard');
  check('AI → /dashboard/analyze', href.ai === '/dashboard/analyze');
  check('Spaces → /dashboard/spaces', href.spaces === '/dashboard/spaces');
  check('Connections → /dashboard/connections', href.connections === '/dashboard/connections');
  check('AI is the centre slot', PRIMARY_NAV[2].id === 'ai' && PRIMARY_NAV.length === 5);
  check('Settings is not primary navigation',
    !PRIMARY_NAV.some((d) => (d.id as string) === 'settings' || d.label === 'Settings' || d.href.startsWith('/dashboard/settings')));
  check('ids are unique', new Set(PRIMARY_NAV.map((d) => d.id)).size === 5);
  check('hrefs are unique', new Set(PRIMARY_NAV.map((d) => d.href)).size === 5);
}

console.log('exactly one destination active per route (nested routes keep their section)');
{
  const cases: Array<[string, PrimaryDestId | null]> = [
    ['/dashboard/brief', 'brief'],
    ['/dashboard', 'myspace'],
    ['/dashboard/analyze', 'ai'],
    ['/dashboard/spaces', 'spaces'],
    ['/dashboard/spaces/invites', 'spaces'],
    ['/dashboard/connections', 'connections'],
    ['/dashboard/connections/abc', 'connections'],
    ['/dashboard/settings', null],
    ['/dashboard/settings/account', null],
    ['/dashboard/credit', null],
    ['/dashboard/platform/ops', null],
  ];
  for (const [path, expected] of cases) {
    const on = PRIMARY_NAV.filter((d) => isPrimaryDestActive(d.id, path)).map((d) => d.id);
    check(`${path} → ${expected ?? 'none'}`, dump(on) === dump(expected ? [expected] : []), dump(on));
  }
  check('My Space and Spaces are never both active',
    cases.every(([p]) => !(isPrimaryDestActive('myspace', p) && isPrimaryDestActive('spaces', p))));
}

console.log('the AI conversation-surface predicate (2FA nudge + layout)');
{
  check('true on the AI page', isPrimaryDestActive('ai', '/dashboard/analyze'));
  for (const p of ['/dashboard', '/dashboard/spaces', '/dashboard/brief', '/dashboard/connections', '/dashboard/settings/security']) {
    check(`false on ${p}`, !isPrimaryDestActive('ai', p));
  }
}

if (failures > 0) {
  console.error(`\nspace-nav.test: ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nspace-nav.test: all passed.');
