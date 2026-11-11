/**
 * lib/platform/intelligence/ai/authz/handles.ts  (Platform AI P2 — per-turn record handles, I-6 / D-6)
 *
 * The model never sees a record id. A RECORD tool's records leave the boundary with a
 * HANDLE: `"h_" + randomBytes(12).toString("base64url")` (96 bits from node:crypto,
 * 16 base64url chars — tools/contract.ts HANDLE_KEY_PATTERN). The handle → record map
 * is a TABLE created per turn, inside the turn's boundary closure:
 *
 *   · never module-global (createHandleTable returns a fresh closure; nothing here is
 *     module state), never serialised (toJSON / util.inspect render a fixed marker —
 *     no key, no record id), never logged, never persisted (stored answers keep record
 *     refs, P4 — never keys);
 *   · each entry is BOUND: {kind, area, tier, recordId, operatorId, correlationId};
 *   · resolve(key, expect) returns the record id ONLY when every bound field matches
 *     the call: the record kind the argument declares, an area the call may read, a
 *     tier the call may receive, THIS operator, THIS turn's correlation id. Anything
 *     else (a key from another turn, operator or correlation; a forged / guessed key;
 *     another kind) is null — the boundary's NOT_FOUND.
 *
 * Re-minting from history is P4 (only after replay re-authz); history grants nothing.
 */

import { randomBytes } from "node:crypto";
import type { PlatformArea } from "@prisma/client";
import { HANDLE_KEY_PATTERN, type ToolTier } from "../tools/contract";

export interface HandleEntry {
  readonly kind: string;
  readonly area: PlatformArea;
  readonly tier: ToolTier;
  readonly recordId: string;
  readonly operatorId: string;
  readonly correlationId: string;
}

export interface HandleExpectation {
  /** The record kind the handle argument declares (tools/contract.ts HandleArg.recordKind). */
  readonly kind: string;
  /** The areas this call may read (the tool's requires.areas ∩ the turn's live scope). */
  readonly areas: readonly PlatformArea[];
  /** The call's tier: a CUSTOMER_SUCCESS-tier record resolves only for a CUSTOMER_SUCCESS-tier call. */
  readonly tier: ToolTier;
  readonly operatorId: string;
  readonly correlationId: string;
}

export interface HandleTable {
  /** A handle for this record in THIS turn (the same record minted twice ⇒ the same key). */
  mint(e: Pick<HandleEntry, "kind" | "area" | "tier" | "recordId">): string;
  /** The record id, or null unless every bound field matches (see header). */
  resolve(key: string, expect: HandleExpectation): string | null;
  /** True when `key` was minted by this table (a Handle-typed record field must be one). */
  owns(key: string): boolean;
  readonly size: number;
}

/** 96 bits of node:crypto randomness, base64url: "h_" + 16 chars. */
export const newHandleKey = (): string => `h_${randomBytes(12).toString("base64url")}`;

const MARKER = "[platform-ai handle table]";

/** A fresh, empty table bound to one operator and one turn (correlation id). */
export function createHandleTable(bind: { operatorId: string; correlationId: string }): HandleTable {
  if (!bind.operatorId || !bind.correlationId) throw new Error("createHandleTable: operatorId and correlationId are required");
  const byKey = new Map<string, HandleEntry>();
  const byRecord = new Map<string, string>();
  const table: HandleTable = {
    mint(e) {
      const rk = `${e.kind}\u0000${e.area}\u0000${e.tier}\u0000${e.recordId}`;
      const existing = byRecord.get(rk);
      if (existing) return existing;
      let key = newHandleKey();
      while (byKey.has(key)) key = newHandleKey();
      byKey.set(key, Object.freeze({ kind: e.kind, area: e.area, tier: e.tier, recordId: e.recordId, operatorId: bind.operatorId, correlationId: bind.correlationId }));
      byRecord.set(rk, key);
      return key;
    },
    resolve(key, expect) {
      if (typeof key !== "string" || !HANDLE_KEY_PATTERN.test(key)) return null;
      const h = byKey.get(key);
      if (!h) return null;
      const ok = h.operatorId === expect.operatorId
        && h.correlationId === expect.correlationId
        && h.operatorId === bind.operatorId && h.correlationId === bind.correlationId
        && h.kind === expect.kind
        && expect.areas.includes(h.area)
        && (h.tier === "OPS" || expect.tier === "CUSTOMER_SUCCESS");
      return ok ? h.recordId : null;
    },
    owns: (key) => typeof key === "string" && byKey.has(key),
    get size() { return byKey.size; },
  };
  // Never serialised or logged: JSON and util.inspect see a fixed marker only.
  Object.defineProperty(table, "toJSON", { value: () => MARKER, enumerable: false });
  Object.defineProperty(table, Symbol.for("nodejs.util.inspect.custom"), { value: () => MARKER, enumerable: false });
  return Object.freeze(table);
}
