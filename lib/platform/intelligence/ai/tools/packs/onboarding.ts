/**
 * lib/platform/intelligence/ai/tools/packs/onboarding.ts  (Platform AI P6 — the onboarding pack: contracts + mappers)
 *
 * Design v2 §2, §5, §6.5; MVP PA-1 item 3 (the new users' journey). Tools over the EXISTING onboarding
 * readers — injected; tools/packs/onboarding.server.ts wires the Production ones:
 *
 *   onboarding_overview        AGGREGATE  PLATFORM_OPS | CUSTOMER_SUCCESS  OPS tier   counts only:
 *                              · new-connection imports (lib/platform/ops/new-connection-imports.ts — the Platform Ops
 *                                tile's identity-free fold: started, by status, failed by reason category, interrupted);
 *                              · ONLY when the call holds a fresh CUSTOMER_SUCCESS guard: the onboarding "needs help"
 *                                counts per reason (lib/platform/customer/attention.ts — THE fold the CS overview and the
 *                                Customers list read), link-exit / add-failure CODE counts, the strict funnel's stage
 *                                distribution (overview-core.ts funnelStageCounts) and the TEXT-ONLY suggested next step
 *                                per reason that applies (attention-core.ts ATTENTION_ACTIONS — code-written strings).
 *   list_onboarding_attention  RECORD  CUSTOMER_SUCCESS  CS tier  who needs onboarding help: the keyed customer ref, the
 *                              reason code, when (the fact's time), the closed link code / add-failure stage, the import
 *                              reason category. PLATFORM_AI_RECORD_VIEWED per customer, written first (I-5).
 *   get_onboarding_timeline    RECORD  CUSTOMER_SUCCESS  CS tier  one customer (CUSTOMER handle): registration → first
 *                              session → connections → imports → first AI turn / Brief (customer-detail.ts's
 *                              onboarding-core timeline). PLATFORM_AI_RECORD_VIEWED, written first.
 * The OPS aggregate carries no customer linkage (counts; the boundary's AGGREGATE path returns no record). The two
 * record tools are the CUSTOMER kind (rid = the keyed PRIV-ref, PACK-PR-CONDITIONS 6) so their handles chain into the
 * customers pack and render through the CUSTOMER source (authz/record-render.ts — T2 only after a fresh CS check
 * and an audit row).
 *
 * FREE TEXT (I-3, S2 09dx): link exits / add failures are CODES ONLY from the closed vocabularies —
 * LINK_EXIT_ERROR_CODES (lib/analytics/link-error-codes.ts) and the add-failure stage / code set
 * (lib/connections/add-failure.ts); anything else is "OTHER". Never a provider message, an institution name
 * (OnboardingConnection.label / ImportedItem.institutionName), an event label, a pending line, a connection id.
 * The mappers read NAMED fields only and never spread a DTO.
 *
 * NOTHING HERE CONTACTS A CUSTOMER. Next steps are the operator-facing strings attention-core already shows.
 *
 * PURE: no I/O, no clock, no env — every read is the injected `OnboardingPackReaders`.
 */

import type { PlatformArea } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";
import { LINK_EXIT_ERROR_CODES } from "@/lib/analytics/link-error-codes";
import { CONNECTION_ADD_FAILURE_CODES, CONNECTION_ADD_FAILURE_STAGES } from "@/lib/connections/add-failure";
import {
  ATTENTION_ACTIONS, LINK_EXIT_WINDOW_DAYS, attentionOf,
  type AttentionFacts, type AttentionFold, type LinkExitFact, type LinkFailureFact,
} from "@/lib/platform/customer/attention-core";
import type { CustomerRollup } from "@/lib/platform/customer/customer-core";
import type { OnboardingTimeline } from "@/lib/platform/customer/onboarding-core";
import { funnelStageCounts } from "@/lib/platform/customer/overview-core";
import type { AttentionKey } from "@/lib/platform/customer/overview-types";
import { FUNNEL_STAGE_ORDER } from "@/lib/platform/growth/product-analytics-core";
import type { CsToken } from "@/lib/platform/incidents/intelligence";
import { IMPORT_REASON_LABELS, IMPORT_STATUSES, type ImportReasonCategory } from "@/lib/platform/onboarding/import-status-core";
import type { NewConnectionImports } from "@/lib/platform/ops/new-connection-imports-core";
import type { FreshGuard } from "../../authz/recheck";
import {
  RECORD_LIST_MAX, boolFlag, code, count, isoTime, opaqueRef,
  type Code, type RawRecord, type RecordFields, type RecordRunResult, type RecordSchema,
} from "../../evidence/record-envelope";
import { RECORD_PLACE_RULE, aggregatePlaceRule, countPaths, type AggregatePathSpec, type PlatformAiToolContract } from "../contract";
import { CUSTOMER_AREA, CUSTOMER_RECORD_KIND, CUSTOMER_RID, refOfRid, stageKeyOf } from "./customers";

export const ONBOARDING_OPS_AREA: PlatformArea = "PLATFORM_OPS";

/** The attention reasons that ARE onboarding (attention-core.ts): the new customer's journey, in display order. */
export const ONBOARDING_REASONS = ["import_failed", "import_stuck", "link_exited", "link_failed", "no_connection_24h", "stalled"] as const satisfies readonly AttentionKey[];
export type OnboardingReason = (typeof ONBOARDING_REASONS)[number];

/** The readers the pack runs over (Production: onboarding.server.ts; tests / E0: fixtures). */
export interface OnboardingPackReaders {
  /** The Platform Ops tile's identity-free fold (new-connection-imports.ts). */
  newConnectionImports(now: Date): Promise<NewConnectionImports>;
  /** THE attention read (attention.ts loadAttention) with the CS token of THIS call's fresh guard. */
  attention(token: CsToken, now: Date): Promise<{ facts: Pick<AttentionFacts, "linkExits" | "linkFailures" | "recentImports">; fold: AttentionFold }>;
  /** One customer's onboarding timeline + funnel stage (customer-detail.ts getCustomerDetail), or null. */
  timeline(userId: string, token: CsToken, now: Date): Promise<{ onboarding: OnboardingTimeline; rollup: Pick<CustomerRollup, "funnelStage"> } | null>;
  /** The keyed CUSTOMER rid of a customer (null without the server key — the record is then never returned). */
  ridOf(userId: string): string | null;
  /** rid → the ONE customer it names (customers.server.ts resolveCustomerRid), else null. */
  resolveRid(rid: string): Promise<string | null>;
  now(): Date;
}

export interface OnboardingToolContext {
  readonly fresh?: ReadonlyMap<PlatformArea, FreshGuard>;
  readonly ev?: { readonly trace: { tool: string; outcome: string; refs: string[]; count?: number }[] };
}

// ── Closed vocabularies ──────────────────────────────────────────────────────

const REASONS = ONBOARDING_REASONS as readonly string[];
/** Link-exit codes (LINK_EXIT_ERROR_CODES, incl. NONE / OTHER) ∪ add-failure codes (CONNECTION_ADD_FAILURE_CODES). */
export const LINK_CODES: readonly string[] = [...new Set<string>([...LINK_EXIT_ERROR_CODES, ...CONNECTION_ADD_FAILURE_CODES, "OTHER"])];
export const ADD_FAILURE_STAGES: readonly string[] = CONNECTION_ADD_FAILURE_STAGES;
const IMPORT_REASONS = Object.keys(IMPORT_REASON_LABELS) as ImportReasonCategory[];
const IMPORT_HEALTH = ["green", "amber", "red", "none"] as const;
const STAGES = FUNNEL_STAGE_ORDER as readonly string[];
const DAY_MS = 86_400_000;

const linkCode = (raw: string | null | undefined): string | null => (raw === null || raw === undefined ? null : LINK_CODES.includes(raw) ? raw : "OTHER");

// ── Schemas ──────────────────────────────────────────────────────────────────

const T2: RecordSchema["t2Fields"] = ["name", "email"];

/*
 * S2 09io A1 — each schema's `placeable`: the CLOSED T1 fields the model may place as {{r:h|<field>}} (codes,
 * counts, times; pinned by tools/placeables.test.ts). Never the ref, a bool (invited, testAccount, floor), a T2 name.
 */
export const ONBOARDING_ATTENTION_SCHEMA: RecordSchema = {
  kind: CUSTOMER_RECORD_KIND, t2Fields: T2,
  placeable: ["reason", "reasonAt", "registeredAt", "linkErrorCode", "addFailureStage", "importReason", "otherReasons"],
  fields: {
    ref: { type: "opaqueRef" },
    reason: { type: "code", values: REASONS },
    reasonAt: { type: "isoTime", nullable: true },
    registeredAt: { type: "isoTime", nullable: true },
    linkErrorCode: { type: "code", values: LINK_CODES, nullable: true },
    addFailureStage: { type: "code", values: ADD_FAILURE_STAGES, nullable: true },
    importReason: { type: "code", values: IMPORT_REASONS, nullable: true },
    otherReasons: { type: "count" },
    testAccount: { type: "bool" },
  },
};

export const ONBOARDING_TIMELINE_SCHEMA: RecordSchema = {
  kind: CUSTOMER_RECORD_KIND, t2Fields: T2,
  placeable: [
    "registeredAt", "verifiedAt", "firstSessionAt", "stage", "bankConnections", "walletConnections", "firstConnectedAt", "importsInProgress",
    "importsComplete", "importsRecovered", "importsFailed", "importsRemoved", "importsInterrupted", "lastImportFailure", "importHealth",
    "firstWealthRegenAt", "firstAiTurnAt", "firstBriefAt",
  ],
  fields: {
    ref: { type: "opaqueRef" },
    registeredAt: { type: "isoTime", nullable: true },
    invited: { type: "bool" },
    verifiedAt: { type: "isoTime", nullable: true },
    firstSessionAt: { type: "isoTime", nullable: true },
    stage: { type: "code", values: STAGES, nullable: true },
    bankConnections: { type: "count" },
    walletConnections: { type: "count" },
    firstConnectedAt: { type: "isoTime", nullable: true },
    importsInProgress: { type: "count" },
    importsComplete: { type: "count" },
    importsRecovered: { type: "count" },
    importsFailed: { type: "count" },
    importsRemoved: { type: "count" },
    importsInterrupted: { type: "count" },
    lastImportFailure: { type: "code", values: IMPORT_REASONS, nullable: true },
    importHealth: { type: "code", values: IMPORT_HEALTH },
    firstWealthRegenAt: { type: "isoTime", nullable: true },
    firstAiTurnAt: { type: "isoTime", nullable: true },
    firstBriefAt: { type: "isoTime", nullable: true },
    floor: { type: "bool" },
  },
};

// ── Mappers (named fields only; never a spread) ──────────────────────────────

const safeTime = (v: unknown) => {
  const d = v instanceof Date ? v : typeof v === "string" ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? isoTime(d) : null;
};
const codeOr = <E extends string>(values: readonly E[], v: unknown): Code<E> | null =>
  (typeof v === "string" && (values as readonly string[]).includes(v) ? code(values, v) : null);

/** The customer's LATEST fact inside the fold's window (the fold already decided the reason applies). */
function latestIn<F extends LinkExitFact | LinkFailureFact>(facts: readonly F[] | undefined, userId: string, now: Date): F | null {
  const from = now.getTime() - LINK_EXIT_WINDOW_DAYS * DAY_MS;
  let best: F | null = null;
  for (const f of facts ?? []) {
    const t = f.at.getTime();
    if (f.userId !== userId || t < from || t > now.getTime()) continue;
    if (!best || t > best.at.getTime()) best = f;
  }
  return best;
}

function customerRecord(userId: string, readers: OnboardingPackReaders, fields: (ref: string) => RecordFields): RawRecord | null {
  const rid = readers.ridOf(userId);
  const ref = rid ? refOfRid(rid) : null;
  if (!rid || !ref) return null; // no key ⇒ no reference ⇒ never returned (fail closed)
  return { ref: { kind: CUSTOMER_RECORD_KIND, recordId: rid, area: CUSTOMER_AREA, tier: "CUSTOMER_SUCCESS", linkedUserIds: [userId] }, fields: fields(ref) };
}

type AttentionRead = Awaited<ReturnType<OnboardingPackReaders["attention"]>>;

/** Who needs onboarding help (one reason, or any onboarding reason), with codes + times. ≤ RECORD_LIST_MAX. */
export function mapOnboardingAttention(read: AttentionRead, reason: OnboardingReason | null, readers: OnboardingPackReaders, now: Date): { records: RawRecord[]; total: number } {
  const { fold, facts } = read;
  const registered = new Map(fold.activeFunnel.users.map((u) => [u.id, u.createdAt] as const));
  const wanted = reason ? [reason] : ONBOARDING_REASONS.filter((k) => fold.keys.includes(k));
  const ids = new Set<string>();
  for (const k of wanted) for (const id of fold.sets[k] ?? []) ids.add(id);
  const rows = [...ids].map((id) => {
    const all = attentionOf(fold, id);
    const primary = (reason ?? ONBOARDING_REASONS.find((k) => all.includes(k))) as OnboardingReason;
    const exit = primary === "link_exited" ? latestIn(facts.linkExits, id, now) : null;
    const failure = primary === "link_failed" ? latestIn(facts.linkFailures, id, now) : null;
    const at = exit?.at ?? failure?.at ?? (primary === "no_connection_24h" || primary === "stalled" ? registered.get(id) ?? null : null);
    return { id, primary, all, exit, failure, at, rid: readers.ridOf(id) ?? "" };
  }).filter((r) => r.all.includes(r.primary))
    .sort((a, b) => REASONS.indexOf(a.primary) - REASONS.indexOf(b.primary)
      || (b.at?.getTime() ?? -Infinity) - (a.at?.getTime() ?? -Infinity)
      || (a.rid < b.rid ? -1 : a.rid > b.rid ? 1 : 0));
  const records = rows.slice(0, RECORD_LIST_MAX).flatMap((r) => {
    const imp = r.primary === "import_failed" || r.primary === "import_stuck"
      ? (facts.recentImports ?? []).find((i) => i.userId === r.id && (r.primary === "import_failed" ? i.verdict.status === "failed" : i.verdict.status === "in_progress" && i.verdict.interrupted))
      : undefined;
    const rec = customerRecord(r.id, readers, (ref) => ({
      ref: opaqueRef(ref),
      reason: code(REASONS, r.primary),
      reasonAt: safeTime(r.at),
      registeredAt: safeTime(registered.get(r.id)),
      linkErrorCode: (() => { const c = linkCode((r.exit ?? r.failure)?.errorCode); return c ? code(LINK_CODES, c) : null; })(),
      addFailureStage: codeOr(ADD_FAILURE_STAGES, r.failure?.stage),
      importReason: codeOr(IMPORT_REASONS, imp?.verdict.reason),
      otherReasons: count(r.all.filter((k) => k !== r.primary).length),
      testAccount: boolFlag(fold.testAccounts.has(r.id)),
    }));
    return rec ? [rec] : [];
  });
  return { records, total: rows.length };
}

export function mapOnboardingTimeline(userId: string, t: NonNullable<Awaited<ReturnType<OnboardingPackReaders["timeline"]>>>, readers: OnboardingPackReaders): RawRecord | null {
  const o = t.onboarding;
  const banks = o.connections.filter((c) => c.kind === "BANK");
  const wallets = o.connections.filter((c) => c.kind === "WALLET");
  const byStatus = (s: (typeof IMPORT_STATUSES)[number]) => count(banks.filter((c) => c.importStatus === s).length);
  const linked = o.connections.map((c) => safeTime(c.linkedAt)).filter((x): x is NonNullable<typeof x> => x !== null).sort();
  const regens = banks.map((c) => safeTime(c.firstWealthRegenAt)).filter((x): x is NonNullable<typeof x> => x !== null).sort();
  const lastFailed = [...banks].filter((c) => c.importStatus === "failed").sort((a, b) => String(a.linkedAt).localeCompare(String(b.linkedAt))).at(-1);
  return customerRecord(userId, readers, (ref) => ({
    ref: opaqueRef(ref),
    registeredAt: safeTime(o.registeredAt),
    invited: boolFlag(o.invited === true),
    verifiedAt: safeTime(o.emailVerifiedAt),
    firstSessionAt: safeTime(o.firstSessionAt),
    stage: (() => { const k = stageKeyOf(t.rollup.funnelStage); return k ? code(STAGES, k) : null; })(),
    bankConnections: count(banks.length),
    walletConnections: count(wallets.length),
    firstConnectedAt: linked[0] ?? null,
    importsInProgress: byStatus("in_progress"),
    importsComplete: byStatus("complete"),
    importsRecovered: byStatus("recovered"),
    importsFailed: byStatus("failed"),
    importsRemoved: byStatus("removed"),
    importsInterrupted: count(banks.filter((c) => c.importStatus === "in_progress" && c.interrupted === true).length),
    lastImportFailure: codeOr(IMPORT_REASONS, lastFailed?.reason),
    importHealth: code(IMPORT_HEALTH, (IMPORT_HEALTH as readonly string[]).includes(o.importHealth) ? o.importHealth : "none"),
    firstWealthRegenAt: regens[0] ?? null,
    firstAiTurnAt: safeTime(o.firstAiTurnAt),
    firstBriefAt: safeTime(o.firstBriefAt),
    floor: boolFlag(o.floor === true),
  }));
}

// ── The aggregate (counts only; every key a code) ────────────────────────────

const tallyKnown = (keys: readonly string[], values: readonly (string | null | undefined)[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const v of values) {
    const k = typeof v === "string" && keys.includes(v) ? v : "OTHER";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};

export interface OnboardingOverview {
  readonly status: "CONFIRMED" | "PARTIAL" | "UNAVAILABLE";
  readonly asOf: string;
  readonly imports?: {
    readonly windowDays: number; readonly started: number; readonly byStatus: Readonly<Record<string, number>>;
    readonly failedReasons: Readonly<Record<string, number>>; readonly interruptedInProgress: number; readonly floor: boolean;
  };
  /** CUSTOMER_SUCCESS only (null otherwise): the onboarding "needs help" counts of THE attention fold. */
  readonly needsHelp?: {
    readonly customers: number; readonly byReason: Readonly<Record<string, number>>; readonly testAccounts: number;
    readonly linkExitCodes: Readonly<Record<string, number>>; readonly addFailureCodes: Readonly<Record<string, number>>;
    readonly addFailureStages: Readonly<Record<string, number>>; readonly stages: Readonly<Record<string, number>>;
    readonly floor: boolean; readonly nextSteps: Readonly<Record<string, string>>;
  } | null;
}

const safeCount = (n: unknown) => (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0);

/**
 * S2 09io B2 — onboarding_overview's CLOSED placeable result paths ({{a:onboarding_overview|<path>}}): the import
 * counts, the needs-help counts (present in the result only for a fresh CS call — the path list is the same for
 * every operator; an absent value is unavailable), keyed by the pack's own vocabularies, and asOf. NEVER
 * needsHelp.nextSteps (text). Pinned by tools/placeables.test.ts.
 */
export const ONBOARDING_OVERVIEW_PATHS: readonly AggregatePathSpec[] = [
  { path: "imports.windowDays", type: "count" }, { path: "imports.started", type: "count" }, { path: "imports.interruptedInProgress", type: "count" },
  ...countPaths("imports.byStatus", IMPORT_STATUSES), ...countPaths("imports.failedReasons", IMPORT_REASONS),
  { path: "needsHelp.customers", type: "count" }, { path: "needsHelp.testAccounts", type: "count" },
  ...countPaths("needsHelp.byReason", REASONS), ...countPaths("needsHelp.linkExitCodes", LINK_CODES), ...countPaths("needsHelp.addFailureCodes", LINK_CODES),
  ...countPaths("needsHelp.addFailureStages", [...ADD_FAILURE_STAGES, "OTHER"]), ...countPaths("needsHelp.stages", STAGES),
  { path: "asOf", type: "isoTime" },
];

export function importsOf(nci: NewConnectionImports): NonNullable<OnboardingOverview["imports"]> {
  const byStatus: Record<string, number> = {};
  for (const s of IMPORT_STATUSES) byStatus[s] = safeCount(nci.byStatus?.[s]);
  const failedReasons: Record<string, number> = {};
  for (const [k, v] of Object.entries(nci.failedReasons ?? {})) {
    const key = (IMPORT_REASONS as readonly string[]).includes(k) ? k : "UNKNOWN";
    failedReasons[key] = (failedReasons[key] ?? 0) + safeCount(v);
  }
  return {
    windowDays: safeCount(nci.windowDays), started: safeCount(nci.started), byStatus, failedReasons,
    interruptedInProgress: safeCount(nci.interruptedInProgress), floor: nci.floor === true,
  };
}

export function needsHelpOf(read: AttentionRead, now: Date): NonNullable<OnboardingOverview["needsHelp"]> {
  const { fold, facts } = read;
  const keys = ONBOARDING_REASONS.filter((k) => fold.keys.includes(k));
  const byReason: Record<string, number> = {};
  const union = new Set<string>();
  for (const k of keys) { byReason[k] = fold.sets[k]?.size ?? 0; for (const id of fold.sets[k] ?? []) union.add(id); }
  const exits = [...(fold.sets.link_exited ?? [])].map((id) => latestIn(facts.linkExits, id, now));
  const failures = [...(fold.sets.link_failed ?? [])].map((id) => latestIn(facts.linkFailures, id, now));
  const stages: Record<string, number> = {};
  for (const s of funnelStageCounts(fold.through)) if ((STAGES as readonly string[]).includes(s.key)) stages[s.key] = s.count;
  const nextSteps: Record<string, string> = {};
  for (const k of keys) if (byReason[k] > 0) nextSteps[k] = ATTENTION_ACTIONS[k];
  return {
    customers: union.size, byReason, testAccounts: [...union].filter((id) => fold.testAccounts.has(id)).length,
    linkExitCodes: tallyKnown(LINK_CODES, exits.map((e) => e?.errorCode ?? null)),
    addFailureCodes: tallyKnown(LINK_CODES, failures.map((f) => f?.errorCode ?? null)),
    addFailureStages: tallyKnown(ADD_FAILURE_STAGES, failures.map((f) => f?.stage ?? null)),
    stages, floor: fold.floor === true, nextSteps,
  };
}

// ── The contracts ────────────────────────────────────────────────────────────

/** THIS call's fresh CS token (minted by the guarded caller, authz/recheck.server.ts), or null. */
function csTokenOrNull(ctx: OnboardingToolContext): CsToken | null {
  const g = ctx.fresh?.get(CUSTOMER_AREA);
  const t = g?.incidentToken;
  return g && g.csTier === true && t && t.audience === "CUSTOMER_SUCCESS" ? (t as CsToken) : null;
}
function csToken(ctx: OnboardingToolContext): CsToken {
  const t = csTokenOrNull(ctx);
  if (!t) throw new Error("onboarding pack: no fresh CUSTOMER_SUCCESS guard");
  return t;
}

const result = (status: RecordRunResult["status"], now: Date, records: RawRecord[], truncated: boolean): RecordRunResult =>
  ({ status, asOf: isoTime(now), records, truncated });

const viewed = { action: AuditAction.PLATFORM_AI_RECORD_VIEWED, detail: { surface: "platform-ai", recordKind: CUSTOMER_RECORD_KIND } } as const;

/** The onboarding-pack tools over these readers (the registry uses the Production readers). */
export function onboardingPackTools<Ctx extends OnboardingToolContext>(readers: OnboardingPackReaders): PlatformAiToolContract<Ctx>[] {
  const cs = {
    pack: "onboarding", requires: { areas: [CUSTOMER_AREA], level: "READ", tier: "CUSTOMER_SUCCESS" },
    scope: "RECORD", customerLinkable: true, audit: viewed, pii: 2, cost: { toolCalls: 1 },
  } as const;
  return [
    {
      name: "onboarding_overview", pack: "onboarding", scope: "AGGREGATE", customerLinkable: false, pii: 0, cost: { toolCalls: 1 },
      requires: { areas: [ONBOARDING_OPS_AREA, CUSTOMER_AREA], level: "READ", tier: "OPS" },
      description: "Onboarding counts: new-connection imports (7 d) by status / failed reason; with Customer Success also needsHelp (per onboarding reason, link codes, funnel stages, nextSteps text). No records. " + aggregatePlaceRule("onboarding_overview", "imports.byStatus.failed"),
      args: { properties: {} },
      placeablePaths: ONBOARDING_OVERVIEW_PATHS,
      run: async (_args, ctx) => {
        const c = ctx as OnboardingToolContext;
        const now = readers.now();
        try {
          const token = csTokenOrNull(c);
          const [nci, att] = await Promise.all([readers.newConnectionImports(now), token ? readers.attention(token, now) : Promise.resolve(null)]);
          const imports = importsOf(nci);
          const needsHelp = att ? needsHelpOf(att, now) : null;
          const out: OnboardingOverview = { status: imports.floor || needsHelp?.floor ? "PARTIAL" : "CONFIRMED", asOf: now.toISOString(), imports, needsHelp };
          c.ev?.trace.push({ tool: "onboarding_overview", outcome: "OK", refs: [], count: imports.started });
          return out;
        } catch {
          // A failed read: UNAVAILABLE, never a partial count (an AGGREGATE run is not wrapped by the boundary).
          c.ev?.trace.push({ tool: "onboarding_overview", outcome: "UNAVAILABLE", refs: [] });
          return { status: "UNAVAILABLE", asOf: now.toISOString() } satisfies OnboardingOverview;
        }
      },
    },
    {
      ...cs, name: "list_onboarding_attention", recordSchema: ONBOARDING_ATTENTION_SCHEMA,
      description: "Customers who need onboarding help (Customer Success), ≤10: handle, ref, reason, reasonAt, registeredAt, linkErrorCode, addFailureStage, importReason, otherReasons, testAccount. Optional reason filter. " + RECORD_PLACE_RULE,
      args: { properties: { reason: { kind: "enum", values: REASONS, optional: true } } },
      run: async (args, ctx) => {
        const token = csToken(ctx);
        const now = readers.now();
        const read = await readers.attention(token, now);
        const { records, total } = mapOnboardingAttention(read, (args.reason as OnboardingReason | undefined) ?? null, readers, now);
        return result(records.length === 0 ? "MISSING" : read.fold.floor ? "PARTIAL" : "CONFIRMED", now, records, total > records.length);
      },
    },
    {
      ...cs, name: "get_onboarding_timeline", recordSchema: ONBOARDING_TIMELINE_SCHEMA,
      description: "One customer's onboarding by handle: registeredAt, invited, verifiedAt, firstSessionAt, stage, bank / wallet connections, imports by status, lastImportFailure, firstWealthRegenAt, firstAiTurnAt, firstBriefAt. " + RECORD_PLACE_RULE,
      args: { properties: { customer: { kind: "handle", recordKind: CUSTOMER_RECORD_KIND } } },
      // The boundary resolved the handle to the keyed rid; it must still name exactly one visible customer.
      revalidate: async (rid) => CUSTOMER_RID.test(rid) && (await readers.resolveRid(rid)) !== null,
      run: async (args, ctx) => {
        const token = csToken(ctx);
        const now = readers.now();
        const userId = await readers.resolveRid(String(args.customer));
        const t = userId ? await readers.timeline(userId, token, now) : null;
        const rec = userId && t ? mapOnboardingTimeline(userId, t, readers) : null;
        return result(rec ? (t?.onboarding.floor ? "PARTIAL" : "CONFIRMED") : "MISSING", now, rec ? [rec] : [], false);
      },
    },
  ] as PlatformAiToolContract<Ctx>[];
}

/** The onboarding-pack tool names. */
export const ONBOARDING_TOOL_NAMES: readonly string[] = ["onboarding_overview", "list_onboarding_attention", "get_onboarding_timeline"];
