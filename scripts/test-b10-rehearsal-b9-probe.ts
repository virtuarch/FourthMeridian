/**
 * scripts/test-b10-rehearsal-b9-probe.ts  (B10.6 rollback rehearsal — the B9-CODE side)
 *
 * ⚠️ THIS FILE RUNS AGAINST B9's CODE, NOT develop's. The orchestrator
 * (scripts/test-b10-rollback-rehearsal.ts) copies it into a worktree of origin/main
 * (B9) that has its OWN `npm ci` + `prisma generate`, and runs it there with
 * that tree's tsx, so `@/…` resolves to B9's modules and `@prisma/client` is
 * B9's generated client — i.e. exactly what an app rollback would serve.
 *
 * That is why every application import below goes through `imp()` with a
 * computed specifier: develop's `tsc` must not type-check these calls against
 * develop's signatures (they are B9's). The shapes used are the ones B9 exports
 * at `dc76711`; the orchestrator fails loudly if any import or call breaks.
 *
 * Phases (argv[2]):
 *   pre       — B9 schema, B9 code: the baseline smoke before any B10 migration.
 *   rollback  — B10 SCHEMA (kept), B9 code: the app-rollback claims of B10.2a/B10.4.
 *
 * Input: env B10REH_FIX (fixture ids, JSON) and B10REH_STATE (values earlier
 * phases handed over), both REQUIRED; refuses (exit 1, nothing read) outside the
 * orchestrator — scripts/lib/b10-rehearsal-guard.ts. Output: ONE line `@@B10REH <json>` on stdout. Synthetic
 * data only; no figures from any real environment.
 */

// ⚠️ THE GUARD RUNS FIRST (S2), before any application module (and so lib/db)
// is imported — every app import below is dynamic. The orchestrator copies the
// guard into the B9 tree at scripts/lib/b10-rehearsal-guard.ts beside this file.
import { guardRehearsalProbe } from "./lib/b10-rehearsal-guard";

const GUARDED = guardRehearsalProbe();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const imp = (spec: string): Promise<Any> => import(spec);

type Check = { id: string; claim: string; ok: boolean; detail: string };
const checks: Check[] = [];
const out: Record<string, unknown> = {};
const check = (id: string, claim: string, ok: boolean, detail: unknown = "") => {
  const d = typeof detail === "string" ? detail : JSON.stringify(detail);
  checks.push({ id, claim, ok, detail: d.slice(0, 600) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${id}  ${claim}${ok ? "" : `  -> ${d.slice(0, 300)}`}`);
};
const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).replace(/\s+/g, " ").slice(-400);
async function attempt(fn: () => Promise<Any>): Promise<{ ok: true; value: Any } | { ok: false; error: string }> {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: errText(e) }; }
}

const FIX = GUARDED.fix;
const STATE = GUARDED.state as Record<string, Any>;
const phase = process.argv[2];

async function signIn(identifier: string, password: string, extra: Record<string, string> = {}) {
  const { authOptions } = await imp("@/lib/auth");
  const provider = authOptions.providers[0] as Any;
  return provider.options.authorize({ identifier, password, ...extra }, { headers: { "user-agent": "b10-rehearsal" } });
}
async function sessionFor(userId: string, sessionToken: string, role = "USER") {
  const { authOptions } = await imp("@/lib/auth");
  const s = await authOptions.callbacks.session({
    session: { user: {}, expires: new Date(Date.now() + 3_600_000).toISOString() },
    token: { id: userId, sessionToken, role },
  });
  return s as Any;
}

async function pre(): Promise<void> {
  const dbMod = await imp("@/lib/db");
  const { systemDb } = dbMod;
  const roles = dbMod.activeDbRoles();
  check("P0", "B9 lib/db bound distinct fm_app / fm_auth / fm_system clients", roles.app && roles.auth && roles.system, roles);

  const login = await attempt(() => signIn(FIX.u1Name, FIX.password));
  const tok = login.ok ? (login.value?.sessionToken as string | undefined) : undefined;
  check("P1", "B9 sign-in (authorize on fm_auth) creates a session on the B9 schema", login.ok && login.value?.id === FIX.u1 && !!tok, login.ok ? { id: login.value?.id } : login.error);
  if (tok) {
    const s = await attempt(() => sessionFor(FIX.u1, tok));
    check("P2", "B9 session callback accepts the session it created", s.ok && s.value?.user?.id === FIX.u1, s.ok ? s.value?.user : s.error);
    out.b9PreSessionToken = tok;
  }

  const { recordIncidentObservation, resolveByAutomaticRecovery } = await imp("@/lib/platform/incidents/lifecycle");
  const blocking = (item: string, t: string) => ({
    kind: "TRANSACTION_PERSISTENCE_FAILED", plaidItemId: item, plaidTransactionId: t,
    detail: { stage: "transaction-persist", cursorBlocking: true },
  });
  const ids: Record<string, string> = {};
  for (const [k, item] of [["i0", FIX.item0], ["iA", FIX.itemA], ["iB", FIX.itemB], ["iC", FIX.itemC]] as const) {
    const r = await attempt(() => recordIncidentObservation(blocking(item, `t-${k}`), systemDb, async () => null));
    if (r.ok && r.value?.incidentId) ids[k] = r.value.incidentId;
  }
  const inv = await attempt(() => recordIncidentObservation({
    kind: "INVESTMENT_DATA_PERSISTENCE_FAILED", financialAccountId: FIX.faChecking,
    detail: { stage: "investment-import-repair", error: "synthetic" },
  }, systemDb, async () => null));
  if (inv.ok && inv.value?.incidentId) ids.iD = inv.value.incidentId;
  check("P3", "B9 incident writer opens 5 conditions (4 cursor-blocking on 4 items, 1 investments)", Object.keys(ids).length === 5, ids);
  out.incidents = ids;

  const r0 = await attempt(() => resolveByAutomaticRecovery({ plaidItemId: FIX.item0, domain: "transactions", runId: null }, systemDb, async () => null));
  check("P4", "B9 automatic recovery resolves its incident on the B9 schema", r0.ok && r0.value.resolved === 1, r0.ok ? r0.value : r0.error);

  const fa = await attempt(() => systemDb.financialAccount.create({
    data: { name: "B9 pre account", type: "checking", institution: "Synthetic Bank", ownerType: "USER", ownerUserId: FIX.u1, createdByUserId: FIX.u1, balance: 10, currency: "USD" },
    select: { id: true },
  }));
  check("P5", "B9 FinancialAccount insert (fm_system) succeeds on the B9 schema", fa.ok, fa.ok ? "" : fa.error);
  if (fa.ok) out.b9PreAccount = fa.value.id;

  const { regenerateSpaceSnapshot } = await imp("@/lib/snapshots/regenerate");
  const snap = await attempt(() => regenerateSpaceSnapshot(FIX.space1));
  check("P6", "B9 snapshot writer (regenerateSpaceSnapshot) succeeds on the B9 schema", snap.ok, snap.ok ? "" : snap.error);

  const { runDataRetention } = await imp("@/jobs/data-retention");
  const { retainProductEvents } = await imp("@/jobs/product-event-retention");
  const dr = await attempt(() => runDataRetention());
  const tableErrors = dr.ok ? Object.entries(dr.value).filter(([, v]) => v && typeof v === "object" && (v as Any).error).map(([k, v]) => `${k}: ${(v as Any).error}`) : [];
  check("P7", "B9 data retention (incl. beta-intake minimisation) runs clean on the B9 schema; baseline aged rows minimised",
    dr.ok && tableErrors.length === 0 && dr.value.betaIntakeNetwork?.minimised === Number(FIX.agedBetaCount) && !dr.value.betaIntakeNetwork?.error,
    dr.ok ? { tableErrors, minimised: dr.value.betaIntakeNetwork?.minimised } : dr.error);
  const pe = await attempt(() => retainProductEvents());
  check("P8", "B9 product-event retention deletes the baseline aged product events on the B9 schema",
    pe.ok && pe.value.deleted === Number(FIX.agedProductCount), pe.ok ? pe.value : pe.error);
}

async function rollback(): Promise<void> {
  const dbMod = await imp("@/lib/db");
  const { systemDb, db } = dbMod;
  const roles = dbMod.activeDbRoles();
  check("R0", "B9 lib/db bound distinct fm_app / fm_auth / fm_system clients (against the B10 schema)", roles.app && roles.auth && roles.system, roles);

  // ── #256 + v2 ciphertext: B10 claimed this TOTP step and wrote the secret. ──
  const claimRows = await db.rateLimit.count({ where: { key: `user:totp-login-step:${FIX.u2}` } });
  const t1 = await attempt(() => signIn(FIX.u2Name, FIX.password, { totpCode: STATE.b10TotpCode }));
  check("R1", "#256: B9 TOTP sign-in succeeds while B10's step-claim RateLimit row exists (B9 ignores claim rows)",
    claimRows >= 1 && t1.ok && t1.value?.id === FIX.u2, { claimRows, result: t1.ok ? (t1.value ? "signed-in" : "null") : t1.error });
  const t2 = await attempt(() => signIn(FIX.u2Name, FIX.password, { totpCode: STATE.b10TotpCode }));
  check("R1b", "#256 rollback note holds: B9 accepts the SAME code again (replay window reopens, as documented)", t2.ok && t2.value?.id === FIX.u2, t2.ok ? (t2.value ? "signed-in" : "null") : t2.error);
  const claimAfter = await db.rateLimit.count({ where: { key: `user:totp-login-step:${FIX.u2}` } });
  check("R1c", "#256: B9 neither writes nor removes step-claim rows", claimAfter === claimRows, { before: claimRows, after: claimAfter });

  const { decryptWithPurpose, detectCiphertextVersion, EncryptionPurpose } = await imp("@/lib/plaid/encryption");
  const v = detectCiphertextVersion(STATE.b10Ciphertext);
  const dec = await attempt(async () => decryptWithPurpose(STATE.b10Ciphertext, EncryptionPurpose.TOTP_SECRET));
  check("R2", "v2 ciphertext: the TOTP secret B10 encrypted (no rotation in progress) is v2 and B9 decrypts it", v === "v2" && dec.ok && dec.value === STATE.b10Plaintext, { version: v, decrypted: dec.ok ? dec.value === STATE.b10Plaintext : dec.error });

  // ── sign-in + sessions with the PB-10 columns present ──
  const login = await attempt(() => signIn(FIX.u1Name, FIX.password));
  const tok = login.ok ? (login.value?.sessionToken as string | undefined) : undefined;
  check("R3", "PB-10: B9 sign-in creates a session with lastPresenceAt/lastInteractionAt present in the schema", login.ok && !!tok, login.ok ? "" : login.error);
  if (tok) {
    out.b9RollbackSessionToken = tok;
    const s = await attempt(() => sessionFor(FIX.u1, tok));
    check("R4", "PB-10: B9 session callback accepts its own new session", s.ok && s.value?.user?.id === FIX.u1, s.ok ? s.value?.user : s.error);
  }
  const s10 = await attempt(() => sessionFor(FIX.u1, STATE.b10SessionToken));
  check("R5", "PB-10: B9 session callback accepts a session B10 created (presence columns written by B10)", s10.ok && s10.value?.user?.id === FIX.u1, s10.ok ? s10.value?.user : s10.error);
  const sessRead = await attempt(() => db.userSession.findMany({ where: { userId: FIX.u1 } }));
  check("R6", "PB-10: B9 full-row UserSession reads succeed (B9 client ignores the extra columns)", sessRead.ok && sessRead.value.length >= 2, sessRead.ok ? sessRead.value.length : sessRead.error);

  // ── PB-1: automatic recovery on the B10 schema ──
  const { recordIncidentObservation, resolveByAutomaticRecovery } = await imp("@/lib/platform/incidents/lifecycle");
  const auto = async (item: string) => attempt(() => resolveByAutomaticRecovery({ plaidItemId: item, domain: "transactions", runId: null }, systemDb, async () => null));
  const rA = await auto(FIX.itemA);
  check("R7", "PB-1: B9 auto-resolve of an incident B10 ACKNOWLEDGED succeeds (CHECKs pass on a NULL-state row)", rA.ok && rA.value.resolved === 1, rA.ok ? rA.value : rA.error);
  const rC = await auto(FIX.itemC);
  check("R8", "PB-1: B9 auto-resolve of a plain open incident succeeds on the B10 schema", rC.ok && rC.value.resolved === 1, rC.ok ? rC.value : rC.error);
  const rE = await auto(FIX.itemE);
  check("R9", "PB-1: B9 auto-resolve of an incident B10 OPENED (subjectUserId/openedBy set) succeeds", rE.ok && rE.value.resolved === 1, rE.ok ? rE.value : rE.error);
  const rB = await auto(FIX.itemB);
  check("R10", "PB-1: B9 auto-resolve leaves a B10 OPERATOR-RESOLVED incident untouched (0 rows)", rB.ok && rB.value.resolved === 0, rB.ok ? rB.value : rB.error);
  const again = await attempt(() => recordIncidentObservation({
    kind: "TRANSACTION_PERSISTENCE_FAILED", plaidItemId: FIX.itemB, plaidTransactionId: "t-recur",
    detail: { stage: "transaction-persist", cursorBlocking: true },
  }, systemDb, async () => null));
  check("R11", "PB-1: a B9 recurrence after a B10 operator resolve opens a NEW episode (no reopen of the resolved row)",
    again.ok && again.value?.created === true && again.value?.incidentId !== STATE.incidents?.iB, again.ok ? again.value : again.error);
  if (again.ok && again.value?.incidentId) out.b9Recurrence = again.value.incidentId;
  const occ = await attempt(() => recordIncidentObservation({
    kind: "INVESTMENT_DATA_PERSISTENCE_FAILED", financialAccountId: FIX.faChecking,
    detail: { stage: "investment-import-repair", error: "synthetic" },
  }, systemDb, async () => null));
  check("R12", "PB-1: B9 repeat observation on an open B9 incident appends an occurrence (B10 columns stay NULL)",
    occ.ok && occ.value?.created === false && occ.value?.incidentId === STATE.incidents?.iD, occ.ok ? occ.value : occ.error);
  const list = await attempt(() => systemDb.syncIssue.findMany({ where: { resolved: false } }));
  check("R13", "PB-1: B9 full-row SyncIssue reads succeed on the B10 schema", list.ok && list.value.length >= 1, list.ok ? list.value.length : list.error);

  // ── DB-010: the two B9 retention paths, now under the append-only policy ──
  const { runDataRetention } = await imp("@/jobs/data-retention");
  const { retainProductEvents } = await imp("@/jobs/product-event-retention");
  const dr = await attempt(() => runDataRetention());
  const tableErrors = dr.ok ? Object.entries(dr.value).filter(([, v]) => v && typeof v === "object" && (v as Any).error).map(([k, v]) => `${k}: ${(v as Any).error}`) : [];
  check("R14", "DB-010: B9 data retention runs with no table error under DB-010", dr.ok && tableErrors.length === 0, dr.ok ? tableErrors : dr.error);
  check("R15", "DB-010: B9 beta-intake minimisation updates every aged row (column-limited UPDATE allowed)",
    dr.ok && dr.value.betaIntakeNetwork?.minimised === Number(FIX.agedBetaCount) && !dr.value.betaIntakeNetwork?.error,
    dr.ok ? dr.value.betaIntakeNetwork : dr.error);
  out.retention = dr.ok ? { syncIssue: dr.value.syncIssue, userSession: dr.value.userSession } : null;
  const pe = await attempt(() => retainProductEvents());
  check("R16", "DB-010: B9 product-event retention deletes every aged product event (fm_system_retain allows B9's list)",
    pe.ok && pe.value.deleted === Number(FIX.agedProductCount), pe.ok ? pe.value : pe.error);

  // ── FIN-A2 / FIN-E: B9 inserts rely on the defaults ──
  const fa = await attempt(() => systemDb.financialAccount.create({
    data: { name: "B9 rollback account", type: "savings", institution: "Synthetic Bank", ownerType: "USER", ownerUserId: FIX.u1, createdByUserId: FIX.u1, balance: 20, currency: "USD" },
    select: { id: true },
  }));
  check("R17", "FIN-A2: B9 FinancialAccount insert succeeds against the B10 schema", fa.ok, fa.ok ? "" : fa.error);
  if (fa.ok) out.b9RollbackAccount = fa.value.id;
  const faRead = await attempt(() => systemDb.financialAccount.findMany({ where: { ownerUserId: FIX.u1 } }));
  check("R18", "FIN-A2: B9 full-row FinancialAccount reads succeed against the B10 schema", faRead.ok && faRead.value.length >= 3, faRead.ok ? faRead.value.length : faRead.error);

  const { regenerateSpaceSnapshot } = await imp("@/lib/snapshots/regenerate");
  const today = await attempt(() => regenerateSpaceSnapshot(FIX.space1));
  check("R19", "FIN-E: B9 snapshot writer UPSERTs today's row (written by B10) on the B10 schema", today.ok, today.ok ? "" : today.error);
  const past = new Date(`${FIX.newSnapshotDate}T00:00:00.000Z`);
  const fresh = await attempt(() => regenerateSpaceSnapshot(FIX.space1, past));
  check("R20", "FIN-E: B9 snapshot writer INSERTs a new row on the B10 schema", fresh.ok, fresh.ok ? "" : fresh.error);
  const snapRead = await attempt(() => systemDb.spaceSnapshot.findMany({ where: { spaceId: FIX.space1 } }));
  check("R21", "FIN-E: B9 full-row SpaceSnapshot reads succeed against the B10 schema", snapRead.ok && snapRead.value.length >= 2, snapRead.ok ? snapRead.value.length : snapRead.error);
}

async function main() {
  console.log(`\n--- B9 probe: ${phase} ---`);
  if (phase === "pre") await pre();
  else if (phase === "rollback") await rollback();
  else throw new Error(`unknown phase ${phase}`);
}

main()
  .catch((e) => { check("FATAL", `B9 probe ${phase} crashed`, false, errText(e)); })
  .finally(async () => {
    console.log(`@@B10REH ${JSON.stringify({ side: "B9", phase, checks, out })}`);
    try { const m = await imp("@/lib/db"); await Promise.all([m.db, m.tenantDb, m.authDb, m.systemDb].map((c: Any) => c?.$disconnect?.())); } catch { /* best effort */ }
    process.exit(0);
  });
