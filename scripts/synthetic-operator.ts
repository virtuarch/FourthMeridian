/**
 * scripts/synthetic-operator.ts — provision / revoke / clean up ONE synthetic,
 * Preview-only Platform operator for acceptance testing — or, under
 * `--profile=e0-live`, the fixed five-operator E0-LIVE roster.
 *
 * Owner-authorized (a dedicated, fabricated Preview operator); method approved
 * by S2. The rules live in scripts/lib/synthetic-operator.core.ts (pure,
 * unit-tested) and are pinned by scripts/synthetic-operator.test.ts.
 *
 *   npm run ops:synthetic-operator -- --env=<preview|local> --provision
 *   npm run ops:synthetic-operator -- --env=<preview|local> --revoke-area=GROWTH_REVENUE
 *   npm run ops:synthetic-operator -- --env=<preview|local> --cleanup --record=<private dir>
 *
 *   E0-LIVE (S2 ruling R-1; Preview ONLY):
 *   npm run ops:synthetic-operator -- --profile=e0-live --env=preview --provision --operators=<role,…>   (only the roles the run uses)
 *   npm run ops:synthetic-operator -- --profile=e0-live --env=preview --revoke-area=CUSTOMER_SUCCESS --operator=rev [--await-signal]
 *   npm run ops:synthetic-operator -- --profile=e0-live --env=preview --regrant-area=CUSTOMER_SUCCESS --operator=rev
 *   npm run ops:synthetic-operator -- --profile=e0-live --env=preview --cleanup --record=<private e0l dir>
 *
 *   E0-LIVE suite R revoking actor (S2 09ic; owner-approved; Preview ONLY; immediately before / after suite R):
 *   npm run ops:synthetic-operator -- --profile=e0-live-sa --env=preview --provision --roster=<same-day e0l dir>
 *   npm run ops:synthetic-operator -- --profile=e0-live-sa --env=preview --cleanup --record=<private e0lsa dir>
 *
 * PROVISION — one User (role USER, "Synthetic Operator", an @example.test
 * address, email pre-verified, NO TOTP) created in the SAME shape the
 * registration route creates (app/api/auth/register/route.ts: Personal Space
 * from the `personal` template, OWNER membership, preferredSpaceId, AiAgent,
 * default CustomerPolicyAssignment, REGISTER audit row) — no other Space, no
 * provider connection, no customer data. Then the allowlisted grants
 * (PLATFORM_OPS READ, GROWTH_REVENUE READ), each with its canonical
 * PLATFORM_GRANT_CREATED AuditLog row, all in ONE transaction. Password: 32
 * random characters, bcryptjs cost 12 (exactly the registration route's
 * `bcrypt.hash(password, 12)` — the app has no shared hash helper). TOTP: NOT
 * provisioned here — a seed sealed with this process's ENCRYPTION_KEY would not
 * open under the target deployment's key (Preview's is Vercel Sensitive, never
 * pulled); where operator 2FA is enforced the operator enrols through the app's
 * own /api/user/totp setup at first sign-in. The password goes ONLY to
 * ~/FourthMeridian-private/synthetic-operator-<UTC stamp>/credentials.json
 * (umask 077, dir 0700, file 0600); stdout carries PASS lines, the private
 * directory and the cleanup deadline — never a secret, id, host or ref.
 *
 * REVOKE-AREA — flips one allowlisted grant ACTIVE → REVOKED with its canonical
 * PLATFORM_GRANT_REVOKED AuditLog row in one transaction (the lost-area case).
 *
 * CLEANUP — (1) revoke every remaining ACTIVE grant, audited; (2) delete the
 * user through the app's ACCOUNT-DELETION path: the deletion REQUEST stamp
 * (deletionRequestedAt / deletionScheduledAt / deactivatedAt, as
 * app/api/user/delete does, but with a ZERO grace window — the synthetic
 * account has a hard deadline and nobody to cancel it) plus its
 * ACCOUNT_DELETION_REQUESTED audit row, then purgeUser() — the SAME function
 * jobs/process-deletions.ts calls per user (sessions revoked, Personal Space,
 * TOTP, grants, conversations and messages cascade; one ACCOUNT_DELETED audit
 * row). purgeUser's after-commit e-mail and Plaid revocation are INJECTED as
 * refusing no-ops: this script sends nothing and calls no provider; (3) print
 * the Preview purge-dispatch instruction (not run); (4) shred every secret file
 * (credentials.json, and totp.json if the operator saved the enrolment there);
 * (5) write cleanup.json (counts only) beside it at 0600.
 *
 * E0-LIVE PROFILE (--profile=e0-live; Preview ONLY — --env=local is refused):
 *   · PROVISION — the FIXED roster (core E0_LIVE_ROSTER): ops (PLATFORM_OPS
 *     READ), cs1–cs3 (CUSTOMER_SUCCESS READ), rev (PLATFORM_OPS +
 *     CUSTOMER_SUCCESS READ), each at e0l-<role>@example.test, each in the SAME
 *     registration shape and with the SAME audited grant rows as above — all
 *     five in ONE transaction (all or nothing). Secrets and records go to
 *     ~/FourthMeridian-private/synthetic-operator-e0l-<UTC stamp>/<role>/ (one
 *     0700 sub-directory per operator; files 0600). Deadline: the provision
 *     UTC day at 23:59:59Z.
 *   · REVOKE-AREA / REGRANT-AREA — `rev` ONLY (--operator=rev; any other
 *     operator is refused by the gate). Revoke = the same audited flip as
 *     above. With --await-signal the revoker pre-checks, prints READY, and
 *     flips ONLY when stdin delivers exactly `REVOKE` (anything else, EOF or 15
 *     minutes ⇒ exit 2, nothing changed). Regrant = the app grant route's
 *     classification: a REVOKED row is REINSTATED (PLATFORM_GRANT_REINSTATED),
 *     an absent row is CREATED (PLATFORM_GRANT_CREATED); an ACTIVE row refuses.
 *   · CLEANUP — the SAME per-user cleanup (incl. the REVOKED-item guard) for
 *     every roster operator that has a record; one purge-dispatch line after.
 *
 * Never: app/api/admin/platform-grants, notifyPlatformAccessChange or any other
 * notification / e-mail module; a session-level SET; --env=production.
 *
 * Exit: 0 done · 2 refused (nothing changed) · 3 an operation failed · 1 could not run.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  SYNTHETIC_EMAIL, SYNTHETIC_USERNAME, SYNTHETIC_FIRST_NAME, SYNTHETIC_LAST_NAME, SYNTHETIC_REASON, SYNTHETIC_ROLE,
  SYNTHETIC_GRANTS, isSyntheticEmailAllowed, isGrantAllowed, computeCleanupDeadline, privateDirFor, recordDirRefusal,
  decideSyntheticOperator, passwordFromBytes, parseSyntheticRecord, cleanupCountsRecord, providerConnectionBlocksCleanup,
  E0_LIVE_ROSTER, E0_LIVE_FLIP_OPERATOR, isRosterGrant, isE0LiveGrantAllowed, computeE0LiveDeadline, e0LiveDirFor,
  e0LiveOperatorDir, e0LiveRecordDirRefusal, parseE0LiveRecord, classifySignalLine, regrantAuditAction,
  AWAIT_SIGNAL_GO, AWAIT_SIGNAL_MAX_MS, E0_LIVE_PROFILE, decideE0LiveProvisionExpiry,
  E0_LIVE_SA, E0_LIVE_SA_ROLE, e0LiveSaDirFor, e0LiveSaRecordDirRefusal, parseE0LiveSaRecord, decideE0LiveSaProvision, decideE0LiveSaExpiry,
  type E0LiveSaRecord, type E0LiveRole,
  type SyntheticRecord, type CleanupCounts, type SyntheticArea, type E0LiveArea, type E0LiveRecord, type E0LiveOperator,
} from "./lib/synthetic-operator.core";
import {
  CREDENTIALS_FILE, RECORD_FILE, CLEANUP_FILE, SECRET_FILES, defaultPrivateBase, createPrivateDir, writePrivateJson, readPrivateJson, shredFile,
} from "./lib/synthetic-operator.files";
import type { Prisma as PrismaTypes } from "@prisma/client";
import { redactConnectionDetails } from "./lib/repair-env-guard";

const secrets: string[] = [];

function refuse(reasons: string[], contacted: boolean): never {
  console.error(`\n  REFUSED — ${contacted ? "nothing was changed" : "nothing was contacted"}.`);
  for (const r of reasons) console.error(`    · ${r}`);
  console.error("");
  process.exit(2);
}
const pass = (line: string) => console.log(`  PASS  ${line}`);

type Db = typeof import("@/lib/db").db;
type Tx = PrismaTypes.TransactionClient;

/**
 * Interactive-transaction bounds for a REMOTE target. Prisma's default (5 s) is
 * shorter than this script's provision transaction over a pooled Supabase link;
 * the first Preview run timed out and rolled back cleanly (nothing written, the
 * credentials shredded). Same bounds as the precheck script.
 */
const TX_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;

/** One read of the connecting principal's RLS posture (S2 Fix B). */
export const PRINCIPAL_BYPASS_SQL = `SELECT (rolbypassrls OR rolsuper) AS ok FROM pg_roles WHERE rolname = current_user`;

async function countsFor(db: Db, userId: string): Promise<CleanupCounts> {
  const [users, grants, conversations, messages, sessions] = await Promise.all([
    db.user.count({ where: { id: userId } }),
    db.platformGrant.count({ where: { userId } }),
    db.platformAiConversation.count({ where: { operatorUserId: userId } }),
    db.platformAiMessage.count({ where: { conversation: { operatorUserId: userId } } }),
    db.userSession.count({ where: { userId } }),
  ]);
  return { users, grants, conversations, messages, sessions };
}

/** Revoke ACTIVE grants (optionally one area) — each status flip + its canonical audit row, one transaction. */
async function revokeGrants(db: Db, userId: string, area: SyntheticArea | E0LiveArea | null): Promise<number> {
  const { AuditAction } = await import("@/lib/audit-actions");
  return db.$transaction(async (tx) => {
    const active = await tx.platformGrant.findMany({
      where: { userId, status: "ACTIVE", ...(area ? { area } : {}) },
      select: { id: true, area: true, level: true },
    });
    const now = new Date();
    for (const g of active) {
      const flipped = await tx.platformGrant.updateMany({
        where: { id: g.id, status: "ACTIVE" },
        data: { status: "REVOKED", revokedAt: now, revokedById: null },
      });
      if (flipped.count !== 1) throw new Error("a grant changed state during revocation — aborted, nothing written");
      await tx.auditLog.create({
        data: {
          userId,
          action: AuditAction.PLATFORM_GRANT_REVOKED,
          performedByAdminId: null,
          metadata: { area: g.area, level: g.level, previousStatus: "ACTIVE", actorType: "SYSTEM", reason: SYNTHETIC_REASON },
        },
      });
    }
    return active.length;
  }, TX_OPTIONS);
}

// ── Registration shape (shared by both profiles) ─────────────────────────────

interface Identity { email: string; username: string; firstName: string; lastName: string }
type GrantSpec = ReadonlyArray<Readonly<{ area: string; level: string }>>;

/** The app modules the registration shape needs, loaded once AFTER the gate. */
async function loadRegistration() {
  const { AuditAction } = await import("@/lib/audit-actions");
  const { auditEmailHash } = await import("@/lib/audit");
  const { possessive } = await import("@/lib/format");
  const { getTemplateForCategory } = await import("@/lib/space-templates/registry");
  const { planTemplateApplication } = await import("@/lib/space-templates/apply");
  const { loadPolicyGroupCatalogue } = await import("@/lib/platform/policies/policy-group-catalogue");
  const { Prisma, SpaceMemberRole } = await import("@prisma/client");
  const defaultPolicyGroup = (await loadPolicyGroupCatalogue()).defaultKey;
  const personalTemplate = getTemplateForCategory("PERSONAL");
  if (!personalTemplate) throw new Error("space-templates registry has no PERSONAL template");
  const plannedSections = planTemplateApplication(personalTemplate, new Set<string>()).sectionsToCreate;
  return { AuditAction, auditEmailHash, possessive, Prisma, SpaceMemberRole, defaultPolicyGroup, plannedSections };
}
type Registration = Awaited<ReturnType<typeof loadRegistration>>;

/**
 * ONE operator in the registration route's shape + its allowlisted grants, each
 * with its canonical PLATFORM_GRANT_CREATED audit row — inside the caller's
 * transaction. `allowed` is the profile's grant predicate, re-checked per grant.
 */
async function createOperatorInTx(
  tx: Tx, reg: Registration, who: Identity, grants: GrantSpec, allowed: (area: string, level: string) => boolean,
  passwordHash: string, now: Date,
  /** SYNTHETIC_ROLE (USER) for every profile; E0_LIVE_SA_ROLE ONLY from provisionE0LiveSa (pinned by the test). */
  role: typeof SYNTHETIC_ROLE | typeof E0_LIVE_SA_ROLE = SYNTHETIC_ROLE,
): Promise<{ userId: string; grantIds: Record<string, string> }> {
  const { AuditAction, auditEmailHash, possessive, Prisma, SpaceMemberRole, defaultPolicyGroup, plannedSections } = reg;
  if (!isSyntheticEmailAllowed(who.email)) throw new Error("operator address is not an @example.test address");
  const user = await tx.user.create({
    data: {
      email: who.email,
      username: who.username,
      name: `${who.firstName} ${who.lastName}`,
      firstName: who.firstName,
      lastName: who.lastName,
      role,
      passwordHash,
      // NO TOTP here (S1, 2026-11-05): a seed sealed with THIS process's ENCRYPTION_KEY
      // would not open under the target deployment's key (Preview's key is a Vercel
      // Sensitive value and is never pulled). If operator 2FA is enforced, the
      // operator enrols through the app's own /api/user/totp setup at first sign-in.
      totpEnabled: false,
      emailVerifiedAt: now,
    },
    select: { id: true },
  });
  const space = await tx.space.create({
    data: {
      name: `${possessive(who.firstName)} Space`,
      type: "PERSONAL",
      dashboardSections: {
        create: plannedSections.map((s) => ({
          key: s.key, label: s.label, tab: s.tab, enabled: s.enabled, order: s.order,
          config: s.config == null ? Prisma.DbNull : (s.config as PrismaTypes.InputJsonValue),
        })),
      },
    },
    select: { id: true },
  });
  await tx.spaceMember.create({ data: { userId: user.id, spaceId: space.id, role: SpaceMemberRole.OWNER } });
  await tx.user.update({ where: { id: user.id }, data: { preferredSpaceId: space.id } });
  await tx.aiAgent.create({ data: { spaceId: space.id, name: `${possessive(who.firstName)} Financial Agent` } });
  await tx.customerPolicyAssignment.create({ data: { userId: user.id, policyGroup: defaultPolicyGroup } });
  await tx.auditLog.create({
    data: {
      userId: user.id, spaceId: space.id, action: AuditAction.REGISTER,
      metadata: { emailHash: auditEmailHash(who.email), username: who.username, invited: false, synthetic: true, actorType: "SYSTEM", reason: SYNTHETIC_REASON },
    },
  });

  const grantIds: Record<string, string> = {};
  for (const g of grants) {
    if (!allowed(g.area, g.level)) throw new Error("grant outside the allowlist");
    const grant = await tx.platformGrant.create({
      data: { userId: user.id, area: g.area as SyntheticArea | E0LiveArea, level: "READ", status: "ACTIVE", grantedById: null },
      select: { id: true },
    });
    await tx.auditLog.create({
      data: {
        userId: user.id,
        action: AuditAction.PLATFORM_GRANT_CREATED,
        performedByAdminId: null,
        metadata: { area: g.area, level: g.level, actorType: "SYSTEM", reason: SYNTHETIC_REASON },
      },
    });
    grantIds[g.area] = grant.id;
  }
  return { userId: user.id, grantIds };
}

/** Read back one operator's stored shape; throws (exit 1) on any mismatch. */
async function checkOperatorShape(db: Db, userId: string, grants: GrantSpec, label: string,
  role: typeof SYNTHETIC_ROLE | typeof E0_LIVE_SA_ROLE = SYNTHETIC_ROLE): Promise<void> {
  const u = await db.user.findUnique({
    where: { id: userId },
    select: { role: true, totpEnabled: true, totpSecret: true, passwordHash: true, email: true, platformGrants: { select: { area: true, level: true, status: true } } },
  });
  const ok = (what: string, cond: boolean) => { if (!cond) throw new Error(`post-provision check failed: ${label}${what}`); pass(`${label}${what}`); };
  ok(`user exists with role ${role} and an @example.test address`, !!u && u.role === role && isSyntheticEmailAllowed(u.email));
  ok("no TOTP provisioned (enrolment, if enforced, is the app's own flow)", !u?.totpEnabled && !u?.totpSecret);
  ok("password stored as a bcrypt cost-12 hash", !!u?.passwordHash && /^\$2[aby]\$12\$/.test(u.passwordHash));
  const held = (u?.platformGrants ?? []).map((g) => `${g.area}:${g.level}:${g.status}`).sort();
  ok(`grants are exactly ${grants.map((g) => `${g.area} ${g.level}`).join(" + ") || "none"}${grants.length ? ", all ACTIVE" : ""}`,
    JSON.stringify(held) === JSON.stringify(grants.map((g) => `${g.area}:${g.level}:ACTIVE`).sort()));
  const [spaces, plaid] = await Promise.all([
    db.spaceMember.count({ where: { userId } }),
    db.plaidItem.count({ where: { userId } }),
  ]);
  ok("exactly the one Personal Space registration creates; no provider connection", spaces === 1 && plaid === 0);
}

// ── Default (G1) profile ─────────────────────────────────────────────────────

async function provision(db: Db, env: "local" | "preview", targetHash: string | null): Promise<number> {
  if (!isSyntheticEmailAllowed(SYNTHETIC_EMAIL)) refuse(["the synthetic address is not an @example.test address."], false);
  for (const g of SYNTHETIC_GRANTS) if (!isGrantAllowed(g.area, g.level)) refuse(["a grant outside the allowlist was requested."], false);

  const existing = await db.user.findFirst({
    where: { OR: [{ email: SYNTHETIC_EMAIL }, { username: SYNTHETIC_USERNAME }] },
    select: { id: true },
  });
  if (existing) refuse(["a synthetic operator already exists on this database — run --cleanup with its record first."], true);

  const now = new Date();
  const deadline = computeCleanupDeadline(now);
  if (deadline.getTime() <= now.getTime()) refuse(["the owner's hard cleanup deadline has passed — no new synthetic operator."], true);

  const bcrypt = (await import("bcryptjs")).default;
  const reg = await loadRegistration();

  const password = passwordFromBytes(randomBytes(24));
  secrets.push(password);
  const passwordHash = await bcrypt.hash(password, 12);

  // The secrets reach disk BEFORE the account exists, so an account can never
  // exist whose password nobody holds. On a failed write below they are shredded.
  const dir = privateDirFor(defaultPrivateBase(), now);
  createPrivateDir(dir);
  const base = {
    env, targetHash, email: SYNTHETIC_EMAIL,
    provisionedAt: now.toISOString(), cleanupDeadline: deadline.toISOString(),
  };
  const credentials = (userId: string | null, grantIds: Record<string, string>) => ({
    kind: "synthetic-operator-credentials", ...base, userId, grantIds,
    password,
  });
  writePrivateJson(dir, CREDENTIALS_FILE, credentials(null, {}), true);

  const who: Identity = { email: SYNTHETIC_EMAIL, username: SYNTHETIC_USERNAME, firstName: SYNTHETIC_FIRST_NAME, lastName: SYNTHETIC_LAST_NAME };
  let created: { userId: string; grantIds: Record<string, string> };
  try {
    created = await db.$transaction(async (tx) => {
      return createOperatorInTx(tx, reg, who, SYNTHETIC_GRANTS, isGrantAllowed, passwordHash, now);
    }, TX_OPTIONS);
  } catch (e) {
    shredFile(path.join(dir, CREDENTIALS_FILE));
    throw e;
  }

  writePrivateJson(dir, CREDENTIALS_FILE, credentials(created.userId, created.grantIds));
  const record: SyntheticRecord = { kind: "synthetic-operator-record", ...base, userId: created.userId, grantIds: created.grantIds };
  writePrivateJson(dir, RECORD_FILE, record, true);

  await checkOperatorShape(db, created.userId, SYNTHETIC_GRANTS, "");
  pass("credentials written to the private directory (0600 in 0700)");
  console.log(`\n  private directory: ${dir}`);
  console.log(`  cleanup deadline:  ${deadline.toISOString()}\n`);
  return 0;
}

async function revokeArea(db: Db, area: SyntheticArea): Promise<number> {
  const u = await db.user.findUnique({ where: { email: SYNTHETIC_EMAIL }, select: { id: true, role: true } });
  if (!u || u.role !== "USER") refuse(["no synthetic operator exists on this database."], true);
  const active = await db.platformGrant.count({ where: { userId: u.id, area, status: "ACTIVE" } });
  if (active !== 1) refuse([`the synthetic operator holds no ACTIVE ${area} grant.`], true);
  const n = await revokeGrants(db, u.id, area);
  if (n !== 1) throw new Error("revocation did not flip exactly one grant");
  pass(`${area} grant revoked with its PLATFORM_GRANT_REVOKED audit row`);
  return 0;
}

/**
 * The per-user cleanup shared by both profiles: the provider-connection guard,
 * the audited revoke of remaining grants, the account-deletion request stamp +
 * purgeUser(), the zero-rows check, the secret shred and the counts-only record.
 * `opDir` holds that operator's credentials / record / cleanup files.
 */
async function purgeOperator(db: Db, userId: string, expectedEmail: string, opDir: string, env: string, label: string,
  /** The roles the recorded user may hold: USER for every operator; the e0-live-sa revoker also SYSTEM_ADMIN. */
  allowedRoles: ReadonlyArray<typeof SYNTHETIC_ROLE | typeof E0_LIVE_SA_ROLE> = [SYNTHETIC_ROLE]): Promise<number> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, role: true } });
  if (!u) refuse([`${label}the recorded synthetic operator no longer exists on this database.`], true);
  if (u.email !== expectedEmail || !isSyntheticEmailAllowed(u.email) || !(allowedRoles as readonly string[]).includes(u.role)) {
    refuse([`${label}the recorded user is not the synthetic operator (email/role mismatch) — refusing to delete it.`], true);
  }
  // REVOKED (disconnected) items do not block: the user purge's cascade
  // (PlaidItem.user onDelete: Cascade) removes them, and purgeUser only calls
  // Plaid itemRemove for ACTIVE items (lib/account-deletion/purge.ts), so the
  // throwing itemRemove stub below stays unreachable. ACTIVE / ERROR / any other
  // non-REVOKED item still refuses (providerConnectionBlocksCleanup).
  const plaidItems = await db.plaidItem.findMany({ where: { userId: u.id }, select: { status: true } });
  if (providerConnectionBlocksCleanup(plaidItems.map((i) => i.status))) {
    refuse([`${label}the synthetic operator has an active (not disconnected) provider connection — it must have none; investigate before cleanup.`], true);
  }

  const before = await countsFor(db, u.id);

  // (1) Revoke remaining ACTIVE grants, audited.
  const revoked = await revokeGrants(db, u.id, null);
  pass(`${label}remaining ACTIVE grants revoked with audit rows (${revoked})`);

  // (2) The account-deletion path: the request stamp (zero grace) + purgeUser().
  const { AuditAction } = await import("@/lib/audit-actions");
  const { purgeUser } = await import("@/lib/account-deletion/purge");
  type PurgeDeps = NonNullable<Parameters<typeof purgeUser>[1]>;
  const stampedAt = new Date(Date.now() - 1000);
  await db.$transaction(async (tx) => {
    const n = await tx.user.updateMany({
      where: { id: u.id, email: expectedEmail, role: { in: [...allowedRoles] } },
      // The SAME stamp demotes to USER (a no-op for USER operators): an e0-live-sa revoker that a later purge step
      // failed to delete is never left holding the admin role.
      data: { deletionRequestedAt: stampedAt, deletionScheduledAt: stampedAt, deactivatedAt: stampedAt, role: SYNTHETIC_ROLE },
    });
    if (n.count !== 1) throw new Error("deletion request stamp matched no synthetic operator");
    await tx.auditLog.create({
      data: {
        userId: u.id,
        action: AuditAction.ACCOUNT_DELETION_REQUESTED,
        metadata: { deletionScheduledAt: stampedAt.toISOString(), graceDays: 0, synthetic: true, previousRole: u.role, actorType: "SYSTEM", reason: SYNTHETIC_REASON },
      },
    });
  }, TX_OPTIONS);
  const noEmail: NonNullable<PurgeDeps["sendEmail"]> = async () => ({ status: "skipped", provider: "none", reason: "SYNTHETIC_OPERATOR_NO_SEND" } as never);
  const noProvider: NonNullable<PurgeDeps["plaid"]> = {
    itemRemove: (async () => { throw new Error("the synthetic operator has no provider connection; no provider call is made"); }) as never,
  };
  const result = await purgeUser(u.id, { sendEmail: noEmail, plaid: noProvider });
  if (!result.purged) {
    console.error(`\n  FAILED — ${label}the deletion path did not purge the synthetic operator (${result.skipped ?? "unknown"}). Re-run --cleanup.\n`);
    return 3;
  }
  pass(`${label}user deleted through the account-deletion purge (purgeUser — the process-deletions function)`);

  const after = await countsFor(db, u.id);
  if (after.users !== 0 || after.grants !== 0 || after.conversations !== 0 || after.messages !== 0 || after.sessions !== 0) {
    console.error(`\n  FAILED — ${label}rows remain after the purge; see cleanup.json in the private directory.\n`);
    writePrivateJson(opDir, CLEANUP_FILE, cleanupCountsRecord(env, before, after, new Date()));
    return 3;
  }
  pass(`${label}zero rows remain for the synthetic operator (user, grants, conversations, messages, sessions)`);

  // Shred every secret file present (credentials.json, and totp.json from the app's enrolment — S2 Fix A).
  for (const f of SECRET_FILES) shredFile(path.join(opDir, f));
  pass(`${label}secret files shredded (overwritten, then unlinked): ${SECRET_FILES.join(", ")}`);

  // Counts-only cleanup record.
  writePrivateJson(opDir, CLEANUP_FILE, cleanupCountsRecord(env, before, after, new Date()));
  pass(`${label}counts-only cleanup record written to the private directory (0600)`);
  return 0;
}

function printPurgeDispatch(): void {
  // The Preview purge dispatch — printed, never run here.
  console.log("\n  NEXT (operator, not run by this script):");
  console.log("    npm run ops:platform-ai-conversations-purge -- --env=preview\n");
}

async function cleanup(db: Db, recordDir: string, targetHash: string | null, env: string): Promise<number> {
  const loc = recordDirRefusal(recordDir, defaultPrivateBase());
  if (loc) refuse([loc], false);
  let record: SyntheticRecord;
  try { record = parseSyntheticRecord(readPrivateJson(recordDir, RECORD_FILE)); }
  catch (e) { refuse([`record rejected: ${e instanceof Error ? e.message : String(e)}`], false); }
  if (record.env !== env || record.targetHash !== targetHash) {
    refuse(["the record was provisioned on a different environment/database than this connection — refusing."], false);
  }
  const rc = await purgeOperator(db, record.userId, SYNTHETIC_EMAIL, recordDir, env, "");
  if (rc !== 0) return rc;
  printPurgeDispatch();
  console.log(`  private directory: ${recordDir}`);
  console.log(`  cleanup deadline:  ${record.cleanupDeadline}\n`);
  return 0;
}

// ── E0-LIVE profile (S2 ruling R-1) ──────────────────────────────────────────

async function provisionE0Live(db: Db, targetHash: string | null, roles: readonly E0LiveRole[]): Promise<number> {
  // S2 L4 lesson: provision ONLY the roster operators the run uses (--operators, required by the gate).
  const roster = E0_LIVE_ROSTER.filter((o) => roles.includes(o.role));
  if (roster.length === 0 || roster.length !== roles.length) refuse(["--operators selects no roster operator (or an unknown one)."], false);
  for (const o of roster) {
    if (!isSyntheticEmailAllowed(o.email)) refuse([`roster operator ${o.role} does not have an @example.test address.`], false);
    for (const g of o.grants) if (!isRosterGrant(o.role, g.area, g.level)) refuse([`roster operator ${o.role} carries a grant outside the e0-live allowlist.`], false);
  }

  const existing = await db.user.count({
    where: { OR: [{ email: { in: E0_LIVE_ROSTER.map((o) => o.email) } }, { username: { in: E0_LIVE_ROSTER.map((o) => o.username) } }] },
  });
  if (existing > 0) refuse(["an e0-live roster operator already exists on this database — run --cleanup with its record first."], true);

  const now = new Date();
  const expiry = decideE0LiveProvisionExpiry(now);
  if (!expiry.ok) refuse([expiry.reason], true);
  const deadline = computeE0LiveDeadline(now);
  if (deadline.getTime() <= now.getTime()) refuse(["the same-day cleanup deadline has passed — provision on a new UTC day."], true);

  const bcrypt = (await import("bcryptjs")).default;
  const reg = await loadRegistration();

  const rosterDir = e0LiveDirFor(defaultPrivateBase(), now);
  createPrivateDir(rosterDir);
  const base = {
    profile: E0_LIVE_PROFILE, env: "preview" as const, targetHash,
    provisionedAt: now.toISOString(), cleanupDeadline: deadline.toISOString(),
  };
  const plan: Array<{ op: E0LiveOperator; dir: string; password: string; passwordHash: string }> = [];
  for (const o of roster) {
    const password = passwordFromBytes(randomBytes(24));
    secrets.push(password);
    plan.push({ op: o, dir: e0LiveOperatorDir(rosterDir, o.role), password, passwordHash: await bcrypt.hash(password, 12) });
  }
  const credentials = (p: (typeof plan)[number], userId: string | null, grantIds: Record<string, string>) => ({
    kind: "synthetic-operator-e0l-credentials", ...base, role: p.op.role, email: p.op.email, userId, grantIds,
    password: p.password,
  });
  // Secrets reach disk BEFORE any account exists; on a failed transaction every one is shredded.
  for (const p of plan) {
    createPrivateDir(p.dir);
    writePrivateJson(p.dir, CREDENTIALS_FILE, credentials(p, null, {}), true);
  }

  let created: Array<{ userId: string; grantIds: Record<string, string> }>;
  try {
    created = await db.$transaction(async (tx) => {
      const out: Array<{ userId: string; grantIds: Record<string, string> }> = [];
      for (const p of plan) {
        out.push(await createOperatorInTx(tx, reg, p.op, p.op.grants, (a, l) => isRosterGrant(p.op.role, a, l), p.passwordHash, now));
      }
      return out;
    }, TX_OPTIONS);
  } catch (e) {
    for (const p of plan) shredFile(path.join(p.dir, CREDENTIALS_FILE));
    throw e;
  }

  for (const [i, p] of plan.entries()) {
    writePrivateJson(p.dir, CREDENTIALS_FILE, credentials(p, created[i].userId, created[i].grantIds));
    const record: E0LiveRecord = {
      kind: "synthetic-operator-e0l-record", ...base, role: p.op.role, email: p.op.email,
      userId: created[i].userId, grantIds: created[i].grantIds,
    };
    writePrivateJson(p.dir, RECORD_FILE, record, true);
  }

  for (const [i, p] of plan.entries()) await checkOperatorShape(db, created[i].userId, p.op.grants, `${p.op.role}: `);
  const outside = await db.platformGrant.count({
    where: { userId: { in: created.map((c) => c.userId) }, area: { notIn: ["PLATFORM_OPS", "CUSTOMER_SUCCESS"] } },
  });
  if (outside !== 0 || !roster.every((o) => o.grants.every((g) => isE0LiveGrantAllowed(g.area, g.level)))) {
    throw new Error("post-provision check failed: a roster operator holds an area outside PLATFORM_OPS / CUSTOMER_SUCCESS");
  }
  pass("no roster operator holds any area outside PLATFORM_OPS / CUSTOMER_SUCCESS");
  pass(`credentials written per operator (0600 in 0700): ${roster.map((o) => o.role).join(", ")} only`);
  console.log(`\n  private directory: ${rosterDir}`);
  console.log(`  cleanup deadline:  ${deadline.toISOString()}  (same UTC day — run --cleanup before it)\n`);
  return 0;
}

const FLIP_OP = E0_LIVE_ROSTER.find((o) => o.role === E0_LIVE_FLIP_OPERATOR)!;

async function findFlipOperator(db: Db): Promise<{ id: string }> {
  const u = await db.user.findUnique({ where: { email: FLIP_OP.email }, select: { id: true, role: true, email: true } });
  if (!u || u.role !== "USER" || u.email !== FLIP_OP.email) refuse(["no e0-live rev operator exists on this database."], true);
  return { id: u.id };
}

/** Wait for exactly AWAIT_SIGNAL_GO on stdin. Anything else, EOF or the timeout ⇒ false. */
function awaitSignal(): Promise<boolean> {
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.pause();
      resolve(v);
    };
    const onData = (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) done(classifySignalLine(buf.slice(0, nl)) === "go");
    };
    const onEnd = () => done(false);
    const timer = setTimeout(() => done(false), AWAIT_SIGNAL_MAX_MS);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    console.log(`  READY  awaiting \`${AWAIT_SIGNAL_GO}\` on stdin`);
  });
}

async function revokeAreaE0Live(db: Db, area: E0LiveArea, waitForSignal: boolean): Promise<number> {
  const u = await findFlipOperator(db);
  const active = await db.platformGrant.count({ where: { userId: u.id, area, status: "ACTIVE" } });
  if (active !== 1) refuse([`the rev operator holds no ACTIVE ${area} grant.`], true);
  if (waitForSignal && !(await awaitSignal())) {
    refuse(["no revoke signal (wrong line, end of input or timeout)."], true);
  }
  const n = await revokeGrants(db, u.id, area);
  if (n !== 1) throw new Error("revocation did not flip exactly one grant");
  pass(`rev: ${area} grant revoked with its PLATFORM_GRANT_REVOKED audit row at ${new Date().toISOString()}`);
  return 0;
}

async function regrantAreaE0Live(db: Db, area: E0LiveArea): Promise<number> {
  if (!isRosterGrant(E0_LIVE_FLIP_OPERATOR, area, "READ")) refuse(["the area is not one of the rev operator's grants."], false);
  const u = await findFlipOperator(db);
  const before = await db.platformGrant.findUnique({ where: { userId_area: { userId: u.id, area } }, select: { status: true } });
  if (regrantAuditAction(before) === null) refuse([`the rev operator already holds an ACTIVE ${area} grant — nothing to regrant.`], true);
  const { AuditAction } = await import("@/lib/audit-actions");
  const action = await db.$transaction(async (tx) => {
    const existing = await tx.platformGrant.findUnique({ where: { userId_area: { userId: u.id, area } }, select: { status: true, level: true } });
    const act = regrantAuditAction(existing);
    if (act === null) throw new Error("the grant changed state before the regrant — aborted, nothing written");
    await tx.platformGrant.upsert({
      where: { userId_area: { userId: u.id, area } },
      create: { userId: u.id, area, level: "READ", status: "ACTIVE", grantedById: null },
      update: { level: "READ", status: "ACTIVE", grantedById: null, grantedAt: new Date(), revokedAt: null, revokedById: null },
    });
    await tx.auditLog.create({
      data: {
        userId: u.id,
        action: act === "PLATFORM_GRANT_CREATED" ? AuditAction.PLATFORM_GRANT_CREATED : AuditAction.PLATFORM_GRANT_REINSTATED,
        performedByAdminId: null,
        metadata: act === "PLATFORM_GRANT_CREATED"
          ? { area, level: "READ", actorType: "SYSTEM", reason: SYNTHETIC_REASON }
          : { area, level: "READ", previousStatus: "REVOKED", previousLevel: existing?.level ?? null, actorType: "SYSTEM", reason: SYNTHETIC_REASON },
      },
    });
    return act;
  }, TX_OPTIONS);
  pass(`rev: ${area} READ regranted with its ${action} audit row`);
  return 0;
}

async function cleanupE0Live(db: Db, rosterDir: string, targetHash: string | null): Promise<number> {
  const loc = e0LiveRecordDirRefusal(rosterDir, defaultPrivateBase());
  if (loc) refuse([loc], false);
  const records: Array<{ op: E0LiveOperator; dir: string; record: E0LiveRecord }> = [];
  for (const o of E0_LIVE_ROSTER) {
    const dir = e0LiveOperatorDir(rosterDir, o.role);
    if (!existsSync(path.join(dir, RECORD_FILE))) continue;
    let record: E0LiveRecord;
    try { record = parseE0LiveRecord(readPrivateJson(dir, RECORD_FILE), o.role); }
    catch (e) { refuse([`${o.role}: record rejected: ${e instanceof Error ? e.message : String(e)}`], false); }
    if (record.env !== "preview" || record.targetHash !== targetHash) {
      refuse([`${o.role}: the record was provisioned on a different environment/database than this connection — refusing.`], false);
    }
    records.push({ op: o, dir, record });
  }
  if (records.length === 0) refuse(["no e0-live operator record found in the directory."], false);

  // Preflight EVERY operator before touching any, so a refusal really means "nothing was changed".
  // An operator already purged by an earlier, partly failed run (user gone AND its cleanup.json
  // present) is skipped; a user gone WITHOUT a cleanup record refuses.
  const todo: typeof records = [];
  for (const r of records) {
    const u = await db.user.findUnique({ where: { id: r.record.userId }, select: { email: true, role: true } });
    if (!u) {
      if (existsSync(path.join(r.dir, CLEANUP_FILE))) { pass(`${r.op.role}: already cleaned by an earlier run — skipped`); continue; }
      refuse([`${r.op.role}: the recorded synthetic operator no longer exists and has no cleanup record.`], false);
    }
    if (u.email !== r.op.email || !isSyntheticEmailAllowed(u.email) || u.role !== "USER") {
      refuse([`${r.op.role}: the recorded user is not the roster operator (email/role mismatch) — refusing to delete it.`], false);
    }
    const items = await db.plaidItem.findMany({ where: { userId: r.record.userId }, select: { status: true } });
    if (providerConnectionBlocksCleanup(items.map((i) => i.status))) {
      refuse([`${r.op.role}: the operator has an active (not disconnected) provider connection — investigate before cleanup.`], false);
    }
    todo.push(r);
  }

  let worst = 0;
  for (const r of todo) {
    const rc = await purgeOperator(db, r.record.userId, r.op.email, r.dir, "preview", `${r.op.role}: `);
    worst = Math.max(worst, rc);
  }
  if (worst !== 0) return worst;
  printPurgeDispatch();
  console.log(`  operators cleaned: ${todo.map((r) => r.op.role).join(", ") || "none (all already cleaned)"}`);
  console.log(`  private directory: ${rosterDir}`);
  console.log(`  cleanup deadline:  ${records[0].record.cleanupDeadline}\n`);
  return 0;
}

// ── E0-LIVE-SA profile (S2 09ic; owner-approved) — the suite R revoking actor ─────
//
// ONE synthetic System Admin (e0l-sa@example.test), NO Platform grants, beside a live same-day e0-live roster
// that includes rev. Provisioned IMMEDIATELY before suite R, purged IMMEDIATELY after (zero rows). This tool never
// calls the grant route; the private runner does, as this identity, over HTTP.

async function provisionE0LiveSa(db: Db, targetHash: string | null, rosterDir: string): Promise<number> {
  const loc = e0LiveRecordDirRefusal(rosterDir, defaultPrivateBase());
  if (loc) refuse([`--roster: ${loc}`], false);
  const revDir = e0LiveOperatorDir(rosterDir, E0_LIVE_FLIP_OPERATOR);
  let rev: E0LiveRecord | null = null;
  if (existsSync(path.join(revDir, RECORD_FILE))) {
    try { rev = parseE0LiveRecord(readPrivateJson(revDir, RECORD_FILE), E0_LIVE_FLIP_OPERATOR); }
    catch (e) { refuse([`rev record rejected: ${e instanceof Error ? e.message : String(e)}`], false); }
  }
  const now = new Date();
  const window = decideE0LiveSaProvision(now, rev, targetHash);
  if (!window.ok) refuse([window.reason], false);
  const revRecord = rev as E0LiveRecord;

  const revUser = await db.user.findUnique({ where: { id: revRecord.userId }, select: { email: true, role: true } });
  if (!revUser || revUser.email !== FLIP_OP.email || revUser.role !== SYNTHETIC_ROLE) {
    refuse(["the roster's rev operator does not exist on this database (or is not the roster user) — no revoker without suite R."], true);
  }
  const existing = await db.user.count({ where: { OR: [{ email: E0_LIVE_SA.email }, { username: E0_LIVE_SA.username }] } });
  if (existing > 0) refuse(["an e0-live-sa revoker already exists on this database — run --cleanup with its record first."], true);

  const deadline = computeE0LiveDeadline(now);
  const bcrypt = (await import("bcryptjs")).default;
  const reg = await loadRegistration();
  const password = passwordFromBytes(randomBytes(24));
  secrets.push(password);
  const passwordHash = await bcrypt.hash(password, 12);

  // Secrets reach disk BEFORE the account exists; on a failed transaction they are shredded.
  const dir = e0LiveSaDirFor(defaultPrivateBase(), now);
  createPrivateDir(dir);
  const base = {
    profile: "e0-live-sa" as const, env: "preview" as const, targetHash, email: E0_LIVE_SA.email, roster: path.basename(rosterDir),
    provisionedAt: now.toISOString(), cleanupDeadline: deadline.toISOString(),
  };
  const credentials = (userId: string | null) => ({ kind: "synthetic-operator-e0lsa-credentials", ...base, userId, password });
  writePrivateJson(dir, CREDENTIALS_FILE, credentials(null), true);

  let created: { userId: string; grantIds: Record<string, string> };
  try {
    created = await db.$transaction(async (tx) => {
      // NO grants: the SA acts only through the guarded admin grant route (requireFreshSystemAdmin).
      return createOperatorInTx(tx, reg, E0_LIVE_SA, [], () => false, passwordHash, now, E0_LIVE_SA_ROLE);
    }, TX_OPTIONS);
  } catch (e) {
    shredFile(path.join(dir, CREDENTIALS_FILE));
    throw e;
  }

  writePrivateJson(dir, CREDENTIALS_FILE, credentials(created.userId));
  const record: E0LiveSaRecord = { kind: "synthetic-operator-e0lsa-record", ...base, userId: created.userId };
  writePrivateJson(dir, RECORD_FILE, record, true);

  await checkOperatorShape(db, created.userId, [], "sa: ", E0_LIVE_SA_ROLE);
  pass("sa: credentials written to the private directory (0600 in 0700)");
  console.log(`\n  private directory: ${dir}`);
  console.log(`  cleanup deadline:  ${deadline.toISOString()}  (purge IMMEDIATELY after suite R: --profile=e0-live-sa --cleanup --record=<this dir>)\n`);
  return 0;
}

async function cleanupE0LiveSa(db: Db, recordDir: string, targetHash: string | null): Promise<number> {
  const loc = e0LiveSaRecordDirRefusal(recordDir, defaultPrivateBase());
  if (loc) refuse([loc], false);
  let record: E0LiveSaRecord;
  try { record = parseE0LiveSaRecord(readPrivateJson(recordDir, RECORD_FILE)); }
  catch (e) { refuse([`record rejected: ${e instanceof Error ? e.message : String(e)}`], false); }
  if (record.env !== "preview" || record.targetHash !== targetHash) {
    refuse(["the record was provisioned on a different environment/database than this connection — refusing."], false);
  }
  const u = await db.user.findUnique({ where: { id: record.userId }, select: { id: true } });
  if (!u && existsSync(path.join(recordDir, CLEANUP_FILE))) {
    pass("sa: already cleaned by an earlier run — skipped");
  } else {
    // The SAME per-user cleanup; the stamp demotes SYSTEM_ADMIN → USER before purgeUser deletes the account.
    const rc = await purgeOperator(db, record.userId, E0_LIVE_SA.email, recordDir, "preview", "sa: ", [SYNTHETIC_ROLE, E0_LIVE_SA_ROLE]);
    if (rc !== 0) return rc;
  }
  // Grant provenance pointing at the revoker is SetNull on delete (schema PlatformGrant grantedBy / revokedBy): must be zero.
  const linked = await db.platformGrant.count({ where: { OR: [{ grantedById: record.userId }, { revokedById: record.userId }] } });
  if (linked !== 0) {
    console.error(`\n  FAILED — sa: ${linked} grant row(s) still reference the revoker after the purge.\n`);
    return 3;
  }
  pass("sa: zero rows remain for the revoker (user, grants, conversations, messages, sessions) and zero grant rows reference it");
  // Disclosed residue: append-only audit rows that name the revoker as the acting admin (performedByAdminId, no FK).
  const auditNamingSa = await db.auditLog.count({ where: { performedByAdminId: record.userId } });
  console.log(`  disclosed residue: ${auditNamingSa} append-only audit row(s) name the revoker as the acting admin (kept by design)`);
  printPurgeDispatch();
  console.log(`  private directory: ${recordDir}\n`);
  return 0;
}

async function main(): Promise<void> {
  const decision = decideSyntheticOperator(process.argv.slice(2), process.env);
  if (!decision.ok) refuse(decision.reasons, false);
  if (decision.profile === "e0-live-sa" && decision.command.kind === "provision") {
    // S2 09ic: the SA profile has its own hard stop — refuse before any database contact or file write.
    const saExpiry = decideE0LiveSaExpiry(new Date());
    if (!saExpiry.ok) refuse([saExpiry.reason], false);
  }
  if (decision.profile === "e0-live" && decision.command.kind === "provision") {
    // S2 09eh: hard stop — refuse before any database contact or file write.
    const expiry = decideE0LiveProvisionExpiry(new Date());
    if (!expiry.ok) refuse([expiry.reason], false);
  }

  // Imported only after the gate: constructing the client is the first contact with any database.
  const { db } = await import("@/lib/db");
  try {
    // S2 Fix B: the conversation tables are FORCE RLS, so a principal that does not bypass RLS
    // would read them as empty and "zero rows remain" would pass while rows remain. Refuse first.
    const role = await db.$queryRawUnsafe<Array<{ ok: boolean }>>(PRINCIPAL_BYPASS_SQL);
    if (role.length !== 1 || role[0].ok !== true) {
      refuse(["the connecting principal does not bypass RLS (rolbypassrls / rolsuper) — its counts of the FORCE-RLS conversation tables would be vacuous; use the direct (migration) principal."], true);
    }
    if (decision.profile === "e0-live-sa") {
      const c = decision.command;
      process.exitCode = c.kind === "provision" ? await provisionE0LiveSa(db, decision.targetHash, path.resolve(c.rosterDir))
        : await cleanupE0LiveSa(db, path.resolve(c.recordDir), decision.targetHash);
      return;
    }
    if (decision.profile === "e0-live") {
      const c = decision.command;
      process.exitCode = c.kind === "provision" ? await provisionE0Live(db, decision.targetHash, c.roles)
        : c.kind === "revoke-area" ? await revokeAreaE0Live(db, c.area, c.awaitSignal)
        : c.kind === "regrant-area" ? await regrantAreaE0Live(db, c.area)
        : await cleanupE0Live(db, path.resolve(c.recordDir), decision.targetHash);
      return;
    }
    const c = decision.command;
    process.exitCode = c.kind === "provision" ? await provision(db, decision.env, decision.targetHash)
      : c.kind === "revoke-area" ? await revokeArea(db, c.area)
      : await cleanup(db, path.resolve(c.recordDir), decision.targetHash, decision.env);
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(redactConnectionDetails(e instanceof Error ? e.message : String(e), [process.env.FM_PRODUCTION_DB_REF, ...secrets]));
  process.exit(1);
});
