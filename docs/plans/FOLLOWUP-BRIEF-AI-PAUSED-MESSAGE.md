# Follow-up: Daily Brief shows a generic "Couldn't update" when paid AI is paused

**Status:** FIXED on branch `fix/brief-ai-paused-message` (client-only; see "Resolution").
**Severity:** P3 (UX). It is not a safety defect: the server refuses correctly and no provider call is made.
**Found:** 2026-10-24, during the Preview maintenance AI-gate validation (Step C), after PR #29 (`15e6172`) was deployed.
**Was it there before?** Yes. Neither PR #29 nor PR #27 introduced it.

## Observed

With `maintenance_mode = "true"` on Preview:

- `POST /api/brief/generate` returned **503**. The server logged `[brief] refused before the provider: paid AI paused (MAINTENANCE)`.
- Nothing else happened: no AiInvocation row, and no DailyBrief write or claim.
- The Brief page kept the previously generated content and only showed **"Couldn't update"** next to "Brief updated …".
- For comparison, Conversations shows the server's own sentence for the same refusal: "AI features are paused for maintenance. Nothing was changed. Please try again later."

## Cause

`components/brief/brief-flow.ts`, in `httpBriefTransport.generate`: any non-OK status becomes `brief generation request failed: <status>`, and the response body (the `AI_PAUSED` code and its user-facing message) is thrown away. As a result, the Brief UI can't tell these apart:

- maintenance or the kill switch (an expected, operator-declared pause)
- a real failure (provider error, quota)

## Proposed fix

1. **Transport.** On a 503 whose body carries `code: "AI_PAUSED"`, return a typed `paused` outcome that includes the server's message. Don't throw.
2. **Status line.** Show the server's sentence, e.g. "AI features are paused for maintenance", in a neutral tone rather than the error tone. Keep the existing Brief content visible.
3. **No retry loop.** While the pause is in effect, the existing 3-minute failure cooldown should still apply. Make sure it does.
4. **Tests.** Cover 503 `AI_PAUSED` producing the paused wording, and 500 producing "Couldn't update" as it does today. Also pin that the transport reads the body only for the `AI_PAUSED` code.

No server change is needed. The refusal and its body are already correct.

## Resolution

All changes are client-only.

**Transport** (`components/brief/brief-flow.ts`)
- `isPaidAiPaused` recognises **only** a 503 whose body carries `code: "AI_PAUSED"`.
- In that case `httpBriefTransport.generate` throws `BriefPausedError`, which carries no server text.
- Everything else is an ordinary failure, unchanged: network errors, 401/403, 429 (pacing or `AI_ALLOWANCE`), and any other 5xx.

**Controller**
- A new `PAUSED` phase keeps the Brief already on screen and sets a 5-minute hold (`BRIEF_PAUSED_HOLD_MS`).
- During the hold nothing asks again: no timer, and visibility events and the retry control are both ignored.
- After the hold, one retry sends one POST.

**Page** (`components/brief/DailyBriefClient.tsx`)
- **With a Brief:** the status shows "Paused for maintenance" (neutral tone, polite live region), followed by Conversations' sentence. A prior-day Brief's note says "Today's Brief is paused for maintenance".
- **Without a Brief:** a `role="status"` panel shows the same sentence, with the retry control gated by the hold.
- An ordinary failure still says "Couldn't update".

**Tests:** `components/brief/brief-paused.test.ts`. The client's code and sentence are pinned to the server constants.

No change to admission, provider code, API contracts, schema or settings.
