/**
 * lib/ai/conversation/tools/shared/origin.ts
 *
 * Argument provenance: USER_STATED vs MODEL_SUPPLIED for a figure-bearing
 * argument (measures, projection and scenario tools).
 *
 * Part of the tool surface split out of `tools.ts` (CQ-011). The facade
 * `lib/ai/conversation/tools.ts` owns the registry (`TOOLS`) and is the only
 * import path callers use; this module never imports the facade.
 *
 * Moved verbatim: every comment and invariant in `tools.ts`'s header applies
 * here — adapters, not authorities; read and calculate only; no Prisma client in
 * scope (the source scans in `lib/test-support/tools-source.ts` read this file).
 */

import { argumentFiguresStated } from '../../pending-plan';
import { ORIGIN, type Origin } from '../../scenario-ledger';
import type { ToolContext } from '../types';

/** USER_STATED when the user's own words license every figure in `a[key]`; MODEL_SUPPLIED otherwise. */
export function originOf(a: Record<string, unknown>, key: string, ctx: ToolContext): Origin {
  return argumentFiguresStated(key, a[key], ctx.turn) ? ORIGIN.USER_STATED : ORIGIN.MODEL_SUPPLIED;
}
