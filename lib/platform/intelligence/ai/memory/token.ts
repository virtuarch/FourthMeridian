/**
 * lib/platform/intelligence/ai/memory/token.ts  (Platform AI operational memory — the proposal token)
 *
 * Design v2 §2 (D3 + B5 + the dedicated key purpose). A proposal is STATELESS:
 * nothing is stored until the operator confirms. The server hands the confirm
 * card a SEALED token (AES-256-GCM under the PLATFORM_AI_MEMORY_TOKEN subkey —
 * authenticated, so a forged or edited token never opens) and takes it back:
 *
 *   { v, op, area, ft, c, n, r, iat, jti, sh, st, k }
 *     op / area   the operator and the area the proposal was made in
 *     ft / c      fact type, concern
 *     n           the proposed (guarded) note, or null
 *     r           the refs, each from THIS turn's evidence (server-read state)
 *     iat / jti   issued-at (15-minute life, D3) and the single-use id (the
 *                 UNIQUE(operatorUserId, proposalJti) index makes a replay 409)
 *     sh / st     B5: HMAC-SHA256 (key_memory = the same purpose's subkey),
 *                 truncated to 64 bits, of every 6-word window of this turn's
 *                 question, answer and replayed history (question and answer
 *                 first, then history newest → oldest), at most 512; st = the
 *                 cap was hit. NO plaintext of any source is in the token.
 *     k           the key id the shingles were computed under (rotation-safe)
 *
 * NO conversation id, message id or transcript text is ever in the token.
 */

import "server-only";

import { randomUUID } from "node:crypto";
import type { PlatformArea } from "@prisma/client";
import { EncryptionPurpose, macWithPurpose, openWithPurposeReportingKey, sealWithPurpose } from "@/lib/plaid/encryption";
import { MEMORY_CONCERNS, MEMORY_FACT_TYPES, MEMORY_PROPOSAL_TTL_MS, MEMORY_SHINGLES_MAX, type MemoryConcern, type MemoryFactType } from "./constants";
import { charWindows, wordShingles } from "./note-guard";
import { refProblem, type MemoryRef } from "./schema";

export interface MemoryProposal {
  v: 1;
  op: string;
  area: PlatformArea;
  ft: MemoryFactType;
  c: MemoryConcern | null;
  n: string | null;
  r: MemoryRef[];
  iat: number;
  jti: string;
  sh: string[];
  st: boolean;
  k: string;
}

/** 64-bit truncation, hex. */
const SHINGLE_HEX = 16;

/** The HMAC of one normalised shingle under key_memory (a given kid, or the current key). */
function shingleMac(shingle: string, kid?: string): { hex: string; kid: string } {
  const { mac, kid: used } = macWithPurpose(shingle, EncryptionPurpose.PLATFORM_AI_MEMORY_TOKEN, kid ? { kid } : {});
  return { hex: mac.subarray(0, SHINGLE_HEX / 2).toString("hex"), kid: used };
}

/**
 * B5: the shingle MACs of `sources`, IN THE ORDER GIVEN (the caller passes the
 * question, the answer, then history newest → oldest), de-duplicated, capped at
 * MEMORY_SHINGLES_MAX; `truncated` when the cap dropped any.
 */
export function shingleMacs(sources: readonly string[]): { sh: string[]; st: boolean; kid: string } {
  const seen = new Set<string>();
  const out: string[] = [];
  let truncated = false;
  let kid = macWithPurpose("", EncryptionPurpose.PLATFORM_AI_MEMORY_TOKEN).kid;
  for (const src of sources) {
    for (const s of [...wordShingles(src).map((w) => `w:${w}`), ...charWindows(src).map((c) => `c:${c}`)]) {
      const m = shingleMac(s, kid);
      kid = m.kid;
      if (seen.has(m.hex)) continue;
      if (out.length >= MEMORY_SHINGLES_MAX) { truncated = true; break; }
      seen.add(m.hex);
      out.push(m.hex);
    }
    if (truncated) break;
  }
  return { sh: out, st: truncated, kid };
}

/**
 * True when any 6-word window — or any word-aligned 24-character window — of `note`
 * is one of the proposal's MACs (B5, at confirm). A copied span of 24+ characters
 * starting at a word hits the second set.
 */
export function noteHitsShingles(note: string, p: Pick<MemoryProposal, "sh" | "k">): boolean {
  const set = new Set(p.sh);
  return [...wordShingles(note).map((w) => `w:${w}`), ...charWindows(note).map((c) => `c:${c}`)].some((s) => set.has(shingleMac(s, p.k).hex));
}

export interface ProposalInput {
  operatorId: string;
  area: PlatformArea;
  factType: MemoryFactType;
  concern: MemoryConcern | null;
  note: string | null;
  refs: MemoryRef[];
  /** Question, answer, then history newest → oldest. */
  shingleSources: readonly string[];
  now: Date;
}

/** Seal a proposal. Returns the token and its decoded view (for the card). */
export function signProposal(input: ProposalInput): { token: string; proposal: MemoryProposal } {
  const { sh, st, kid } = shingleMacs(input.shingleSources);
  const proposal: MemoryProposal = {
    v: 1, op: input.operatorId, area: input.area, ft: input.factType, c: input.concern, n: input.note,
    r: input.refs.map((r) => ({ ...r })), iat: input.now.getTime(), jti: randomUUID(), sh, st, k: kid,
  };
  return { token: sealWithPurpose(JSON.stringify(proposal), EncryptionPurpose.PLATFORM_AI_MEMORY_TOKEN), proposal };
}

export type VerifyRefusal = "BAD_TOKEN" | "WRONG_OPERATOR" | "WRONG_AREA" | "EXPIRED";

const isProposal = (v: unknown): v is MemoryProposal => {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return p.v === 1 && typeof p.op === "string" && typeof p.area === "string" && (MEMORY_FACT_TYPES as readonly unknown[]).includes(p.ft)
    && (p.c === null || (MEMORY_CONCERNS as readonly unknown[]).includes(p.c)) && (p.n === null || typeof p.n === "string")
    && Array.isArray(p.r) && p.r.every((r) => refProblem(r) === null) && typeof p.iat === "number" && typeof p.jti === "string"
    && Array.isArray(p.sh) && p.sh.every((x) => typeof x === "string") && typeof p.st === "boolean" && typeof p.k === "string";
};

/**
 * Open and check a token: authentic (sealed under this purpose), well-formed,
 * the SAME operator, an area the caller allows, and younger than 15 minutes.
 */
export function verifyProposalToken(
  token: unknown,
  ctx: { operatorId: string; areaAllowed(area: string): boolean; now: Date },
): { ok: true; proposal: MemoryProposal } | { ok: false; reason: VerifyRefusal } {
  if (typeof token !== "string" || token.length > 64_000) return { ok: false, reason: "BAD_TOKEN" };
  let parsed: unknown;
  try { parsed = JSON.parse(openWithPurposeReportingKey(token, EncryptionPurpose.PLATFORM_AI_MEMORY_TOKEN).plaintext); }
  catch { return { ok: false, reason: "BAD_TOKEN" }; }
  if (!isProposal(parsed)) return { ok: false, reason: "BAD_TOKEN" };
  if (parsed.op !== ctx.operatorId) return { ok: false, reason: "WRONG_OPERATOR" };
  if (!ctx.areaAllowed(parsed.area)) return { ok: false, reason: "WRONG_AREA" };
  const age = ctx.now.getTime() - parsed.iat;
  if (!(age >= 0 && age <= MEMORY_PROPOSAL_TTL_MS)) return { ok: false, reason: "EXPIRED" };
  return { ok: true, proposal: parsed };
}
