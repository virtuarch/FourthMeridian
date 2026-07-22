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
| `npm run db:backup` | Timestamped `pg_dump` → `backups/<db>-<iso>.sql` (gitignored). Fails loudly on an empty/partial dump. Restore: `psql "$DATABASE_URL" < backups/<file>.sql`. |
| `npm run db:migrate:safe` | `db:backup` then `prisma migrate deploy` — applies pending migrations **additively** (never resets). This is the normal way to apply a new migration to your dev DB. |
| `npm run db:reset` | Routed through `db-guard` **+ backup** first. Refuses unless `ALLOW_DESTRUCTIVE_DB=true`. Even then, a backup is taken before the reset. |

The **guard** (`scripts/db-guard.ts`, run by the destructive scripts) blocks unless **both**:
1. `ALLOW_DESTRUCTIVE_DB=true` is set explicitly (no default, no config), and
2. `SHADOW_DATABASE_URL` ≠ `DATABASE_URL` (the shadow-DB footgun).

So the *only* way to reset is a conscious, backed-up act:
```bash
npm run db:backup                                  # if you want a manual one first
ALLOW_DESTRUCTIVE_DB=true npm run db:reset          # backs up again, then resets
```

---

## 3. Authoring a NEW migration safely

Generating a migration needs a **shadow** database to compute the diff. **Never use the dev DB as the shadow.**

- Set `SHADOW_DATABASE_URL` to a **throwaway** database (a separate empty DB / a disposable container), or
- Add the field to `schema.prisma`, then `npm run db:migrate:safe` (which runs `migrate deploy` — additive, non-destructive), letting a proper migration be authored against a throwaway shadow.

The guard refuses if it ever sees `SHADOW_DATABASE_URL === DATABASE_URL`.

---

## 4. Recovery process (if data is lost anyway)

1. **Check `backups/`** first — restore the newest good dump: `psql "$DATABASE_URL" < backups/<file>.sql`.
2. No backup? The **Plaid data is not truly lost** — Plaid is the upstream source of truth. Re-registering the account and reconnecting institutions re-imports transaction history (see the reconstruction flow). What's lost and must be rebuilt: the user row, platform grants, Space configuration, and any manual/CSV accounts.
3. Restore the operator account through the **normal product lifecycle** (register → login → MFA), then re-grant platform access via the SYSTEM_ADMIN grant surface — never by injecting a user row.

---

## 5. For agents specifically

- Never run a destructive Prisma command as a step in a task. If a schema change needs applying, use `npm run db:migrate:safe`.
- Never pass `$DATABASE_URL` as `--shadow-database-url`.
- Take `npm run db:backup` before anything schema-touching.
- If unsure whether an operation is destructive, stop and ask.
