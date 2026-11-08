/**
 * lib/platform/intelligence/ai/memory/schema.ts  (Platform AI operational memory — the shapes)
 *
 * Design v2 §1–§2. PURE (constants only): the closed payload schema per fact
 * type, `validateSourceRefs` — the TypeScript MIRROR of the insert trigger's B2
 * validation (prisma/migrations/20261110120000_platform_ai_operational_memory;
 * ./memory.test.ts drives both with the same cases and the real-PG acceptance
 * proves the trigger) — and the maps from each reader's status onto the CLOSED
 * observed-state list. An observed state is a word, never a number.
 */

import {
  MEMORY_FACT_TYPES, MEMORY_INCIDENT_ID_PATTERN, MEMORY_JOB_NAMES, MEMORY_METRIC_KEYS, MEMORY_METRIC_PARTS,
  MEMORY_METRIC_WINDOWS, MEMORY_OBSERVED_STATES, MEMORY_PAGE_IDS, MEMORY_PAYLOAD_MAX_OCTETS, MEMORY_PAYLOAD_REQUIRED,
  MEMORY_PAYLOAD_SCHEMA, MEMORY_PROVIDER_IDS, MEMORY_REF_ID_MAX, MEMORY_REF_KEYS, MEMORY_REFS_MAX,
  MEMORY_REFS_MAX_OCTETS,
  type MemoryFactType, type MemoryObservedState, type MemoryRefType,
} from "./constants";

/** One stored reference: a registry key / record id, never a value. */
export interface MemoryRef {
  t: MemoryRefType;
  id: string;
  part?: string;
  w?: number;
  observedState: MemoryObservedState;
}

export type MemoryPayload = Readonly<Record<string, string>>;

const has = <T extends string | number>(xs: readonly T[], v: unknown): v is T => (xs as readonly unknown[]).includes(v);
const octets = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");
const INCIDENT_ID = new RegExp(MEMORY_INCIDENT_ID_PATTERN);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const isMemoryFactType = (v: unknown): v is MemoryFactType => has(MEMORY_FACT_TYPES, v);

/** Why a payload is refused (mirrors the trigger), or null when valid. */
export function payloadProblem(factType: MemoryFactType, payload: unknown): string | null {
  if (!isObject(payload)) return "payload must be an object";
  const allowed = MEMORY_PAYLOAD_SCHEMA[factType];
  for (const [k, v] of Object.entries(payload)) {
    if (/conversation|message|transcript/i.test(k)) return "payload key refused";
    if (!Object.prototype.hasOwnProperty.call(allowed, k)) return "payload key not allowed for this fact type";
    if (typeof v !== "string" || !allowed[k].includes(v)) return "payload value not allowed";
  }
  for (const k of MEMORY_PAYLOAD_REQUIRED[factType]) if (!(k in payload)) return "payload missing a required key";
  if (octets(payload) > MEMORY_PAYLOAD_MAX_OCTETS) return "payload too large";
  return null;
}

/** Why ONE ref is refused (the trigger's rule, element by element), or null. */
export function refProblem(ref: unknown): string | null {
  if (!isObject(ref)) return "sourceRef must be an object";
  if (Object.keys(ref).some((k) => !has(MEMORY_REF_KEYS, k))) return "sourceRef has a key outside {t, id, part, w, observedState}";
  if (typeof ref.t !== "string" || typeof ref.id !== "string" || typeof ref.observedState !== "string") return "sourceRef needs string t, id and observedState";
  if (ref.id.length > MEMORY_REF_ID_MAX) return "sourceRef id too long";
  if (!has(MEMORY_OBSERVED_STATES, ref.observedState)) return "sourceRef observedState outside the closed list";
  switch (ref.t) {
    case "INCIDENT": if (!INCIDENT_ID.test(ref.id)) return "INCIDENT ref id is not a cuid"; break;
    case "METRIC": if (!has(MEMORY_METRIC_KEYS, ref.id)) return "METRIC ref id is not a registered metric key"; break;
    case "PAGE": if (!has(MEMORY_PAGE_IDS, ref.id)) return "PAGE ref id is not a registered page"; break;
    case "JOB": if (!has(MEMORY_JOB_NAMES, ref.id)) return "JOB ref id is not a registered job"; break;
    case "PROVIDER": if (!has(MEMORY_PROVIDER_IDS, ref.id)) return "PROVIDER ref id is not a registered provider"; break;
    default: return "sourceRef type outside the enum";
  }
  if ("part" in ref && (ref.t !== "METRIC" || typeof ref.part !== "string" || !has(MEMORY_METRIC_PARTS, ref.part))) return "sourceRef part outside the registry";
  if ("w" in ref && (ref.t !== "METRIC" || typeof ref.w !== "number" || !Number.isInteger(ref.w) || !has(MEMORY_METRIC_WINDOWS, ref.w))) return "sourceRef window outside the registry";
  return null;
}

/** The whole sourceRefs value (the trigger + the CHECKs), or null when valid. */
export function sourceRefsProblem(factType: MemoryFactType, refs: unknown): string | null {
  if (!Array.isArray(refs)) return "sourceRefs must be an array";
  if (refs.length > MEMORY_REFS_MAX) return "too many sourceRefs";
  if (factType !== "OPERATOR_PREFERENCE" && refs.length < 1) return "a sourceRef is required";
  for (const r of refs) { const p = refProblem(r); if (p) return p; }
  if (octets(refs) > MEMORY_REFS_MAX_OCTETS) return "sourceRefs too large";
  return null;
}

/** Validated refs (a copy carrying the allowed keys only), or null when refused. */
export function validateSourceRefs(factType: MemoryFactType, refs: unknown): MemoryRef[] | null {
  if (sourceRefsProblem(factType, refs) !== null) return null;
  return (refs as MemoryRef[]).map((r) => ({
    t: r.t, id: r.id, ...(r.part !== undefined ? { part: r.part } : {}), ...(r.w !== undefined ? { w: r.w } : {}), observedState: r.observedState,
  }));
}

/** Stored refs read back: anything malformed is dropped (never shown, never trusted). */
export function parseStoredRefs(v: unknown): MemoryRef[] {
  return Array.isArray(v) ? v.filter((r) => refProblem(r) === null) as MemoryRef[] : [];
}

// ── Each reader's status → the closed observed-state list ────────────────────

/** A metric envelope: UNAVAILABLE ⇒ UNKNOWN; a failing / dead named subject ⇒ FAILING; any named subject ⇒ DEGRADED; else OK. */
export function metricObservedState(e: { status: string; subjects?: readonly { state: string }[] | null }): MemoryObservedState {
  if (e.status === "UNAVAILABLE") return "UNKNOWN";
  const subjects = e.subjects ?? [];
  if (subjects.some((s) => ["failed", "failing", "dead", "firing-critical"].includes(s.state))) return "FAILING";
  if (subjects.length > 0) return "DEGRADED";
  return "OK";
}

/** An incident's state (lib/platform/incidents/intelligence/types.ts IncidentState). */
export function incidentObservedState(state: string): MemoryObservedState {
  if (state === "resolved" || state === "archived") return "RESOLVED";
  if (state === "acknowledged") return "ACKNOWLEDGED";
  if (state === "active" || state === "recovering" || state === "stale-unverified") return "OPEN";
  return "UNKNOWN";
}

/** A scheduled job's latest JobRun.status. */
export function jobObservedState(status: string | null): MemoryObservedState {
  if (status === "running") return "RUNNING";
  if (status === "succeeded") return "SUCCEEDED";
  if (status === "failed") return "FAILED";
  return "UNKNOWN";
}

/** A provider's trust roll-up (lib/platform/provider-health.ts ProviderTrust). */
export function providerObservedState(trust: string | null): MemoryObservedState {
  if (trust === "OPERATIONAL") return "OK";
  if (trust === "DEGRADED" || trust === "STALE") return "DEGRADED";
  if (trust === "FAILING") return "FAILING";
  return "UNKNOWN";
}
