/**
 * scripts/test-b10-rehearsal-b10-probe.ts  (B10.6 rollback rehearsal — the B10-CODE side)
 *
 * Runs in the develop tree against the throwaway database AFTER the five B10
 * migrations. The orchestrator (scripts/test-b10-rollback-rehearsal.ts) spawns it
 * with the role URLs in the environment, so lib/db binds fm_app / fm_auth /
 * fm_system at module load exactly as production does.
 *
 * Phases (argv[2]):
 *   smoke       — sign-in, presence beat, incident read + operator acknowledge /
 *                 resolve, a B10 observation, AuditLog append (and DB-010's
 *                 refusals), balanceObserved, restrictedCash, v2 ciphertext.
 *   totp-claim  — a B10 TOTP sign-in that claims the current step (#256), run
 *                 immediately before the B9 rollback phase so B9 can present
 *                 the same code inside its window.
 *
 * Refuses to run (exit 1, nothing read) outside the orchestrator: see
 * scripts/lib/b10-rehearsal-guard.ts.
 *
 * Output: ONE line `@@B10REH <json>` on stdout. Synthetic data only.
 */

// ⚠️ THE GUARD RUNS FIRST (S2). It is the only static import: every application
// module — and so lib/db, which binds its clients at load — is imported
// DYNAMICALLY in loadApp(), after the guard has accepted the environment.
import { guardRehearsalProbe } from "./lib/b10-rehearsal-guard";

const GUARDED = guardRehearsalProbe();

// Type-only references (erased at runtime; no module is loaded by them).
let authOptions!: typeof import("@/lib/auth")["authOptions"];
let activeDbRoles!: typeof import("@/lib/db")["activeDbRoles"];
let authDb!: typeof import("@/lib/db")["authDb"];
let db!: typeof import("@/lib/db")["db"];
let systemDb!: typeof import("@/lib/db")["systemDb"];
let recordPresenceBeat!: typeof import("@/lib/auth/presence-activity")["recordPresenceBeat"];
let applyOperatorTransition!: typeof import("@/lib/platform/incidents/lifecycle")["applyOperatorTransition"];
let recordIncidentObservation!: typeof import("@/lib/platform/incidents/lifecycle")["recordIncidentObservation"];
let auditInsert!: typeof import("@/lib/audit")["auditInsert"];
let buildAuditData!: typeof import("@/lib/audit")["buildAuditData"];
let AuditAction!: typeof import("@/lib/audit-actions")["AuditAction"];
let regenerateSpaceSnapshot!: typeof import("@/lib/snapshots/regenerate")["regenerateSpaceSnapshot"];
let backfillSpaceSnapshots!: typeof import("@/lib/snapshots/backfill")["backfillSpaceSnapshots"];
let detectCiphertextVersion!: typeof import("@/lib/plaid/encryption")["detectCiphertextVersion"];
let encryptWithPurpose!: typeof import("@/lib/plaid/encryption")["encryptWithPurpose"];
let EncryptionPurpose!: typeof import("@/lib/plaid/encryption")["EncryptionPurpose"];
let generateTOTP!: typeof import("@/lib/totp")["generateTOTP"];

async function loadApp(): Promise<void> {
  ({ authOptions } = await import("@/lib/auth"));
  ({ activeDbRoles, authDb, db, systemDb } = await import("@/lib/db"));
  ({ recordPresenceBeat } = await import("@/lib/auth/presence-activity"));
  ({ applyOperatorTransition, recordIncidentObservation } = await import("@/lib/platform/incidents/lifecycle"));
  ({ auditInsert, buildAuditData } = await import("@/lib/audit"));
  ({ AuditAction } = await import("@/lib/audit-actions"));
  ({ regenerateSpaceSnapshot } = await import("@/lib/snapshots/regenerate"));
  ({ backfillSpaceSnapshots } = await import("@/lib/snapshots/backfill"));
  ({ detectCiphertextVersion, encryptWithPurpose, EncryptionPurpose } = await import("@/lib/plaid/encryption"));
  ({ generateTOTP } = await import("@/lib/totp"));
}

type Check = { id: string; claim: string; ok: boolean; detail: string };
const checks: Check[] = [];
const out: Record<string, unknown> = {};
const check = (id: string, claim: string, ok: boolean, detail: unknown = "") => {
  const d = typeof detail === "string" ? detail : JSON.stringify(detail);
  checks.push({ id, claim, ok, detail: d.slice(0, 600) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${id}  ${claim}${ok ? "" : `  -> ${d.slice(0, 300)}`}`);
};
const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).replace(/\s+/g, " ").slice(-400);
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: errText(e) }; }
}

const FIX = GUARDED.fix;
const STATE = GUARDED.state as { incidents?: Record<string, string> };
const phase = process.argv[2];

type Authorize = (c: Record<string, string>, r: { headers: Record<string, string> }) => Promise<{ id: string; sessionToken: string } | null>;
const authorize: Authorize = (c, r) => (authOptions.providers[0] as unknown as { options: { authorize: Authorize } }).options.authorize(c, r);
const signIn = (identifier: string, password: string, extra: Record<string, string> = {}) =>
  authorize({ identifier, password, ...extra }, { headers: { "user-agent": "b10-rehearsal" } });
type SessionCb = (a: { session: Record<string, unknown>; token: Record<string, unknown> }) => Promise<{ user?: { id?: string } }>;
const sessionFor = (userId: string, sessionToken: string) =>
  (authOptions.callbacks!.session as unknown as SessionCb)({
    session: { user: {}, expires: new Date(Date.now() + 3_600_000).toISOString() },
    token: { id: userId, sessionToken, role: "USER" },
  });

async function smoke(): Promise<void> {
  const roles = activeDbRoles();
  check("B0", "B10 lib/db bound distinct fm_app / fm_auth / fm_system clients", roles.app && roles.auth && roles.system, roles);

  // ── sign-in (PB-10: the session create returns every scalar, incl. the new columns) ──
  const login = await attempt(() => signIn(FIX.u1Name, FIX.password));
  const tok = login.ok ? login.value?.sessionToken : undefined;
  check("B1", "B10 sign-in creates a session (needs PB-10's columns: create returns all scalars)", login.ok && login.value?.id === FIX.u1 && !!tok, login.ok ? "" : login.error);
  if (tok) {
    out.b10SessionToken = tok;
    const s = await attempt(() => sessionFor(FIX.u1, tok));
    check("B2", "B10 session callback accepts the new session", s.ok && s.value?.user?.id === FIX.u1, s.ok ? s.value?.user : s.error);
    const s9 = await attempt(() => sessionFor(FIX.u1, String(process.env.B10REH_B9_SESSION ?? "")));
    check("B2b", "B10 session callback accepts a session B9 created before the migration", s9.ok && s9.value?.user?.id === FIX.u1, s9.ok ? s9.value?.user : s9.error);

    // ── presence beat ──
    const beat = await attempt(async () => recordPresenceBeat(authDb, tok, FIX.u1, true));
    const row = await db.userSession.findUnique({ where: { sessionToken: tok }, select: { lastPresenceAt: true, lastInteractionAt: true } });
    check("B3", "B10 presence beat writes lastPresenceAt + lastInteractionAt on fm_auth", beat.ok && beat.value === 1 && !!row?.lastPresenceAt && !!row?.lastInteractionAt, beat.ok ? { n: beat.value, row } : beat.error);
  }

  // ── incident read + operator acknowledge / resolve ──
  const inc = STATE.incidents ?? {};
  const read = await attempt(() => systemDb.syncIssue.findMany({ where: { id: { in: Object.values(inc) } } }));
  check("B4", "B10 incident read (full row, new PB-1 columns) of B9-written incidents; open ones have lifecycleState NULL",
    read.ok && read.value.length === Object.keys(inc).length && read.value.filter((r) => !r.resolved).every((r) => r.lifecycleState === null),
    read.ok ? read.value.map((r) => ({ resolved: r.resolved, state: r.lifecycleState })) : read.error);
  const actor = { userId: FIX.operator, via: "SYSTEM_ADMIN" as const };
  const reason = { code: "INCIDENT" as const, note: "rehearsal" };
  const ack = await attempt(() => applyOperatorTransition({ incidentId: inc.iA, transition: { action: "acknowledge" }, actor, reason }));
  check("B5", "B10 operator ACKNOWLEDGE commits (audit + event) on a B9-written incident", ack.ok && ack.value.ok && ack.value.changed === true, ack.ok ? ack.value : ack.error);
  const res = await attempt(() => applyOperatorTransition({ incidentId: inc.iB, transition: { action: "resolve", resolutionReasonCode: "OPERATOR_FIXED" }, actor, reason }));
  check("B6", "B10 operator RESOLVE commits (RESOLVED + resolved=true + audit + event) on a B9-written incident", res.ok && res.value.ok && res.value.changed === true, res.ok ? res.value : res.error);
  const after = await db.syncIssue.findMany({ where: { id: { in: [inc.iA, inc.iB] } }, select: { id: true, resolved: true, lifecycleState: true, acknowledgedAt: true } });
  const a = after.find((r) => r.id === inc.iA), b = after.find((r) => r.id === inc.iB);
  check("B7", "PB-1 constraint (a): acknowledged row stays OPEN with lifecycleState NULL; resolved row is RESOLVED/true",
    a?.resolved === false && a.lifecycleState === null && !!a.acknowledgedAt && b?.resolved === true && b.lifecycleState === "RESOLVED", after);

  // ── a B10 observation (writes subjectUserId / openedBy and a SyncIssueEvent) ──
  const obs = await attempt(() => recordIncidentObservation({
    kind: "TRANSACTION_PERSISTENCE_FAILED", plaidItemId: FIX.itemE, plaidTransactionId: "t-e",
    detail: { stage: "transaction-persist", cursorBlocking: true },
  }, systemDb, async () => null));
  const eRow = obs.ok && obs.value ? await db.syncIssue.findUnique({ where: { id: obs.value.incidentId }, select: { lifecycleState: true, openedBy: true } }) : null;
  check("B8", "B10 observation opens an incident with lifecycleState NULL (B9-rollback constraint)", obs.ok && !!obs.value?.created && eRow?.lifecycleState === null, { obs: obs.ok ? obs.value : obs.error, eRow });
  if (obs.ok && obs.value) out.iE = obs.value.incidentId;

  // ── AuditLog append + DB-010 refusals ──
  const ai = auditInsert(systemDb, buildAuditData({ actorId: FIX.operator, actorType: "SYSTEM_ADMIN", action: AuditAction.LOGIN, result: "SUCCESS", metadata: { rehearsal: true } }));
  const ins = await attempt(() => ai.write);
  check("B9", "AuditLog append on fm_system succeeds under DB-010", ins.ok && ins.value.count === 1, ins.ok ? ins.value : ins.error);
  const upd = await attempt(() => systemDb.auditLog.updateMany({ where: { id: ai.id }, data: { action: "TAMPERED" } }));
  check("B10", "DB-010 in effect: fm_system cannot UPDATE AuditLog.action (column grant)", !upd.ok && /permission denied/i.test(upd.error), upd.ok ? `UPDATED ${upd.value.count}` : upd.error.slice(-120));
  const del = await attempt(() => systemDb.auditLog.deleteMany({ where: { id: ai.id } }));
  check("B11", "DB-010 in effect: fm_system cannot DELETE a non-product-event AuditLog row (0 rows under fm_system_retain)", del.ok && del.value.count === 0, del.ok ? del.value : del.error);

  // ── FIN-A2 balanceObserved + FIN-E restrictedCash ──
  const unobs = await attempt(() => systemDb.financialAccount.create({
    data: { name: "Unobserved checking", type: "checking", institution: "Synthetic Bank", ownerType: "USER", ownerUserId: FIX.u1, createdByUserId: FIX.u1,
      balance: Number(FIX.unobservedStoredBalance), balanceObserved: false, currency: "USD" },
    select: { id: true, balanceObserved: true },
  }));
  const dflt = await attempt(() => systemDb.financialAccount.create({
    data: { name: "Default checking", type: "checking", institution: "Synthetic Bank", ownerType: "USER", ownerUserId: FIX.u1, createdByUserId: FIX.u1, balance: 1, currency: "USD" },
    select: { id: true, balanceObserved: true },
  }));
  check("B12", "FIN-A2: B10 writes balanceObserved=false explicitly; an insert without it gets the default true",
    unobs.ok && unobs.value.balanceObserved === false && dflt.ok && dflt.value.balanceObserved === true, { unobs: unobs.ok ? unobs.value.balanceObserved : unobs.error, dflt: dflt.ok ? dflt.value.balanceObserved : dflt.error });
  if (unobs.ok) {
    out.unobservedAccount = unobs.value.id;
    await db.spaceAccountLink.create({ data: { spaceId: FIX.space1, financialAccountId: unobs.value.id, kind: "HOME", status: "ACTIVE" } });
  }
  const regen = await attempt(() => regenerateSpaceSnapshot(FIX.space1));
  const today = await db.spaceSnapshot.findFirst({ where: { spaceId: FIX.space1 }, orderBy: { date: "desc" }, select: { date: true, cash: true, savings: true, restrictedCash: true } });
  check("B13", "FIN-E: B10 snapshot writer runs and writes a non-NULL restrictedCash on today's row", regen.ok && typeof today?.restrictedCash === "number", { regen: regen.ok ? "ok" : regen.error, today });
  check("B14", "FIN-A2: B10's snapshot excludes the unobserved account's stored balance from cash",
    !!today && Math.abs(today.cash - Number(FIX.expectedCashB10)) < 0.005, { cash: today?.cash, expected: Number(FIX.expectedCashB10) });
  out.b10Snapshot = today ? { date: today.date.toISOString().slice(0, 10), cash: today.cash, savings: today.savings, restrictedCash: today.restrictedCash } : null;

  await finEParity();

  // ── v2 ciphertext (no rotation in progress ⇒ B10 writes v2) ──
  // ONE registered writer (User.totpSecret, lib/plaid/encrypted-fields.test.ts): the same value
  // proves the format here and is decrypted by B9 twice (directly, and by B9's TOTP sign-in).
  const secretCt = encryptWithPurpose(FIX.totpSecret, EncryptionPurpose.TOTP_SECRET);
  await db.user.update({ where: { id: FIX.u2 }, data: { totpEnabled: true, totpSecret: secretCt } });
  check("B15", "B10 encryption with no ENCRYPTION_KEY_PREVIOUS writes v2 (rollback-readable): the TOTP user's secret", detectCiphertextVersion(secretCt) === "v2", detectCiphertextVersion(secretCt));
  out.b10Ciphertext = secretCt;
  out.b10Plaintext = FIX.totpSecret;
}

/**
 * FIN-E parity on real Postgres (S2, after #411): the LIVE writer and the BACKFILL
 * writer must agree on restrictedCash / cash / savings / netLiquid for the same
 * Space. Two dedicated Spaces (so the rollback checks on Space One are untouched):
 * one links an HSA savings account, one has no HSA. Their accounts have no
 * transactions, so every day's true balances are today's.
 *   1. backfillSpaceSnapshots writes the window up to YESTERDAY (it never writes today);
 *   2. regenerateSpaceSnapshot writes TODAY → compared with backfill's yesterday;
 *   3. regenerateSpaceSnapshot then rewrites YESTERDAY (the same day backfill wrote)
 *      → compared with the backfill values read in 1.
 */
async function finEParity(): Promise<void> {
  const COLS = ["restrictedCash", "cash", "savings", "netLiquid"] as const;
  type Cols = Record<(typeof COLS)[number], number | null>;
  const now = new Date();
  const todayD = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterdayD = new Date(todayD.getTime() - 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const rowAt = async (spaceId: string, d: Date): Promise<Cols | null> => {
    const r = await db.spaceSnapshot.findUnique({ where: { spaceId_date: { spaceId, date: d } }, select: { restrictedCash: true, cash: true, savings: true, netLiquid: true } });
    return r ? { restrictedCash: r.restrictedCash, cash: r.cash, savings: r.savings, netLiquid: r.netLiquid } : null;
  };
  const same = (a: Cols | null, b: Cols | null) => !!a && !!b && COLS.every((k) => a[k] !== null && b[k] !== null && Math.abs(a[k]! - b[k]!) < 0.005);
  const parity: Record<string, unknown> = {};

  for (const [tag, spaceId, expectedRestricted] of [["hsa", FIX.spaceHsa, Number(FIX.parityHsaBalance)], ["noHsa", FIX.spacePlain, 0]] as const) {
    const bfRun = await attempt(() => backfillSpaceSnapshots(spaceId));
    const bf = await rowAt(spaceId, yesterdayD);
    const liveRun = await attempt(() => regenerateSpaceSnapshot(spaceId));
    const liveToday = await rowAt(spaceId, todayD);
    const liveY = await attempt(() => regenerateSpaceSnapshot(spaceId, yesterdayD));
    const liveYesterday = await rowAt(spaceId, yesterdayD);
    parity[tag] = { backfillRows: bfRun.ok ? bfRun.value : bfRun.error, backfillYesterday: bf, liveToday, liveYesterday, yesterday: iso(yesterdayD) };
    const label = tag === "hsa" ? "WITH an HSA" : "with NO HSA";
    check(`FP-${tag}-1`, `FIN-E parity (${label}): backfill and the live writer both run and write their rows`,
      bfRun.ok && (bfRun.value ?? 0) > 0 && liveRun.ok && liveY.ok && !!bf && !!liveToday && !!liveYesterday, parity[tag]);
    check(`FP-${tag}-2`, `FIN-E parity (${label}): live TODAY = backfill's latest day on restrictedCash, cash, savings, netLiquid`, same(liveToday, bf), { liveToday, backfill: bf });
    check(`FP-${tag}-3`, `FIN-E parity (${label}): live rewrite of the SAME day backfill wrote = backfill, on all four`, same(liveYesterday, bf), { liveYesterday, backfill: bf });
    check(`FP-${tag}-4`, `FIN-E parity (${label}): restrictedCash = ${expectedRestricted} from both writers`,
      liveToday?.restrictedCash === expectedRestricted && bf?.restrictedCash === expectedRestricted, { live: liveToday?.restrictedCash, backfill: bf?.restrictedCash });
  }
  out.finEParity = parity;
}

async function totpClaim(): Promise<void> {
  const code = generateTOTP(FIX.totpSecret);
  const first = await attempt(() => signIn(FIX.u2Name, FIX.password, { totpCode: code }));
  const claims = await db.rateLimit.count({ where: { key: `user:totp-login-step:${FIX.u2}` } });
  check("T1", "#256: B10 TOTP sign-in succeeds and claims the step (one RateLimit claim row)", first.ok && first.value?.id === FIX.u2 && claims === 1, { first: first.ok ? !!first.value : first.error, claims });
  const replay = await attempt(() => signIn(FIX.u2Name, FIX.password, { totpCode: code }));
  check("T2", "#256: B10 refuses the same code again (replay blocked)", replay.ok && replay.value === null, replay.ok ? JSON.stringify(replay.value) : replay.error);
  out.b10TotpCode = code;
}

async function main() {
  console.log(`\n--- B10 probe: ${phase} ---`);
  await loadApp();
  if (phase === "smoke") await smoke();
  else if (phase === "totp-claim") await totpClaim();
  else throw new Error(`unknown phase ${phase}`);
}

main()
  .catch((e) => { check("FATAL", `B10 probe ${phase} crashed`, false, errText(e)); })
  .finally(async () => {
    console.log(`@@B10REH ${JSON.stringify({ side: "B10", phase, checks, out })}`);
    await Promise.allSettled([db, authDb, systemDb].filter(Boolean).map((c) => c.$disconnect()));
    process.exit(0);
  });
