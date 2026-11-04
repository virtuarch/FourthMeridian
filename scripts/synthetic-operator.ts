/**
 * scripts/synthetic-operator.ts — provision / revoke / clean up ONE synthetic,
 * Preview-only Platform operator for acceptance testing.
 *
 * Owner-authorized (a dedicated, fabricated Preview operator); method approved
 * by S2. The rules live in scripts/lib/synthetic-operator.core.ts (pure,
 * unit-tested) and are pinned by scripts/synthetic-operator.test.ts.
 *
 *   npm run ops:synthetic-operator -- --env=<preview|local> --provision
 *   npm run ops:synthetic-operator -- --env=<preview|local> --revoke-area=GROWTH_REVENUE
 *   npm run ops:synthetic-operator -- --env=<preview|local> --cleanup --record=<private dir>
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
 * the Preview purge-dispatch instruction (not run); (4) shred credentials.json;
 * (5) write cleanup.json (counts only) beside it at 0600.
 *
 * Never: app/api/admin/platform-grants, notifyPlatformAccessChange or any other
 * notification / e-mail module; a session-level SET; --env=production.
 *
 * Exit: 0 done · 2 refused (nothing changed) · 3 an operation failed · 1 could not run.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  SYNTHETIC_EMAIL, SYNTHETIC_USERNAME, SYNTHETIC_FIRST_NAME, SYNTHETIC_LAST_NAME, SYNTHETIC_REASON, SYNTHETIC_ROLE,
  SYNTHETIC_GRANTS, isSyntheticEmailAllowed, isGrantAllowed, computeCleanupDeadline, privateDirFor, recordDirRefusal,
  decideSyntheticOperator, passwordFromBytes, parseSyntheticRecord, cleanupCountsRecord,
  type SyntheticRecord, type CleanupCounts, type SyntheticArea,
} from "./lib/synthetic-operator.core";
import {
  CREDENTIALS_FILE, RECORD_FILE, CLEANUP_FILE, defaultPrivateBase, createPrivateDir, writePrivateJson, readPrivateJson, shredFile,
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
async function revokeGrants(db: Db, userId: string, area: SyntheticArea | null): Promise<number> {
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
  });
}

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
  const { AuditAction } = await import("@/lib/audit-actions");
  const { auditEmailHash } = await import("@/lib/audit");
  const { possessive } = await import("@/lib/format");
  const { getTemplateForCategory } = await import("@/lib/space-templates/registry");
  const { planTemplateApplication } = await import("@/lib/space-templates/apply");
  const { loadPolicyGroupCatalogue } = await import("@/lib/platform/policies/policy-group-catalogue");
  const { Prisma, SpaceMemberRole } = await import("@prisma/client");

  const password = passwordFromBytes(randomBytes(24));
  secrets.push(password);
  const passwordHash = await bcrypt.hash(password, 12);
  const defaultPolicyGroup = (await loadPolicyGroupCatalogue()).defaultKey;
  const personalTemplate = getTemplateForCategory("PERSONAL");
  if (!personalTemplate) throw new Error("space-templates registry has no PERSONAL template");
  const plannedSections = planTemplateApplication(personalTemplate, new Set<string>()).sectionsToCreate;

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

  let created: { userId: string; grantIds: Record<string, string> };
  try {
    created = await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: SYNTHETIC_EMAIL,
          username: SYNTHETIC_USERNAME,
          name: `${SYNTHETIC_FIRST_NAME} ${SYNTHETIC_LAST_NAME}`,
          firstName: SYNTHETIC_FIRST_NAME,
          lastName: SYNTHETIC_LAST_NAME,
          role: SYNTHETIC_ROLE,
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
          name: `${possessive(SYNTHETIC_FIRST_NAME)} Space`,
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
      await tx.aiAgent.create({ data: { spaceId: space.id, name: `${possessive(SYNTHETIC_FIRST_NAME)} Financial Agent` } });
      await tx.customerPolicyAssignment.create({ data: { userId: user.id, policyGroup: defaultPolicyGroup } });
      await tx.auditLog.create({
        data: {
          userId: user.id, spaceId: space.id, action: AuditAction.REGISTER,
          metadata: { emailHash: auditEmailHash(SYNTHETIC_EMAIL), username: SYNTHETIC_USERNAME, invited: false, synthetic: true, actorType: "SYSTEM", reason: SYNTHETIC_REASON },
        },
      });

      const grantIds: Record<string, string> = {};
      for (const g of SYNTHETIC_GRANTS) {
        if (!isGrantAllowed(g.area, g.level)) throw new Error("grant outside the allowlist");
        const grant = await tx.platformGrant.create({
          data: { userId: user.id, area: g.area, level: g.level, status: "ACTIVE", grantedById: null },
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
    });
  } catch (e) {
    shredFile(path.join(dir, CREDENTIALS_FILE));
    throw e;
  }

  writePrivateJson(dir, CREDENTIALS_FILE, credentials(created.userId, created.grantIds));
  const record: SyntheticRecord = { kind: "synthetic-operator-record", ...base, userId: created.userId, grantIds: created.grantIds };
  writePrivateJson(dir, RECORD_FILE, record, true);

  // Read back the shapes.
  const u = await db.user.findUnique({
    where: { id: created.userId },
    select: { role: true, totpEnabled: true, totpSecret: true, passwordHash: true, email: true, platformGrants: { select: { area: true, level: true, status: true } } },
  });
  const ok = (label: string, cond: boolean) => { if (!cond) throw new Error(`post-provision check failed: ${label}`); pass(label); };
  ok("user exists with role USER and an @example.test address", !!u && u.role === "USER" && isSyntheticEmailAllowed(u.email));
  ok("no TOTP provisioned (enrolment, if enforced, is the app's own flow)", !u?.totpEnabled && !u?.totpSecret);
  ok("password stored as a bcrypt cost-12 hash", !!u?.passwordHash && /^\$2[aby]\$12\$/.test(u.passwordHash));
  const held = (u?.platformGrants ?? []).map((g) => `${g.area}:${g.level}:${g.status}`).sort();
  ok("grants are exactly PLATFORM_OPS READ + GROWTH_REVENUE READ, both ACTIVE",
    JSON.stringify(held) === JSON.stringify(SYNTHETIC_GRANTS.map((g) => `${g.area}:${g.level}:ACTIVE`).sort()));
  const [spaces, plaid] = await Promise.all([
    db.spaceMember.count({ where: { userId: created.userId } }),
    db.plaidItem.count({ where: { userId: created.userId } }),
  ]);
  ok("exactly the one Personal Space registration creates; no provider connection", spaces === 1 && plaid === 0);
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

async function cleanup(db: Db, recordDir: string, targetHash: string | null, env: string): Promise<number> {
  const loc = recordDirRefusal(recordDir, defaultPrivateBase());
  if (loc) refuse([loc], false);
  let record: SyntheticRecord;
  try { record = parseSyntheticRecord(readPrivateJson(recordDir, RECORD_FILE)); }
  catch (e) { refuse([`record rejected: ${e instanceof Error ? e.message : String(e)}`], false); }
  if (record.env !== env || record.targetHash !== targetHash) {
    refuse(["the record was provisioned on a different environment/database than this connection — refusing."], false);
  }

  const u = await db.user.findUnique({ where: { id: record.userId }, select: { id: true, email: true, role: true } });
  if (!u) refuse(["the recorded synthetic operator no longer exists on this database."], true);
  if (u.email !== SYNTHETIC_EMAIL || !isSyntheticEmailAllowed(u.email) || u.role !== "USER") {
    refuse(["the recorded user is not the synthetic operator (email/role mismatch) — refusing to delete it."], true);
  }
  const plaidItems = await db.plaidItem.count({ where: { userId: u.id } });
  if (plaidItems !== 0) refuse(["the synthetic operator has a provider connection — it must have none; investigate before cleanup."], true);

  const before = await countsFor(db, u.id);

  // (1) Revoke remaining ACTIVE grants, audited.
  const revoked = await revokeGrants(db, u.id, null);
  pass(`remaining ACTIVE grants revoked with audit rows (${revoked})`);

  // (2) The account-deletion path: the request stamp (zero grace) + purgeUser().
  const { AuditAction } = await import("@/lib/audit-actions");
  const { purgeUser } = await import("@/lib/account-deletion/purge");
  type PurgeDeps = NonNullable<Parameters<typeof purgeUser>[1]>;
  const stampedAt = new Date(Date.now() - 1000);
  await db.$transaction(async (tx) => {
    const n = await tx.user.updateMany({
      where: { id: u.id, email: SYNTHETIC_EMAIL, role: "USER" },
      data: { deletionRequestedAt: stampedAt, deletionScheduledAt: stampedAt, deactivatedAt: stampedAt },
    });
    if (n.count !== 1) throw new Error("deletion request stamp matched no synthetic operator");
    await tx.auditLog.create({
      data: {
        userId: u.id,
        action: AuditAction.ACCOUNT_DELETION_REQUESTED,
        metadata: { deletionScheduledAt: stampedAt.toISOString(), graceDays: 0, synthetic: true, actorType: "SYSTEM", reason: SYNTHETIC_REASON },
      },
    });
  });
  const noEmail: NonNullable<PurgeDeps["sendEmail"]> = async () => ({ status: "skipped", provider: "none", reason: "SYNTHETIC_OPERATOR_NO_SEND" } as never);
  const noProvider: NonNullable<PurgeDeps["plaid"]> = {
    itemRemove: (async () => { throw new Error("the synthetic operator has no provider connection; no provider call is made"); }) as never,
  };
  const result = await purgeUser(u.id, { sendEmail: noEmail, plaid: noProvider });
  if (!result.purged) {
    console.error(`\n  FAILED — the deletion path did not purge the synthetic operator (${result.skipped ?? "unknown"}). Re-run --cleanup.\n`);
    return 3;
  }
  pass("user deleted through the account-deletion purge (purgeUser — the process-deletions function)");

  const after = await countsFor(db, u.id);
  if (after.users !== 0 || after.grants !== 0 || after.conversations !== 0 || after.messages !== 0 || after.sessions !== 0) {
    console.error("\n  FAILED — rows remain after the purge; see cleanup.json in the private directory.\n");
    writePrivateJson(recordDir, CLEANUP_FILE, cleanupCountsRecord(env, before, after, new Date()));
    return 3;
  }
  pass("zero rows remain for the synthetic operator (user, grants, conversations, messages, sessions)");

  // (3) The Preview purge dispatch — printed, never run here.
  console.log("\n  NEXT (operator, not run by this script):");
  console.log("    npm run ops:platform-ai-conversations-purge -- --env=preview\n");

  // (4) Shred the credential file.
  shredFile(path.join(recordDir, CREDENTIALS_FILE));
  pass("credential file shredded (overwritten, then unlinked)");

  // (5) Counts-only cleanup record.
  writePrivateJson(recordDir, CLEANUP_FILE, cleanupCountsRecord(env, before, after, new Date()));
  pass("counts-only cleanup record written to the private directory (0600)");
  console.log(`\n  private directory: ${recordDir}`);
  console.log(`  cleanup deadline:  ${record.cleanupDeadline}\n`);
  return 0;
}

async function main(): Promise<void> {
  const decision = decideSyntheticOperator(process.argv.slice(2), process.env);
  if (!decision.ok) refuse(decision.reasons, false);

  // Imported only after the gate: constructing the client is the first contact with any database.
  const { db } = await import("@/lib/db");
  try {
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
