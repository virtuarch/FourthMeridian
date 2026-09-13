/**
 * lib/space-nav.test.ts
 *
 * The two presentations of top-level navigation. Standalone tsx (house pattern),
 * exits 0/1. The mobile bar (BOTTOM_NAV) was reorganised in AI-4; the desktop
 * rail's GLOBAL_NAV was deliberately NOT — both are pinned so neither changes by
 * accident when the other does.
 */

import {
  BOTTOM_NAV, GLOBAL_NAV, MY_SPACE_HREF, isBottomDestActive, isGlobalDestActive,
  type BottomDestId,
} from '@/lib/space-nav';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const dump = (x: unknown) => JSON.stringify(x);

console.log('bottom bar: order, labels, routes');
{
  check('exact order', dump(BOTTOM_NAV.map((d) => d.label)) === dump(['Brief', 'My Space', 'AI', 'Spaces', 'Connections']),
    dump(BOTTOM_NAV.map((d) => d.label)));
  const href = Object.fromEntries(BOTTOM_NAV.map((d) => [d.id, d.href]));
  check('Brief → /dashboard/brief', href.brief === '/dashboard/brief');
  check('My Space → /dashboard (the active Space dashboard)', href.myspace === '/dashboard' && MY_SPACE_HREF === '/dashboard');
  check('AI → /dashboard/analyze', href.ai === '/dashboard/analyze');
  check('Spaces → /dashboard/spaces', href.spaces === '/dashboard/spaces');
  check('Connections → /dashboard/connections', href.connections === '/dashboard/connections');
  check('AI is the centre slot', BOTTOM_NAV[2].id === 'ai' && BOTTOM_NAV.length === 5);
  check('Settings is not on the bar',
    !BOTTOM_NAV.some((d) => (d.id as string) === 'settings' || d.label === 'Settings' || d.href.startsWith('/dashboard/settings')));
  check('bar routes are the rail routes (no drift)', ['brief', 'ai', 'spaces', 'connections'].every(
    (id) => href[id] === GLOBAL_NAV.find((g) => g.id === id)?.href));
}

console.log('desktop rail unchanged');
{
  check('GLOBAL_NAV order is still Spaces · Brief · AI · Connections · Settings',
    dump(GLOBAL_NAV.map((d) => d.label)) === dump(['Spaces', 'Brief', 'AI', 'Connections', 'Settings']));
  check('Settings still on the rail', GLOBAL_NAV.some((d) => d.id === 'settings' && d.href === '/dashboard/settings'));
  check('the rail\'s Spaces rule still claims /dashboard', isGlobalDestActive('spaces', '/dashboard'));
}

console.log('bottom bar: exactly one destination active per route');
{
  const cases: Array<[string, BottomDestId | null]> = [
    ['/dashboard/brief', 'brief'],
    ['/dashboard', 'myspace'],
    ['/dashboard/analyze', 'ai'],
    ['/dashboard/spaces', 'spaces'],
    ['/dashboard/spaces/invites', 'spaces'],
    ['/dashboard/connections', 'connections'],
    ['/dashboard/settings/account', null],
    ['/dashboard/credit', null],
  ];
  for (const [path, expected] of cases) {
    const on = BOTTOM_NAV.filter((d) => isBottomDestActive(d.id, path)).map((d) => d.id);
    check(`${path} → ${expected ?? 'none'}`, dump(on) === dump(expected ? [expected] : []), dump(on));
  }
  check('My Space and Spaces are never both active',
    cases.every(([p]) => !(isBottomDestActive('myspace', p) && isBottomDestActive('spaces', p))));
}

console.log('the AI conversation-surface predicate (2FA nudge + layout)');
{
  check('true on the AI page', isGlobalDestActive('ai', '/dashboard/analyze'));
  for (const p of ['/dashboard', '/dashboard/spaces', '/dashboard/brief', '/dashboard/connections', '/dashboard/settings/security']) {
    check(`false on ${p}`, !isGlobalDestActive('ai', p));
  }
}

if (failures > 0) {
  console.error(`\nspace-nav.test: ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nspace-nav.test: all passed.');
