/**
 * lib/history/exploration-url.ts
 *
 * THE URL is the exploration's navigation state. Pure — no React, no router.
 *
 * ── Why the URL and not a store ──────────────────────────────────────────────
 * Browser back, refresh and a pasted link must all restore the same node at the
 * same date over the same window. A component store cannot do that, and a store
 * kept "in sync" with the URL is two sources of truth that drift the moment one
 * update path forgets the other. So the URL holds it, and the panel derives from
 * it. Local state is permitted only for animation and focus.
 *
 * ── The minimum safe parameter set ───────────────────────────────────────────
 * The selected date and window ALREADY live in the URL as `asof` / `preset` /
 * `compareto`, and the lens as `perspective`. Exploration adds exactly three:
 *
 *   hnode   node type + id, e.g. "bucket:crypto", "account:ckq…", "holding:a:b"
 *   hfrom   window start — the INHERITED window, pinned so a refresh cannot
 *           silently re-derive a different one from a preset
 *   hto     window end
 *
 * The ancestor path is deliberately NOT in the URL. It is DERIVED by the
 * resolver walking down from the root, so a link and a click produce the same
 * breadcrumb by construction. Encoding it would let a stale link assert a
 * parentage the data no longer has.
 *
 * Closing the panel removes exactly these three and touches nothing else, so
 * every existing lens/range URL stays byte-compatible.
 */

import type { ExplorationNodeType } from "./exploration";
import { normaliseLensRoot, type LensRoot } from "./lens-root-node";

/** The four params exploration owns. Nothing else may be written by the panel. */
export const EXPLORATION_URL_PARAMS = ["hroot", "hnode", "hfrom", "hto"] as const;

export interface ExplorationUrlState {
  /**
   * WHICH QUESTION the user is asking. The same account under `assets` and under
   * `liquid-net-worth` is two different questions, and back-navigation differs
   * between them, so the root cannot be derived from the node — it must be
   * carried.
   *
   * Absent ⇒ `net-worth`, so every link written before roots existed still
   * resolves exactly as it did.
   */
  root: LensRoot;
  nodeType: ExplorationNodeType;
  /** Null for the lens root, which has no id of its own. */
  nodeId: string | null;
  fromISO: string;
  toISO: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NODE_TYPES = new Set(["lens", "tier", "bucket", "account", "holding"]);

/**
 * Encode a node reference. `bucket:crypto` — the type, then the id verbatim.
 *
 * Node ids already carry their own type prefix (`bucket:crypto`,
 * `account:ck…`), so the stored form is just the canonical id; the lens root has
 * no id and encodes as `lens`.
 */
export function encodeNodeRef(nodeType: ExplorationNodeType, nodeId: string | null): string {
  return nodeType === "lens" ? "lens" : (nodeId ?? "");
}

/**
 * Decode a node reference. Unknown or malformed input yields null rather than a
 * guess: a bad link should open nothing, never the wrong thing.
 */
export function decodeNodeRef(
  raw: string | null,
): { nodeType: ExplorationNodeType; nodeId: string | null } | null {
  if (!raw) return null;
  if (raw === "lens") return { nodeType: "lens", nodeId: null };
  const prefix = raw.split(":")[0];
  if (!NODE_TYPES.has(prefix) || prefix === "lens") return null;
  // A bare prefix with no id is not a node.
  if (raw.length <= prefix.length + 1) return null;
  return { nodeType: prefix as ExplorationNodeType, nodeId: raw };
}

/** Read exploration state out of a query string. Null when the panel is closed. */
export function readExplorationUrl(search: string): ExplorationUrlState | null {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const ref = decodeNodeRef(p.get("hnode"));
  if (!ref) return null;
  // An unknown root is NOT an error: it falls back rather than opening nothing,
  // because a stale or hand-edited link should still show something honest.
  const root = normaliseLensRoot(p.get("hroot")) ?? "net-worth";
  const fromISO = p.get("hfrom");
  const toISO = p.get("hto");
  // The window is REQUIRED. Without it a refresh would fall back to a default
  // range and silently show a different chart than the link promised.
  if (!fromISO || !toISO || !ISO_DATE.test(fromISO) || !ISO_DATE.test(toISO)) return null;
  if (fromISO > toISO) return null;
  return { root, ...ref, fromISO, toISO };
}

/** The param updates that OPEN or move the panel. Merge into the existing query. */
export function explorationOpenUpdate(state: ExplorationUrlState): Record<string, string | null> {
  return {
    // net-worth is omitted from the URL: it is the default, and writing it would
    // make every pre-existing link differ from a freshly-produced one.
    hroot: state.root === "net-worth" ? null : state.root,
    hnode: encodeNodeRef(state.nodeType, state.nodeId),
    hfrom: state.fromISO,
    hto: state.toISO,
  };
}

/**
 * The param updates that CLOSE the panel.
 *
 * Only exploration's own keys are cleared. `asof`, `preset`, `perspective` and
 * every other lens param survive untouched — closing a drill-down must not move
 * the chart the user was looking at.
 */
export function explorationCloseUpdate(): Record<string, string | null> {
  return { hroot: null, hnode: null, hfrom: null, hto: null };
}
