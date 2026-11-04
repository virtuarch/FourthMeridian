/**
 * scripts/lib/acl-core.ts  (DR — grant restoration, PURE)
 *
 * Our backups are `pg_dump --no-owner --no-privileges` (scripts/lib/db-backup.core.ts),
 * so a restored database carries tables, rows, RLS flags and policies but NO GRANTs,
 * and its `_prisma_migrations` ledger is already at head, so `migrate deploy`
 * re-applies nothing. The runtime roles (fm_app / fm_auth / fm_system / fm_backup)
 * then fail closed with "permission denied" (docs/operations/database-safety.md §4c).
 *
 * This module is the pure half of `db:regrant`: it reads the privilege state that a
 * freshly migrated REFERENCE database holds, compares it with a TARGET (the restore),
 * and renders the GRANT / REVOKE statements that make the target match. The reference
 * is derived, never hand-maintained: a migration that changes a grant changes the
 * reference automatically, so there is no fixture to drift.
 *
 * Scope: privileges whose GRANTEE is an `fm_*` role, on objects in schema `public`
 * (tables, views, materialised views, sequences, columns, functions), USAGE/CREATE on
 * the schema itself, and ALTER DEFAULT PRIVILEGES. Role attributes (LOGIN, BYPASSRLS)
 * are cluster-level and are reported, never changed.
 */

export type AclObjectType = "table" | "sequence" | "column" | "function" | "schema" | "default";

export interface AclEntry {
  objType: AclObjectType;
  /** Relation, sequence or schema name; a function's regprocedure text; for "default" the object class (r = tables, S = sequences, f = functions, T = types, n = schemas). */
  name: string;
  /** Column name for "column", else "". */
  column: string;
  grantee: string;
  privilege: string;
}

/**
 * One query, one row per (object, grantee, privilege), pipe-separated, restricted to
 * fm_* grantees. Run it on both databases with psql -A -t.
 */
export const ACL_QUERY = `
with fm as (select oid, rolname from pg_roles where rolname like 'fm\\_%')
select 'table' || '|' || c.relname || '||' || fm.rolname || '|' || a.privilege_type
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a join fm on fm.oid = a.grantee
 where n.nspname = 'public' and c.relkind in ('r','p','v','m')
union all
select 'sequence' || '|' || c.relname || '||' || fm.rolname || '|' || a.privilege_type
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a join fm on fm.oid = a.grantee
 where n.nspname = 'public' and c.relkind = 'S'
union all
select 'column' || '|' || c.relname || '|' || att.attname || '|' || fm.rolname || '|' || a.privilege_type
  from pg_attribute att join pg_class c on c.oid = att.attrelid join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(att.attacl) a join fm on fm.oid = a.grantee
 where n.nspname = 'public' and att.attnum > 0 and not att.attisdropped
union all
select 'function' || '|' || p.oid::regprocedure::text || '||' || fm.rolname || '|' || a.privilege_type
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(p.proacl) a join fm on fm.oid = a.grantee
 where n.nspname = 'public'
union all
select 'schema' || '|' || n.nspname || '||' || fm.rolname || '|' || a.privilege_type
  from pg_namespace n cross join lateral aclexplode(n.nspacl) a join fm on fm.oid = a.grantee
 where n.nspname = 'public'
union all
select 'default' || '|' || d.defaclobjtype::text || '||' || fm.rolname || '|' || a.privilege_type
  from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
  cross join lateral aclexplode(d.defaclacl) a join fm on fm.oid = a.grantee
 where n.nspname = 'public'
order by 1;`;

/** Role attributes worth reporting (never changed by this tool). */
export const ROLE_QUERY = `
select rolname || '|' || rolcanlogin::text || '|' || rolbypassrls::text || '|' || rolsuper::text
  from pg_roles where rolname like 'fm\\_%' order by 1;`;

const OBJ_TYPES = new Set<AclObjectType>(["table", "sequence", "column", "function", "schema", "default"]);

/** Parse ACL_QUERY output (one `type|name|column|grantee|privilege` line per entry). */
export function parseAcl(out: string): AclEntry[] {
  const entries: AclEntry[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split("|");
    if (parts.length !== 5) throw new Error(`unparseable ACL line: ${line}`);
    const [objType, name, column, grantee, privilege] = parts;
    if (!OBJ_TYPES.has(objType as AclObjectType)) throw new Error(`unknown ACL object type: ${objType}`);
    entries.push({ objType: objType as AclObjectType, name, column, grantee, privilege });
  }
  return entries;
}

export const aclKey = (e: AclEntry): string => [e.objType, e.name, e.column, e.grantee, e.privilege].join("|");

export interface AclDiff {
  /** In the reference, absent from the target — what a restore lost. */
  missing: AclEntry[];
  /** In the target, absent from the reference — an over-grant; a security finding. */
  extra: AclEntry[];
}

export function diffAcl(reference: readonly AclEntry[], target: readonly AclEntry[]): AclDiff {
  const ref = new Map(reference.map((e) => [aclKey(e), e]));
  const tgt = new Map(target.map((e) => [aclKey(e), e]));
  const sort = (a: AclEntry, b: AclEntry) => aclKey(a).localeCompare(aclKey(b));
  return {
    missing: [...ref].filter(([k]) => !tgt.has(k)).map(([, e]) => e).sort(sort),
    extra:   [...tgt].filter(([k]) => !ref.has(k)).map(([, e]) => e).sort(sort),
  };
}

/** Quote a SQL identifier. */
export const qi = (s: string): string => `"${s.replace(/"/g, '""')}"`;

const PRIVILEGE = /^(SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|USAGE|EXECUTE|CREATE)$/;
const DEFAULT_CLASS: Record<string, string> = { r: "TABLES", S: "SEQUENCES", f: "FUNCTIONS", T: "TYPES", n: "SCHEMAS" };

/** The object clause of a GRANT/REVOKE for one entry. */
function onClause(e: AclEntry): string {
  switch (e.objType) {
    case "table":    return `ON TABLE public.${qi(e.name)}`;
    case "sequence": return `ON SEQUENCE public.${qi(e.name)}`;
    case "column":   return `ON TABLE public.${qi(e.name)}`;
    // regprocedure text is already schema-qualified and quoted by PostgreSQL.
    case "function": return `ON FUNCTION ${e.name}`;
    case "schema":   return `ON SCHEMA ${qi(e.name)}`;
    default:         throw new Error(`no ON clause for ${e.objType}`);
  }
}

function statement(verb: "GRANT" | "REVOKE", e: AclEntry): string {
  if (!PRIVILEGE.test(e.privilege)) throw new Error(`refusing unknown privilege: ${e.privilege}`);
  if (!/^fm_[a-z0-9_]+$/.test(e.grantee)) throw new Error(`refusing grantee outside fm_*: ${e.grantee}`);
  const to = verb === "GRANT" ? "TO" : "FROM";
  if (e.objType === "default") {
    const cls = DEFAULT_CLASS[e.name];
    if (!cls) throw new Error(`unknown default-privilege class: ${e.name}`);
    return `ALTER DEFAULT PRIVILEGES IN SCHEMA public ${verb} ${e.privilege} ON ${cls} ${to} ${qi(e.grantee)};`;
  }
  const priv = e.objType === "column" ? `${e.privilege} (${qi(e.column)})` : e.privilege;
  return `${verb} ${priv} ${onClause(e)} ${to} ${qi(e.grantee)};`;
}

/**
 * The statements that make the target match the reference: GRANT every missing
 * entry; REVOKE extra entries only when asked (an extra privilege is reported as a
 * finding first — revoking is a separate, deliberate choice).
 */
export function renderRegrant(diff: AclDiff, opts: { revokeExtra?: boolean } = {}): string[] {
  const grants = diff.missing.map((e) => statement("GRANT", e));
  const revokes = opts.revokeExtra ? diff.extra.map((e) => statement("REVOKE", e)) : [];
  return [...grants, ...revokes];
}

/** A database name this tool may write to without an explicit Production approval: a clone. */
export const isCloneName = (name: string): boolean => /^fintracker_[a-z0-9_]+$/.test(name);
