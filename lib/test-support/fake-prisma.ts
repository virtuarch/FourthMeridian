/**
 * lib/test-support/fake-prisma.ts  (TEST-002 / TEST-004)
 *
 * AN IN-MEMORY PRISMA CLIENT, DRIVEN BY THE REAL SCHEMA — so route handlers can
 * be invoked for real (their `POST(req)` / `DELETE(req, ctx)`) with no Postgres.
 *
 * WHAT IT IS. Every model delegate the generated client has (from
 * `Prisma.dmmf`), backed by plain arrays. Defaults (`cuid()`, `uuid()`, `now()`,
 * `autoincrement()`, literal enum/boolean/number defaults), `@updatedAt`,
 * `@unique` / `@@unique` / `@id` (a violation throws the REAL
 * `Prisma.PrismaClientKnownRequestError` with code P2002), P2025 on a missing
 * `update`/`delete` target, relation reads (`select` / `include` / relation
 * filters `some`/`none`/`every`/`is`/`isNot`), nested `create` / `connect`,
 * atomic number updates, lazy "PrismaPromise" semantics (nothing runs until
 * awaited — which is what makes the array form of `$transaction` work), and
 * `$transaction` with ROLLBACK (a snapshot is restored when the callback or any
 * array member throws) and Postgres' ABORTED-TRANSACTION rule (after one failed
 * statement, every later statement in that interactive transaction fails 25P02).
 *
 * WHAT IT IS NOT. Not SQL, not RLS, not isolation: `withTenantDb`'s
 * `set_config` is recorded and accepted, so these tests prove the APPLICATION
 * layer's authority (the route's own predicates and guards). Database-level
 * policies are proved by the RLS suites, against Postgres. Concurrent
 * interactive transactions share one store (no isolation); a rollback restores
 * the snapshot taken at its start. `aggregate` / `groupBy` / `$queryRaw` return
 * what a test configures, or throw so a test never passes on a silent stub.
 *
 * INSTALLATION. `installFakePrisma()` defines each delegate on the process's
 * `db` object (the same technique as lib/auth/token-update.test.ts). With no
 * DATABASE_URL_APP/AUTH/SYSTEM set, `tenantDb`, `authDb` and `systemDb` ARE `db`
 * (lib/db.ts), so every authority a route can reach lands here — asserted at
 * install time, so a test can never silently talk to a real client.
 *
 * ⚠️ TEST-ONLY. Imported by *.test.ts files and nothing else.
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

type Row = Record<string, unknown>;
type Field = Prisma.DMMF.Field;
type Model = Prisma.DMMF.Model;

export interface FakeCall { model: string; op: string; args: unknown }
interface TxState { aborted: boolean; abortedBy?: string }
/** A hook may throw (fault injection) or return a value to replace the result. */
export type FakeHook = (args: Record<string, unknown>, call: FakeCall) => unknown | Promise<unknown>;

const MODELS = new Map<string, Model>(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
const lcFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const DELEGATE_TO_MODEL = new Map<string, string>([...MODELS.keys()].map((n) => [lcFirst(n), n]));

let idCounter = 0;
function fakeCuid(): string {
  idCounter++;
  return `cfake${idCounter.toString(36).padStart(8, "0")}${Math.random().toString(36).slice(2, 14).padEnd(12, "0")}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)
    && !Prisma.Decimal.isDecimal(v) && !isNullType(v) && !Buffer.isBuffer(v);
}
function isNullType(v: unknown): boolean {
  return v === Prisma.DbNull || v === Prisma.JsonNull || v === Prisma.AnyNull;
}
function clone<T>(v: T): T {
  if (v instanceof Date) return new Date(v.getTime()) as unknown as T;
  if (Array.isArray(v)) return v.map(clone) as unknown as T;
  if (Prisma.Decimal.isDecimal(v)) return v;
  if (v !== null && typeof v === "object" && !Buffer.isBuffer(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = clone(x);
    return out as T;
  }
  return v;
}
function scalarEq(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : typeof a === "string" ? Date.parse(a) : NaN;
    const tb = b instanceof Date ? b.getTime() : typeof b === "string" ? Date.parse(b) : NaN;
    return ta === tb;
  }
  if (Prisma.Decimal.isDecimal(a) || Prisma.Decimal.isDecimal(b)) return Number(a) === Number(b);
  if (a !== null && typeof a === "object") return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}
function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  const na = a instanceof Date ? a.getTime() : Prisma.Decimal.isDecimal(a) ? Number(a) : a;
  const nb = b instanceof Date ? b.getTime() : Prisma.Decimal.isDecimal(b) ? Number(b) : b;
  return (na as number) < (nb as number) ? -1 : (na as number) > (nb as number) ? 1 : 0;
}

export function knownError(code: string, message: string, meta?: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "fake", meta });
}

/** A Prisma-like lazy promise: the work runs once, on first `then`. */
class LazyPromise<T> implements PromiseLike<T> {
  private p: Promise<T> | null = null;
  constructor(private readonly run: () => Promise<T>) {}
  private start(): Promise<T> { return (this.p ??= this.run()); }
  then<A = T, B = never>(ok?: ((v: T) => A | PromiseLike<A>) | null, no?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    return this.start().then(ok, no);
  }
  catch<B = never>(no?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<T | B> { return this.start().catch(no); }
  finally(f?: (() => void) | null): Promise<T> { return this.start().finally(f); }
  get [Symbol.toStringTag]() { return "PrismaPromise"; }
}

export class FakePrisma {
  readonly tables = new Map<string, Row[]>();
  readonly calls: FakeCall[] = [];
  readonly raw: { sql: string; values: unknown[] }[] = [];
  private hooks: { model: string; op: string; fn: FakeHook; once: boolean }[] = [];
  /** Handler for `$queryRaw` / `$queryRawUnsafe`. Unset ⇒ throws (no silent stub). */
  queryRaw: ((sql: string, values: unknown[]) => unknown) | null = null;
  private seq = 0;
  private partialUniques: { model: string; fields: string[]; where: Row; name: string }[] = [];

  // ── fixtures ────────────────────────────────────────────────────────────────
  table(model: string): Row[] {
    if (!MODELS.has(model)) throw new Error(`FakePrisma: unknown model ${model}`);
    let t = this.tables.get(model);
    if (!t) { t = []; this.tables.set(model, t); }
    return t;
  }
  /** Insert a fixture row with schema defaults applied. Returns the stored row. */
  seed(model: string, data: Row): Row { return this.createRow(model, data); }
  rows(model: string, where: Row = {}): Row[] { return this.table(model).filter((r) => this.match(model, r, where)); }
  one(model: string, where: Row): Row | undefined { return this.rows(model, where)[0]; }
  /** Intercept `model.op` (e.g. ("User","create")). Throw from `fn` to inject a fault. */
  on(model: string, op: string, fn: FakeHook, opts: { once?: boolean } = {}): void {
    this.hooks.push({ model, op, fn, once: !!opts.once });
  }
  clearHooks(): void { this.hooks = []; }
  /**
   * Declare a PARTIAL unique index that exists only in SQL (a migration), which
   * `Prisma.dmmf` cannot see — e.g. `CREATE UNIQUE INDEX … WHERE status IN (…)`.
   * The test must cite the migration it mirrors. Survives `reset()`.
   */
  partialUnique(model: string, fields: string[], where: Row, name: string): void {
    this.partialUniques.push({ model, fields, where, name });
  }
  callsTo(model: string, op?: string): FakeCall[] { return this.calls.filter((c) => c.model === model && (!op || c.op === op)); }
  reset(): void { this.tables.clear(); this.calls.length = 0; this.raw.length = 0; this.hooks = []; this.queryRaw = null; }

  // ── client surface ──────────────────────────────────────────────────────────
  delegate(model: string, tx?: TxState): Record<string, (args?: Record<string, unknown>) => LazyPromise<unknown>> {
    const ops = ["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "create", "createMany",
      "update", "updateMany", "upsert", "delete", "deleteMany", "count", "aggregate", "groupBy"];
    const out: Record<string, (args?: Record<string, unknown>) => LazyPromise<unknown>> = {};
    for (const op of ops) out[op] = (args = {}) => new LazyPromise(() => this.inTx(tx, () => this.exec(model, op, args)));
    return out;
  }

  /** The object a transaction callback receives: delegates + raw, but NO `$transaction` (as Prisma's ITX client). */
  txClient(tx?: TxState): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    for (const [d, m] of DELEGATE_TO_MODEL) c[d] = this.delegate(m, tx);
    c.$executeRaw = (s: TemplateStringsArray | string, ...v: unknown[]) => this.lazyInTx(tx, () => this.execRaw(s, v));
    c.$executeRawUnsafe = (s: string, ...v: unknown[]) => this.lazyInTx(tx, () => this.execRaw(s, v));
    c.$queryRaw = (s: TemplateStringsArray | string, ...v: unknown[]) => this.lazyInTx(tx, () => this.doQueryRaw(s, v));
    c.$queryRawUnsafe = (s: string, ...v: unknown[]) => this.lazyInTx(tx, () => this.doQueryRaw(s, v));
    return c;
  }

  /**
   * POSTGRES TRANSACTION-ABORT SEMANTICS. Inside an interactive transaction, once
   * any statement fails, every later statement on that transaction fails with
   * SQLSTATE 25P02 until it ends — catching the first error in application code
   * does NOT make the transaction usable again (no savepoints are taken). The
   * fake reproduces that, so code that "catches P2002 and reads on" inside a
   * transaction fails here exactly as it would against the database.
   */
  private async inTx<T>(tx: TxState | undefined, run: () => Promise<T>): Promise<T> {
    if (tx?.aborted) {
      throw Object.assign(new Error("current transaction is aborted, commands ignored until end of transaction block"),
        { code: "25P02", meta: { abortedBy: tx.abortedBy } });
    }
    try { return await run(); }
    catch (err) {
      if (tx) { tx.aborted = true; tx.abortedBy ??= (err as { code?: string }).code ?? String(err); }
      throw err;
    }
  }
  private lazyInTx<T>(tx: TxState | undefined, make: () => LazyPromise<T>): LazyPromise<T> {
    return new LazyPromise(() => this.inTx(tx, async () => make()));
  }

  async transaction(arg: unknown): Promise<unknown> {
    const snapshot = new Map([...this.tables].map(([k, v]) => [k, v.map(clone)]));
    try {
      if (Array.isArray(arg)) {
        const out: unknown[] = [];
        for (const p of arg) out.push(await p);
        return out;
      }
      return await (arg as (tx: unknown) => Promise<unknown>)(this.txClient({ aborted: false }));
    } catch (err) {
      this.tables.clear();
      for (const [k, v] of snapshot) this.tables.set(k, v);
      throw err;
    }
  }

  /** A template, a string, or a `Prisma.sql` object (its `.sql` text; values arrive via `valuesOf`). */
  private sqlOf(s: TemplateStringsArray | string | { sql: string }): string {
    if (typeof s === "string") return s;
    if (Array.isArray(s)) return s.join("?");
    return (s as { sql: string }).sql;
  }
  private valuesOf(s: unknown, values: unknown[]): unknown[] {
    return s && typeof s === "object" && !Array.isArray(s) && Array.isArray((s as { values?: unknown[] }).values) ? (s as { values: unknown[] }).values : values;
  }
  private execRaw(s: TemplateStringsArray | string, values: unknown[]): LazyPromise<number> {
    return new LazyPromise(async () => { this.raw.push({ sql: this.sqlOf(s), values }); return 1; });
  }
  private doQueryRaw(s: TemplateStringsArray | string, rawValues: unknown[]): LazyPromise<unknown> {
    return new LazyPromise(async () => {
      const sql = this.sqlOf(s);
      const values = this.valuesOf(s, rawValues);
      this.raw.push({ sql, values });
      if (!this.queryRaw) throw new Error(`FakePrisma: $queryRaw not configured (${sql.slice(0, 80)})`);
      return this.queryRaw(sql, values);
    });
  }

  // ── engine ──────────────────────────────────────────────────────────────────
  private async exec(model: string, op: string, args: Record<string, unknown>): Promise<unknown> {
    const call: FakeCall = { model, op, args: clone(args) };
    this.calls.push(call);
    for (const h of [...this.hooks]) {
      if (h.model === model && h.op === op) {
        if (h.once) this.hooks.splice(this.hooks.indexOf(h), 1);
        const r = await h.fn(args, call);
        if (r !== undefined) return r;
      }
    }
    const where = (args.where ?? {}) as Row;
    switch (op) {
      case "findUnique": case "findFirst": {
        const r = this.findMany(model, { ...args, take: 1 })[0];
        return r ?? null;
      }
      case "findUniqueOrThrow": case "findFirstOrThrow": {
        const r = this.findMany(model, { ...args, take: 1 })[0];
        if (!r) throw knownError("P2025", `No ${model} found`);
        return r;
      }
      case "findMany": return this.findMany(model, args);
      case "count": return this.rows(model, where).length;
      case "create": {
        const row = this.createRow(model, args.data as Row);
        return this.project(model, row, args);
      }
      case "createMany": {
        const list = (Array.isArray(args.data) ? args.data : [args.data]) as Row[];
        let count = 0;
        for (const d of list) {
          try { this.createRow(model, d); count++; }
          catch (e) { if (!(args.skipDuplicates && (e as { code?: string }).code === "P2002")) throw e; }
        }
        return { count };
      }
      case "update": {
        const target = this.rows(model, where)[0];
        if (!target) throw knownError("P2025", `An operation failed because it depends on one or more records that were required but not found. Record to update not found. (${model})`);
        this.applyUpdate(model, target, args.data as Row);
        return this.project(model, target, args);
      }
      case "updateMany": {
        const targets = this.rows(model, where);
        for (const t of targets) this.applyUpdate(model, t, args.data as Row);
        return { count: targets.length };
      }
      case "upsert": {
        const target = this.rows(model, where)[0];
        if (target) { this.applyUpdate(model, target, args.update as Row); return this.project(model, target, args); }
        const created = this.createRow(model, args.create as Row);
        return this.project(model, created, args);
      }
      case "delete": {
        const t = this.table(model);
        const target = t.find((r) => this.match(model, r, where));
        if (!target) throw knownError("P2025", `Record to delete does not exist. (${model})`);
        t.splice(t.indexOf(target), 1);
        return this.project(model, target, args);
      }
      case "deleteMany": {
        const t = this.table(model);
        const doomed = t.filter((r) => this.match(model, r, where));
        for (const d of doomed) t.splice(t.indexOf(d), 1);
        return { count: doomed.length };
      }
      default:
        throw new Error(`FakePrisma: ${model}.${op} is not supported — configure it with fake.on("${model}", "${op}", …)`);
    }
  }

  private fieldsOf(model: string): Map<string, Field> {
    return new Map(MODELS.get(model)!.fields.map((f) => [f.name, f]));
  }

  private uniqueSets(model: string): string[][] {
    const m = MODELS.get(model)!;
    const sets: string[][] = [];
    for (const f of m.fields) if (f.isId || f.isUnique) sets.push([f.name]);
    if (m.primaryKey) sets.push([...m.primaryKey.fields]);
    for (const u of m.uniqueIndexes) sets.push([...u.fields]);
    return sets;
  }

  private assertUnique(model: string, row: Row): void {
    for (const set of this.uniqueSets(model)) {
      if (set.some((k) => row[k] === null || row[k] === undefined)) continue;
      const clash = this.table(model).find((o) => o !== row && set.every((k) => scalarEq(o[k], row[k])));
      if (clash) throw knownError("P2002", `Unique constraint failed on the fields: (${set.map((s) => `\`${s}\``).join(",")})`, { target: set });
    }
    for (const p of this.partialUniques) {
      if (p.model !== model || !this.match(model, row, p.where)) continue;
      if (p.fields.some((k) => row[k] === null || row[k] === undefined)) continue;
      const clash = this.table(model).find((o) => o !== row && this.match(model, o, p.where) && p.fields.every((k) => scalarEq(o[k], row[k])));
      if (clash) throw knownError("P2002", `Unique constraint failed on the index: \`${p.name}\``, { target: p.name });
    }
  }

  private defaultFor(f: Field): unknown {
    const d = f.default as unknown;
    if (f.isUpdatedAt) return new Date();
    if (d === undefined || d === null) return f.isList ? [] : null;
    if (typeof d === "object" && !Array.isArray(d) && "name" in (d as object)) {
      const name = (d as { name: string }).name;
      if (name === "cuid") return fakeCuid();
      if (name === "uuid") return randomUUID();
      if (name === "now") return new Date();
      if (name === "autoincrement") return ++this.seq;
      if (name === "dbgenerated") return null;
      return null;
    }
    if (f.type === "Json" && typeof d === "string") { try { return JSON.parse(d); } catch { return d; } }
    if (f.type === "Decimal") return new Prisma.Decimal(d as string);
    if (f.type === "BigInt") return BigInt(d as string);
    return clone(d);
  }

  private createRow(model: string, data: Row): Row {
    const fields = this.fieldsOf(model);
    const row: Row = {};
    const deferred: [Field, unknown][] = [];
    for (const f of fields.values()) {
      if (f.kind === "object") continue;
      const v = data[f.name];
      row[f.name] = v === undefined ? this.defaultFor(f) : isNullType(v) ? null : clone(v);
    }
    for (const [k, v] of Object.entries(data)) {
      const f = fields.get(k);
      if (!f) throw new Error(`FakePrisma: ${model}.create — unknown field "${k}"`);
      if (f.kind !== "object" || v === undefined) continue;
      const rel = v as Row;
      if (f.relationFromFields && f.relationFromFields.length > 0) {
        // This side holds the FK: connect (or create) the target first.
        let target: Row | undefined;
        if (rel.connect) target = this.rows(f.type, rel.connect as Row)[0];
        else if (rel.create) target = this.createRow(f.type, rel.create as Row);
        if (!target) throw knownError("P2025", `${model}.${k}: connect target not found`);
        f.relationFromFields.forEach((ff, i) => { row[ff] = target![f.relationToFields![i]]; });
      } else {
        deferred.push([f, rel]);
      }
    }
    this.assertUnique(model, row);
    this.table(model).push(row);
    for (const [f, rel] of deferred) {
      const back = this.backRelation(model, f);
      const fk: Row = {};
      back.relationFromFields!.forEach((ff, i) => { fk[ff] = row[back.relationToFields![i]]; });
      const r = rel as Row;
      const creates = r.create ? (Array.isArray(r.create) ? r.create : [r.create]) as Row[] : [];
      const many = (r.createMany as { data?: Row[] } | undefined)?.data ?? [];
      for (const c of [...creates, ...many]) this.createRow(f.type, { ...c, ...fk });
      if (r.connect) {
        for (const w of (Array.isArray(r.connect) ? r.connect : [r.connect]) as Row[]) {
          const t = this.rows(f.type, w)[0];
          if (!t) throw knownError("P2025", `${model}.${f.name}: connect target not found`);
          Object.assign(t, fk);
        }
      }
    }
    return row;
  }

  private applyUpdate(model: string, row: Row, data: Row): void {
    const fields = this.fieldsOf(model);
    const before = clone(row);
    for (const [k, v] of Object.entries(data ?? {})) {
      if (v === undefined) continue;
      const f = fields.get(k);
      if (!f) throw new Error(`FakePrisma: ${model}.update — unknown field "${k}"`);
      if (f.kind === "object") {
        const rel = v as Row;
        if (f.relationFromFields?.length) {
          if (rel.connect) {
            const t = this.rows(f.type, rel.connect as Row)[0];
            if (!t) throw knownError("P2025", `${model}.${k}: connect target not found`);
            f.relationFromFields.forEach((ff, i) => { row[ff] = t[f.relationToFields![i]]; });
          } else if (rel.disconnect) {
            f.relationFromFields.forEach((ff) => { row[ff] = null; });
          } else {
            throw new Error(`FakePrisma: ${model}.update — nested op on "${k}" not supported`);
          }
        } else {
          throw new Error(`FakePrisma: ${model}.update — nested write on back-relation "${k}" not supported`);
        }
        continue;
      }
      if (isPlainObject(v) && f.type !== "Json") {
        const op = v as Record<string, unknown>;
        const cur = row[k] as number;
        if ("set" in op) row[k] = isNullType(op.set) ? null : clone(op.set);
        else if ("increment" in op) row[k] = Number(cur ?? 0) + Number(op.increment);
        else if ("decrement" in op) row[k] = Number(cur ?? 0) - Number(op.decrement);
        else if ("multiply" in op) row[k] = Number(cur ?? 0) * Number(op.multiply);
        else if ("divide" in op) row[k] = Number(cur ?? 0) / Number(op.divide);
        else if ("push" in op) row[k] = [...((row[k] as unknown[]) ?? []), ...(Array.isArray(op.push) ? op.push : [op.push])];
        else throw new Error(`FakePrisma: ${model}.update — unsupported op on "${k}": ${Object.keys(op).join(",")}`);
      } else {
        row[k] = isNullType(v) ? null : clone(v);
      }
    }
    for (const f of fields.values()) if (f.isUpdatedAt && !(f.name in (data ?? {}))) row[f.name] = new Date();
    try { this.assertUnique(model, row); }
    catch (e) { Object.assign(row, before); throw e; }
  }

  private backRelation(model: string, f: Field): Field {
    const target = MODELS.get(f.type)!;
    const back = target.fields.find((x) => x.relationName === f.relationName && x !== f && (x.relationFromFields?.length ?? 0) > 0);
    if (!back) throw new Error(`FakePrisma: no back relation for ${model}.${f.name}`);
    return back;
  }

  private related(model: string, row: Row, f: Field): Row[] {
    if (f.relationFromFields && f.relationFromFields.length > 0) {
      if (f.relationFromFields.some((ff) => row[ff] === null || row[ff] === undefined)) return [];
      return this.table(f.type).filter((t) => f.relationToFields!.every((tf, i) => scalarEq(t[tf], row[f.relationFromFields![i]])));
    }
    const back = this.backRelation(model, f);
    return this.table(f.type).filter((t) => back.relationFromFields!.every((ff, i) => scalarEq(t[ff], row[back.relationToFields![i]])));
  }

  match(model: string, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    const fields = this.fieldsOf(model);
    for (const [k, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (k === "AND") { if (!(Array.isArray(cond) ? cond : [cond]).every((c) => this.match(model, row, c as Row))) return false; continue; }
      if (k === "OR") { if (!(cond as Row[]).some((c) => this.match(model, row, c))) return false; continue; }
      if (k === "NOT") { if ((Array.isArray(cond) ? cond : [cond]).some((c) => this.match(model, row, c as Row))) return false; continue; }
      const f = fields.get(k);
      if (!f) {
        // A compound unique selector: `spaceId_userId: { spaceId, userId }`.
        if (isPlainObject(cond)) { if (!this.match(model, row, cond)) return false; continue; }
        throw new Error(`FakePrisma: ${model} where — unknown field "${k}"`);
      }
      if (f.kind === "object") {
        const rel = this.related(model, row, f);
        const c = cond as Row | null;
        if (f.isList) {
          if (c && "some" in c && !rel.some((r) => this.match(f.type, r, c.some as Row))) return false;
          if (c && "none" in c && rel.some((r) => this.match(f.type, r, c.none as Row))) return false;
          if (c && "every" in c && !rel.every((r) => this.match(f.type, r, c.every as Row))) return false;
        } else {
          const one = rel[0] ?? null;
          if (c === null) { if (one !== null) return false; continue; }
          if ("is" in c) { if (c.is === null ? one !== null : !(one && this.match(f.type, one, c.is as Row))) return false; continue; }
          if ("isNot" in c) { if (c.isNot === null ? one === null : (one && this.match(f.type, one, c.isNot as Row))) return false; continue; }
          if (!one || !this.match(f.type, one, c)) return false;
        }
        continue;
      }
      if (!this.matchScalar(row[k], cond)) return false;
    }
    return true;
  }

  private matchScalar(v: unknown, cond: unknown): boolean {
    if (cond === null) return v === null || v === undefined;
    if (!isPlainObject(cond)) return scalarEq(v ?? null, cond);
    let c = cond as Record<string, unknown>;
    if (Array.isArray(c.path)) {
      // A Json path filter: `{ path: ["identifier"], equals: "x" }`.
      const { path, ...rest } = c;
      v = (path as string[]).reduce<unknown>((o, k) => (o !== null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), v);
      if (v === undefined) return false;
      c = rest;
    }
    const ci = c.mode === "insensitive";
    const s = (x: unknown) => (ci ? String(x).toLowerCase() : String(x));
    for (const [op, arg] of Object.entries(c)) {
      if (arg === undefined || op === "mode") continue;
      switch (op) {
        case "equals": if (!this.matchScalar(v, arg)) return false; break;
        case "not": if (this.matchScalar(v, arg)) return false; break;
        case "in": if (!(arg as unknown[]).some((a) => scalarEq(v, a))) return false; break;
        case "notIn": if ((arg as unknown[]).some((a) => scalarEq(v, a))) return false; break;
        case "lt": if (v === null || v === undefined || !(cmp(v, arg) < 0)) return false; break;
        case "lte": if (v === null || v === undefined || !(cmp(v, arg) <= 0)) return false; break;
        case "gt": if (v === null || v === undefined || !(cmp(v, arg) > 0)) return false; break;
        case "gte": if (v === null || v === undefined || !(cmp(v, arg) >= 0)) return false; break;
        case "contains": if (typeof v !== "string" || !s(v).includes(s(arg))) return false; break;
        case "startsWith": if (typeof v !== "string" || !s(v).startsWith(s(arg))) return false; break;
        case "endsWith": if (typeof v !== "string" || !s(v).endsWith(s(arg))) return false; break;
        case "has": if (!Array.isArray(v) || !v.some((x) => scalarEq(x, arg))) return false; break;
        case "string_contains": if (typeof v !== "string" || !v.includes(String(arg))) return false; break;
        case "string_starts_with": if (typeof v !== "string" || !v.startsWith(String(arg))) return false; break;
        case "array_contains": if (!Array.isArray(v) || !(Array.isArray(arg) ? arg : [arg]).every((a) => v.some((x: unknown) => scalarEq(x, a)))) return false; break;
        default: throw new Error(`FakePrisma: unsupported scalar filter "${op}"`);
      }
    }
    return true;
  }

  private order(model: string, rows: Row[], orderBy: unknown): Row[] {
    if (!orderBy) return rows;
    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Record<string, unknown>[];
    return [...rows].sort((a, b) => {
      for (const o of keys) {
        for (const [k, dir] of Object.entries(o)) {
          const d = typeof dir === "string" ? dir : (dir as { sort: string }).sort;
          const r = cmp(a[k], b[k]);
          if (r !== 0) return d === "desc" ? -r : r;
        }
      }
      return 0;
    });
  }

  private findMany(model: string, args: Record<string, unknown>): Row[] {
    let rows = this.rows(model, args.where as Row);
    rows = this.order(model, rows, args.orderBy);
    if (typeof args.skip === "number") rows = rows.slice(args.skip);
    if (typeof args.take === "number") rows = args.take >= 0 ? rows.slice(0, args.take) : rows.slice(args.take);
    return rows.map((r) => this.project(model, r, args));
  }

  private project(model: string, row: Row, args: Record<string, unknown>): Row {
    const fields = this.fieldsOf(model);
    const sel = args.select as Record<string, unknown> | undefined;
    const inc = args.include as Record<string, unknown> | undefined;
    const out: Row = {};
    const relation = (name: string, spec: unknown) => {
      const f = fields.get(name);
      if (!f || f.kind !== "object") throw new Error(`FakePrisma: ${model} select — "${name}" is not a relation`);
      const nested = (spec === true ? {} : spec) as Record<string, unknown>;
      if (f.isList) {
        let rel = this.related(model, row, f).filter((r) => this.match(f.type, r, nested.where as Row));
        rel = this.order(f.type, rel, nested.orderBy);
        if (typeof nested.take === "number") rel = rel.slice(0, nested.take);
        return rel.map((r) => this.project(f.type, r, nested));
      }
      const one = this.related(model, row, f)[0];
      return one ? this.project(f.type, one, nested) : null;
    };
    if (sel) {
      for (const [k, v] of Object.entries(sel)) {
        if (!v) continue;
        if (k === "_count") {
          const counts: Row = {};
          const which = (v as { select?: Record<string, unknown> }).select ?? {};
          for (const [rk, rv] of Object.entries(which)) {
            if (!rv) continue;
            const f = fields.get(rk)!;
            const w = rv === true ? undefined : (rv as { where?: Row }).where;
            counts[rk] = this.related(model, row, f).filter((r) => this.match(f.type, r, w)).length;
          }
          out._count = counts;
          continue;
        }
        const f = fields.get(k);
        if (!f) throw new Error(`FakePrisma: ${model} select — unknown field "${k}"`);
        out[k] = f.kind === "object" ? relation(k, v) : clone(row[k]);
      }
      return out;
    }
    for (const f of fields.values()) if (f.kind !== "object") out[f.name] = clone(row[f.name]);
    if (inc) for (const [k, v] of Object.entries(inc)) if (v) out[k] = relation(k, v);
    return out;
  }
}

/**
 * Put `fake` behind the process's Prisma client(s). Returns the fake for chaining.
 * Throws if a distinct role client exists (a role URL was set) — a test must
 * never be able to reach a real database through a client this did not replace.
 *
 * ⚠️ HOW THE CLIENT IS FOUND. Not by importing `db` from "@/lib/db": that is the
 * migration-principal import scripts/audit-db-authority.ts ratchets for runtime
 * files, and this file — under lib/, not named *.test.ts — is "runtime" to that
 * audit even though it never queries anything. Instead lib/db is loaded (via
 * tenant-context) and the singletons are read from the globalThis registry
 * lib/db.ts itself maintains outside production (`prisma`, `fmTenant`, `fmAuth`,
 * `fmSystem`). A null role client there is exactly lib/db's "falls back to db"
 * case, so asserting all three are null proves every authority is the one
 * object replaced below.
 */
export async function installFakePrisma(fake = new FakePrisma()): Promise<FakePrisma> {
  for (const v of ["DATABASE_URL_APP", "DATABASE_URL_AUTH", "DATABASE_URL_SYSTEM"]) {
    if (process.env[v]) throw new Error(`installFakePrisma: ${v} is set — refusing (a real role client would bypass the fake)`);
  }
  if (process.env.NODE_ENV === "production") throw new Error("installFakePrisma: NODE_ENV=production — refusing");
  await import("@/lib/db/tenant-context"); // loads lib/db, which registers its clients on globalThis
  const registry = globalThis as unknown as { prisma?: unknown; fmTenant?: unknown; fmAuth?: unknown; fmSystem?: unknown };
  if (!registry.prisma) throw new Error("installFakePrisma: lib/db did not register its client");
  if (registry.fmTenant || registry.fmAuth || registry.fmSystem) {
    throw new Error("installFakePrisma: role clients are distinct from the shared client — refusing");
  }
  const target = registry.prisma as Record<string, unknown>;
  const define = (k: string, value: unknown) => Object.defineProperty(target, k, { value, configurable: true, writable: true });
  for (const [d, m] of DELEGATE_TO_MODEL) define(d, fake.delegate(m));
  const tx = fake.txClient();
  for (const k of ["$executeRaw", "$executeRawUnsafe", "$queryRaw", "$queryRawUnsafe"]) define(k, tx[k]);
  define("$transaction", (arg: unknown) => fake.transaction(arg));
  define("$connect", async () => undefined);
  define("$disconnect", async () => undefined);
  return fake;
}
