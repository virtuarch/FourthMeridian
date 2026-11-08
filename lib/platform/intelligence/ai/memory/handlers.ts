/**
 * lib/platform/intelligence/ai/memory/handlers.ts  (Platform AI operational memory — the route logic, DI)
 *
 * Design v2 §2 (confirm / remember / renew / routes), §5 (panel), §7 (audit).
 * The routes under app/api/platform/ai/memory/ supply the real seams; the unit
 * tests supply fakes. Nothing here imports a database, a key or the provider.
 *
 * THE GATE CHAIN (every route, inline in the route like the conversations):
 *   1. flag       isMemoryEffective ⇒ else 404 NOT_AVAILABLE, before anything;
 *   2. viewer     a session, ≥ 1 ACTIVE grant, the FRESH guard on the first area;
 *   3. limiter    mutations only (#352).
 * Then these handlers. Facts are only ever read through the store's visible
 * view (RLS: owner + ACTIVE grant + not deleted / expired; the store: not
 * invalidated); every area a handler touches is read through ITS OWN fresh
 * readers (`readersFor`), so a revoked area yields nothing.
 */

import type { PlatformArea } from "@prisma/client";
import { PLATFORM_AREAS } from "@/lib/platform/policy";
import {
  MEMORY_CONCERNS, MEMORY_TTL_CHOICES,
  type MemoryConcern, type MemoryFactType, type MemoryTtl,
} from "./constants";
import { validateOperatorNote } from "./note-guard";
import { memPlaceholderText, notedDate, retrieveFacts, type RetrieveStore } from "./retrieve";
import { revalidateFact, type MemoryReaders } from "./revalidate";
import { refProblem, type MemoryRef } from "./schema";
import type { InsertFactInput, InsertOutcome, MemoryFactRecord, RenewOutcome } from "./store";
import { noteHitsShingles, verifyProposalToken } from "./token";

export interface MemoryHttp { status: number; body: Record<string, unknown> | null }

export const NOT_FOUND_BODY = Object.freeze({ error: "Not found.", code: "NOT_FOUND" });
const notFound = (): MemoryHttp => ({ status: 404, body: { ...NOT_FOUND_BODY } });
const bad = (code: string, error: string, status = 400): MemoryHttp => ({ status, body: { error, code } });

export interface MemoryStoreSeam extends RetrieveStore {
  insertFact(input: InsertFactInput): Promise<InsertOutcome>;
  renewFact(operatorId: string, id: string, currentRefs: readonly MemoryRef[]): Promise<RenewOutcome>;
  softDeleteFact(operatorId: string, id: string): Promise<{ deleted: number }>;
  softDeleteAllFacts(operatorId: string): Promise<{ deleted: number }>;
  recordProposalRefusals(operatorId: string, area: PlatformArea, codes: readonly string[]): Promise<void>;
}

export interface MemoryDeps {
  /** The operator's ACTIVE-grant areas (ONE directory read; no denial writes). */
  heldAreas(): Promise<ReadonlySet<PlatformArea>>;
  /** The authorized readers for `area` from a FRESH guard; null on any refusal. */
  readersFor(area: PlatformArea): Promise<MemoryReaders | null>;
  store: MemoryStoreSeam;
  now(): Date;
}

/** Fact ids are cuids; anything else is simply not found. */
export const FACT_ID = /^c[a-z0-9]{20,40}$/;
const areaLabel = (a: PlatformArea) => PLATFORM_AREAS[a]?.label ?? a;

// ── GET /memory — the panel (design §5) ─────────────────────────────────────

export interface PanelRow {
  id: string;
  type: MemoryFactType;
  /** The live subject label (null for a GONE row: type only, no label, no link). */
  subject: string | null;
  concern: MemoryConcern | null;
  note: string | null;
  noted: string;
  notedAt: string;
  expiresAt: string;
  badge: "UNCHANGED" | "CHANGED" | "UPDATED" | "GONE" | "UNVERIFIED";
  canRenew: boolean;
}

export async function handleListMemory(operatorId: string, deps: MemoryDeps): Promise<MemoryHttp> {
  const held = [...(await deps.heldAreas())];
  const { facts } = await retrieveFacts({ operatorId, areas: held, readersFor: deps.readersFor, store: deps.store, mode: "panel" });
  const areas = held
    .map((area) => ({
      area, areaLabel: areaLabel(area),
      facts: facts.filter((r) => r.fact.area === area).map((r): PanelRow => r.shown === "GONE"
        ? { id: r.fact.id, type: r.fact.factType, subject: null, concern: null, note: null, noted: `noted ${notedDate(r.fact.observedAt)}`,
            notedAt: r.fact.observedAt.toISOString(), expiresAt: r.fact.expiresAt.toISOString(), badge: "GONE", canRenew: false }
        : { id: r.fact.id, type: r.fact.factType, subject: r.check.label, concern: r.fact.concern, note: r.fact.note,
            noted: memPlaceholderText(r), notedAt: r.fact.observedAt.toISOString(), expiresAt: r.fact.expiresAt.toISOString(),
            badge: r.shown, canRenew: true }),
    }))
    .filter((a) => a.facts.length > 0);
  return { status: 200, body: { areas } };
}

// ── DELETE ──────────────────────────────────────────────────────────────────

export async function handleDeleteFact(operatorId: string, id: string, deps: Pick<MemoryDeps, "store">): Promise<MemoryHttp> {
  if (!FACT_ID.test(id)) return notFound();
  const r = await deps.store.softDeleteFact(operatorId, id);
  return r.deleted > 0 ? { status: 204, body: null } : notFound();
}

export async function handleDeleteAll(operatorId: string, deps: Pick<MemoryDeps, "store">): Promise<MemoryHttp> {
  const r = await deps.store.softDeleteAllFacts(operatorId);
  return { status: 200, body: { deleted: r.deleted } };
}

// ── POST /memory/confirm (design §2: steps 1–6) ─────────────────────────────

const isTtl = (ft: MemoryFactType, v: unknown): v is MemoryTtl => typeof v === "string" && (MEMORY_TTL_CHOICES[ft] as readonly string[]).includes(v);

export async function handleConfirm(operatorId: string, body: unknown, deps: MemoryDeps): Promise<MemoryHttp> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("VALIDATION", "Send { token, ttl, note? }.");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => !["token", "ttl", "note"].includes(k))) return bad("VALIDATION", "Send { token, ttl, note? }.");
  const held = await deps.heldAreas();
  // 1. signature, operator, area, expiry.
  const v = verifyProposalToken(b.token, { operatorId, areaAllowed: (a) => held.has(a as PlatformArea), now: deps.now() });
  if (!v.ok) return bad("PROPOSAL_INVALID", "This proposal is no longer valid.");
  const p = v.proposal;
  const refuse = async (code: string, status: number, error: string) => {
    await deps.store.recordProposalRefusals(operatorId, p.area, [code]).catch(() => {});
    return bad(code, error, status);
  };
  if (!isTtl(p.ft, b.ttl)) return bad("VALIDATION", "Choose how long to keep it.");
  // 2. the guard on the FINAL note.
  const finalRaw = "note" in b ? b.note : p.n;
  if (finalRaw !== null && typeof finalRaw !== "string") return bad("VALIDATION", "The note must be text.");
  const guarded = validateOperatorNote(finalRaw as string | null);
  if (!guarded.ok) return refuse(guarded.reason, 422, "That note can't be saved.");
  // 3. an EDITED note: the shingle check (B5); a truncated set ⇒ no edit (keep or clear only).
  const edited = guarded.note !== p.n;
  if (edited && guarded.note !== null) {
    if (p.st) return refuse("NOTE_EDIT_UNAVAILABLE", 422, "Keep the proposed note or clear it.");
    if (noteHitsShingles(guarded.note, p)) return refuse("NOTE_VERBATIM", 422, "Write the note in your own words, not copied from the conversation.");
  }
  // 4. revalidate every ref through the area's CURRENT readers.
  const readers = await deps.readersFor(p.area);
  if (!readers) return notFound();
  const check = await revalidateFact({ refs: p.r, observedAt: new Date(p.iat) }, readers);
  if (check.status === "GONE" || check.status === "CHANGED") return bad("RECORD_CHANGED", "This has changed since it was proposed. Ask again to save the current state.", 409);
  // 5–6. insert with proposalJti (a replay hits the unique index ⇒ 409) + the CONFIRMED audit, one transaction.
  const out = await deps.store.insertFact({
    operatorId, area: p.area, factType: p.ft, origin: "TOOL_DERIVED", concern: p.c, note: guarded.note,
    payload: {}, refs: p.r, ttl: b.ttl, proposalJti: p.jti,
  });
  if (out.kind === "REPLAY") return refuse("REPLAY", 409, "This proposal was already saved.");
  if (out.kind === "INVALID") return bad("VALIDATION", "This proposal cannot be saved.");
  return { status: 201, body: { id: out.fact.id } };
}

// ── POST /memory/remember (the Remember button: incident / job / provider) ──

const REMEMBER_KINDS = ["INCIDENT", "JOB", "PROVIDER"] as const;
const REMEMBER_TYPES: readonly MemoryFactType[] = ["WATCHING_ISSUE", "OPERATIONAL_STATE", "FOLLOW_UP"];

export async function handleRemember(operatorId: string, body: unknown, deps: MemoryDeps): Promise<MemoryHttp> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("VALIDATION", "Send { area, kind, id, factType, ttl, concern?, note? }.");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => !["area", "kind", "id", "factType", "ttl", "concern", "note"].includes(k))) return bad("VALIDATION", "Unknown field.");
  const held = await deps.heldAreas();
  if (typeof b.area !== "string" || !held.has(b.area as PlatformArea)) return notFound();
  const area = b.area as PlatformArea;
  if (!(REMEMBER_KINDS as readonly unknown[]).includes(b.kind) || typeof b.id !== "string") return bad("VALIDATION", "Unknown record.");
  if (typeof b.factType !== "string" || !REMEMBER_TYPES.includes(b.factType as MemoryFactType)) return bad("VALIDATION", "Unknown type.");
  const factType = b.factType as MemoryFactType;
  if (!isTtl(factType, b.ttl)) return bad("VALIDATION", "Choose how long to keep it.");
  const concern = b.concern === undefined || b.concern === null ? null : b.concern;
  if (concern !== null && !(MEMORY_CONCERNS as readonly unknown[]).includes(concern)) return bad("VALIDATION", "Unknown concern.");
  // The operator's own note, written with no turn context: no verbatim check.
  const guarded = validateOperatorNote(typeof b.note === "string" ? b.note : null);
  if (!guarded.ok) {
    await deps.store.recordProposalRefusals(operatorId, area, [guarded.reason]).catch(() => {});
    return bad(guarded.reason, "That note can't be saved.", 422);
  }
  const readers = await deps.readersFor(area);
  if (!readers) return notFound();
  const kind = b.kind as (typeof REMEMBER_KINDS)[number];
  const read = kind === "INCIDENT" ? await readers.incident(b.id) : kind === "JOB" ? await readers.job(b.id) : await readers.provider(b.id);
  if (!read) return notFound();
  const ref: MemoryRef = { t: kind, id: b.id, observedState: read.state };
  if (refProblem(ref) !== null) return notFound();
  const out = await deps.store.insertFact({
    operatorId, area, factType, origin: "OPERATOR_EXPLICIT", concern: concern as MemoryConcern | null, note: guarded.note,
    payload: {}, refs: [ref], ttl: b.ttl, proposalJti: null,
  });
  if (out.kind !== "CREATED") return bad("VALIDATION", "This cannot be saved.");
  return { status: 201, body: { id: out.fact.id } };
}

// ── POST /memory/[id]/renew (revalidates first) ─────────────────────────────

export async function handleRenew(operatorId: string, id: string, deps: MemoryDeps): Promise<MemoryHttp> {
  if (!FACT_ID.test(id)) return notFound();
  const [fact] = await deps.store.visibleFacts(operatorId, { ids: [id], take: 1 });
  const f: MemoryFactRecord | undefined = fact && fact.id === id ? fact : undefined;
  if (!f) return notFound();
  const readers = await deps.readersFor(f.area);
  if (!readers) return notFound();
  const check = await revalidateFact(f, readers);
  if (check.status === "GONE") return bad("GONE", "This has changed; save a new item instead.", 409);
  if (check.status === "CHANGED" && f.factType === "OPERATIONAL_STATE") {
    await deps.store.recordProposalRefusals(operatorId, f.area, ["RENEW_CHANGED"]).catch(() => {});
    return bad("RENEW_CHANGED", "This has changed; save a new item instead.", 409);
  }
  const out = await deps.store.renewFact(operatorId, id, check.currentRefs);
  if (out.kind === "RENEWED") return { status: 201, body: { id: out.fact.id } };
  return out.kind === "CONFLICT" ? bad("CONFLICT", "Already renewed.", 409) : notFound();
}
