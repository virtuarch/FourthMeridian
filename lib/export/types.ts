/**
 * lib/export/types.ts  (OPS-2 S6)
 *
 * Serialisable shapes for the personal-data export. Every field here is a
 * plain JSON value (no Date instances) — the assembler composes existing
 * read-layer DTOs, which are already client-safe, and the tabular sets extend
 * them with the Space they were read through.
 */

import type { Account, Holding, Snapshot, Transaction } from "@/types";

/** A visible account tagged with the Space it was exported through. */
export type ExportAccount = Account & { spaceId: string; spaceName: string };
/** A banking transaction tagged with its Space. */
export type ExportTransaction = Transaction & { spaceId: string };
/** An investment holding tagged with its Space. */
export type ExportHolding = Holding & { spaceId: string };
/** A daily Space snapshot tagged with its Space. */
export type ExportSnapshot = Snapshot & { spaceId: string; spaceName: string };

export interface ExportManifest {
  app: "fourth-meridian";
  kind: "personal-data-export";
  schemaVersion: string;
  generatedAt: string; // ISO
  userId: string;
  files: string[];
  counts: Record<string, number>;
  /** True when the KD-7 transaction cap truncated the transactions set (D6). */
  truncated: boolean;
  notes: string[];
}

export interface ExportData {
  manifest: ExportManifest;
  profile: Record<string, unknown>;
  settings: Record<string, unknown>;
  security: {
    totpEnabled: boolean;
    sessions: Record<string, unknown>[];
    recoveryCodes: Record<string, unknown>[];
  };
  spaces: Record<string, unknown>[];
  accounts: ExportAccount[];
  connections: {
    accountConnections: Record<string, unknown>[];
    plaidItems: Record<string, unknown>[];
    connections: Record<string, unknown>[];
  };
  transactions: ExportTransaction[];
  holdings: ExportHolding[];
  snapshots: ExportSnapshot[];
  creditHistory: Record<string, unknown>[];
  goals: Record<string, unknown>[];
  auditHistory: Record<string, unknown>[];
  imports: {
    batches: Record<string, unknown>[];
    mappingProfiles: Record<string, unknown>[];
  };
  aiAdvice: Record<string, unknown>[];
}
