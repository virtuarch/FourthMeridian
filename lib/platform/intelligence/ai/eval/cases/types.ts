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

export type E0Case = RouteCase | CoreMemoryCase;

/** Tool results helper: the i-th result equals the one NOT_FOUND shape. */
export const isNotFound = (x: unknown): boolean => JSON.stringify(x) === JSON.stringify({ found: false });
