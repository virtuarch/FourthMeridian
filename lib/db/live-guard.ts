/**
 * lib/db/live-guard.ts   (I1 — Slice 0, database safety)
 *
 * WHICH DATABASE IS THIS, AND MAY A DISPOSABLE PROCESS WRITE TO IT.
 *
 * ── THE INCIDENT THIS EXISTS FOR ────────────────────────────────────────────
 * The post-M1 program ran seven agent worktrees against DB clones. Five of them
 * wrote to LIVE, because an EXPORTED `DATABASE_URL` beats `--env-file=.env.local`
 * — Node's `--env-file` fills blanks and never overrides — so a worktree that
 * merely *had* a clone URL in its own env file inherited the parent shell's live
 * one instead. The program's closure records the lesson in as many words: "the
 * guard belongs in the script, not in the instruction. The clone-guard pattern
 * (`current_database()` checked at runtime) is the thing that worked." That
 * guard lived in `tmp/` and was never landed. This is it, landed.
 *
 * ── WHY A NAME IS THE ONLY DISCRIMINATOR ────────────────────────────────────
 * Measured on this machine: live and all twelve existing clones share a
 * byte-identical host, port, user and password. `postgresql://…@localhost:5432/`
 * is the same prefix for `fintracker` and for `fintracker_postm1_a`. The PATH
 * SEGMENT is the whole of the difference, which is why this classifies on the
 * database name and on nothing else.
 *
 * ── FAIL CLOSED, AND THE UNKNOWN CASE IS THE POINT ──────────────────────────
 * An unset, unparseable or unrecognised URL is UNKNOWN, and UNKNOWN is refused.
 * `scripts/lib/db-guard.core.ts` already treats an unreachable population probe
 * as populated for the same reason: a guard that waves through what it could not
 * read is a guard that fails open on exactly the malformed input an accident
 * produces.
 *
 * ── ARMED, NOT ALWAYS ON ────────────────────────────────────────────────────
 * `npm run ai:chat` against the real Space is a legitimate product workflow, and
 * so is every `audit:*` script. A guard that refused those would be turned off
 * within a day. So the guard is ARMED by `FM_DB_GUARD=clone-only` and is
 * otherwise inert — and the arming lives in the I1 harness and the I1 npm
 * scripts, where a write-capable experiment cannot start without it.
 *
 * ⚠️ PURE. No I/O and no Prisma import, so the classifier is unit-testable and
 * so `lib/db.ts` can consult it before it constructs a client.
 */

/** The arming switch. Any other value, or none, leaves the guard inert. */
export const DB_GUARD_ENV = 'FM_DB_GUARD';
export const DB_GUARD_CLONE_ONLY = 'clone-only';

/**
 * Databases a disposable process may never write to, by exact name.
 *
 * `fintracker` is the local dogfood database and is NOT disposable:
 * `docs/operations/database-safety.md` §0 — "real operator account, connected
 * Plaid accounts, real sync history, manually created Spaces… `prisma db seed`
 * does NOT recreate any of that". `postgres` is the server's own maintenance
 * database.
 */
export const LIVE_DATABASE_NAMES: readonly string[] = ['fintracker', 'postgres'];

/**
 * The shape every non-live copy has had since the first clone was cut.
 *
 * ⚠️ A SUFFIX PATTERN, NOT A LITERAL LIST. Twelve clones already exist
 * (`fintracker_postm1`, `_a`…`_g`, `_lead1`…`_lead4`) and each program mints
 * more; a literal list would need editing every program and would rot into a
 * guard nobody trusts. A bare `name !== 'fintracker'` would be worse — it waves
 * through a hosted `postgres`, a typo, and any URL that is not this convention
 * at all.
 */
export const NON_LIVE_DATABASE_SHAPE = /^fintracker_[a-z0-9_]+$/;

export type DatabaseVerdict = 'NON_LIVE' | 'LIVE' | 'UNKNOWN';

export interface DatabaseTarget {
  /** The database name, or null when the URL yielded none. */
  name: string | null;
  verdict: DatabaseVerdict;
  /** Why, in one sentence, for a refusal a human has to act on. */
  reason: string;
}

/**
 * The database name a connection string names, or null.
 *
 * ⚠️ NO CREDENTIAL EVER LEAVES THIS FUNCTION. Only the path segment is read, so
 * a refusal message can quote the name without quoting a password — which is
 * what makes the message safe to print in CI and in an agent transcript.
 */
export function databaseNameOf(url: string | undefined | null): string | null {
  if (typeof url !== 'string' || url.trim() === '') return null;
  try {
    const name = new URL(url).pathname.replace(/^\//, '');
    return name === '' ? null : decodeURIComponent(name);
  } catch {
    return null;
  }
}

/** What this connection string points at, and whether a disposable process may write to it. */
export function classifyDatabaseTarget(url: string | undefined | null): DatabaseTarget {
  const name = databaseNameOf(url);
  if (name === null) {
    return { name: null, verdict: 'UNKNOWN',
      reason: 'DATABASE_URL is unset, empty or not a parseable connection string, so the target '
        + 'database could not be identified at all.' };
  }
  if (LIVE_DATABASE_NAMES.includes(name)) {
    return { name, verdict: 'LIVE',
      reason: `"${name}" is a LIVE database — it holds the real operator account, the real Plaid `
        + 'connections and the real sync history, and a seed does not recreate any of it.' };
  }
  if (NON_LIVE_DATABASE_SHAPE.test(name)) {
    return { name, verdict: 'NON_LIVE', reason: `"${name}" is a clone.` };
  }
  return { name, verdict: 'UNKNOWN',
    reason: `"${name}" is not a recognised clone name. A clone is named `
      + `\`fintracker_<suffix>\` (the convention every existing clone follows); anything else `
      + 'may be a hosted database, a typo, or a copy nobody has vouched for.' };
}

/** Is the guard armed in this process? */
export function dbGuardArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DB_GUARD_ENV] === DB_GUARD_CLONE_ONLY;
}

const refusal = (where: string, t: DatabaseTarget) =>
  `REFUSING TO RUN: ${where} ${t.reason}\n`
  + `  ${DB_GUARD_ENV}=${DB_GUARD_CLONE_ONLY} is set, so this process may only reach a clone.\n`
  + '  Point DATABASE_URL at a clone (`fintracker_<suffix>`) — and note that an EXPORTED\n'
  + '  DATABASE_URL BEATS `--env-file`, so check `printenv DATABASE_URL` before blaming the file.';

/**
 * The URL's own claim, checked. Returns a refusal message, or null to proceed.
 *
 * ⚠️ THIS IS THE CHEAP HALF AND IT IS NOT SUFFICIENT. A URL is a claim; the
 * server is the fact. `serverDatabaseRefusal` below is the other half, and the
 * post-M1 clone guard ran both for that reason.
 */
export function urlDatabaseRefusal(
  url: string | undefined | null, env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!dbGuardArmed(env)) return null;
  const t = classifyDatabaseTarget(url);
  return t.verdict === 'NON_LIVE' ? null : refusal('DATABASE_URL names a database that is not a clone —', t);
}

/**
 * What the SERVER says it is, checked. Returns a refusal message, or null.
 *
 * ⚠️ WHY THE URL IS NOT ENOUGH. A `datasources` override, a rewritten URL, a
 * pooler pointing somewhere else, or a client constructed before the env was
 * read all produce a connection whose database is not the one the string named.
 * `select current_database()` is the only statement that cannot be wrong about it.
 */
export function serverDatabaseRefusal(
  currentDatabase: string | null | undefined, env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!dbGuardArmed(env)) return null;
  const name = typeof currentDatabase === 'string' && currentDatabase !== '' ? currentDatabase : null;
  const t = name === null
    ? { name: null, verdict: 'UNKNOWN' as const,
        reason: 'the server did not answer `select current_database()`, so the connected database '
          + 'could not be confirmed.' }
    : classifyDatabaseTarget(`postgresql://h/${encodeURIComponent(name)}`);
  return t.verdict === 'NON_LIVE' ? null
    : refusal('the SERVER reports a database that is not a clone —', t);
}

/**
 * Refuse, loudly, unless this process is pointed at a clone. Throws.
 *
 * Called from `lib/db.ts` before a client is constructed, so a write-capable
 * script cannot get as far as a query against live.
 */
export function assertNonLiveDatabase(
  url: string | undefined | null, env: NodeJS.ProcessEnv = process.env,
): void {
  const message = urlDatabaseRefusal(url, env);
  if (message !== null) throw new Error(message);
}
