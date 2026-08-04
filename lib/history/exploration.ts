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
import { getNetWorthPointDetail } from "./net-worth-point-detail";
import { expandBucketNode, expandAccountNode } from "./bucket-node";
import type {
  HistoricalNode, HistoricalSeriesPoint,
} from "./historical-node.core";

/** Generous enough for an all-time window; the boundary takes the newest N rows. */
const WINDOW_ROWS = 1100;

export const EXPLORATION_NODE_TYPES = ["lens", "bucket", "account", "holding"] as const;
export type ExplorationNodeType = (typeof EXPLORATION_NODE_TYPES)[number];

export interface ExplorationRequest {
  spaceId: string;
  /** Which lens root to walk from. Only "net-worth" today; the tree is the same. */
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
  const { spaceId, lens, nodeType, nodeId, dateISO, fromISO, toISO } = req;
  if (lens !== "net-worth") return { node: null, path: [], error: "UNSUPPORTED_LENS" };

  // The root always carries its own series: it is the chart the user clicked.
  const root = await getNetWorthPointDetail({
    spaceId, dateISO, fromISO, toISO, includeSeries: true,
  });
  if (nodeType === "lens") return { node: root, path: [root], error: null };

  // ── bucket ────────────────────────────────────────────────────────────────
  //
  // Descending to an account or holding requires finding which bucket owns it,
  // and that search EXPANDS buckets. The expansion is carried back rather than
  // repeated: expanding twice was the single largest cost in the walk.
  let expandedBucket: Awaited<ReturnType<typeof expandBucketNode>> | null = null;
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
  // A bucket the ROOT refused is never expanded: a child must never render
  // beneath a parent that may not be asserted.
  if (!rawBucket.assertable) {
    return { node: rawBucket, path: [root, rawBucket], error: null };
  }

  const bucket = expandedBucket ?? await expandBucketNode({ spaceId, bucket: rawBucket });
  // A bucket's own chart is only needed when the bucket is what we are showing.
  if (nodeType === "bucket") {
    bucket.series = await bucketSeries(spaceId, bucket.bucketKind, fromISO, toISO);
  }
  if (nodeType === "bucket") return { node: bucket, path: [root, bucket], error: null };

  // ── account ───────────────────────────────────────────────────────────────
  const accountId = nodeType === "account" ? nodeId : accountIdOf(nodeId ?? "");
  const rawAccount = bucket.components.find((c) => c.id === accountId);
  if (!rawAccount || rawAccount.nodeType !== "account") {
    return { node: null, path: [root, bucket], error: "NODE_NOT_FOUND" };
  }
  const account = await expandAccountNode({ spaceId, account: rawAccount });
  if (nodeType === "account") return { node: account, path: [root, bucket, account], error: null };

  // ── holding ───────────────────────────────────────────────────────────────
  const holding = account.components.find((c) => c.id === nodeId);
  if (!holding || holding.nodeType !== "holding") {
    return { node: null, path: [root, bucket, account], error: "NODE_NOT_FOUND" };
  }
  return { node: holding, path: [root, bucket, account, holding], error: null };
}

/**
 * Which bucket owns an `account:…` or `holding:…` id.
 *
 * Only the drillable buckets are expanded, and expansion stops at the first
 * match — a deep link to a checking account never expands Investments.
 */
async function findBucketFor(
  spaceId: string,
  root: Awaited<ReturnType<typeof getNetWorthPointDetail>>,
  descendantId: string,
): Promise<Awaited<ReturnType<typeof expandBucketNode>> | null> {
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
