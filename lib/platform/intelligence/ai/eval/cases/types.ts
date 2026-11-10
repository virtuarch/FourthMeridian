/**
 * lib/platform/intelligence/ai/eval/cases/types.ts  (Platform AI E0-CI — the case shape)
 *
 * A ROUTE case runs one or more turns through the REAL ask route (flag ON, in-memory
 * Prisma fake, scripted provider). A CORE case runs runPlatformAiTurn directly (the
 * memory hooks, which only the conversations route wires). Each case names the gates it
 * feeds and returns its own problems (empty = held) from what the runner observed.
 */

import type { GateId } from "../gates";
import type { E0_OPERATORS } from "../fixtures";
import type { ScriptStep } from "../scripted-model";
import type { PlatformArea } from "@prisma/client";
import type { PlatformAiBinding } from "../../core";
import type { ScopedArea } from "../../authz/boundary";
import type { PlatformAiRecheck } from "../../authz/recheck";

export type E0Pack = "metrics" | "navigation" | "memory" | "boundary";

/** What the runner observed for one route turn. */
export interface RouteTurnObservation {
  status: number;
  body: Record<string, unknown>;
  /** Raw provider request bodies of this turn. */
  requests: readonly string[];
  /** The tool results the model received this turn (parsed `role: "tool"` contents of the last request). */
  toolResults: readonly unknown[];
  /** Hrefs this turn's tool results returned (href / drill.page) — the only links that may render. */
  returnedHrefs: ReadonlySet<string>;
}

export interface RouteCase {
  kind: "route";
  id: string;
  pack: E0Pack;
  gates: readonly GateId[];
  operator: keyof typeof E0_OPERATORS;
  /**
   * P2b — Platform AI spend already on today's ledger before the case runs: one RETURNED
   * `platform_ai` row per entry, costing `usd` at the E0 model's rate (the runner seeds it and
   * drains it after the case). Absent ⇒ an empty ledger, as before.
   */
  ledger?: readonly { operator: keyof typeof E0_OPERATORS; usd: number }[];
  /** One entry per turn (a case may need several turns to stay within the tool budget). */
  turns: readonly { question: string; steps: readonly ScriptStep[] }[];
  /** Problems (empty = the case held). Called once with every turn's observation. */
  check(obs: readonly RouteTurnObservation[]): string[];
}

/** What the runner observed for one core turn with memory hooks. */
export interface CoreTurnObservation {
  requests: readonly string[];
  toolResults: readonly unknown[];
  answerText: string;
  card: unknown;
  refusals: readonly string[];
}

export interface CoreMemoryCase {
  kind: "core-memory";
  id: string;
  pack: E0Pack;
  gates: readonly GateId[];
  question: string;
  steps: readonly ScriptStep[];
  check(obs: CoreTurnObservation): string[];
}

/**
 * P2 — what a UNIT case gets from the runner: real route-issued scopes and real bindings for
 * the fixture operators (scope.ts is only imported by the runner, a test file), and a recheck
 * that reads the fixture world's grant rows on every call.
 */
export interface UnitContext {
  operatorId(op: keyof typeof E0_OPERATORS): string;
  scoped(op: keyof typeof E0_OPERATORS, area: PlatformArea): { scope: ScopedArea; binding: PlatformAiBinding } | null;
  /** A per-call recheck over the fixture world's PlatformGrant rows (status ACTIVE ⇒ fresh guard). */
  recheck(op: keyof typeof E0_OPERATORS): PlatformAiRecheck;
}

/** A case that drives authz/boundary.ts directly (handle binding, flag-OFF packs): no provider. */
export interface UnitCase {
  kind: "unit";
  id: string;
  pack: E0Pack;
  gates: readonly GateId[];
  run(ctx: UnitContext): Promise<string[]>;
}

export type E0Case = RouteCase | CoreMemoryCase | UnitCase;

/** Tool results helper: the i-th result equals the one NOT_FOUND shape. */
export const isNotFound = (x: unknown): boolean => JSON.stringify(x) === JSON.stringify({ found: false });
