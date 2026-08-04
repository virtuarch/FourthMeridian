/**
 * lib/history/exploration.ts
 *
 * THE single resolver behind the shared historical exploration panel.
 *
 * One entry point resolves any node in the tree — lens → bucket → account →
 * holding — by walking down from the canonical root. It composes authorities and
 * decides nothing:
 *
 *   getNetWorthPointDetail   the lens root (Slice B)
 *   expandBucketNode         bucket → accounts, reconciled (Slice C)
 *   expandAccountNode        account → holdings, reconciled (Slice D)
 *   buildNetWorthNode        the bucket partition, for a bucket's own series
 *
 * ── Why it re-walks from the root every time ─────────────────────────────────
 * A deep link arrives with a node id and nothing else. Walking down from the
 * root is what produces the ANCESTOR PATH — the breadcrumb — and it is the only
 * way to guarantee the path a link restores is the same one clicking produced.
 * Caching a flat id→node map would let the two drift, and the breadcrumb is
 * navigation state the user is entitled to trust.
 *
 * The walk is also what enforces refusal: a bucket the root refused is never
 * expanded, so a child can never appear beneath a parent that has no value.
 *
 * NO PERSISTENCE. READ-ONLY. No financial arithmetic of its own.
 */

import { getRecentSnapshots } from "@/lib/data/snapshots";
import { buildNetWorthNode } from "./net-worth-node";
import { expandBucketNode, expandAccountNode } from "./bucket-node";
import {
  buildLensRootNode, buildLiquidityRootNode, reframeBucketAsRoot, normaliseLensRoot,
  bucketKindForRoot, isBucketRoot, LENS_ROOT_LABELS, type LensRoot,
} from "./lens-root-node";
import type {
  BucketKind, HistoricalBucketNode, HistoricalLensNode,
  HistoricalNode, HistoricalSeriesPoint,
} from "./historical-node.core";

/** Generous enough for an all-time window; the boundary takes the newest N rows. */
const WINDOW_ROWS = 1100;

export const EXPLORATION_NODE_TYPES = ["lens", "tier", "bucket", "account", "holding"] as const;
export type ExplorationNodeType = (typeof EXPLORATION_NODE_TYPES)[number];

export interface ExplorationRequest {
  spaceId: string;
  /**
   * Which ROOT to walk from. Every root selects an existing canonical authority;
   * none of them forks one. Absent or unknown resolves to net-worth, so every
   * link written before roots existed keeps working.
   */
  lens: string;
  nodeType: ExplorationNodeType;
  /** Canonical node id. Ignored for `lens`. */
  nodeId?: string | null;
  dateISO: string;
  fromISO: string;
  toISO: string;
}

export type ExplorationError =
  | "NODE_NOT_FOUND"
  | "PARENT_REFUSED"
  | "UNSUPPORTED_LENS";

/** Generous enough for an all-time window; the boundary takes the newest N rows. */
async function readSnapshotFor(spaceId: string, dateISO: string) {
  const rows = await getRecentSnapshots(WINDOW_ROWS, { spaceId });
  return { row: rows.find((r) => r.date === dateISO) ?? null, rows };
}

/**
 * The ACCOUNT node id owning a node id.
 *
 * A holding id is `holding:<accountId>:<instrumentId>`, and an account id is
 * `account:<accountId>` — different prefixes over the same account. Slicing the
 * holding id without re-prefixing yields `holding:<accountId>`, which matches no
 * account and made every holding deep-link resolve to NODE_NOT_FOUND.
 */
function accountIdOf(nodeId: string): string {
  if (!nodeId.startsWith("holding:")) return nodeId;
  const [, accountId] = nodeId.split(":");
  return `account:${accountId}`;
}

export interface ExplorationResult {
  node: HistoricalNode | null;
  /** Root → … → node. The last entry IS the node. Empty when unresolved. */
  path: HistoricalNode[];
  error: ExplorationError | null;
}

/**
 * Resolve one node, with its ancestors.
 *
 * Total: never throws. An unresolvable id returns `error`, never a fabricated
 * node — the panel renders the refusal rather than an empty shell.
 */
export async function resolveExplorationNode(
  req: ExplorationRequest,
): Promise<ExplorationResult> {
  const { spaceId, nodeType, nodeId, dateISO, fromISO, toISO } = req;

  // BACKWARD COMPATIBILITY: an unknown or absent root is net-worth, so every
  // link written before roots existed resolves exactly as it did.
  const lens: LensRoot = normaliseLensRoot(req.lens) ?? "net-worth";

  const { row } = await readSnapshotFor(spaceId, dateISO);
  const currency = row?.currency ?? "USD";

  if (!row) {
    return { node: unavailableRoot(lens, dateISO, fromISO, toISO, currency), path: [], error: null };
  }

  // ── ROOT DISPATCH ─────────────────────────────────────────────────────────
  //
  // Each branch SELECTS an authority; none of them computes. The Net Worth
  // partition is built once and every root is a projection of it, so two roots
  // can never disagree about a bucket they share.
  let root: HistoricalLensNode;
  const bucketKind = bucketKindForRoot(lens);

  if (isBucketRoot(lens) && bucketKind) {
    const nw = buildLensRootNode({ snapshot: row, lens: "net-worth", dateISO, fromISO, toISO, currency })!;
    const raw = nw.components.find(
      (c): c is HistoricalBucketNode => c.nodeType === "bucket" && c.bucketKind === bucketKind,
    );
    if (!raw) {
      return { node: unavailableRoot(lens, dateISO, fromISO, toISO, currency), path: [], error: null };
    }
    // A refused bucket is still a legitimate root: it states its refusal rather
    // than 404-ing, so a Debt link on a contradictory date explains itself.
    const expanded = raw.assertable ? await expandBucketNode({ spaceId, bucket: raw }) : raw;
    root = reframeBucketAsRoot(expanded, lens, LENS_ROOT_LABELS[lens]);
    root.series = await bucketSeries(spaceId, bucketKind, fromISO, toISO);
  } else if (lens === "liquidity") {
    root = buildLiquidityRootNode({ snapshot: row, dateISO, fromISO, toISO, currency });
    root.series = await lensSeries(spaceId, lens, fromISO, toISO);
  } else {
    const built = buildLensRootNode({ snapshot: row, lens, dateISO, fromISO, toISO, currency });
    if (!built) {
      return { node: null, path: [], error: "UNSUPPORTED_LENS" };
    }
    root = built;
    root.series = await lensSeries(spaceId, lens, fromISO, toISO);
  }

  if (nodeType === "lens") return { node: root, path: [root], error: null };

  // ── tier (liquidity only) ─────────────────────────────────────────────────
  //
  // A tier groups buckets, so descending past one adds a level the other roots
  // do not have. The path records it, because "Liquidity › Cash now › Cash" is
  // the question the user asked.
  if (lens === "liquidity") {
    const tiers = root.components.filter((c) => c.nodeType === "tier");
    if (nodeType === "tier") {
      const tier = tiers.find((t) => t.id === nodeId);
      if (!tier) return { node: null, path: [root], error: "NODE_NOT_FOUND" };
      return { node: tier, path: [root, tier], error: null };
    }
    for (const tier of tiers) {
      const found = await resolveUnderTier(spaceId, root, tier, nodeType, nodeId);
      if (found) return found;
    }
    return { node: null, path: [root], error: "NODE_NOT_FOUND" };
  }

  // ── bucket ────────────────────────────────────────────────────────────────
  //
  // A BUCKET root has no bucket level beneath it — its children are accounts —
  // so a bucket request under one is the root itself.
  if (isBucketRoot(lens)) {
    return resolveBeneathAccounts(spaceId, root, nodeType, nodeId, root.components);
  }

  let expandedBucket: HistoricalBucketNode | null = null;
  let bucketId: string | null | undefined;
  if (nodeType === "bucket") {
    bucketId = nodeId;
  } else {
    const found = await findBucketFor(spaceId, root, nodeId ?? "");
    bucketId = found?.id ?? null;
    expandedBucket = found;
  }

  const rawBucket = root.components.find((c) => c.id === bucketId);
  if (!rawBucket || rawBucket.nodeType !== "bucket") {
    return { node: null, path: [root], error: "NODE_NOT_FOUND" };
  }
  if (!rawBucket.assertable) {
    return { node: rawBucket, path: [root, rawBucket], error: null };
  }

  const bucket = expandedBucket ?? await expandBucketNode({ spaceId, bucket: rawBucket });
  if (nodeType === "bucket") {
    bucket.series = await bucketSeries(spaceId, bucket.bucketKind, fromISO, toISO);
    return { node: bucket, path: [root, bucket], error: null };
  }

  // ── account / holding ─────────────────────────────────────────────────────
  const accountId = nodeType === "account" ? nodeId : accountIdOf(nodeId ?? "");
  const rawAccount = bucket.components.find((c) => c.id === accountId);
  if (!rawAccount || rawAccount.nodeType !== "account") {
    return { node: null, path: [root, bucket], error: "NODE_NOT_FOUND" };
  }
  const account = await expandAccountNode({ spaceId, account: rawAccount });
  if (nodeType === "account") return { node: account, path: [root, bucket, account], error: null };

  const holding = account.components.find((c) => c.id === nodeId);
  if (!holding || holding.nodeType !== "holding") {
    return { node: null, path: [root, bucket, account], error: "NODE_NOT_FOUND" };
  }
  return { node: holding, path: [root, bucket, account, holding], error: null };
}

/** Descend beneath one liquidity tier. Null when the node is not in this tier. */
async function resolveUnderTier(
  spaceId: string,
  root: HistoricalLensNode,
  tier: HistoricalNode,
  nodeType: ExplorationNodeType,
  nodeId: string | null | undefined,
): Promise<ExplorationResult | null> {
  const accountId = nodeType === "account" ? nodeId : accountIdOf(nodeId ?? "");
  for (const raw of tier.components) {
    if (raw.nodeType !== "bucket" || !raw.assertable) continue;
    if (nodeType === "bucket" && raw.id !== nodeId) continue;
    const bucket = await expandBucketNode({ spaceId, bucket: raw });
    if (nodeType === "bucket") {
      bucket.series = await bucketSeries(spaceId, bucket.bucketKind, root.fromISO, root.toISO);
      return { node: bucket, path: [root, tier, bucket], error: null };
    }
    const rawAccount = bucket.components.find((c) => c.id === accountId);
    if (!rawAccount || rawAccount.nodeType !== "account") continue;
    const account = await expandAccountNode({ spaceId, account: rawAccount });
    if (nodeType === "account") return { node: account, path: [root, tier, bucket, account], error: null };
    const holding = account.components.find((c) => c.id === nodeId);
    if (!holding || holding.nodeType !== "holding") return { node: null, path: [root, tier, bucket, account], error: "NODE_NOT_FOUND" };
    return { node: holding, path: [root, tier, bucket, account, holding], error: null };
  }
  return null;
}

/**
 * Descend from a BUCKET root, whose children are already accounts.
 *
 * The path is two levels shorter than under Net Worth, and that is the point:
 * `Debt › Chase Card` is the question the user asked, not
 * `Net worth › Debt › Chase Card`.
 */
async function resolveBeneathAccounts(
  spaceId: string,
  root: HistoricalLensNode,
  nodeType: ExplorationNodeType,
  nodeId: string | null | undefined,
  accounts: readonly HistoricalNode[],
): Promise<ExplorationResult> {
  const accountId = nodeType === "account" ? nodeId : accountIdOf(nodeId ?? "");
  const rawAccount = accounts.find((c) => c.id === accountId);
  if (!rawAccount || rawAccount.nodeType !== "account") {
    return { node: null, path: [root], error: "NODE_NOT_FOUND" };
  }
  const account = await expandAccountNode({ spaceId, account: rawAccount });
  if (nodeType === "account") return { node: account, path: [root, account], error: null };

  const holding = account.components.find((c) => c.id === nodeId);
  if (!holding || holding.nodeType !== "holding") {
    return { node: null, path: [root, account], error: "NODE_NOT_FOUND" };
  }
  return { node: holding, path: [root, account, holding], error: null };
}

/** A root with no snapshot or no component on this date. States it, never 404s. */
function unavailableRoot(
  lens: LensRoot, dateISO: string, fromISO: string, toISO: string, currency: string,
): HistoricalLensNode {
  return {
    nodeType: "lens", lens, id: `lens:${lens}`, label: LENS_ROOT_LABELS[lens],
    dateISO, fromISO, toISO, currency,
    displayedValue: null, explainedValue: null, unattributedObservedAmount: null,
    reconciliation: "UNAVAILABLE", assertable: false, unavailableReason: "NO_SNAPSHOT_FOR_DATE",
    provenance: { basis: "reconstructed", tier: "unknown", supportedFromISO: null, supportedToISO: null, note: null },
    breadcrumb: [{ id: `lens:${lens}`, label: LENS_ROOT_LABELS[lens], nodeType: "lens" }],
    components: [], drilldown: { available: false, reason: "NO_SNAPSHOT_FOR_DATE" },
    historicalCount: 0, valuedCount: 0, explainedAssets: null, explainedLiabilities: null,
  };
}

/**
 * Which bucket owns an `account:…` or `holding:…` id.
 *
 * Only the drillable buckets are expanded, and expansion stops at the first
 * match — a deep link to a checking account never expands Investments.
 */
async function findBucketFor(
  spaceId: string,
  root: HistoricalLensNode,
  descendantId: string,
): Promise<HistoricalBucketNode | null> {
  const accountId = accountIdOf(descendantId);
  const candidates = root.components.filter(
    (c) => c.nodeType === "bucket" && c.drilldown.available && c.assertable,
  );
  // Searched in parallel: the buckets are independent reads, and a deep link to
  // the last one should not pay for every bucket before it in sequence.
  const expanded = await Promise.all(
    candidates.map((c) => expandBucketNode({ spaceId, bucket: c as never })),
  );
  return expanded.find((b) => b.components.some((a) => a.id === accountId)) ?? null;
}

/**
 * A bucket's own series over the inherited window.
 *
 * Built by running the SAME `buildNetWorthNode` partition over each stored row
 * and reading this bucket out of it — so a bucket's chart and the Net Worth
 * chart above it can never disagree about what that bucket was worth. One read
 * for the whole window.
 */
/**
 * An AGGREGATE root's own chart over the inherited window.
 *
 * Built from the same `buildLensRootNode` that produced the point, per stored
 * row — so a root's chart and its selected point can never disagree.
 */
async function lensSeries(
  spaceId: string,
  lens: LensRoot,
  fromISO: string,
  toISO: string,
): Promise<HistoricalSeriesPoint[]> {
  const rows = await getRecentSnapshots(WINDOW_ROWS, { spaceId });
  const currency = rows[0]?.currency ?? "USD";
  return rows
    .filter((r) => r.date >= fromISO && r.date <= toISO && r.fxMiss !== true)
    .map((r) => {
      const node = lens === "liquidity"
        ? buildLiquidityRootNode({ snapshot: r, dateISO: r.date, fromISO, toISO, currency: r.currency ?? currency })
        : buildLensRootNode({ snapshot: r, lens, dateISO: r.date, fromISO, toISO, currency: r.currency ?? currency });
      return {
        dateISO: r.date,
        value: node?.displayedValue ?? null,
        basis: node?.provenance.basis ?? "reconstructed",
        ...(node?.displayedValue == null
          ? { unavailableReason: node?.unavailableReason ?? "UNAVAILABLE" }
          : {}),
      };
    });
}

async function bucketSeries(
  spaceId: string,
  bucketKind: string,
  fromISO: string,
  toISO: string,
): Promise<HistoricalSeriesPoint[]> {
  const rows = await getRecentSnapshots(WINDOW_ROWS, { spaceId });
  const currency = rows[0]?.currency ?? "USD";
  return rows
    .filter((r) => r.date >= fromISO && r.date <= toISO && r.fxMiss !== true)
    .map((r) => {
      const node = buildNetWorthNode({
        snapshot: r, dateISO: r.date, fromISO, toISO, currency: r.currency ?? currency,
      });
      const b = node.components.find((c) => c.nodeType === "bucket" && c.bucketKind === bucketKind);
      return {
        dateISO: r.date,
        value: b?.displayedValue ?? null,
        basis: node.provenance.basis,
        // A bucket absent from a date is a real gap: it held nothing material,
        // or the aggregate refused it. Never a zero.
        ...(b?.displayedValue == null
          ? { unavailableReason: b?.unavailableReason ?? "NOT_PRESENT_ON_DATE" }
          : {}),
      };
    });
}
