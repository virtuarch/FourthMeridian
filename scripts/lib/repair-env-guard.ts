/**
 * scripts/lib/repair-env-guard.ts — the PURE environment gate for historical
 * repair scripts that WRITE (first user: scripts/repair-transfer-debt-payment.ts).
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * A DRY RUN reads. With no --env it is always allowed; with an --env it must
 * pass the same TARGET proof an apply would (so a dry run labelled
 * `--env=production` provably read Production, and its count can be trusted as
 * the `--expect` of the apply that follows). An APPLY must name its environment
 * and the connection must PROVE it is that environment:
 *
 *   --env=local       the target is a loopback host (lib/db/target-identity "local").
 *   --env=preview     the target is a Supabase project (direct host or pooler user)
 *                     whose project ref is NOT the Production ref. The Production
 *                     ref is not in the repository (it is an operator fact), so it
 *                     must be supplied in FM_PRODUCTION_DB_REF — and when it is not,
 *                     the gate REFUSES: "I cannot tell" is not "it is not Production".
 *   --env=production  OWNER-AUTHORIZED ONLY. Every one of:
 *                       · FM_PRODUCTION_DB_REF is set and the target's project ref
 *                         IS that ref (positive proof, the mirror of preview);
 *                       · --i-have-owner-approval=<ticket> names the owner's
 *                         written authorization (a ticket / issue id, 3–80 chars
 *                         of [A-Za-z0-9._:#/-], no URL); it is recorded in the report;
 *                       · --expect=<n> states the candidate count the operator saw
 *                         in the read-only Production dry run. The repair refuses
 *                         to write when the plan's count differs (checked by the
 *                         caller, after planning, before the first write).
 *   anything else     refused — including no --env at all.
 *
 * Plus, for every apply:
 *   · VERCEL_ENV=production refuses unless --env=production (a Production
 *     runtime must never be mistaken for a Preview/local run).
 *   · DATABASE_URL and DIRECT_URL, when both are set, must be provably ONE logical
 *     database (`targetRelationship` === SAME) — the FM-AUDIT-002 class: never
 *     check A and write B.
 *   · FM_DB_GUARD=clone-only, when armed, keeps its meaning (`urlDatabaseRefusal`)
 *     — which also refuses every Production apply, by construction.
 *   · --i-have-owner-approval outside --env=production is refused, so an operator
 *     who believes they are running the authorized Production apply but typed
 *     another env learns it before anything is read.
 *
 * ⚠️ PURE and SECRET-FREE. It never returns or prints a URL, a host, a user, a
 * project ref or a password; refusals name the RULE, never the value. The only
 * target fact it returns is `targetHash` — a truncated sha256 of the logical
 * database identity — which binds a restore file to the database it came from.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { databaseIdentity, targetRelationship } from "@/lib/db/target-identity";
import { urlDatabaseRefusal } from "@/lib/db/live-guard";

export type RepairEnv = "local" | "preview" | "production";

export interface RepairEnvGuardInput {
  apply: boolean;
  /** The raw `--env=` value, or null when absent. */
  envFlag: string | null;
  databaseUrl: string | undefined;
  directUrl: string | undefined;
  /** FM_PRODUCTION_DB_REF — the Production Supabase project ref. Never printed. */
  productionRef: string | undefined;
  vercelEnv: string | undefined;
  /** The process env, for the FM_DB_GUARD clone-only check. */
  env: NodeJS.ProcessEnv;
  /** The raw `--i-have-owner-approval=` value, or null when absent. */
  approvalTicket?: string | null;
  /** The raw `--expect=` value, or null when absent. */
  expect?: string | null;
}

export interface RepairEnvGuardDecision {
  ok: boolean;
  mode: "DRY_RUN" | "APPLY";
  env: RepairEnv | null;
  /** Why it was refused. Never contains a URL, host, user, ref or secret. */
  reasons: string[];
  /** sha256(logical database identity), 16 hex — null when the target cannot be identified. */
  targetHash: string | null;
  /** The validated owner-approval ticket (production only). */
  approvalTicket: string | null;
  /** The validated expected candidate count, when given. */
  expect: number | null;
}

const SUPABASE_KEY = /^supabase:([a-z0-9]+)\//;
/** A ticket / issue id: short, printable, no whitespace, no URL scheme. */
export const APPROVAL_TICKET = /^(?!.*:\/\/)[A-Za-z0-9][A-Za-z0-9._:#/-]{2,79}$/;

export const hashTarget = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 16);

function parseExpect(raw: string | null | undefined): number | null | "INVALID" {
  if (raw == null) return null;
  return /^(0|[1-9][0-9]{0,6})$/.test(raw) ? Number(raw) : "INVALID";
}

export function decideRepairEnvGuard(i: RepairEnvGuardInput): RepairEnvGuardDecision {
  const env: RepairEnv | null =
    i.envFlag === "local" || i.envFlag === "preview" || i.envFlag === "production" ? i.envFlag : null;
  const mode = i.apply ? "APPLY" : "DRY_RUN";
  const id = databaseIdentity(i.databaseUrl);
  const targetHash = id ? hashTarget(id.key) : null;
  const expectParsed = parseExpect(i.expect);
  const expect = expectParsed === "INVALID" ? null : expectParsed;
  const ticketRaw = i.approvalTicket ?? null;
  const approvalTicket = env === "production" && ticketRaw != null && APPROVAL_TICKET.test(ticketRaw) ? ticketRaw : null;

  const refuse = (...reasons: string[]): RepairEnvGuardDecision =>
    ({ ok: false, mode, env, reasons, targetHash, approvalTicket, expect });
  const allow = (): RepairEnvGuardDecision =>
    ({ ok: true, mode, env, reasons: [], targetHash, approvalTicket, expect });

  if (expectParsed === "INVALID") return refuse("--expect must be a non-negative whole number.");
  if (ticketRaw != null && i.envFlag !== "production") {
    return refuse("--i-have-owner-approval is only meaningful with --env=production; refusing so the environment is never ambiguous.");
  }

  // A dry run with no --env reads whatever it is pointed at, as before.
  if (!i.apply && i.envFlag == null) return allow();

  if (env === null) {
    return refuse(
      i.envFlag == null
        ? "--apply requires an explicit --env=preview, --env=local or (owner-authorized) --env=production."
        : "--env must be exactly `local`, `preview` or `production`.",
    );
  }
  if (i.apply && env !== "production" && (i.vercelEnv ?? "").toLowerCase() === "production") {
    return refuse("VERCEL_ENV is production but --env is not — refusing to mistake a Production runtime for another environment.");
  }

  if (!id) return refuse("DATABASE_URL is unset or unparseable, so the target cannot be identified.");
  if (i.directUrl && targetRelationship(i.databaseUrl, i.directUrl) !== "SAME") {
    return refuse("DATABASE_URL and DIRECT_URL are not provably the same database — refusing to check one and write the other.");
  }
  if (urlDatabaseRefusal(i.databaseUrl, i.env)) return refuse("FM_DB_GUARD=clone-only is armed and the target is not a clone.");

  if (env === "local") {
    return id.family === "local" ? allow() : refuse("--env=local requires a loopback database host.");
  }

  const ref = SUPABASE_KEY.exec(id.key)?.[1] ?? null;
  if (!ref) return refuse(`--env=${env} requires a Supabase target (direct host or pooler user) whose project can be identified.`);
  const prod = (i.productionRef ?? "").trim().toLowerCase();
  if (prod === "") {
    return refuse(`FM_PRODUCTION_DB_REF is not set, so the target cannot be proven ${env === "production" ? "to be" : "to be outside"} the Production project.`);
  }

  if (env === "preview") {
    return ref === prod
      ? refuse("The target IS the Production project. --env=preview never writes Production; an authorized Production run uses --env=production.")
      : allow();
  }

  // production
  if (ref !== prod) return refuse("--env=production but the target is NOT the Production project (FM_PRODUCTION_DB_REF).");
  if (!i.apply) return allow();
  const reasons: string[] = [];
  if (ticketRaw == null) {
    reasons.push("--env=production --apply requires --i-have-owner-approval=<ticket> naming the owner's written authorization.");
  } else if (approvalTicket == null) {
    reasons.push("--i-have-owner-approval must be a ticket id: 3–80 characters of letters, digits and . _ : # / -");
  }
  if (expect == null) {
    reasons.push("--env=production --apply requires --expect=<n>: the candidate count from the read-only Production dry run.");
  }
  return reasons.length ? refuse(...reasons) : allow();
}

/**
 * Where a RESTORE file (raw row ids) may be written: outside the repository, or
 * under its git-ignored `tmp/`. Returns a refusal, or null. Pure.
 */
export function restoreLocationRefusal(outPath: string, repoRoot: string): string | null {
  const abs = path.resolve(repoRoot, outPath);
  const rel = path.relative(path.resolve(repoRoot), abs);
  const insideRepo = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  if (!insideRepo) return null;
  return rel.split(path.sep)[0] === "tmp"
    ? null
    : "--out must be outside the repository or under its git-ignored tmp/ — the restore file holds raw row ids and must never be committed.";
}

/**
 * Strip connection details from a free-text error before it is printed. Prisma's
 * connection errors name the server (`Can't reach database server at …`); the
 * repair promises never to print a host, user or URL.
 */
export function redactConnectionDetails(text: string, extraSecrets: readonly (string | undefined)[] = []): string {
  let out = text
    .replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, "<redacted-url>")
    .replace(/[A-Za-z0-9.-]+\.(?:supabase\.(?:co|com)|pooler\.supabase\.com|amazonaws\.com)(?::\d+)?/gi, "<redacted-host>")
    .replace(/\bpostgres\.[a-z0-9]{8,}\b/gi, "<redacted-user>");
  for (const s of extraSecrets) {
    if (s && s.length >= 4) out = out.split(s).join("<redacted>");
  }
  return out;
}
