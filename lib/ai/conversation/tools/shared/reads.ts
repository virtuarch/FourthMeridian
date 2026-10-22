/**
 * lib/ai/conversation/tools/shared/reads.ts
 *
 * The two context-bound reads every domain uses: an adjudicated absence
 * (`absentIn`) and an assembler read on the tool's own authority (`assemble`).
 *
 * Part of the tool surface split out of `tools.ts` (CQ-011). The facade
 * `lib/ai/conversation/tools.ts` owns the registry (`TOOLS`) and is the only
 * import path callers use; this module never imports the facade.
 *
 * Moved verbatim: every comment and invariant in `tools.ts`'s header applies
 * here — adapters, not authorities; read and calculate only; no Prisma client in
 * scope (the source scans in `lib/test-support/tools-source.ts` read this file).
 */

import { getAssembler } from '@/lib/ai/assembler-registry';
/**
 * RLS-AI-S0 — THE ABSENCE CONTRACT. Value imports, and deliberately: the oracle is
 * a CAPABILITY derived from `ctx.readClient`, not a client, so this file still
 * holds no Prisma client and the source scans that assert it still pass.
 */
import { absent } from '@/lib/ai/absence';
import type { ToolContext } from '../types';

/**
 * RLS-AI-S0 — AN EMPTY AUTHORITATIVE READ, ADJUDICATED.
 *
 * ⚠️ EVERY DECLARATIVE ABSENCE IN THIS FILE GOES THROUGH HERE, which is the point:
 * one helper means the next tool somebody writes cannot assert an absence without
 * also establishing it. `proven` is the sentence for a Space that genuinely holds
 * nothing; `subject` is a NOUN PHRASE from which the indeterminate sentence is
 * derived — a caller cannot write prose into the indeterminate branch.
 *
 * ⚠️ IT COSTS NOTHING ON THE SUCCESS PATH. It is called only where a read already
 * came back empty, and `adjudicateAbsence` issues at most ONE indexed probe per
 * client per Space (see lib/ai/absence.ts), so a six-hop turn that happens to find
 * three empty domains pays one query, not three.
 */
export const absentIn = (
  ctx: ToolContext, proven: string, subject: string, extra: Record<string, unknown> = {},
) => absent(ctx.readClient, ctx.spaceId, { proven, subject }, extra);

export async function assemble<T>(
  domain: string, ctx: ToolContext, options: Record<string, unknown> = {},
): Promise<T | null> {
  const a = getAssembler(domain);
  if (!a) return null;
  // ⚠️ RLS-AI-S6 — THE TOOL'S OWN READ AUTHORITY, PASSED DOWN. Inside a phase this
  // is the tenant transaction the dispatcher opened; outside one it is whatever the
  // surface stated. Either way the assembler no longer picks: before this slice a
  // tool running as the tenant still assembled its domain as the migration
  // principal, which is a split authority inside a SINGLE tool call.
  const section = await a(ctx.readClient, ctx.spaceCtx, { scopeHint: 'full', ...options } as never);
  return (section?.data as T) ?? null;
}
