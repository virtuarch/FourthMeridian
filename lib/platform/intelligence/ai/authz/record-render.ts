/**
 * lib/platform/intelligence/ai/authz/record-render.ts  (Platform AI P4 — read-time record render, THE only T2 path)
 *
 * Design v2 §8.2, invariant I-1, S2 ruling 4. A stored answer keeps record REFS
 * ({rk, rid, a, f} — conversations/answer.ts V2), never a value. Every place an operator
 * SEES an answer renders its record segments HERE, at read time, for THAT viewer:
 *   · the live turn response (core.ts handlePlatformAiAsk, `renderRecords`);
 *   · the conversation view / replay (conversations/handlers.ts, via AreaAccess);
 *   · the export renders T1 only and never asks for T2 (conversations/export.ts — a kind
 *     marker, never a value: `mode: "export"` here can never produce T2 either).
 *
 * PER RENDER (nothing is cached across renders):
 *   1. ONE fresh area check per distinct area (`recheck`, injected:
 *      requireFreshPlatformAccess(area, "READ", { probe: true }) — the same decision as the
 *      boundary's, a refusal NOT recorded as OBS-009 because the operator asked to read a
 *      conversation, not that area). A refused / thrown check ⇒ every record of that area
 *      renders RECORD_GONE_TEXT "[no longer available]" (this also closes a conversation
 *      whose record area the operator no longer holds — design §8.3);
 *   2. per record, its kind's source `revalidate(rid, area, guard)` — the record still exists
 *      and this fresh guard may see it (null / false / throw / unknown kind ⇒ "[no longer
 *      available]"). No source is registered in P4 (no RECORD pack exists yet); the packs
 *      (P5+) register theirs in PLATFORM_AI_RECORD_SOURCES;
 *   3. a T2 field (name / email / username) renders its VALUE only when ALL hold: the mode is
 *      not "export", the area's fresh guard carries the CUSTOMER_SUCCESS tier, an audit
 *      writer exists, and the PLATFORM_AI_RECORD_VIEWED rows (one per linked customer per
 *      area, written BEFORE any T2 value is read) were written. Any failure ⇒ MASKED: the
 *      record's T1 reference, or RECORD_PENDING_TEXT "[restricted]" when it has none;
 *   4. every other field renders the record's T1 reference (opaque ref / code-derived label),
 *      or "[restricted]".
 * The outcome texts are server literals or reader values; a model never receives a rendered
 * segment (history replays kind markers only — conversations/history.ts).
 *
 * No module state; never logs a value or an id.
 */

import "server-only";

import type { PlatformArea } from "@prisma/client";
import { AuditAction, type AuditActionType } from "@/lib/audit-actions";
import { ALL_PLATFORM_AREAS } from "@/lib/platform/policy";
import { RECORD_GONE_TEXT, RECORD_PENDING_TEXT, isT2Field } from "../compose/record";
import type { T2FieldName } from "../evidence/record-envelope";
import type { ToolTier } from "../tools/contract";
import type { FreshGuard } from "./recheck";
import { customerRecordSource } from "../tools/packs/customers.server";
import { incidentRecordSource } from "../tools/packs/incidents.server";

/** The record segment the renderer reads (= conversations/answer.ts StoredRecordSegment / compose/record.ts RecordSpan). */
export interface RecordRef { readonly rk: string; readonly rid: string; readonly a: string; readonly f: string }

/** One RECORD kind's read-time source (registered by its pack, P5+). Every method reads FRESH. */
export interface RecordRenderSource {
  /** T2 fields that exist behind this kind (names only). */
  readonly t2Fields: readonly T2FieldName[];
  /**
   * The record still exists and THIS fresh guard may see it: the tier it is visible at
   * (a CUSTOMER_SUCCESS-tier record only for a CS guard), or null ⇒ not visible.
   */
  revalidate(rid: string, area: PlatformArea, guard: FreshGuard): Promise<ToolTier | null>;
  /**
   * The T1 reference (the HMAC opaque user ref, a code-derived label) — never a T2 value. `guard` = the
   * area's FRESH guard of this render (P8: a kind whose T1 needs a read — INCIDENT — reads with ITS token).
   */
  t1(rid: string, area: PlatformArea, guard?: FreshGuard): Promise<string | null>;
  /** The customers this record links to (the audit targets). */
  linkedUserIds(rid: string, area: PlatformArea, guard?: FreshGuard): Promise<readonly string[]>;
  /** The T2 value — called ONLY after the audit rows were written. */
  t2(rid: string, area: PlatformArea, field: T2FieldName, guard?: FreshGuard): Promise<string | null>;
}

/**
 * The RECORD sources by kind (each pack PR registers its own, S2-reviewed). P5: CUSTOMER — the
 * customers pack's keyed-rid source (tools/packs/customers.server.ts customerRecordSource). P8:
 * INCIDENT — the incidents pack's source (tools/packs/incidents.server.ts incidentRecordSource): every
 * read through the incident module with the area's fresh audience token; T2 only on the CS tier.
 */
export const PLATFORM_AI_RECORD_SOURCES: Readonly<Record<string, RecordRenderSource>> = Object.freeze({
  CUSTOMER: customerRecordSource(),
  INCIDENT: incidentRecordSource(),
});

/** The audit row a T2 render writes (codes + the linked customer; never a value). */
export interface RecordViewedRow {
  readonly action: AuditActionType;
  readonly area: PlatformArea;
  readonly targetUserId: string;
  readonly detail: { readonly surface: "platform-ai"; readonly tool: "record-render"; readonly recordKind: string };
}

/** The fail-closed audit writer (authz/audit.ts, P5). `guard` = the area's fresh guard (the actor). Throws ⇒ masked. */
export type RecordRenderAudit = (rows: readonly RecordViewedRow[], guards: ReadonlyMap<PlatformArea, FreshGuard>) => Promise<void>;

export type RecordRenderMode = "live" | "history" | "export";

export interface RecordRenderViewer {
  readonly operatorId: string;
  readonly mode: RecordRenderMode;
  /** A FRESH area check for this viewer (probe: a refusal is not recorded). null on any refusal. */
  recheck(area: PlatformArea): Promise<FreshGuard | null>;
  /** Absent ⇒ PLATFORM_AI_RECORD_SOURCES. */
  readonly sources?: Readonly<Record<string, RecordRenderSource>>;
  /** Absent ⇒ T2 is never rendered (masked). */
  readonly audit?: RecordRenderAudit;
}

/** What one record segment rendered to (the outcome CODE is for tests / counts; never logged with a value). */
export interface RenderedRecord { readonly text: string; readonly outcome: "T2" | "T1" | "MASKED" | "GONE" }

const isArea = (a: string): a is PlatformArea => (ALL_PLATFORM_AREAS as readonly string[]).includes(a);

async function safe<T>(f: () => Promise<T>, fallback: T): Promise<T> {
  try { return await f(); } catch { return fallback; }
}

/** Render every record segment for this viewer, in order. Never throws. */
export async function renderRecordSegments(segments: readonly RecordRef[], viewer: RecordRenderViewer): Promise<RenderedRecord[]> {
  if (segments.length === 0) return [];
  const sources = viewer.sources ?? PLATFORM_AI_RECORD_SOURCES;

  // 1. one fresh check per distinct area (this render only).
  const guards = new Map<PlatformArea, FreshGuard>();
  for (const a of new Set(segments.map((s) => s.a))) {
    if (!isArea(a)) continue;
    const g = await safe(() => viewer.recheck(a), null);
    if (g && g.auth?.user?.id === viewer.operatorId && g.auth.grant !== null && g.auth.grant?.area === a) {
      // P8: the audience token minted from THIS guard rides with it (a kind that reads the incident module needs it; never kept).
      guards.set(a, { auth: g.auth, csTier: g.csTier === true, ...(g.incidentToken ? { incidentToken: g.incidentToken } : {}) });
    }
  }

  // 2. per record: source + revalidate (fresh).
  type Live = { seg: RecordRef; area: PlatformArea; src: RecordRenderSource; guard: FreshGuard };
  const live: (Live | null)[] = [];
  for (const seg of segments) {
    const area = isArea(seg.a) ? seg.a : null;
    const guard = area ? guards.get(area) : undefined;
    const src = Object.prototype.hasOwnProperty.call(sources, seg.rk) ? sources[seg.rk] : undefined;
    if (!area || !guard || !src) { live.push(null); continue; }
    const tier = await safe(() => src.revalidate(seg.rid, area, guard), null);
    const visible = tier === "OPS" || (tier === "CUSTOMER_SUCCESS" && guard.csTier);
    live.push(visible ? { seg, area, src, guard } : null);
  }

  // 3. T2: export never; a fresh CS tier + an audit writer + the rows written FIRST (fail closed ⇒ masked).
  const wantsT2 = (l: Live) => viewer.mode !== "export" && isT2Field(l.seg.f) && l.src.t2Fields.includes(l.seg.f) && l.guard.csTier;
  const t2Candidates = live.filter((l): l is Live => l !== null && wantsT2(l));
  let audited = false;
  if (t2Candidates.length > 0 && viewer.audit) {
    const rows: RecordViewedRow[] = [];
    const seen = new Set<string>();
    let linkageOk = true;
    for (const l of t2Candidates) {
      const users = await safe(() => l.src.linkedUserIds(l.seg.rid, l.area, l.guard), null);
      if (!users || !users.every((u) => typeof u === "string" && u.length > 0)) { linkageOk = false; break; }
      for (const u of users) {
        const k = `${l.area}|${u}`;
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push({ action: AuditAction.PLATFORM_AI_RECORD_VIEWED, area: l.area, targetUserId: u, detail: { surface: "platform-ai", tool: "record-render", recordKind: l.seg.rk } });
      }
    }
    if (linkageOk) audited = await safe(async () => { if (rows.length > 0) await viewer.audit!(rows, guards); return true; }, false);
  }

  // 4. render.
  const out: RenderedRecord[] = [];
  for (const l of live) {
    if (!l) { out.push({ text: RECORD_GONE_TEXT, outcome: "GONE" }); continue; }
    if (audited && wantsT2(l)) {
      const v = await safe(() => l.src.t2(l.seg.rid, l.area, l.seg.f as T2FieldName, l.guard), null);
      if (typeof v === "string" && v.length > 0 && v.length <= 200) { out.push({ text: v, outcome: "T2" }); continue; }
    }
    const t1 = await safe(() => l.src.t1(l.seg.rid, l.area, l.guard), null);
    const masked = isT2Field(l.seg.f);
    if (typeof t1 === "string" && t1.length > 0 && t1.length <= 120) out.push({ text: t1, outcome: masked ? "MASKED" : "T1" });
    else out.push({ text: RECORD_PENDING_TEXT, outcome: masked ? "MASKED" : "T1" });
  }
  return out;
}

/**
 * Render a list of answers' record segments in ONE pass (one recheck per area for the whole
 * read) and hand back a lookup by segment object. No record segment ⇒ no recheck at all.
 */
export async function renderRecordsByIdentity<S extends RecordRef>(segments: readonly S[], viewer: RecordRenderViewer): Promise<Map<S, RenderedRecord>> {
  const map = new Map<S, RenderedRecord>();
  if (segments.length === 0) return map;
  const rendered = await renderRecordSegments(segments, viewer);
  segments.forEach((s, i) => map.set(s, rendered[i] ?? { text: RECORD_GONE_TEXT, outcome: "GONE" }));
  return map;
}

/** The text-only renderer a route hands to its handler (AreaAccess.renderRecords / PlatformAiAskDeps.renderRecords). */
export function recordTextRenderer(viewer: RecordRenderViewer): <S extends RecordRef>(segments: readonly S[]) => Promise<Map<S, string>> {
  return async (segments) => {
    const rendered = await renderRecordsByIdentity(segments, viewer);
    return new Map([...rendered].map(([s, r]) => [s, r.text]));
  };
}
