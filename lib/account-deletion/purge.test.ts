/**
 * lib/account-deletion/purge.test.ts  (IDEMP-002 · PRIV-001 · DB-002 · DB-011)
 *
 * Behavioural proof of the purge over an in-memory fake that evaluates the
 * where-clauses the way Postgres would. Standalone tsx (house pattern):
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/account-deletion/purge.test.ts
 *
 * Covers the runtime-confirmed defects:
 *   1. two concurrent workers ⇒ exactly ONE destructive tail, one ACCOUNT_DELETED
 *      row, one e-mail, one itemRemove (the audit observed 4 rows for 2 users);
 *   2. a cancel between the claim and the tail ⇒ nothing irreversible;
 *   3. a crash mid-tail ⇒ the transaction leaves the user intact, the claim
 *      blocks a live retry, a STALE claim is re-claimable, and the completed
 *      retry still writes exactly one audit row and calls itemRemove once;
 *   4. PRIV-001 / DB-011: a SHARED Space whose only active member is the user
 *      dies with its Space-owned accounts; a SHARED Space with another active
 *      member survives with its accounts;
 *   5. DB-002: the soft references are scrubbed inside the same transaction;
 *   6. a provider HOLD releases the claim and destroys nothing.
 */

process.env.ENCRYPTION_KEY ??= "0".repeat(64);

import { encryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { AuditAction } from "@/lib/audit-actions";
import {
  purgeUser, purgeClaimWhere, soleMemberSharedSpaceWhere, PURGE_CLAIM_STALE_MS,
  type PurgeClient, type PurgeDeps,
} from "@/lib/account-deletion/purge";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

const T0 = new Date("2026-10-22T07:00:00Z");
const TOKEN = encryptWithPurpose("access-sandbox-test-token", EncryptionPurpose.PLAID_ACCESS_TOKEN);
const USER = "user_1";
const OTHER = "user_2";

// ── The fake world ────────────────────────────────────────────────────────────

type Member = { userId: string; role: string; status: string };
interface World {
  users: Array<{ id: string; email: string; deletionScheduledAt: Date | null; purgeStartedAt: Date | null }>;
  spaces: Array<{ id: string; type: string; platformArea: string | null; members: Member[] }>;
  accounts: Array<{ id: string; ownerUserId: string | null; ownerSpaceId: string | null; syncStatus: string }>;
  items: Array<{ id: string; userId: string; status: string; encryptedToken: string; institutionName: string }>;
  audits: Array<{ userId: string | null; action: string; metadata: Record<string, unknown>; createdAt: Date }>;
  links: Array<{ id: string; addedByUserId: string; status: string }>;
  aiInvocations: Array<{ id: string; userId: string | null }>;
  betaRequests: Array<{ id: string; email: string }>;
  betaEvents: Array<{ id: string; email: string }>;
  mergeDecisions: Array<{ id: string; decidedByUserId: string | null }>;
  settings: Array<{ key: string; updatedById: string | null }>;
  merchantRules: Array<{ id: string; ownerUserId: string | null }>;
}

function baseWorld(): World {
  return {
    users: [{ id: USER, email: "Jane@Example.com", deletionScheduledAt: new Date(T0.getTime() - 86_400_000), purgeStartedAt: null }],
    spaces: [
      { id: "P1", type: "PERSONAL", platformArea: null, members: [{ userId: USER, role: "OWNER", status: "ACTIVE" }] },
      { id: "S1", type: "SHARED", platformArea: null, members: [{ userId: USER, role: "OWNER", status: "ACTIVE" }, { userId: OTHER, role: "MEMBER", status: "LEFT" }] },
      { id: "S2", type: "SHARED", platformArea: null, members: [{ userId: USER, role: "OWNER", status: "ACTIVE" }, { userId: OTHER, role: "OWNER", status: "ACTIVE" }] },
      { id: "S3", type: "SHARED", platformArea: null, members: [{ userId: OTHER, role: "OWNER", status: "ACTIVE" }, { userId: USER, role: "VIEWER", status: "REMOVED" }] },
      { id: "PLAT", type: "SHARED", platformArea: "PLATFORM_OPS", members: [] },
    ],
    accounts: [
      { id: "A1", ownerUserId: USER, ownerSpaceId: null, syncStatus: "synced" },
      { id: "A2", ownerUserId: null, ownerSpaceId: "S1", syncStatus: "synced" },
      { id: "A3", ownerUserId: null, ownerSpaceId: "S2", syncStatus: "synced" },
      { id: "A4", ownerUserId: null, ownerSpaceId: "P1", syncStatus: "synced" },
      { id: "A5", ownerUserId: OTHER, ownerSpaceId: null, syncStatus: "synced" },
    ],
    items: [{ id: "pi_1", userId: USER, status: "ACTIVE", encryptedToken: TOKEN, institutionName: "Chase" }],
    audits: [],
    links: [{ id: "L1", addedByUserId: USER, status: "ACTIVE" }],
    aiInvocations: [{ id: "ai1", userId: USER }, { id: "ai2", userId: OTHER }],
    betaRequests: [{ id: "b1", email: "jane@example.com" }, { id: "b2", email: "someone@else.com" }],
    betaEvents: [{ id: "e1", email: "JANE@example.com" }],
    mergeDecisions: [{ id: "m1", decidedByUserId: USER }],
    settings: [{ key: "k", updatedById: USER }],
    merchantRules: [{ id: "r1", ownerUserId: USER }, { id: "r2", ownerUserId: OTHER }],
  };
}

interface Hooks {
  afterClaim?: () => void;
  failTailOnce?: boolean;
}

function makeFake(world: World, hooks: Hooks = {}) {
  const stats = { tails: 0, claims: 0, txCommits: 0 };
  const yieldTick = () => new Promise<void>((r) => setImmediate(r));
  const W = world;
  const userUpdateMany = async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    await yieldTick();
    const u = W.users.find((x) => x.id === where.id);
    if (!u) return { count: 0 };
    const lte = (where.deletionScheduledAt as { lte?: Date } | undefined)?.lte;
    if (lte !== undefined && !(u.deletionScheduledAt !== null && u.deletionScheduledAt.getTime() <= lte.getTime())) return { count: 0 };
    if (where.OR) {
      const or = where.OR as Array<Record<string, unknown>>;
      const ok = or.some((c) => {
        if (c.purgeStartedAt === null) return u.purgeStartedAt === null;
        const stale = (c.purgeStartedAt as { lte?: Date }).lte!;
        return u.purgeStartedAt !== null && u.purgeStartedAt.getTime() <= stale.getTime();
      });
      if (!ok) return { count: 0 };
    }
    if (where.purgeStartedAt instanceof Date && (u.purgeStartedAt === null || u.purgeStartedAt.getTime() !== where.purgeStartedAt.getTime())) return { count: 0 };
    Object.assign(u, data);
    if (where.OR) { stats.claims++; hooks.afterClaim?.(); }
    return { count: 1 };
  };
  const memberMatches = (m: Member, c: Record<string, unknown>) =>
    (c.userId === undefined || (typeof c.userId === "string" ? m.userId === c.userId : m.userId !== (c.userId as { not: string }).not))
    && (c.role === undefined || m.role === c.role) && (c.status === undefined || m.status === c.status);
  const spaceMatches = (s: World["spaces"][number], where: Record<string, unknown>) => {
    if (typeof where.type === "string" && s.type !== where.type) return false;
    if (typeof where.type === "object" && where.type && s.type === (where.type as { not: string }).not) return false;
    if (where.platformArea === null && s.platformArea !== null) return false;
    const some = (where.members as { some: Record<string, unknown> } | undefined)?.some;
    if (some && !s.members.some((m) => memberMatches(m, some))) return false;
    const notSome = ((where.NOT as { members?: { some: Record<string, unknown> } } | undefined)?.members)?.some;
    if (notSome && s.members.some((m) => memberMatches(m, notSome))) return false;
    return true;
  };
  const tx = {
    user: { updateMany: userUpdateMany, delete: async ({ where }: { where: { id: string } }) => {
      const i = W.users.findIndex((u) => u.id === where.id); if (i < 0) throw new Error("P2025");
      W.users.splice(i, 1); W.audits.forEach((a) => { if (a.userId === where.id) a.userId = null; });
      W.items = W.items.filter((it) => it.userId !== where.id); return {};
    } },
    financialAccount: {
      deleteMany: async ({ where }: { where: { OR: Array<Record<string, unknown>> } }) => {
        const before = W.accounts.length;
        W.accounts = W.accounts.filter((a) => !where.OR.some((c) =>
          (c.ownerUserId !== undefined && a.ownerUserId === c.ownerUserId)
          || (c.ownerSpaceId !== undefined && a.ownerSpaceId !== null && (c.ownerSpaceId as { in: string[] }).in.includes(a.ownerSpaceId))));
        return { count: before - W.accounts.length };
      },
      update: async () => ({}),
    },
    space: {
      delete: async ({ where }: { where: { id: string } }) => {
        if (hooks.failTailOnce) { hooks.failTailOnce = false; throw new Error("connection reset mid-tail"); }
        W.spaces = W.spaces.filter((s) => s.id !== where.id); return {};
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => W.spaces.filter((s) => spaceMatches(s, where)).map((s) => ({ id: s.id })),
    },
    aiInvocation: { updateMany: async ({ where, data }: { where: { userId: string }; data: { userId: null } }) => {
      let n = 0; W.aiInvocations.forEach((r) => { if (r.userId === where.userId) { r.userId = data.userId; n++; } }); return { count: n };
    } },
    betaAccessRequest: { deleteMany: async ({ where }: { where: { email: { equals: string } } }) => {
      const b = W.betaRequests.length; W.betaRequests = W.betaRequests.filter((r) => r.email.toLowerCase() !== where.email.equals.toLowerCase()); return { count: b - W.betaRequests.length };
    } },
    betaAccessRequestEvent: { deleteMany: async ({ where }: { where: { email: { equals: string } } }) => {
      const b = W.betaEvents.length; W.betaEvents = W.betaEvents.filter((r) => r.email.toLowerCase() !== where.email.equals.toLowerCase()); return { count: b - W.betaEvents.length };
    } },
    merchantMergeDecision: { updateMany: async ({ where }: { where: { decidedByUserId: string } }) => {
      let n = 0; W.mergeDecisions.forEach((r) => { if (r.decidedByUserId === where.decidedByUserId) { r.decidedByUserId = null; n++; } }); return { count: n };
    } },
    platformSetting: { updateMany: async ({ where }: { where: { updatedById: string } }) => {
      let n = 0; W.settings.forEach((r) => { if (r.updatedById === where.updatedById) { r.updatedById = null; n++; } }); return { count: n };
    } },
    investmentEvent: { updateMany: async () => ({ count: 0 }) },
    merchantRule: { deleteMany: async ({ where }: { where: { ownerUserId: string } }) => {
      const b = W.merchantRules.length; W.merchantRules = W.merchantRules.filter((r) => r.ownerUserId !== where.ownerUserId); return { count: b - W.merchantRules.length };
    } },
    auditLog: {
      create: async ({ data }: { data: { userId?: string | null; action: string; metadata?: unknown } }) => {
        W.audits.push({ userId: data.userId ?? null, action: data.action, metadata: (data.metadata ?? {}) as Record<string, unknown>, createdAt: new Date() }); return {};
      },
      findMany: async ({ where }: { where: { userId: string; action: string } }) =>
        W.audits.filter((a) => a.userId === where.userId && a.action === where.action).map((a) => ({ createdAt: a.createdAt })),
    },
  };
  const client = {
    ...tx,
    user: { ...tx.user, findUnique: async ({ where }: { where: { id: string } }) => { await yieldTick(); const u = W.users.find((x) => x.id === where.id); return u ? { ...u } : null; } },
    plaidItem: {
      findMany: async ({ where }: { where: { userId: string; status: string } }) =>
        W.items.filter((i) => i.userId === where.userId && i.status === where.status).map((i) => ({ id: i.id, encryptedToken: i.encryptedToken, institutionName: i.institutionName })),
      update: async ({ where, data }: { where: { id: string }; data: { status?: string } }) => { const i = W.items.find((x) => x.id === where.id); if (i && data.status) i.status = data.status; return {}; },
    },
    spaceAccountLink: { updateMany: async ({ where, data }: { where: { addedByUserId: string; status: string }; data: { status: string } }) => {
      let n = 0; W.links.forEach((l) => { if (l.addedByUserId === where.addedByUserId && l.status === where.status) { l.status = data.status; n++; } }); return { count: n };
    } },
    accountConnection: { findMany: async () => [], findFirst: async () => null, update: async () => ({}) },
    $transaction: async <T,>(fn: (t: typeof tx) => Promise<T>) => {
      const snapshot = JSON.stringify(W);
      stats.tails++;
      try { const r = await fn(tx); stats.txCommits++; return r; }
      catch (e) { Object.assign(W, JSON.parse(snapshot, (k, v) => (k.endsWith("At") && typeof v === "string" ? new Date(v) : v))); throw e; }
    },
  };
  return { client: client as unknown as PurgeClient, stats };
}

function depsFor(fake: ReturnType<typeof makeFake>, over: Partial<PurgeDeps> & { removeFails?: boolean } = {}) {
  const calls = { itemRemove: 0, emails: 0, revoke: 0 };
  const deps: PurgeDeps = {
    client: fake.client,
    plaid: { itemRemove: (async () => {
      calls.itemRemove++;
      if (over.removeFails) throw { isAxiosError: true, response: { status: 500, data: { error_code: "INTERNAL_SERVER_ERROR", error_type: "API_ERROR" } }, message: "boom" };
      return {} as never;
    }) as never },
    sendEmail: (async () => { calls.emails++; return { status: "sent" as const, id: "m" }; }) as never,
    revokeSessions: async () => { calls.revoke++; return 0; },
    now: over.now ?? (() => T0),
  };
  return { deps, calls };
}

const quiet = <T,>(fn: () => Promise<T>) => {
  const o = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  return fn().finally(() => Object.assign(console, o));
};

async function main() {
  console.log("predicates");
  {
    const w = purgeClaimWhere(USER, T0);
    check("claim matches only a due row with no live claim", w.id === USER && (w.deletionScheduledAt as { lte: Date }).lte === T0
      && Array.isArray(w.OR) && w.OR.length === 2 && w.OR[0].purgeStartedAt === null
      && (w.OR[1].purgeStartedAt as { lte: Date }).lte.getTime() === T0.getTime() - PURGE_CLAIM_STALE_MS);
    const s = soleMemberSharedSpaceWhere(USER);
    check("sole-member predicate: non-PERSONAL, no platform area, the user ACTIVE, nobody else ACTIVE",
      (s.type as { not: string }).not === "PERSONAL" && s.platformArea === null && !!s.members && !!s.NOT);
  }

  console.log("\n1. two concurrent workers ⇒ exactly one destructive tail");
  {
    const fake = makeFake(baseWorld());
    const { deps, calls } = depsFor(fake);
    const [a, b] = await quiet(() => Promise.all([purgeUser(USER, deps), purgeUser(USER, deps)]));
    const outcomes = [a, b].map((r) => (r.purged ? "purged" : r.skipped)).sort().join(",");
    check("one purged, one claimed-elsewhere", outcomes === "claimed-elsewhere,purged", outcomes);
    check("exactly one transaction tail ran", fake.stats.tails === 1, `${fake.stats.tails}`);
    check("exactly one ACCOUNT_DELETED row (the audit observed two per user)",
      (await countAudit(fake, AuditAction.ACCOUNT_DELETED)) === 1);
    check("exactly one deletion e-mail", calls.emails === 1, `${calls.emails}`);
    check("exactly one itemRemove", calls.itemRemove === 1, `${calls.itemRemove}`);
    check("the user is gone", !(await userExists(fake)));
  }

  console.log("\n2. cancel between the claim and the tail ⇒ nothing irreversible");
  {
    const world = baseWorld();
    const fake = makeFake(world, { afterClaim: () => { world.users[0].deletionScheduledAt = null; } });
    const { deps, calls } = depsFor(fake);
    const r = await quiet(() => purgeUser(USER, deps));
    check("reported as cancelled", r.skipped === "cancelled" && !r.purged);
    check("the user row survives", world.users.length === 1);
    check("no account, no Space deleted", world.accounts.length === 5 && world.spaces.length === 5);
    check("no ACCOUNT_DELETED row, no e-mail", (await countAudit(fake, AuditAction.ACCOUNT_DELETED)) === 0 && calls.emails === 0);
  }

  console.log("\n3. crash mid-tail ⇒ atomic, claim-fenced retry");
  {
    const world = baseWorld();
    const fake = makeFake(world, { failTailOnce: true });
    const { deps, calls } = depsFor(fake);
    let threw = false;
    try { await quiet(() => purgeUser(USER, deps)); } catch { threw = true; }
    check("the first run throws (the job records a failure and retries next run)", threw);
    check("the transaction rolled back: user, accounts and Spaces intact", world.users.length === 1 && world.accounts.length === 5 && world.spaces.length === 5);
    check("the claim is still held", world.users[0].purgeStartedAt !== null);
    check("the provider item was already revoked once (not retried)", calls.itemRemove === 1 && world.items[0].status === "REVOKED");
    const live = await quiet(() => purgeUser(USER, deps));
    check("a retry while the claim is live is refused", live.skipped === "claimed-elsewhere");
    const later = { ...deps, now: () => new Date(T0.getTime() + PURGE_CLAIM_STALE_MS + 1) };
    const r = await quiet(() => purgeUser(USER, later));
    check("a retry after the claim went stale completes", r.purged === true);
    check("itemRemove was never called again", calls.itemRemove === 1);
    check("still exactly one ACCOUNT_DELETED row and one e-mail", (await countAudit(fake, AuditAction.ACCOUNT_DELETED)) === 1 && calls.emails === 1);
  }

  console.log("\n4. PRIV-001 / DB-011 — sole-member SHARED Spaces die with their accounts");
  {
    const world = baseWorld();
    const fake = makeFake(world);
    const { deps } = depsFor(fake);
    const r = await quiet(() => purgeUser(USER, deps));
    const spaces = world.spaces.map((s) => s.id).sort().join();
    check("PERSONAL and sole-member SHARED Spaces deleted; shared-with-others, left-by-user and platform Spaces survive",
      spaces === "PLAT,S2,S3", spaces);
    const accounts = world.accounts.map((a) => a.id).sort().join();
    check("USER-owned and dying-Space-owned accounts deleted; the surviving Space's account and the other user's account remain",
      accounts === "A3,A5", accounts);
    check("the result counts both classes", r.personalSpaces === 1 && r.soleMemberSharedSpaces === 1 && r.deletedAccounts === 3,
      JSON.stringify({ p: r.personalSpaces, s: r.soleMemberSharedSpaces, a: r.deletedAccounts }));
    const audit = world.audits.find((a) => a.action === AuditAction.ACCOUNT_DELETED)!;
    check("the audit row is anonymised: hashed e-mail only, userId SetNull'd", audit.userId === null
      && typeof audit.metadata.emailHash === "string" && !JSON.stringify(audit.metadata).toLowerCase().includes("example.com"));
  }

  console.log("\n5. DB-002 — soft references scrubbed in the same transaction");
  {
    const world = baseWorld();
    const fake = makeFake(world);
    const { deps } = depsFor(fake);
    await quiet(() => purgeUser(USER, deps));
    check("AiInvocation.userId nulled for the subject only", world.aiInvocations.find((r) => r.id === "ai1")!.userId === null && world.aiInvocations.find((r) => r.id === "ai2")!.userId === OTHER);
    check("BetaAccessRequest + events for the e-mail deleted (case-insensitive), others kept",
      world.betaRequests.map((r) => r.id).join() === "b2" && world.betaEvents.length === 0);
    check("MerchantMergeDecision.decidedByUserId and PlatformSetting.updatedById nulled",
      world.mergeDecisions[0].decidedByUserId === null && world.settings[0].updatedById === null);
    check("the user's MerchantRules deleted, the other user's kept", world.merchantRules.map((r) => r.id).join() === "r2");
    check("SALs the user added are REVOKED", world.links[0].status === "REVOKED");
  }

  console.log("\n6. provider HOLD releases the claim and destroys nothing");
  {
    const world = baseWorld();
    const fake = makeFake(world);
    const { deps, calls } = depsFor(fake, { removeFails: true });
    const r = await quiet(() => purgeUser(USER, deps));
    check("held", r.skipped === "pending-provider-revocation");
    check("claim released for tomorrow's worker", world.users[0].purgeStartedAt === null);
    check("nothing deleted, no tail, no e-mail", world.accounts.length === 5 && fake.stats.tails === 0 && calls.emails === 0);
  }

  console.log("\n7. not-due and already-deleted short-circuit before any claim");
  {
    const world = baseWorld(); world.users[0].deletionScheduledAt = new Date(T0.getTime() + 1);
    const fake = makeFake(world); const { deps } = depsFor(fake);
    check("not due", (await quiet(() => purgeUser(USER, deps))).skipped === "not-due" && fake.stats.claims === 0);
    check("already deleted", (await quiet(() => purgeUser("ghost", deps))).skipped === "already-deleted");
  }

  if (failures > 0) { console.error(`\n❌ purge: ${failures} check(s) failed`); process.exit(1); }
  console.log("\n✅ purge: all checks passed");
}

async function countAudit(fake: ReturnType<typeof makeFake>, action: string): Promise<number> {
  const rows = await (fake.client.auditLog as unknown as { findMany: (a: unknown) => Promise<unknown[]> }).findMany({ where: { userId: null, action } });
  // findMany above filters on userId === null (post-delete rows); count those with the action.
  return rows.length;
}
async function userExists(fake: ReturnType<typeof makeFake>): Promise<boolean> {
  return (await fake.client.user.findUnique({ where: { id: USER }, select: { id: true, email: true, deletionScheduledAt: true, purgeStartedAt: true } })) !== null;
}

main().catch((e) => { console.error(e); process.exit(1); });
