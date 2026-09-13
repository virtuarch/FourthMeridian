import { cookies } from "next/headers";
import { getSpaceContext, type SpaceContext } from "@/lib/space";
import { getLatestAdvice } from "@/lib/data/advice";
import { recallMemories } from "@/lib/ai/conversation/memory-store";
import { selectStarterTopics, type StarterTopics } from "@/lib/ai/conversation/starter-topics";
import { todayUTCISO } from "@/lib/time/clock";
import { AnalyzeClient } from "@/components/dashboard/AnalyzeClient";
import { composeStarters, starterIndexFrom } from "@/components/ai/conversation-surface";
import { TRANSCRIPT_HINT_COOKIE } from "@/components/ai/transcript-cache";

export const preferredRegion = "sin1";
export const runtime = "nodejs";

export default async function AnalyzePage() {
  // AI-4: ONE CONVERSATION, ONE SPACE — the dashboard's active Space. The same
  // resolution every dashboard page uses (cookie → preferred Space → personal),
  // cache()-shared with the layout, so the advice, the starters and the chat all
  // name one Space. The id is posted with every turn and the route still treats it
  // as untrusted: it re-resolves membership and refuses a mismatch with a 403.
  const ctx = await getSpaceContext();

  // AI Experience Convergence (AI-2): only the scheduled-advice capability and the
  // starters need server data. Both are scoped to the Space resolved above.
  const [advice, personal] = await Promise.all([
    getLatestAdvice({ spaceId: ctx.spaceId }),
    loadStarterTopics(ctx),
  ]);

  // AI-3: the empty-state starter line is chosen here, per request, so the server
  // render and hydration agree on it — no client-side re-pick, no flicker. (The
  // dashboard layout reads the session, so this route is always dynamic.)
  // An async server component renders once per request, so the purity rule's concern
  // (unstable output across re-renders) does not apply; varying per visit is the point.
  // eslint-disable-next-line react-hooks/purity
  const starterIndex = starterIndexFrom(Math.random());

  // ⚠️ A HINT ABOUT THE FIRST PAINT, NOT A SOURCE OF TRUTH. The transcript lives
  // in the browser's own storage, which a server render cannot see — so without
  // this, a returning user's first frame is always the empty state and their
  // conversation arrives as a visible replacement. The cookie says only which
  // Space a local transcript was last written for (an id the browser already
  // posts with every turn), and the client's cache still decides what is actually
  // restored. Stale in one direction only: it can promise a conversation that
  // turns out to be expired, which costs a flip in the other direction.
  const hint = (await cookies()).get(TRANSCRIPT_HINT_COOKIE)?.value;
  const expectTranscript = hint === ctx.spaceId;

  // key: a render under a different active Space is a different conversation — the
  // transcript, and the scenario sealed against it, never cross Spaces.
  return (
    <AnalyzeClient
      key={ctx.spaceId}
      advice={advice}
      starterIndex={starterIndex}
      spaceId={ctx.spaceId}
      spaceName={ctx.space.name}
      starter={composeStarters(personal)}
      userId={ctx.userId}
      expectTranscript={expectTranscript}
    />
  );
}

/**
 * The user's own durable memory in this Space, as starter topics — or null.
 *
 * One indexed read (ACTIVE rows, scoped to this Space AND this user) plus pure
 * formatting; no model call. Memory is a nicety here: any failure is the generic
 * empty state, never a failed page.
 */
async function loadStarterTopics(ctx: SpaceContext): Promise<StarterTopics | null> {
  try {
    const memories = await recallMemories(
      { spaceId: ctx.spaceId, ownerUserId: ctx.userId },
      { limit: 50 },
    );
    return selectStarterTopics(memories, todayUTCISO(), ctx.space.reportingCurrency);
  } catch {
    return null;
  }
}
