/**
 * app/api/ai/memory/route.test.ts
 *
 * THE USER'S OWN MEMORY — ownership, proved with an injected store. No database.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/ai/memory/route.test.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { listMemory, retireMemoryItem, eraseMemoryItem, groupListing, type MemoryApiDeps } from './handlers';
import type { MemoryScope, OwnMemoryItem } from '@/lib/ai/conversation/memory-store';

let failures = 0;
const check = (name: string, cond: boolean, detail?: string): void => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

interface Stored extends OwnMemoryItem { spaceId: string; ownerUserId: string }
const item = (id: string, spaceId: string, ownerUserId: string, over: Partial<OwnMemoryItem> = {}): Stored => ({
  id, spaceId, ownerUserId, class: 'RULE', state: 'IN_FORCE', inWords: 'Keep 6 months of expenses in cash.',
  notedAs: 'keep six months', notedOn: '2026-09-20', ...over });

function world(as: string | null = 'alice') {
  const rows: Stored[] = [
    item('a1', 'home', 'alice'), item('a2', 'home', 'alice', { class: 'BASELINE', inWords: 'Plan with 5,000 a month…' }),
    item('a3', 'home', 'alice', { class: 'PROJECTION', state: 'IN_FORCE' }), item('a4', 'home', 'alice', { class: null, state: 'UNREADABLE', inWords: null }),
    item('b1', 'home', 'bob'), item('a9', 'other', 'alice'),
  ];
  const seen: MemoryScope[] = []; const audits: unknown[] = []; let limited = false;
  const mine = (s: MemoryScope) => rows.filter((r) => r.spaceId === s.spaceId && r.ownerUserId === s.ownerUserId);
  const deps: MemoryApiDeps = {
    requireUser: async () => (as ? [{ id: as }, null] : [null, NextResponse.json({ error: 'no' }, { status: 401 })]),
    limit: async () => (limited ? NextResponse.json({ error: 'slow down' }, { status: 429 }) : null),
    // The real resolver FALLS BACK to a Space the user can reach. `home` is reachable by both; nothing else is.
    resolveSpace: async () => ({ spaceId: 'home' }),
    today: () => '2026-09-20',
    list: async (s) => { seen.push(s); return mine(s).map(({ spaceId: _s, ownerUserId: _o, ...rest }) => { void _s; void _o; return rest; }); },
    retire: async (s, id) => { seen.push(s); const r = mine(s).find((x) => x.id === id);
      if (!r) return { ok: false, why: 'NOT_FOUND' };
      if (r.class === null || r.class === 'PROJECTION') return { ok: false, why: 'NOT_RETIRABLE' };
      rows.splice(rows.indexOf(r), 1); return { ok: true }; },
    erase: async (s, id) => { seen.push(s); const r = mine(s).find((x) => x.id === id);
      if (!r) return { ok: false, why: 'NOT_FOUND' };
      rows.splice(rows.indexOf(r), 1); return { ok: true, erased: 3, kind: 'INTENTION' }; },
    audit: async (e) => { audits.push(e); },
  };
  return { deps, rows, seen, audits, limit: (on: boolean) => { limited = on; } };
}
const json = async (r: NextResponse) => ({ status: r.status, body: await r.json() as Record<string, OwnMemoryItem[]> & { error?: string } });

void (async () => {
  console.log('1. list — this user, this Space, grouped for the panel');
  {
    const w = world();
    const r = await json(await listMemory(w.deps, 'home'));
    check('200 with the five sections', r.status === 200 && ['remembered', 'planningFigures', 'projections', 'lapsed', 'unreadable'].every((k) => Array.isArray(r.body[k])));
    check('a planning figure, a projection and an unreadable row each sit in their own section',
      r.body.remembered.length === 1 && r.body.planningFigures.length === 1 && r.body.projections.length === 1 && r.body.unreadable.length === 1);
    check('another member\'s rows are never listed', !JSON.stringify(r.body).includes('b1'));
    check('the scope is the session user and the resolved Space — both, on every call',
      w.seen.every((s) => s.spaceId === 'home' && s.ownerUserId === 'alice'));
    check('an unreadable row carries no sentence — only its date and the words it was noted in', r.body.unreadable[0].inWords === null);
    check('a lapsed goal is listed apart', groupListing([item('x', 'h', 'a', { class: 'GOAL', state: 'LAPSED' })]).lapsed.length === 1);
  }

  console.log('2. refusals');
  {
    const w = world();
    check('no spaceId → 400', (await listMemory(w.deps, null)).status === 400);
    check('a named Space that resolves to a DIFFERENT one → 403, and the store is never reached',
      (await listMemory(w.deps, 'someone-elses')).status === 403 && w.seen.length === 0);
    check('…for retire and erase too', (await retireMemoryItem(w.deps, 'a1', { spaceId: 'someone-elses', action: 'retire' })).status === 403
      && (await eraseMemoryItem(w.deps, 'a1', 'someone-elses')).status === 403 && w.rows.some((r) => r.id === 'a1'));
    check('anonymous → the session\'s own 401', (await listMemory(world(null).deps, 'home')).status === 401);
    w.limit(true);
    check('rate limited → 429 before anything else', (await listMemory(w.deps, 'home')).status === 429 && w.seen.length === 0);
  }

  console.log('3. retire and erase — own rows only');
  {
    const w = world();
    check('another member\'s id is a 404 — existence is not disclosed', (await retireMemoryItem(w.deps, 'b1', { spaceId: 'home', action: 'retire' })).status === 404
      && (await eraseMemoryItem(w.deps, 'b1', 'home')).status === 404 && w.rows.some((r) => r.id === 'b1'));
    check('my own id in ANOTHER Space is a 404 here', (await eraseMemoryItem(w.deps, 'a9', 'home')).status === 404);
    check('an unknown action is refused', (await retireMemoryItem(w.deps, 'a1', { spaceId: 'home', action: 'use-now' })).status === 400);
    check('a projection and an unreadable row cannot be "stopped" — only deleted',
      (await retireMemoryItem(w.deps, 'a3', { spaceId: 'home', action: 'retire' })).status === 422
      && (await retireMemoryItem(w.deps, 'a4', { spaceId: 'home', action: 'retire' })).status === 422);
    const retired = await json(await retireMemoryItem(w.deps, 'a1', { spaceId: 'home', action: 'retire' }));
    check('retire returns the updated listing', retired.status === 200 && retired.body.remembered.length === 0);
    const erased = await json(await eraseMemoryItem(w.deps, 'a4', 'home'));
    check('erase returns the updated listing', erased.status === 200 && erased.body.unreadable.length === 0);
    check('…and writes ONE content-free audit event: kind and a count, nothing of what was erased',
      w.audits.length === 1 && JSON.stringify(w.audits[0]) === '{"userId":"alice","spaceId":"home","kind":"INTENTION","versionsErased":3}');
    const conflict = world();
    conflict.deps.retire = async () => { throw Object.assign(new Error('unique'), { code: 'P2002' }); };
    check('P2002 on `supersedesId` is a 409, not a 500', (await retireMemoryItem(conflict.deps, 'a1', { spaceId: 'home', action: 'retire' })).status === 409);
    conflict.deps.retire = async () => ({ ok: false, why: 'CONFLICT' });
    check('…and so is the store\'s own conflict result', (await retireMemoryItem(conflict.deps, 'a1', { spaceId: 'home', action: 'retire' })).status === 409);
    const failing = world(); failing.deps.audit = async () => { throw new Error('audit down'); };
    check('an audit failure does not fail an erasure that already happened', (await eraseMemoryItem(failing.deps, 'a1', 'home')).status === 200);
  }

  console.log('4. source — no user id, no memory query outside the store');
  {
    const read = (f: string) => readFileSync(join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const files = ['route.ts', '[id]/route.ts', 'handlers.ts', 'deps.ts'].map(read);
    check('no route or handler reads a user id from the request', files.every((s) => !/searchParams\.get\('(userId|ownerUserId)'\)|\.(userId|ownerUserId)\s*[;,)]/.test(s.replace(/ownerUserId: user\.id|s\.scope\.ownerUserId/g, ''))));
    check('the owner is the session user', /ownerUserId: user\.id/.test(files[2]));
    check('no memory query lives outside memory-store.ts', files.every((s) => !/spaceMemory/.test(s)));
    check('the only table the routes touch directly is the audit log', (files[3].match(/\bdb\.(\w+)/g) ?? []).every((m) => m === 'db.auditLog')
      && files.slice(0, 3).every((s) => !/@\/lib\/db/.test(s)));
    check('the audit metadata is counts and kinds only', /metadata: \{ kind, versionsErased \}/.test(files[3]));
    check('there is no admin bypass of ownership', files.every((s) => !/SYSTEM_ADMIN/.test(s)));
    check('the routes are rate limited like the chat route', /limitByUser\(userId, 'ai-memory', \{ limit: 30, windowSec: 60 \}\)/.test(files[3]));
  }

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
