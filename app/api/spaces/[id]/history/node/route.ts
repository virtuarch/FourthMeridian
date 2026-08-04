/**
 * GET /api/spaces/[id]/history/node
 *   ?lens=net-worth&type=lens|bucket|account|holding&id=<nodeId>
 *   &date=YYYY-MM-DD&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * THE one exploration route. Every level of the tree resolves through it, so a
 * lens-specific route can never introduce a second answer to the same question.
 *
 * The route resolves NOTHING financial. It gates membership, validates the
 * window, and returns `resolveExplorationNode` — which itself only composes the
 * canonical authorities. No reconciliation, ownership, valuation or assertability
 * decision is made here or downstream of here.
 */

import { NextRequest, NextResponse } from "next/server";
import { SpaceMemberRole } from "@prisma/client";
import { requireSpaceRole } from "@/lib/session";
import {
  resolveExplorationNode, EXPLORATION_NODE_TYPES, type ExplorationNodeType,
} from "@/lib/history/exploration";

export const dynamic = "force-dynamic";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A window wider than this is a mistake, not a request. Bounds the response. */
const MAX_WINDOW_DAYS = 3660;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: spaceId } = await params;

  const [ctx, err] = await requireSpaceRole(spaceId, SpaceMemberRole.VIEWER);
  if (err) return err;
  void ctx;

  const q = req.nextUrl.searchParams;
  const lens = q.get("root") ?? q.get("lens") ?? "net-worth";
  const nodeType = (q.get("type") ?? "lens") as ExplorationNodeType;
  const nodeId = q.get("id");
  const date = q.get("date");
  const from = q.get("from");
  const to = q.get("to");

  if (!EXPLORATION_NODE_TYPES.includes(nodeType)) {
    return NextResponse.json({ error: "BAD_NODE_TYPE" }, { status: 400 });
  }
  for (const [name, v] of [["date", date], ["from", from], ["to", to]] as const) {
    if (!v || !ISO_DATE.test(v)) {
      return NextResponse.json({ error: "BAD_DATE", detail: `${name} must be YYYY-MM-DD` }, { status: 400 });
    }
  }
  if (from! > to!) {
    return NextResponse.json({ error: "BAD_WINDOW", detail: "from must not exceed to" }, { status: 400 });
  }
  const days = (Date.parse(to!) - Date.parse(from!)) / 86_400_000;
  if (days > MAX_WINDOW_DAYS) {
    return NextResponse.json({ error: "WINDOW_TOO_WIDE", detail: `max ${MAX_WINDOW_DAYS} days` }, { status: 400 });
  }
  if (nodeType !== "lens" && !nodeId) {
    return NextResponse.json({ error: "MISSING_NODE_ID" }, { status: 400 });
  }

  const result = await resolveExplorationNode({
    spaceId, lens, nodeType, nodeId, dateISO: date!, fromISO: from!, toISO: to!,
  });

  if (result.error) {
    // Stable, enumerable codes. Never a provider payload, never an internal
    // message — an error body is a surface an attacker reads too.
    const status = result.error === "UNSUPPORTED_LENS" ? 400 : 404;
    return NextResponse.json({ error: result.error, path: result.path }, { status });
  }

  // Observability for the two states worth watching in production.
  if (result.node && (result.node.reconciliation === "CONTRADICTORY" || result.node.reconciliation === "UNAVAILABLE")) {
    console.warn(
      `[history/node] ${spaceId} ${date} ${nodeType}:${nodeId ?? lens} → ` +
      `${result.node.reconciliation} (${result.node.unavailableReason ?? "no reason"})`,
    );
  }

  return NextResponse.json({ node: result.node, path: result.path });
}
