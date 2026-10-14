/**
 * jobs/product-event-retention.ts  (BETA A6 — coordinator STUB; Workstream W3 fills it)
 *
 * Deletes AuditLog rows whose action is in PRODUCT_EVENT_ACTIONS (lib/audit-actions.ts)
 * and whose createdAt is older than the owner's 13-month retention window. Never
 * touches security, auth, operator or product-lifecycle actions. Daily, fixed.
 */
export const PRODUCT_EVENT_RETENTION_MONTHS = 13;
export interface ProductEventRetentionResult { deleted: number; cutoff: string; }
export async function retainProductEvents(): Promise<ProductEventRetentionResult> {
  throw new Error("product-event-retention: not implemented (BETA W3)");
}
