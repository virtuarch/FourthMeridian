/**
 * lib/notifications/delivery/capped-body.ts  (Comms Center C — review F4)
 *
 * Read a request body with a RUNNING BYTE COUNT, refusing as soon as it passes
 * `maxBytes` — whatever Content-Length says, or when there is none (chunked
 * transfer). The bytes are kept exactly and decoded once as UTF-8, which is
 * what `req.text()` does, so the svix signature (computed over the body text)
 * verifies exactly as before. Pure apart from consuming the stream.
 */

export type CappedBody = { ok: true; text: string } | { ok: false; reason: "TOO_LARGE" };

export async function readBodyCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<CappedBody> {
  if (!body) return { ok: true, text: "" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop reading; nothing past the cap is buffered.
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "TOO_LARGE" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return { ok: true, text: new TextDecoder("utf-8").decode(all) };
}
