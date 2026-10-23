/**
 * components/ai/transcript-cache.ts
 *
 * THE CONVERSATION IS STILL THERE WHEN YOU COME BACK.
 *
 * ⚠️ A UX CACHE, AND NOTHING ELSE. It keeps the prose the user already read, in
 * their own browser, for a day. It is not conversation persistence, not history,
 * not memory, not a server store, and it is never financial authority. When the
 * next turn is sent, the runtime re-reads the ledger exactly as it does on a cold
 * start — the cache tells the model what was being TALKED ABOUT, the tools say
 * what is TRUE.
 *
 * ⚠️ WHAT MAY BE WRITTEN IS EXACTLY WHAT WAS ON SCREEN. Two roles, two strings.
 * No system prompt, no tool call, no tool result, no evidence, no scenario, no
 * memory row, no knowledge gap, no account id, no provider metadata. That is not
 * a policy applied on the way out — `parseTranscript` is the only reader and it
 * accepts nothing else, so a payload that grew a field would be discarded rather
 * than restored.
 *
 * ⚠️ AND IT IS READABLE BY ANY SCRIPT ON THIS ORIGIN, which is why the list above
 * is a hard boundary rather than a preference. Assistant prose can name amounts;
 * that is the transcript the user chose to keep, and it is the same text their
 * screen was showing a minute ago. The evidence BEHIND it never leaves the server.
 *
 * Pure over an injected store, so every rule here is provable without a browser.
 */

/** Bumped when the stored shape changes. An older or newer version is discarded. */
export const TRANSCRIPT_CACHE_VERSION = 1;

/** A day. Long enough to click around the app and come back; short enough to forget. */
export const TRANSCRIPT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Defensive ceilings.
 *
 * ⚠️ A CACHE CANNOT BE ALLOWED TO FREEZE THE PAGE IT IS MEANT TO SPEED UP.
 * `localStorage` is synchronous, so a pathological blob costs a frame on every
 * read. These are generous against real use — the longest dogfood session was
 * 17 turns and well under 60 KB — and both are enforced, because a hundred short
 * messages and one enormous one are different failures.
 */
export const MAX_CACHED_MESSAGES = 200;
export const MAX_CACHED_CHARS = 256_000;

/** Namespaced so a sweep can find every one of them and nothing else. */
export const TRANSCRIPT_KEY_PREFIX = 'fm:ai-transcript:v1:';

/**
 * A hint, so a returning user does not watch an empty state turn into their
 * conversation.
 *
 * ⚠️ IT CARRIES NO TRANSCRIPT AND NO SECRET — just the Space id a cache was last
 * written for, which the browser already posts with every turn. The server cannot
 * read `localStorage`, so without this the first paint is always the empty state
 * and the restore is always a visible flip. Written and cleared in lockstep with
 * the cache itself, with the same lifetime.
 */
export const TRANSCRIPT_HINT_COOKIE = 'fm_ai_transcript';

/** One visible turn. Exactly what was on screen, and nothing that was behind it. */
export interface CachedMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface CachedTranscript {
  version:   number;
  savedAt:   string;
  expiresAt: string;
  messages:  CachedMessage[];
}

/** The smallest interface this needs. `localStorage` satisfies it; so does a test double. */
export interface TranscriptStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

/**
 * One conversation per user, per Space.
 *
 * ⚠️ BOTH HALVES ARE LOAD-BEARING. The Space, because a transcript about one
 * Space's money must never appear under another's — the page already keys the
 * client by it, and this makes the stored copy obey the same rule. The user,
 * because a browser outlives a session: two people who share a Space and a
 * laptop must not share a transcript, and a Space id alone would let them. The
 * user id is already in the browser (next-auth serves it to every client that
 * reads the session), so naming it here discloses nothing new.
 */
export function transcriptKey(userId: string, spaceId: string): string {
  return `${TRANSCRIPT_KEY_PREFIX}${userId}:${spaceId}`;
}

/**
 * A turn this may keep, on the way IN.
 *
 * ⚠️ TWO ROLES. `system` is the instruction and `tool` is financial evidence;
 * neither was ever on screen, and neither may be restored into a transcript that
 * is posted back to the server on the next turn.
 */
const isStorable = (v: unknown): v is CachedMessage => {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  if (m.role !== 'user' && m.role !== 'assistant') return false;
  return typeof m.content === 'string' && m.content.length > 0;
};

/**
 * A turn this will accept back OUT — the same two fields, and NOTHING else.
 *
 * ⚠️ STRICTER THAN THE WAY IN, ON PURPOSE. Writing is ours: a caller's message
 * object may legitimately carry knowledge gaps or a render mode, and the
 * serializer simply does not copy them. Reading is not ours: a stored message
 * with an extra field was written by something that is not this module, and the
 * safe reading of that is not "keep the parts I recognise" — it is "start clean".
 */
const isStored = (v: unknown): v is CachedMessage =>
  isStorable(v) && Object.keys(v as unknown as Record<string, unknown>).length === 2;

/**
 * Read a stored transcript, or refuse it. PURE.
 *
 * ⚠️ EVERY REFUSAL IS THE SAME REFUSAL: null. Malformed JSON, a version we do not
 * write, a role we never store, a message that is not a message, a missing or
 * unparseable timestamp, an expired one, an oversized one — all of them mean
 * "start clean", because a cache is a convenience and a half-trusted one is
 * worse than none. The caller deletes what it could not read.
 */
export function parseTranscript(raw: string | null | undefined, now: number): CachedMessage[] | null {
  if (!raw || raw.length > MAX_CACHED_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const t = parsed as Partial<CachedTranscript>;
  if (t.version !== TRANSCRIPT_CACHE_VERSION) return null;
  const expiresAt = typeof t.expiresAt === 'string' ? Date.parse(t.expiresAt) : Number.NaN;
  // ⚠️ THE STORED TIMESTAMP IS THE TTL, not the browser's eviction policy. An
  // expiry we cannot read is an expiry we do not have.
  if (!Number.isFinite(expiresAt) || now >= expiresAt) return null;
  if (!Array.isArray(t.messages)) return null;
  if (t.messages.length === 0 || t.messages.length > MAX_CACHED_MESSAGES) return null;
  if (!t.messages.every(isStored)) return null;
  return t.messages as CachedMessage[];
}

/**
 * The bytes to store for this transcript, or null when there is nothing to keep.
 * PURE.
 *
 * ⚠️ IT TRIMS BY WHOLE TURNS, FROM THE OLDEST END, AND NEVER INSIDE A MESSAGE.
 * Half an answer is a different answer — a figure with its caveat cut off is the
 * failure this whole architecture exists to prevent — so the unit of forgetting
 * is a turn, never a sentence. A transcript that begins with an answer to a
 * question that is no longer there would read as a reply to nothing, so a
 * leading assistant message is dropped with it.
 *
 * (On READ the policy is the opposite and deliberately so: stored bytes are
 * untrusted input, and an oversized blob is discarded whole rather than trimmed
 * into something that looks legitimate.)
 */
export function serializeTranscript(
  messages: readonly CachedMessage[], now: number,
): string | null {
  let kept = messages.filter(isStorable).map((m) => ({ role: m.role, content: m.content }));
  if (kept.length === 0) return null;

  const envelope = (list: CachedMessage[]): string => JSON.stringify({
    version: TRANSCRIPT_CACHE_VERSION,
    savedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TRANSCRIPT_TTL_MS).toISOString(),
    messages: list,
  } satisfies CachedTranscript);

  let body = envelope(kept);
  while (kept.length > 0 && (kept.length > MAX_CACHED_MESSAGES || body.length > MAX_CACHED_CHARS)) {
    kept = kept.slice(1);
    while (kept.length > 0 && kept[0].role === 'assistant') kept = kept.slice(1);
    body = envelope(kept);
  }
  return kept.length === 0 ? null : body;
}

// ── The browser side ─────────────────────────────────────────────────────────
//
// ⚠️ EVERY ACCESS IS GUARDED. `localStorage` throws outright in a browser set to
// block site data and in some private modes — reading it is the one thing here
// that can fail for reasons that have nothing to do with us, and a conversation
// must not fail with it.

function store(): TranscriptStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The cached transcript for this user and Space, or null. Deletes what it refuses. */
export function readTranscript(
  userId: string, spaceId: string, now: number = Date.now(),
  s: TranscriptStore | null = store(),
): CachedMessage[] | null {
  if (!s) return null;
  const key = transcriptKey(userId, spaceId);
  try {
    const messages = parseTranscript(s.getItem(key), now);
    // Lazy cleanup: the read that refuses it is the one that removes it. No timer,
    // no sweep, no cron — the next visit is the collector.
    if (!messages) { clearTranscript(userId, spaceId, s); return null; }
    return messages;
  } catch {
    return null;
  }
}

/** Store the visible transcript. A transcript with nothing in it clears instead. */
export function writeTranscript(
  userId: string, spaceId: string, messages: readonly CachedMessage[],
  now: number = Date.now(), s: TranscriptStore | null = store(),
): void {
  if (!s) return;
  const body = serializeTranscript(messages, now);
  if (!body) { clearTranscript(userId, spaceId, s); return; }
  try {
    s.setItem(transcriptKey(userId, spaceId), body);
    setHint(spaceId);
  } catch {
    // A full or unavailable store is not an error the user needs to see; the
    // conversation on screen is unaffected and the next visit simply starts clean.
  }
}

/** Forget this user's transcript for this Space. */
export function clearTranscript(
  userId: string, spaceId: string, s: TranscriptStore | null = store(),
): void {
  if (!s) return;
  try {
    s.removeItem(transcriptKey(userId, spaceId));
    setHint(null);
  } catch { /* nothing to clean up if the store cannot be reached */ }
}

/**
 * Forget every cached transcript in this browser.
 *
 * ⚠️ CALLED ON SIGN-OUT, as defence in depth. The key is already bound to the
 * user, so one account cannot read another's; this is about what is left on the
 * disk of a shared machine after someone deliberately leaves.
 */
export function clearAllTranscripts(s: TranscriptStore | null = store()): void {
  if (!s) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(TRANSCRIPT_KEY_PREFIX)) doomed.push(k);
    }
    for (const k of doomed) s.removeItem(k);
    setHint(null);
  } catch { /* see above */ }
}

/** The first-paint hint. Same lifetime as the cache, written and cleared with it. */
function setHint(spaceId: string | null): void {
  try {
    if (typeof document === 'undefined') return;
    document.cookie = spaceId
      ? `${TRANSCRIPT_HINT_COOKIE}=${encodeURIComponent(spaceId)}; Max-Age=${
        Math.floor(TRANSCRIPT_TTL_MS / 1000)}; Path=/; SameSite=Lax`
      : `${TRANSCRIPT_HINT_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
  } catch { /* no document, no hint — the cache still works, the first paint flips */ }
}
