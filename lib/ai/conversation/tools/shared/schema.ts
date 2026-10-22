/**
 * lib/ai/conversation/tools/shared/schema.ts
 *
 * JSON-schema builders for tool parameters (`obj`, `str`, `num`).
 *
 * Part of the tool surface split out of `tools.ts` (CQ-011). The facade
 * `lib/ai/conversation/tools.ts` owns the registry (`TOOLS`) and is the only
 * import path callers use; this module never imports the facade.
 *
 * Moved verbatim: every comment and invariant in `tools.ts`'s header applies
 * here — adapters, not authorities; read and calculate only; no Prisma client in
 * scope (the source scans in `lib/test-support/tools-source.ts` read this file).
 */

export const obj = (props: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties: props, required, additionalProperties: false });
export const str = (description: string) => ({ type: 'string', description });
export const num = (description: string) => ({ type: 'number', description });
