/**
 * lib/db/live-guard.test.ts   (I1 — Slice 0)
 *
 * The clone guard, as a property rather than as a spelling. Pure, no DB.
 *
 * ⚠️ THE MUTATION PROOF IS THE POINT. A guard nobody has watched refuse is a
 * guard nobody knows works. §5 plants the two accidents that actually happened —
 * an exported live URL beating an env file, and a client whose server turns out
 * to be somewhere other than the string said — and demands a refusal from each.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DB_GUARD_ENV, DB_GUARD_CLONE_ONLY, LIVE_DATABASE_NAMES, NON_LIVE_DATABASE_SHAPE,
  classifyDatabaseTarget, databaseNameOf, dbGuardArmed,
  urlDatabaseRefusal, serverDatabaseRefusal, assertNonLiveDatabase,
} from './live-guard';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const ARMED = { [DB_GUARD_ENV]: DB_GUARD_CLONE_ONLY } as unknown as NodeJS.ProcessEnv;
const DISARMED = {} as unknown as NodeJS.ProcessEnv;

const LIVE_URL  = 'postgresql://fintracker:pw@localhost:5432/fintracker?schema=public';
const CLONE_URL = 'postgresql://fintracker:pw@localhost:5432/fintracker_i1_a?schema=public';

console.log('live-guard — a disposable process may reach a clone and nothing else');

// ── 1. The name is the whole of the discrimination ──────────────────────────
{
  check('the name is read off the path, credentials and all else ignored',
    databaseNameOf(LIVE_URL) === 'fintracker' && databaseNameOf(CLONE_URL) === 'fintracker_i1_a');
  check('live and clone differ ONLY by the path segment',
    LIVE_URL.replace('/fintracker?', '/fintracker_i1_a?') === CLONE_URL);
  check('an unset / empty / unparseable URL yields no name',
    databaseNameOf(undefined) === null && databaseNameOf('') === null
    && databaseNameOf('   ') === null && databaseNameOf('not a url') === null);
  check('a URL with no database yields no name',
    databaseNameOf('postgresql://u:p@localhost:5432') === null
    && databaseNameOf('postgresql://u:p@localhost:5432/') === null);
}

// ── 2. The verdicts ──────────────────────────────────────────────────────────
{
  for (const live of LIVE_DATABASE_NAMES) {
    check(`"${live}" is LIVE`, classifyDatabaseTarget(`postgresql://h/${live}`).verdict === 'LIVE');
  }
  // Every clone that exists on this machine today, by name.
  for (const clone of ['fintracker_postm1', 'fintracker_postm1_a', 'fintracker_postm1_lead4',
    'fintracker_i1', 'fintracker_i1_agent_c']) {
    check(`"${clone}" is NON_LIVE`, classifyDatabaseTarget(`postgresql://h/${clone}`).verdict === 'NON_LIVE');
  }
  check('an unset URL is UNKNOWN, not NON_LIVE', classifyDatabaseTarget(undefined).verdict === 'UNKNOWN');
  check('a hosted database is UNKNOWN, not NON_LIVE',
    classifyDatabaseTarget('postgresql://u:p@db.abcdef.supabase.com:5432/postgres').verdict === 'LIVE'
    && classifyDatabaseTarget('postgresql://u:p@aws.pooler.supabase.com:6543/prod').verdict === 'UNKNOWN');
  // ⚠️ THE NEAR MISS. A bare `!== 'fintracker'` would wave both of these through.
  check('a name that merely CONTAINS the clone shape is not a clone',
    classifyDatabaseTarget('postgresql://h/notfintracker_a').verdict === 'UNKNOWN'
    && classifyDatabaseTarget('postgresql://h/fintrackerX_a').verdict === 'UNKNOWN');
  check('a typo one character from live is refused',
    classifyDatabaseTarget('postgresql://h/fintracke').verdict === 'UNKNOWN'
    && classifyDatabaseTarget('postgresql://h/fintracker2').verdict === 'UNKNOWN');
  check('the shape demands a suffix, so `fintracker_` alone is not a clone',
    classifyDatabaseTarget('postgresql://h/fintracker_').verdict === 'UNKNOWN');
  check('the shape and the denylist do not overlap',
    LIVE_DATABASE_NAMES.every((n) => !NON_LIVE_DATABASE_SHAPE.test(n)));
}

// ── 3. No credential ever reaches a message ─────────────────────────────────
{
  const msg = urlDatabaseRefusal(LIVE_URL, ARMED) ?? '';
  check('a refusal names the database', msg.includes('fintracker'));
  check('a refusal quotes NO credential', !msg.includes('pw') && !msg.includes('@localhost'));
  check('a refusal says an exported DATABASE_URL beats --env-file',
    /exported/i.test(msg) && /env-file/i.test(msg));
}

// ── 4. Armed, not always on ─────────────────────────────────────────────────
{
  check('inert when the variable is unset', !dbGuardArmed(DISARMED)
    && urlDatabaseRefusal(LIVE_URL, DISARMED) === null
    && serverDatabaseRefusal('fintracker', DISARMED) === null);
  check('inert on any other value',
    !dbGuardArmed({ [DB_GUARD_ENV]: 'true' } as unknown as NodeJS.ProcessEnv));
  check('armed on exactly `clone-only`', dbGuardArmed(ARMED));
  check('armed, a clone proceeds', urlDatabaseRefusal(CLONE_URL, ARMED) === null);
}

// ── 5. THE PLANTED ACCIDENTS ────────────────────────────────────────────────
{
  // (a) The post-M1 incident, exactly: the worktree's env file names a clone and
  //     an EXPORTED live URL is what actually resolves. The guard checks the
  //     value in force, so the env file is irrelevant to it.
  const resolvedDespiteEnvFile = LIVE_URL;
  check('PLANTED: an exported live URL beating an env file is REFUSED',
    urlDatabaseRefusal(resolvedDespiteEnvFile, ARMED) !== null);

  // (b) The URL is a claim; the server is the fact. A client pointed by a
  //     `datasources` override, or a pooler, can land somewhere the string
  //     never named.
  check('PLANTED: URL says clone, SERVER says live — REFUSED',
    urlDatabaseRefusal(CLONE_URL, ARMED) === null
    && serverDatabaseRefusal('fintracker', ARMED) !== null);
  check('the server check accepts a clone', serverDatabaseRefusal('fintracker_i1_a', ARMED) === null);
  check('a server that did not answer is REFUSED',
    serverDatabaseRefusal(null, ARMED) !== null && serverDatabaseRefusal('', ARMED) !== null);

  // (c) The assertion throws rather than returning, so a caller cannot ignore it.
  let threw = false;
  try { assertNonLiveDatabase(LIVE_URL, ARMED); } catch { threw = true; }
  check('assertNonLiveDatabase THROWS on live', threw);
  let threwOnClone = false;
  try { assertNonLiveDatabase(CLONE_URL, ARMED); } catch { threwOnClone = true; }
  check('assertNonLiveDatabase is silent on a clone', !threwOnClone);
}

// ── 6. It is wired where every write-capable path must pass ─────────────────
{
  const db = readFileSync(path.join(process.cwd(), 'lib/db.ts'), 'utf8');
  check('lib/db.ts consults the guard', db.includes('assertNonLiveDatabase'));
  // ⚠️ BEFORE THE CLIENT, NOT AFTER. A guard that ran after `new PrismaClient`
  // would already have opened a connection to live.
  check('…BEFORE the client is constructed',
    db.indexOf('assertNonLiveDatabase(') < db.indexOf('new PrismaClient('));
  check('…on the RESOLVED url, not on an env file',
    /assertNonLiveDatabase\(\s*datasourceUrl\s*\?\?\s*process\.env\.DATABASE_URL\s*\)/.test(db));
}

if (failures > 0) { console.error(`\nlive-guard: ${failures} failure(s).`); process.exit(1); }
console.log('\nlive-guard: all passed.');
