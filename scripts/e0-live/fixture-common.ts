/**
 * scripts/e0-live/fixture-common.ts — the PURE guard, tag, manifest and drift
 * rules of the E0-LIVE Preview fixture (design §3; S2 rulings 09ec R-1..R-7).
 *
 * ⚠️ PURE: no filesystem, no network, no database, no Prisma. Node builtins
 * `node:crypto` (hashing) and `node:path` only, plus the repo's own pure
 * target-identity / repair-env-guard helpers. Refusals name the RULE, never a
 * URL, host, user, project ref or secret. Unit-tested by fixture-common.test.ts.
 *
 * The seed / teardown CLIs (seed.ts, teardown.ts) call decideE0LiveGuard() FIRST,
 * before any repo module that can reach a database is loaded.
 */

import { createHash } from "node:crypto";
import { databaseIdentity } from "@/lib/db/target-identity";
import { decideRepairEnvGuard } from "../lib/repair-env-guard";

// ── Tag and nonce (design §3.2) ──────────────────────────────────────────────

/** 8 lower-case hex characters, fresh per run day. */
export const NONCE_RE = /^[0-9a-f]{8}$/;
/** `fm-e0-live-<YYYYMMDD>-<nonce>` */
export const TAG_RE = /^fm-e0-live-(\d{8})-([0-9a-f]{8})$/;

export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10).replace(/-/g, "");
}

export function makeTag(at: Date, nonce: string): string {
  if (!NONCE_RE.test(nonce)) throw new Error("nonce must be 8 lower-case hex characters");
  return `fm-e0-live-${utcDay(at)}-${nonce}`;
}

export function parseTag(tag: string): { day: string; nonce: string } | null {
  const m = TAG_RE.exec(tag);
  return m ? { day: m[1], nonce: m[2] } : null;
}

/** A nonce from random bytes (the CLI passes crypto.randomBytes(4)). */
export function nonceFromBytes(bytes: Uint8Array): string {
  if (bytes.length < 4) throw new Error("need at least 4 random bytes for a nonce");
  return Buffer.from(bytes.subarray(0, 4)).toString("hex");
}

/** The same-day teardown deadline: the tag's UTC day at 23:59:59Z. */
export function teardownDeadline(tag: string): string {
  const p = parseTag(tag);
  if (!p) throw new Error("not an e0-live tag");
  return `${p.day.slice(0, 4)}-${p.day.slice(4, 6)}-${p.day.slice(6, 8)}T23:59:59Z`;
}

// ── Guard (design §3.1: Preview ref required, Production ref refused) ────────

/** DB URLs that must NOT be exported in the parent shell (the env file is the only source). */
export const DB_ENV_KEYS = ["DATABASE_URL", "DIRECT_URL", "DATABASE_URL_APP", "DATABASE_URL_AUTH", "DATABASE_URL_SYSTEM"] as const;
const SUPABASE_KEY = /^supabase:([a-z0-9]+)\//;
const REF_RE = /^[a-z0-9]{15,40}$/;

export interface E0LiveGuardInput {
  /** The process environment (exported variables). */
  exported: NodeJS.ProcessEnv;
  /** The parsed Preview env file, or null when it is absent. */
  envFile: Record<string, string> | null;
  /** The env file's permission bits (stat.mode & 0o777), or null when absent. */
  envFileMode: number | null;
}

export type E0LiveGuardDecision =
  | { ok: true; directUrl: string; targetHash: string | null }
  | { ok: false; reasons: string[] };

/**
 * The whole decision about WHICH database, from strings only:
 *   1. no DB URL exported in the shell (an exported DATABASE_URL beats any env file);
 *   2. VERCEL_ENV=production (shell or file) refuses;
 *   3. the env file exists and is 0600 (no group/other bits);
 *   4. FM_PREVIEW_DB_REF and FM_PRODUCTION_DB_REF are set, well-formed and distinct
 *      (operator facts — never in the repository);
 *   5. DIRECT_URL and DATABASE_URL both identify the PREVIEW project (positive proof)
 *      and neither string contains the Production ref anywhere;
 *   6. DIRECT_URL is the session port 5432 (one interactive transaction);
 *   7. the repo's repair-env guard agrees (--env=preview, apply): same logical
 *      database for both URLs, FM_DB_GUARD respected, not the Production project.
 */
export function decideE0LiveGuard(i: E0LiveGuardInput): E0LiveGuardDecision {
  const reasons: string[] = [];
  const refuse = (...r: string[]): E0LiveGuardDecision => ({ ok: false, reasons: [...reasons, ...r] });

  for (const k of DB_ENV_KEYS) {
    if (i.exported[k]) reasons.push(`${k} is exported in this shell; unset it (the Preview env file is the only source).`);
  }
  if ((i.exported.VERCEL_ENV ?? "").toLowerCase() === "production") reasons.push("VERCEL_ENV is production — the E0-LIVE fixture is Preview-only.");
  if (reasons.length) return refuse();

  if (!i.envFile || i.envFileMode === null) return refuse("the Preview env file was not found (FM_E0_LIVE_ENV_FILE).");
  if ((i.envFileMode & 0o077) !== 0) return refuse("the Preview env file must be mode 0600.");
  if ((i.envFile.VERCEL_ENV ?? "").toLowerCase() === "production") return refuse("the env file sets VERCEL_ENV=production — refused.");

  const previewRef = (i.exported.FM_PREVIEW_DB_REF ?? "").trim().toLowerCase();
  const prodRef = (i.exported.FM_PRODUCTION_DB_REF ?? "").trim().toLowerCase();
  if (!REF_RE.test(previewRef)) return refuse("FM_PREVIEW_DB_REF is not set (or malformed), so the target cannot be proven to be Preview.");
  if (!REF_RE.test(prodRef)) return refuse("FM_PRODUCTION_DB_REF is not set (or malformed), so the target cannot be proven outside Production.");
  if (previewRef === prodRef) return refuse("FM_PREVIEW_DB_REF equals FM_PRODUCTION_DB_REF — refused.");

  const directUrl = i.envFile.DIRECT_URL ?? "";
  const pooledUrl = i.envFile.DATABASE_URL ?? "";
  for (const [name, url] of [["DIRECT_URL", directUrl], ["DATABASE_URL", pooledUrl]] as const) {
    if (!url) return refuse(`${name} is missing from the Preview env file.`);
    if (url.toLowerCase().includes(prodRef)) return refuse(`${name} names the PRODUCTION project.`);
    const id = databaseIdentity(url);
    const ref = id ? SUPABASE_KEY.exec(id.key)?.[1] ?? null : null;
    if (ref !== previewRef) return refuse(`${name} does not identify the Preview project.`);
  }
  let port = "";
  try { port = new URL(directUrl).port; } catch { return refuse("DIRECT_URL is not a parseable URL."); }
  if (port !== "5432") return refuse("DIRECT_URL is not the session-mode port 5432.");

  const gate = decideRepairEnvGuard({
    apply: true, envFlag: "preview", databaseUrl: directUrl, directUrl: pooledUrl,
    productionRef: prodRef, vercelEnv: i.exported.VERCEL_ENV, env: i.exported,
  });
  if (!gate.ok) return refuse(...gate.reasons);
  return { ok: true, directUrl, targetHash: gate.targetHash };
}

// ── Repo basis (design §3.4: worktree SHA = Preview deployment SHA; migration ledger) ─

export interface RepoBasisInput {
  headSha: string;
  /** --expect-sha: the Preview deployment's githubCommitSha, read by the operator. */
  expectSha: string | null;
  /** `git status --porcelain --untracked-files=no` is non-empty. */
  dirty: boolean;
}

export function repoBasisRefusal(i: RepoBasisInput): string | null {
  if (!/^[0-9a-f]{40}$/.test(i.headSha)) return "the worktree HEAD is not a full commit SHA.";
  if (i.expectSha === null) return "--expect-sha=<40-hex Preview deployment SHA> is required.";
  if (!/^[0-9a-f]{40}$/.test(i.expectSha)) return "--expect-sha must be a full 40-hex commit SHA.";
  if (i.headSha !== i.expectSha) return "the worktree HEAD is not the Preview deployment SHA (--expect-sha).";
  if (i.dirty) return "the worktree has uncommitted changes to tracked files.";
  return null;
}

/** The newest applied migration on the target must equal the worktree's newest migration directory. */
export function migrationBasisRefusal(localNewest: string | null, dbNewest: string | null): string | null {
  if (!localNewest) return "the worktree has no prisma migrations.";
  if (!dbNewest) return "the target has no applied migration ledger.";
  return localNewest === dbNewest ? null : "the target's newest applied migration differs from the worktree's newest migration.";
}

// ── Manifest (ids + drift hashes; 0600, never committed) ─────────────────────

/**
 * Every table the fixture writes (AuditLog aside — append-only, kept, R-6), in
 * teardown deletion order: children first, users last. No SyncIssueEvent: scripts/
 * may not write or delete it (the incident-boundary census); SyncIssueOccurrence
 * rows cascade with their SyncIssue.
 */
export const MANIFEST_TABLES = [
  "syncIssue", "accountConnection", "financialAccount", "plaidItem", "connection",
  "userSession", "betaAccessRequest", "customerPolicyAssignment", "user",
] as const;
export type ManifestTable = (typeof MANIFEST_TABLES)[number];

export interface E0LiveManifest {
  kind: "e0-live-fixture-manifest";
  tag: string;
  createdAt: string;
  repoSha: string;
  targetHash: string | null;
  teardownDeadline: string;
  ids: Record<ManifestTable, string[]>;
  /** sha256 of each row's fixture-owned columns at seed time, by table then id (hashes only). */
  hashes: Partial<Record<ManifestTable, Record<string, string>>>;
  /** AuditLog rows the seed wrote (append-only; NOT deleted by teardown — disclosed, R-6). */
  auditLogIds: string[];
}

export function emptyIds(): Record<ManifestTable, string[]> {
  return Object.fromEntries(MANIFEST_TABLES.map((t) => [t, [] as string[]])) as Record<ManifestTable, string[]>;
}

export function parseManifest(raw: unknown, expectTag: string): E0LiveManifest {
  const m = raw as Partial<E0LiveManifest> | null;
  if (!m || m.kind !== "e0-live-fixture-manifest") throw new Error("not an e0-live fixture manifest");
  if (m.tag !== expectTag || !parseTag(m.tag)) throw new Error("manifest tag differs from --tag");
  if (!m.ids || typeof m.ids !== "object") throw new Error("manifest has no ids");
  for (const t of MANIFEST_TABLES) {
    const v = (m.ids as Record<string, unknown>)[t];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(x))) {
      throw new Error(`manifest ids.${t} is not a list of ids`);
    }
  }
  if (!Array.isArray(m.auditLogIds)) throw new Error("manifest has no auditLogIds list");
  return m as E0LiveManifest;
}

export interface TagManifestMatch {
  ok: boolean;
  /** Per table: ids found by tag that the manifest does not list. */
  extras: Partial<Record<ManifestTable, number>>;
  /** Per table: manifest ids that the tag discovery did not find. */
  missing: Partial<Record<ManifestTable, number>>;
}

/**
 * Teardown deletes tag ∩ manifest and REFUSES on any mismatch: a row found by
 * tag that the manifest lacks (an extra), or a manifest row the tag no longer
 * finds (missing), in any table.
 */
export function matchTagToManifest(byTag: Record<ManifestTable, readonly string[]>, manifest: E0LiveManifest): TagManifestMatch {
  const extras: Partial<Record<ManifestTable, number>> = {};
  const missing: Partial<Record<ManifestTable, number>> = {};
  for (const t of MANIFEST_TABLES) {
    const found = new Set(byTag[t] ?? []);
    const listed = new Set(manifest.ids[t] ?? []);
    const ex = [...found].filter((id) => !listed.has(id)).length;
    const mi = [...listed].filter((id) => !found.has(id)).length;
    if (ex) extras[t] = ex;
    if (mi) missing[t] = mi;
  }
  return { ok: Object.keys(extras).length === 0 && Object.keys(missing).length === 0, extras, missing };
}

// ── Where the tag lives (design §3.2) — pure `where` fragments ───────────────

/** The tagged rows of each table: by tag where a column carries it, else by a tagged owner. */
export function tagWhere(tag: string) {
  if (!parseTag(tag)) throw new Error("not an e0-live tag");
  const domain = `@${tag}.invalid`;
  return {
    user: { AND: [{ email: { endsWith: domain } }, { username: { startsWith: `${tag}-` } }] },
    plaidItem: { externalItemId: { startsWith: `${tag}:` } },
    connection: { externalConnectionId: { startsWith: `${tag}:` } },
    syncIssue: { incidentKey: { endsWith: `::${tag}` } },
    userSession: { sessionToken: { startsWith: `${tag}:` } },
    betaAccessRequest: { email: { endsWith: domain } },
  };
}

/** Any row of ANY e0-live tag of the given UTC day (seed refuses to stack a second fixture on a day). */
export function dayPrefix(day: string): string {
  if (!/^\d{8}$/.test(day)) throw new Error("day must be YYYYMMDD");
  return `fm-e0-live-${day}-`;
}

/** The fixture-owned columns a scheduled job or an operator could change (hashed for the drift check). */
export const DRIFT_SELECT = {
  user: { id: true, email: true, role: true, deactivatedAt: true, deletionRequestedAt: true },
  plaidItem: { id: true, status: true, errorCode: true, lastSyncedAt: true, syncIncompleteAt: true, completedSyncCount: true, cursor: true },
  connection: { id: true, status: true, errorCode: true, lastSyncedAt: true, cursor: true },
  financialAccount: { id: true, name: true, syncStatus: true, deletedAt: true, walletChain: true },
  syncIssue: { id: true, resolved: true, lifecycleState: true, lastOccurredAt: true, acknowledgedAt: true, resolvedAt: true, causeStatus: true, causeCode: true },
} as const;
export type DriftTable = keyof typeof DRIFT_SELECT;

// ── Drift hashes (design §3.1) ───────────────────────────────────────────────

/** Deterministic JSON (sorted keys; Dates as ISO; bigint as string). */
export function stableJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function rowHash(row: Record<string, unknown>): string {
  return createHash("sha256").update(stableJson(row)).digest("hex");
}

/** Rows whose current hash differs from the seed-time hash (or vanished): counts by table. */
export function driftCounts(
  seeded: Partial<Record<ManifestTable, Record<string, string>>>,
  current: Partial<Record<ManifestTable, Record<string, string>>>,
): Partial<Record<ManifestTable, number>> {
  const out: Partial<Record<ManifestTable, number>> = {};
  for (const t of MANIFEST_TABLES) {
    const s = seeded[t] ?? {};
    const c = current[t] ?? {};
    const n = Object.keys(s).filter((id) => c[id] !== s[id]).length;
    if (n) out[t] = n;
  }
  return out;
}
