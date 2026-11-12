/**
 * lib/platform/incidents/incident-drawer-run-job.test.ts  (Incident drawer PR-B — S2 09gg b)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/incident-drawer-run-job.test.ts
 *
 *   1. the job → command table is EXACTLY the registry's Run Now targets
 *      (registered, mutating, same target, same reason requirement);
 *   2. the remedy × connection status × provider matrix (Ops + CS), the
 *      primary action by remedy class, NO_ACCOUNTS acceptance case (ERROR ⇒
 *      request-reauth primary + "a server retry can't fix this"; ACTIVE ⇒ no
 *      request-reauth / run-job + the healed note);
 *   3. job incidents end to end (investigate → DTO → drawer): run-job with the
 *      SERVER-derived command; an unmapped job ⇒ none; the confirm copy says
 *      "for all customers"; the POST body carries only the server's command;
 *   4. the operations route: incidentId recorded only when VERIFIED against the
 *      incident's own evidence; a client-supplied job name is never read; every
 *      existing guard holds (fresh WRITE first ⇒ READ is 403, CONTROL + reason
 *      for a fleet run, rate limit, intent row, in-flight 409);
 *   5. no button without a route: every action kind the drawer renders posts to
 *      a real route handler.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UserRole } from "@prisma/client";
import { createIncidentAccessors, incidentJobCommandId, type IncidentFactsReader } from "./intelligence/index";
import { incidentAudienceFor, type CsToken, type OpsToken } from "./intelligence/audience";
import { incidentDetailDTO, recoveryActionsFor, RECOVERY_ACTION_KINDS, type RecoveryActionDTO } from "./investigation-dto";
import { INCIDENT_JOB_COMMANDS, jobCommandForJob } from "./job-commands";
import { incidentAuditDetail, incidentIdFromSearch, verifiedJobIncidentId } from "./action-context";
import { listOperationCommands, getOperationCommand, OPERATION_TARGETS } from "@/lib/platform/operations/registry";
import { JOB_LABELS } from "@/components/platform/ops-visual/job-catalog";
import {
  CONFIRM, IncidentDetailSurface, confirmFor, recoveryBody, recoveryButtonLabel, recoveryPath, runJobOutcomeText, runJobScope,
} from "@/components/platform/incidents/IncidentsLead";
import { RECOVERY_LABEL, lifecyclePath } from "@/components/platform/incidents/incidents-model";
import type { IncidentInvestigation, IncidentVerdict } from "./intelligence/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
const ROOT = process.cwd();
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const strip = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const NOW = new Date("2026-11-11T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const kinds = (a: RecoveryActionDTO[]) => a.map((x) => x.kind).join(",");

// ── 1. the table ─────────────────────────────────────────────────────────────
console.log("1. job → command table = the registry's Run Now targets");
{
  const runNow = listOperationCommands().filter((c) => c.kind === "run-now");
  check("the key set is exactly the registered Run Now targets",
    Object.keys(INCIDENT_JOB_COMMANDS).sort().join() === runNow.map((c) => c.targetJob).sort().join(), Object.keys(INCIDENT_JOB_COMMANDS));
  for (const [job, m] of Object.entries(INCIDENT_JOB_COMMANDS)) {
    const c = getOperationCommand(m.commandId);
    check(`${job} ⇒ ${m.commandId}: registered, mutating, same target, same reason requirement`,
      !!c && c.mutates && c.targetJob === job && c.kind === "run-now" && c.requires.reason === m.reasonRequired, c);
  }
  check("every mapped job has a JOB_LABELS word", Object.keys(INCIDENT_JOB_COMMANDS).every((j) => j in JOB_LABELS));
  check("unmapped / excluded / prototype / non-string ⇒ null",
    ["process-deletions", "purge-trash", "comms-automations", "sync-crypto-continuation", "constructor", "__proto__", ""].every((j) => jobCommandForJob(j) === null)
      && jobCommandForJob(null) === null && jobCommandForJob(42) === null);
  check("the registry still has a fleet flag on exactly the reason-required entries",
    OPERATION_TARGETS.every((t) => !(t.targetJob in INCIDENT_JOB_COMMANDS) || INCIDENT_JOB_COMMANDS[t.targetJob].reasonRequired === (t.fleet === true)));
}

// ── 2. the matrix ────────────────────────────────────────────────────────────
console.log("\n2. remedy × connection status × provider (and the primary action)");
{
  const verdict = (o: Partial<IncidentVerdict> = {}) => ({
    id: "inc_m", rowClass: "incident", state: "active", provider: "PLAID", plaidItemId: "item_m", subjectState: "LIVE", subjectUserId: "u_cust_m", ...o,
  }) as unknown as IncidentVerdict;
  const inv = (status: string | null, code: string | null, v = verdict(), jobName: string | null = "sync-banks") => ({
    verdict: v, affected: { provider: v.provider, institution: "Example Bank", itemCount: 1, accountCount: 1, subjectState: "LIVE" as const, itemStatus: status },
    providerError: { code, source: code ? "connection" as const : null, unrecognised: false },
    component: jobName ? { jobName, jobRunId: null } : null,
  }) as unknown as Pick<IncidentInvestigation, "verdict" | "affected" | "providerError" | "component">;
  const ops = (s: string | null, c: string | null, v?: IncidentVerdict, j?: string | null) => kinds(recoveryActionsFor(inv(s, c, v, j), "ops"));
  const cs = (s: string | null, c: string | null, v?: IncidentVerdict, j?: string | null) => kinds(recoveryActionsFor(inv(s, c, v, j), "cs"));

  // remedy class                  status          code                      ops (first = primary)      cs
  const rows: [string, string | null, string | null, string, string][] = [
    ["customer-reconnect", "ERROR", "NO_ACCOUNTS", "request-reauth", ""],
    ["customer-reconnect", "ERROR", "ITEM_LOGIN_REQUIRED", "request-reauth", ""],
    ["customer-reconnect", "NEEDS_REAUTH", null, "request-reauth", ""],
    ["customer-re-add", "REVOKED", null, "", ""],
    ["customer-re-add", "ERROR", "USER_PERMISSION_REVOKED", "", ""],
    ["server-retry", "ERROR", "INSTITUTION_DOWN", "resync", "refresh-customer"],
    ["server-retry", "ACTIVE", "RATE_LIMIT", "resync", "refresh-customer"],
    ["server-retry (healed)", "ACTIVE", "NO_ACCOUNTS", "resync", "refresh-customer"],
    ["investigate", "ERROR", null, "resync,request-reauth", "refresh-customer"],
    ["investigate", "ACTIVE", null, "resync", "refresh-customer"],
  ];
  for (const [remedy, status, code, wantOps, wantCs] of rows) {
    check(`PLAID ${status} ${code ?? "(no code)"} [${remedy}] ⇒ ops "${wantOps}", cs "${wantCs}"`, ops(status, code) === wantOps && cs(status, code) === wantCs, { ops: ops(status, code), cs: cs(status, code) });
  }
  check("a connection incident NEVER gets run-job, whatever its job (the remedy is per connection)",
    rows.every(([, s, c]) => !ops(s, c).includes("run-job")) && !ops("ERROR", null, undefined, "sync-banks").includes("run-job"));
  check("request-reauth is WITHHELD on an ACTIVE connection with a reconnect-class code (S2: NO)",
    ["NO_ACCOUNTS", "ITEM_LOGIN_REQUIRED", "ACCESS_NOT_GRANTED"].every((c) => !ops("ACTIVE", c).includes("request-reauth")));
  check("a non-LIVE / non-PLAID connection subject ⇒ nothing",
    ops("ERROR", "INSTITUTION_DOWN", verdict({ subjectState: "REMOVED" } as never)) === "" && ops("ERROR", null, verdict({ provider: "WALLET" } as never)) === "");
  check("closed ⇒ nothing (connection or job)",
    ops("ERROR", "INSTITUTION_DOWN", verdict({ state: "resolved" })) === "" && ops(null, null, verdict({ state: "resolved", plaidItemId: null, provider: "WALLET" } as never), "sync-crypto") === "");
  // Job-sourced (no connection subject).
  const job = (j: string | null, provider = "WALLET") => recoveryActionsFor(inv(null, null, verdict({ plaidItemId: null, provider } as never), j), "ops");
  check("job incident (sync-crypto) ⇒ run-job only, with the server-derived command",
    JSON.stringify(job("sync-crypto")) === JSON.stringify([{ kind: "run-job", commandId: "run-now:sync-crypto", jobLabel: JOB_LABELS["sync-crypto"], reasonRequired: true }]), job("sync-crypto"));
  check("job incident (fetch-fx-rates) ⇒ run-job, no reason required", job("fetch-fx-rates", "FX")[0]?.kind === "run-job" && (job("fetch-fx-rates", "FX")[0] as { reasonRequired: boolean }).reasonRequired === false);
  check("unmapped job / excluded job / no job ⇒ none", job("internal-secret-job-x").length === 0 && job("process-deletions").length === 0 && job(null).length === 0);
  check("CS never gets run-job", !kinds(recoveryActionsFor(inv(null, null, verdict({ plaidItemId: null, provider: "WALLET" } as never), "sync-crypto"), "cs")).includes("run-job"));
}

// ── 3. end to end: investigate → DTO → drawer ────────────────────────────────
type Item = { id: string; status: string; errorCode: string | null; userId: string; institutionName: string };
const state: { incident: Record<string, unknown>; item: Item | null; occurrence: unknown[] } = { incident: {}, item: null, occurrence: [] };
const baseIncident = (o: Record<string, unknown>) => ({
  id: "inc_x", kind: "UPSERT_ERROR", provider: "PLAID", plaidItemId: null, financialAccountId: null, plaidTransactionId: null,
  detail: {}, resolved: false, incidentKey: "v1::x", previousIncidentId: null,
  createdAt: hoursAgo(5), firstOccurredAt: hoursAgo(5), lastOccurredAt: hoursAgo(1), resolvedAt: null, resolutionKind: null, resolutionReasonCode: null,
  lifecycleState: null, acknowledgedAt: null, recoveringSince: null, archivedAt: null, subjectUserId: null, causeStatus: null, causeCode: null,
  resolutionEvidence: null, _count: { occurrences: 3 }, ...o,
});
const client: IncidentFactsReader = {
  syncIssue: { findMany: (async (a: { where?: { id?: unknown } }) => (a.where && "id" in a.where && a.where.id === state.incident.id ? [state.incident] : [])) as never },
  syncIssueOccurrence: {
    findMany: (async (a: { where?: { syncIssueId?: unknown } }) => (typeof a.where?.syncIssueId === "string" ? state.occurrence : [])) as never,
    groupBy: (async () => []) as never,
  },
  syncIssueArchive: { findMany: (async () => []) as never },
  syncIssueRelation: { findMany: (async () => []) as never },
  syncIssueEvent: { findMany: (async () => []) as never },
  financialAccount: { findMany: (async () => []) as never },
  plaidItem: { findMany: (async () => (state.item ? [state.item] : [])) as never },
  latestAttempts: (async () => []) as never,
  recentAttempts: (async () => []) as never,
};
const acc = createIncidentAccessors(client);
const opsTok = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "PLATFORM_OPS", level: "READ" } as never }) as OpsToken;
const csTok = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "CUSTOMER_SUCCESS", level: "READ" } as never }) as CsToken;
const render = (d: ReturnType<typeof incidentDetailDTO>, canWrite = true) =>
  renderToStaticMarkup(createElement(IncidentDetailSurface, { d, canWrite, onSelect: () => {}, onRecover: () => {} }));

async function noAccountsCase(status: string) {
  state.item = { id: "item_c1", status, errorCode: "NO_ACCOUNTS", userId: "u_cust_c1_0000000001", institutionName: "Example Bank" };
  state.incident = baseIncident({
    id: "inc_c1", plaidItemId: "item_c1", subjectUserId: state.item.userId, incidentKey: "v1::PLAID::item:item_c1::transactions::plaid-item-error",
    detail: { stage: "plaid-item-error", errorCode: "NO_ACCOUNTS" },
  });
  state.occurrence = [{ evidenceSummary: { jobName: "sync-banks", jobRunId: "jr_c1", stage: "plaid-item-error" } }];
  const inv = await acc.investigate(opsTok, "inc_c1", { now: NOW });
  return inv ? incidentDetailDTO(inv, "ops", NOW) : null;
}

async function main(): Promise<void> {
  console.log("\n3a. NO_ACCOUNTS acceptance case (synthetic), end to end");
  const err = await noAccountsCase("ERROR");
  check("ERROR: investigate → DTO", err !== null);
  if (err) {
    check("ERROR: request-reauth is the only action, and it is PRIMARY", kinds(err.recovery) === "request-reauth", kinds(err.recovery));
    const html = render(err);
    check("ERROR: the drawer renders it as primary", /data-recovery-action="request-reauth" data-recovery-rank="primary"/.test(html));
    check("ERROR: the drawer states plainly that a server retry can't fix this", html.includes("A server retry can&#x27;t fix this") || html.includes("A server retry can't fix this"));
    check("ERROR: no resync, no run-job (even though the job is sync-banks)", !html.includes('data-recovery-action="resync"') && !html.includes('data-recovery-action="run-job"'));
  }
  const healed = await noAccountsCase("ACTIVE");
  if (healed) {
    const html = render(healed);
    check("ACTIVE: no request-reauth and no run-job offered", !html.includes('data-recovery-action="request-reauth"') && !html.includes('data-recovery-action="run-job"'), kinds(healed.recovery));
    check("ACTIVE: the healed note stays", html.includes("The connection is healthy again; the next completed sync confirms recovery."));
    check("ACTIVE: no customer-action guidance", !html.includes("Customer must reconnect"));
  } else check("ACTIVE: investigate → DTO", false);

  console.log("\n3b. a job-sourced incident (wallet sync), end to end");
  state.item = null;
  state.incident = baseIncident({ id: "inc_job", kind: "WALLET_SYNC_FAILED", provider: "WALLET", incidentKey: "v1::WALLET::job::sync-crypto" });
  state.occurrence = [{ evidenceSummary: { jobName: "sync-crypto", jobRunId: "jr_j", stage: "wallet-sync" } }];
  const jinv = await acc.investigate(opsTok, "inc_job", { now: NOW });
  const jd = jinv ? incidentDetailDTO(jinv, "ops", NOW) : null;
  check("investigate → DTO", jd !== null);
  if (jd) {
    const a = jd.recovery[0];
    check("run-job with the SERVER-derived command (from the newest occurrence's job)",
      jd.recovery.length === 1 && a.kind === "run-job" && a.commandId === "run-now:sync-crypto" && a.jobLabel === JOB_LABELS["sync-crypto"] && a.reasonRequired === true, jd.recovery);
    const html = render(jd);
    check("the drawer renders it as the primary action, naming the job", /data-recovery-action="run-job" data-recovery-rank="primary"[^>]*>Run Wallet sync</.test(html), html.match(/data-recovery-action="run-job"[^>]*>[^<]*/)?.[0]);
    check("guidance: run the job again, for all customers", html.includes("Run the job again") && html.includes("for all customers"));
    check("read-only operator: words, no button", !render(jd, false).includes("data-recovery-action") && render(jd, false).includes("Run job — requires write access."));
    if (a.kind === "run-job") {
      const c = confirmFor(a);
      check("confirm copy states the scope: \"Runs <job label> for all customers.\"", c.message.startsWith(`Runs ${JOB_LABELS["sync-crypto"]} for all customers.`) && runJobScope("X") === "Runs X for all customers.");
      check("confirm copy warns of provider calls and cost", /provider calls and cost/.test(c.message));
      check("confirm copy (fleet) says a reason + control access are needed", /control access and a reason/.test(c.message));
      check("POST path: the existing operations route + ?incidentId=", recoveryPath(a, "inc_job") === "/api/platform/platform-ops/operations?incidentId=inc_job");
      check("POST body: only the server's command (+ the reason); never a job name",
        recoveryBody(a, { code: "INCIDENT", note: "" }) === JSON.stringify({ commandId: "run-now:sync-crypto", reason: { code: "INCIDENT" } })
          && recoveryBody(a, { code: "", note: "" }) === JSON.stringify({ commandId: "run-now:sync-crypto" })
          && !/jobName|targetJob/.test(recoveryBody(a, { code: "INCIDENT", note: "x" }) ?? ""));
      const fx = { kind: "run-job" as const, commandId: "run-now:fetch-fx-rates", jobLabel: "FX rates", reasonRequired: false };
      check("non-fleet command: no reason sent, no reason line", recoveryBody(fx, { code: "INCIDENT", note: "" }) === JSON.stringify({ commandId: "run-now:fetch-fx-rates" }) && !/control access/.test(confirmFor(fx).message) && confirmFor(fx).message.includes("for all customers"));
      check("the other kinds have no body", recoveryBody({ kind: "resync", connectionId: "i" }, null) === undefined);
      check("outcome words: executed / in-flight / failed / unknown",
        /Ran/.test(runJobOutcomeText(200, { outcome: "executed" })) && /already in progress/.test(runJobOutcomeText(409, {})) && /failed: boom/.test(runJobOutcomeText(200, { outcome: "failed", error: "boom" })) && /did not report/.test(runJobOutcomeText(200, {})));
    }
    const csInv = await acc.investigate(csTok, "inc_job", { now: NOW });
    check("CS drawer: never run-job", csInv !== null && !kinds(incidentDetailDTO(csInv, "cs", NOW).recovery).includes("run-job"));
  }

  state.occurrence = [{ evidenceSummary: { jobName: "internal-secret-job-x", stage: "s" } }];
  const uinv = await acc.investigate(opsTok, "inc_job", { now: NOW });
  const ud = uinv ? incidentDetailDTO(uinv, "ops", NOW) : null;
  check("an unmapped job ⇒ no action, no button, never the raw name", !!ud && ud.recovery.length === 0 && !render(ud).includes("data-recovery-action") && !JSON.stringify(ud).includes("internal-secret-job-x"));

  // ── 4. the route ──────────────────────────────────────────────────────────
  console.log("\n4. the operations route: verified incidentId, guards unchanged");
  state.occurrence = [{ evidenceSummary: { jobName: "sync-crypto", stage: "wallet-sync" } }];
  const verifyClient = {
    syncIssue: { findUnique: (async (a: { where: { id: string } }) => (a.where.id === state.incident.id ? { id: a.where.id } : null)) as never },
    syncIssueOccurrence: client.syncIssueOccurrence,
  };
  const commandOf = (id: string) => incidentJobCommandId(id, verifyClient);
  check("incidentJobCommandId: the incident's own evidence ⇒ its command", (await commandOf("inc_job")) === "run-now:sync-crypto");
  check("incidentJobCommandId: unknown incident / malformed id ⇒ null", (await commandOf("inc_nope")) === null && (await commandOf("../x")) === null);
  check("incidentJobCommandId: a failed read ⇒ null (never throws)",
    (await incidentJobCommandId("inc_job", { syncIssue: { findUnique: (async () => { throw new Error("db"); }) as never }, syncIssueOccurrence: client.syncIssueOccurrence })) === null);
  check("verified: the incident's evidence maps to THIS command ⇒ recorded", (await verifiedJobIncidentId("inc_job", "run-now:sync-crypto", commandOf)) === "inc_job");
  check("unverified: a different command (the client asked for another job) ⇒ omitted",
    (await verifiedJobIncidentId("inc_job", "run-now:sync-banks", commandOf)) === null && (await verifiedJobIncidentId("inc_job", "dry-run:sync-crypto", commandOf)) === null);
  check("unverified: unknown incident / absent / throwing ⇒ omitted",
    (await verifiedJobIncidentId("inc_nope", "run-now:sync-crypto", commandOf)) === null && (await verifiedJobIncidentId(null, "run-now:sync-crypto", commandOf)) === null
      && (await verifiedJobIncidentId("inc_job", "run-now:sync-crypto", async () => { throw new Error("x"); })) === null);
  state.occurrence = [{ evidenceSummary: { jobName: "internal-secret-job-x" } }];
  check("unverified: an incident whose job maps nowhere ⇒ omitted", (await verifiedJobIncidentId("inc_job", "run-now:sync-crypto", commandOf)) === null);
  check("audit detail: { incidentId } only when verified", JSON.stringify(incidentAuditDetail("inc_job")) === '{"incidentId":"inc_job"}' && JSON.stringify(incidentAuditDetail(null)) === "{}");
  check("the query param is id-shaped only", incidentIdFromSearch(new URLSearchParams("incidentId=inc_job")) === "inc_job" && incidentIdFromSearch(new URLSearchParams("incidentId=a b")) === null);

  const ROUTE = "app/api/platform/platform-ops/operations/route.ts";
  const s = strip(ROUTE);
  const post = s.slice(s.indexOf("export const POST"));
  const i = (n: string) => post.indexOf(n);
  check("READ ⇒ 403: fresh PLATFORM_OPS WRITE is the FIRST thing POST does", i('requireFreshPlatformAccess("PLATFORM_OPS", "WRITE")') > -1 && i('requireFreshPlatformAccess("PLATFORM_OPS", "WRITE")') < i("limitByUser(") && /if \(err\) return err;/.test(post.slice(0, i("limitByUser("))));
  check("guards unchanged and in order: WRITE → rate limit → command → CONTROL → reason → incident verify → intent row → run",
    [i('requireFreshPlatformAccess("PLATFORM_OPS", "WRITE")'), i("limitByUser("), i("getOperationCommand(commandId)"), i('requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL")'),
      i("parseOperatorReason(body?.reason)"), i("verifiedJobIncidentId("), i("AuditAction.PLATFORM_OPERATION_REQUESTED"), i("runOperation(")].every((x, k, a) => x > -1 && (k === 0 || a[k - 1] < x)));
  check("the incident id comes from the query, verified against THIS command via the incident's evidence",
    /verifiedJobIncidentId\(incidentIdFromSearch\(req\.nextUrl\.searchParams\), command\.id, incidentJobCommandId\)/.test(post));
  check("both audit rows carry the (verified-only) incident ref", /phase: "requested", \.\.\.incidentRef/.test(post) && /jobRunStatus: result\.status \} : \{\}\),\s*\.\.\.incidentRef,/.test(post));
  check("incidentRef is built ONLY from the verified id", (post.match(/incidentAuditDetail\(/g) ?? []).length === 1 && /incidentAuditDetail\(\s*await verifiedJobIncidentId\(/.test(post));
  check("a client-supplied job name is never read: the body is { commandId, reason } only",
    /as \{ commandId\?: unknown; reason\?: unknown \} \| null/.test(post) && !/body\?\.(jobName|targetJob|job|incidentId)\b/.test(post) && !/searchParams\.get\("(jobName|job|commandId)"\)/.test(post));
  check("existing guards still present: 400 without commandId, 404 unknown command, 409 in-flight, rate limit 30/60s",
    /commandId is required\./.test(post) && /Unknown operation command\./.test(post) && /"in-flight" \? 409 : 200/.test(post) && /limit: 30,\s*windowSec: 60/.test(post));
  check("cost / kill switches stay inside the canonical job body: the route still runs only runOperation (no new execution path)",
    (post.match(/runOperation\(/g) ?? []).length === 1 && !/resolveJobBody|runJob\(/.test(post));

  // ── 5. no button without a route ──────────────────────────────────────────
  console.log("\n5. no button without a route");
  const sample: Record<RecoveryActionDTO["kind"], RecoveryActionDTO> = {
    resync: { kind: "resync", connectionId: "c" }, "request-reauth": { kind: "request-reauth", connectionId: "c" },
    "refresh-customer": { kind: "refresh-customer", userId: "u" }, "run-job": { kind: "run-job", commandId: "run-now:sync-crypto", jobLabel: "Wallet sync", reasonRequired: true },
  };
  const routeFile = (urlPath: string): string | null => {
    let dir = path.join(ROOT, "app");
    for (const seg of urlPath.split("?")[0].split("/").filter(Boolean)) {
      if (existsSync(path.join(dir, seg))) { dir = path.join(dir, seg); continue; }
      const dyn = readdirSync(dir).filter((d) => /^\[[^.\]]+\]$/.test(d));
      if (dyn.length !== 1) return null;
      dir = path.join(dir, dyn[0]);
    }
    const f = path.join(dir, "route.ts");
    return existsSync(f) ? f : null;
  };
  const hasPost = (f: string | null) => !!f && /export const POST\s*=|export async function POST\b/.test(readFileSync(f, "utf8"));
  check("RECOVERY_LABEL covers exactly the action kinds", Object.keys(RECOVERY_LABEL).sort().join() === [...RECOVERY_ACTION_KINDS].sort().join());
  check("CONFIRM + confirmFor cover every kind", RECOVERY_ACTION_KINDS.every((k) => confirmFor(sample[k]).message.length > 20) && Object.keys(CONFIRM).length === RECOVERY_ACTION_KINDS.length - 1);
  for (const k of RECOVERY_ACTION_KINDS) {
    const p = recoveryPath(sample[k], "inc_1");
    check(`${k} ⇒ ${p.split("?")[0]} has a POST handler`, hasPost(routeFile(p)), routeFile(p));
    check(`${k}: a button label`, recoveryButtonLabel(sample[k]).length > 0);
  }
  for (const a of ["acknowledge", "resolve"] as const) check(`lifecycle ${a} has a POST handler`, hasPost(routeFile(lifecyclePath(a, "inc_1"))));
  const lead = strip("components/platform/incidents/IncidentsLead.tsx");
  check("recovery buttons render ONLY from the server's d.recovery (no hand-built action button)",
    (lead.match(/data-recovery-action=/g) ?? []).length === 1 && /d\.recovery\.map\(\(a, i\) => \(\s*<button/.test(lead));

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nincident-drawer-run-job.test: all passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
