/**
 * lib/ai/context-builder.ts
 *
 * AI Context Builder — D4 Slice 1 foundation.
 *
 * buildContext() is the single public entry point. It:
 *   1. Validates that the requesting user is a member of the Space
 *      (not just a Prisma query guard — resolveSpaceContext fallback
 *       is explicitly checked).
 *   2. Loads the AiAgent for the Space (one per Space, auto-created on
 *      Space creation).
 *   3. Determines the domain list: manifest → intersect with agentScope
 *      if non-empty → intersect with scopeOverride if provided.
 *   4. Assembles each domain in parallel, catching per-domain errors so
 *      a failing assembler does not abort the entire build.
 *   5. Runs signal detectors over assembled domains.
 *   6. Writes an AuditLog row (AI_CONTEXT_ASSEMBLED).
 *   7. Returns SpaceContext_AI.
 *
 * Security invariants enforced here:
 *   - resolveSpaceContext fallback check (step 1): if spaceCtx.spaceId
 *     does not equal the requested spaceId, the user is not a member
 *     and we throw before touching any data.
 *   - This file never imports lib/plaid/encryption and never calls any
 *     decrypt function. That belongs exclusively to provider adapters.
 *   - The domain list is always filtered through the manifest + agentScope
 *     intersection before assembly. Assemblers may only read data scoped
 *     to the SpaceContext's spaceId.
 *
 * This is a server-only module — importing it in a client component will
 * throw at build time.
 */

import 'server-only';

// Bootstrap: side-effect imports register all assemblers at module load time.
// Add new assemblers to lib/ai/assemblers/index.ts — no changes needed here.
import '@/lib/ai/assemblers';

import { db } from '@/lib/db';
import { resolveSpaceContext } from '@/lib/space';
import { AuditAction } from '@/lib/audit-actions';
import { getDomainManifest } from '@/lib/ai/domain-manifest';
import { getAssembler } from '@/lib/ai/assembler-registry';
import { runSignalDetectors } from '@/lib/ai/signals';
import type {
  SpaceContext_AI,
  ContextDomain,
  ContextDomainSection,
  AssemblerOptions,
} from '@/lib/ai/types';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BuildContextOptions {
  /**
   * Override the domain list entirely. When set, the manifest and agentScope
   * are ignored — only the listed domains are assembled.
   * Intended for targeted consumers (e.g. a single-domain refresh endpoint).
   */
  scopeOverride?: ContextDomain[];

  /**
   * Passed through to each assembler. 'brief' signals that the assembler
   * should return condensed data; 'full' (default) returns everything.
   */
  scopeHint?: AssemblerOptions['scopeHint'];

  /**
   * Optional explicit transaction window (D6 dynamic windows). Threaded to the
   * transactions assembler so a historical question ("this year", "last 6
   * months") is summarized over the requested range. Absent → the assembler
   * keeps its default 30/90-day window.
   */
  transactionWindow?: AssemblerOptions['transactionWindow'];

  /**
   * Optional transaction-drilldown request (D6 — category/merchant evidence
   * retrieval). Threaded to the transactions assembler for explicit follow-up
   * questions ("what is this Other category made up of?"). Absent → no raw
   * rows are surfaced. Other assemblers ignore this field.
   */
  drilldown?: AssemblerOptions['drilldown'];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Build an AI context object for the given Space and user.
 *
 * Throws if:
 *   - The user is not a member of the Space (includes resolveSpaceContext
 *     fallback guard).
 *   - No AiAgent exists for the Space.
 */
export async function buildContext(
  spaceId: string,
  userId:  string,
  options: BuildContextOptions = {},
): Promise<SpaceContext_AI> {
  const requestedAt = new Date().toISOString();
  const { scopeOverride, scopeHint = 'full', transactionWindow, drilldown } = options;

  // ── Step 1: Validate membership ─────────────────────────────────────────
  //
  // resolveSpaceContext falls back to the user's personal Space when they
  // are not a member of the requested Space. We must check the returned
  // spaceId explicitly to catch that case.

  const spaceCtx = await resolveSpaceContext(userId, spaceId);

  if (spaceCtx.spaceId !== spaceId) {
    throw new Error(
      `[context-builder] Access denied: user "${userId}" is not a member ` +
      `of Space "${spaceId}".`,
    );
  }

  // ── Step 2: Load AiAgent ─────────────────────────────────────────────────

  const agent = await db.aiAgent.findUnique({
    where:  { spaceId },
    select: { id: true, agentScope: true },
  });

  if (!agent) {
    throw new Error(
      `[context-builder] No AiAgent found for Space "${spaceId}". ` +
      `Agents are auto-created on Space creation — this is likely a data ` +
      `integrity issue.`,
    );
  }

  // ── Step 3: Resolve domain list ──────────────────────────────────────────
  //
  // Priority (highest to lowest):
  //   1. scopeOverride — caller requests specific domains; skip manifest.
  //   2. manifest (from SpaceCategory) intersected with agentScope
  //      (when agentScope is non-empty).

  let resolvedDomains: ContextDomain[];

  if (scopeOverride && scopeOverride.length > 0) {
    resolvedDomains = scopeOverride;
  } else {
    const manifest = getDomainManifest(spaceCtx.space.category);

    if (agent.agentScope.length > 0) {
      const scopeSet = new Set(agent.agentScope);
      resolvedDomains = manifest.filter((d) => scopeSet.has(d));
    } else {
      resolvedDomains = manifest;
    }
  }

  // ── Step 4: Assemble domains in parallel ─────────────────────────────────
  //
  // Each assembler is called independently. A per-domain error is caught and
  // recorded in the skipped list — it must not abort other domains.

  const assemblerOptions: AssemblerOptions = {
    scopeHint,
    ...(transactionWindow ? { transactionWindow } : {}),
    ...(drilldown ? { drilldown } : {}),
  };

  const domainResults = await Promise.all(
    resolvedDomains.map(async (domain) => {
      const assembler = getAssembler(domain);

      if (!assembler) {
        // No assembler registered for this domain. Log and skip.
        return { domain, section: null, skipped: true, reason: 'no_assembler' } as const;
      }

      try {
        const section = await assembler(spaceCtx, assemblerOptions);
        return { domain, section, skipped: false } as const;
      } catch (err) {
        console.error(`[context-builder] Assembler for domain "${domain}" threw:`, err);
        return {
          domain,
          section: null,
          skipped: true,
          reason:  'assembler_error',
          error:   err instanceof Error ? err.message : String(err),
        } as const;
      }
    }),
  );

  // Build the domain map (null/skipped sections are excluded from the map
  // but remain in the audit metadata).
  const domains: Record<string, ContextDomainSection> = {};
  const skippedDomains: Array<{ domain: string; reason: string }> = [];

  for (const result of domainResults) {
    if (!result.skipped && result.section !== null) {
      domains[result.domain] = result.section;
    } else {
      skippedDomains.push({
        domain: result.domain,
        reason: result.skipped ? (result as { reason: string }).reason : 'null_section',
      });
    }
  }

  // ── Step 5: Detect signals ───────────────────────────────────────────────
  //
  // Runs after all assemblers complete, over the registered signal detectors.

  const signals = runSignalDetectors(domains, spaceId);

  // ── Step 6: Audit log ────────────────────────────────────────────────────

  const auditEntry = await db.auditLog.create({
    data: {
      action:  AuditAction.AI_CONTEXT_ASSEMBLED,
      userId,
      spaceId,
      metadata: {
        agentId:         agent.id,
        resolvedDomains,
        assembledDomains: Object.keys(domains),
        skippedDomains,
        signalCount:     signals.length,
        scopeHint,
        ...(transactionWindow ? { transactionWindow } : {}),
        ...(scopeOverride ? { scopeOverride } : {}),
      },
    },
    select: { id: true },
  });

  // ── Step 7: Return assembled context ─────────────────────────────────────

  return {
    requestedAt,
    spaceId:         spaceCtx.spaceId,
    userId,
    role:            spaceCtx.role,
    agentId:         agent.id,
    resolvedDomains,
    space: {
      id:       spaceCtx.space.id,
      name:     spaceCtx.space.name,
      type:     spaceCtx.space.type,
      category: spaceCtx.space.category,
      reportingCurrency: spaceCtx.space.reportingCurrency, // MC1 P4 Slice 7 — serializer label
    },
    domains,
    signals,
    auditLogId: auditEntry.id,
  };
}
