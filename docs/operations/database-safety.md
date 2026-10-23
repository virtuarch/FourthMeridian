# Database Safety Protocol

**Status:** BINDING — for every developer and every agent working in this repo.
**Origin:** a destructive Prisma workflow (`migrate diff` with the live DB passed as the shadow, then `migrate reset`) wiped the local database, destroying un-seeded personal state. This protocol exists so that cannot happen by accident again.

---

## 0. The one rule

**The local database is NOT disposable.** It is a personal development environment that holds **real test data** — a real `chrstn` operator account, connected **Plaid** accounts, real sync history, and manually created Spaces/configuration. **`prisma db seed` does NOT recreate any of that.** Treat this DB as valuable, backed-up state, exactly like a small production DB.

---

## 1. Prohibited without an explicit, backed-up opt-in

Never run these against a database that might hold personal/shared/production data:

| Command | Why it's dangerous |
|---|---|
| `prisma migrate reset` | **DROPs and recreates the schema** — total data loss, seed only restores seed users. |
| `prisma migrate dev` | On drift/failed migration it **offers to reset** — one keystroke from data loss. |
| `prisma db push --force-reset` | Force-resets the schema. |
| `prisma migrate diff --shadow-database-url <URL>` where `<URL>` is the **live DB** | `migrate diff --from-migrations` **RESETS the shadow DB** to replay migrations. Passing the live DB as the shadow wipes it. **This was the actual incident.** |

Do **not** invoke these raw. Use the safe scripts below.

---

## 2. Safe workflow (use these, always)

```
backup  →  migrate  →  verify
```

| Command | What it does |
|---|---|
| `npm run db:backup` | Timestamped `pg_dump` of the **mutation target** (`DIRECT_URL`, which Prisma Migrate uses — see §2a) → `backups/<db>-<iso>.sql` (gitignored). Refuses when `DATABASE_URL`/`DIRECT_URL` are not provably one database. Fails loudly on an empty/partial dump. Restore: see §4. |
| `npm run db:migrate:safe` | `db-guard --mode=migrate-deploy` (target identity) → `db:backup` → `prisma migrate deploy` — applies pending migrations **additively** (never resets). This is the normal way to apply a new migration to your dev DB. |
| `npm run db:migrate` | Routed through `db-guard --mode=migrate-dev` **+ backup** first. **Refuses a non-interactive shell** against a populated (or unreachable) database — on 2026-09-15 a bare `prisma migrate dev` run by an agent session with drift pending reset the dev DB before Prisma's own interactivity refusal printed. From a real terminal it proceeds and Prisma prompts you. |
| `npm run db:reset` | Routed through `db-guard` **+ backup** first. Refuses unless `ALLOW_DESTRUCTIVE_DB=true`; for a target that is **not a recognised clone** (`fintracker`, `postgres`, anything off the `fintracker_<suffix>` convention) it additionally requires a human at a real terminal to **type the exact `host/database`** — the env flag alone may be left exported from an earlier command. A backup of the same database is taken before the reset. |

The **guard** (`scripts/db-guard.ts`, run by every destructive or schema-mutating script) refuses unless **all** of:
1. **Target identity (every mode).** The database Prisma Migrate will actually mutate is resolved the way Prisma resolves it — `DIRECT_URL` (schema.prisma declares `directUrl = env("DIRECT_URL")`) — and `DATABASE_URL` and `DIRECT_URL` must be **provably the same logical database** (§2a). A split, an unprovable pairing, or a missing `DIRECT_URL` is refused before anything is probed, backed up or mutated.
2. **Shadow distinct (every mode).** `SHADOW_DATABASE_URL`, if set, must be provably a *different* database from both.
3. **Clone-only (when armed).** With `FM_DB_GUARD=clone-only`, the target must be a `fintracker_<suffix>` clone.
4. **Mode gate.** reset: `ALLOW_DESTRUCTIVE_DB=true` (+ typed target for non-clones). migrate-dev: a TTY when the target is populated or unknown. migrate-deploy: nothing further (additive).

So the *only* way to reset is a conscious, backed-up act:
```bash
npm run db:backup                                  # if you want a manual one first
ALLOW_DESTRUCTIVE_DB=true npm run db:reset          # backs up the same target, then resets
```

### 2a. One command, one database (FM-AUDIT-002)

Until 2026-09-21 the guard and the backup read `DATABASE_URL` while Prisma Migrate connected through `DIRECT_URL`. With the two split — which the old clone recipe produced, since it rewrote `DATABASE_URL` only — the guard approved and backed up the **clone** and Prisma reset **live**. The invariant now enforced by `lib/db/target-identity.ts`:

> A supported command never validates or backs up database A and then mutates database B.

"The same logical database" means equal identity keys:

| Family | Identity | Example pair that is the SAME |
|---|---|---|
| local (loopback) | port + database name | `localhost:5432/fintracker_x` ≡ `127.0.0.1/fintracker_x` |
| Supabase | project ref + database name | pooler `postgres.<ref>@…pooler.supabase.com:6543/postgres` ≡ direct `db.<ref>.supabase.co:5432/postgres` |
| any other host | exact host + port + database name | — |

Anything not provably the same (two unknown hosts that might be a pooler and its primary) is refused. `db:wipe` checks the same authority before its inventory, backup and Plaid teardown.

---

## 3. Authoring a NEW migration safely

Generating a migration needs a **shadow** database to compute the diff. **Never use the dev DB as the shadow.**

- Set `SHADOW_DATABASE_URL` to a **throwaway** database (a separate empty DB / a disposable container), or
- Add the field to `schema.prisma`, then `npm run db:migrate:safe` (which runs `migrate deploy` — additive, non-destructive), letting a proper migration be authored against a throwaway shadow.

The guard refuses if it ever sees `SHADOW_DATABASE_URL === DATABASE_URL`.

---

## 4. Recovery process (if data is lost anyway)

1. **Check `backups/`** first — restore the newest good dump:

   ```bash
   # ⚠️ pg_dump 18 → PG 16. The host tools are 18.x; the server in docker-compose
   # is postgres:16-alpine. A pg_dump 18 file emits `SET transaction_timeout = 0;`
   # (a PG17+ GUC) near line 13, which a PG16 server rejects — so with
   # ON_ERROR_STOP the restore aborts before creating anything.
   grep -v '^SET transaction_timeout = 0;$' backups/<file>.sql \
     | psql -v ON_ERROR_STOP=1 "$DATABASE_URL"
   ```

   Verify by diffing per-table `count(*)` against the source before trusting it.
2. No backup? The **Plaid data is not truly lost** — Plaid is the upstream source of truth. Re-registering the account and reconnecting institutions re-imports transaction history (see the reconstruction flow). What's lost and must be rebuilt: the user row, platform grants, Space configuration, and any manual/CSV accounts.
3. Restore the operator account through the **normal product lifecycle** (register → login → MFA), then re-grant platform access via the SYSTEM_ADMIN grant surface — never by injecting a user row.

---

## 4a. Clones, and the guard that makes them mandatory

**Live is exactly `fintracker`. Every disposable copy is `fintracker_<suffix>`.**
That convention is not a style preference — it is the predicate
`lib/db/live-guard.ts` classifies on, because live and every clone share a
byte-identical host, port, user and password. The database NAME is the whole of
the difference.

Cut a clone:

```bash
createdb fintracker_<program>                      # base clone
pg_dump fintracker | psql -q fintracker_<program>
createdb -T fintracker_<program> fintracker_<program>_a   # per-agent copies
```

`createdb -T` is a file-level copy and needs no other session connected to the
TEMPLATE — which is why the per-agent copies are templated off the base clone and
never off `fintracker`.

**Point EVERY mutation-capable URL at the clone, and arm the guard for anything write-capable:**

```bash
FM_DB_GUARD=clone-only \
  DATABASE_URL="postgresql://…/fintracker_<program>_a" \
  DIRECT_URL="postgresql://…/fintracker_<program>_a" \
  npm run <script>
```

`DIRECT_URL` is not optional: it is what `prisma migrate …` connects to. A clone
recipe that rewrites only `DATABASE_URL` leaves Migrate pointed at live — the
db-guard now refuses that split outright (§2a), but a worktree `.env.local` must
still be rewritten for **both** variables.

Armed, `lib/db.ts` refuses — before a client exists — any database it cannot
identify as a clone. Unset, it is inert, so `npm run ai:chat` and the `audit:*`
scripts still reach live deliberately.

> ⚠️ **An EXPORTED `DATABASE_URL` BEATS `--env-file`.** Node's `--env-file` fills
> blanks and never overrides. Five of seven post-M1 agent worktrees wrote to LIVE
> through exactly this: each had a clone URL in its own `.env.local` and inherited
> the parent shell's live one anyway. Check `printenv DATABASE_URL` before blaming
> the file. Setting up a worktree means **rewriting its `.env.local` to its clone**,
> not instructing an agent to remember to export something.

---

## 5. For agents specifically

- Never run a destructive Prisma command as a step in a task. If a schema change needs applying, use `npm run db:migrate:safe`.
- Anything write-capable — a test, an eval, a model harness — runs with
  `FM_DB_GUARD=clone-only` against a `fintracker_<suffix>` clone (both `DATABASE_URL` and `DIRECT_URL`).
  ⚠️ The runtime guard is ARMED by that variable and inert without it — a script that
  does not set it is protected only by convention. The destructive npm scripts
  (`db:reset`, `db:migrate`, `db:migrate:safe`, `db:backup`, `db:wipe`) check target
  identity whether or not it is set.
- Withholding a tool is **not** isolation — but durable MEMORY is now closed by default
  (FM-AUDIT-019, `lib/ai/conversation/memory-write-policy.ts`): `remember` and the silent
  `project_cash` checkpoint write only when the turn's context carries `memoryWrites: true`,
  which only the product chat route sets. The `ai:*` harnesses are read-only for memory unless
  `FM_AI_MEMORY_WRITES=clone-only` is set AND the target is a clone (opting in against live is
  refused before anything runs); checks whose purpose is writing memory rows refuse anything
  but a clone. `lib/ai/invocation.ts` still writes an `AiInvocation` row on every model call,
  so a harness still writes usage rows to whatever database it is pointed at.
- Never pass `$DATABASE_URL` as `--shadow-database-url`.
- Take `npm run db:backup` before anything schema-touching.
- If unsure whether an operation is destructive, stop and ask.
