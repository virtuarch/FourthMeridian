/**
 * lib/notifications/delivery/capped-body.test.ts  (Comms Center C — review F4)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/notifications/delivery/capped-body.test.ts
 */

import { readBodyCapped } from "@/lib/notifications/delivery/capped-body";
import { svixKey, svixSign, verifySvix } from "@/lib/notifications/delivery/svix";
import { MAX_WEBHOOK_BODY_BYTES } from "@/lib/notifications/delivery/provider-events";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

/** A chunked stream: no length known up front. Counts how many chunks were pulled. */
function chunked(parts: Uint8Array[]) {
  const pulled = { n: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pulled.n >= parts.length) { c.close(); return; }
      c.enqueue(parts[pulled.n++]);
    },
  });
  return { stream, pulled };
}

async function main() {
  console.log("capped streaming body (F4)");
  const enc = new TextEncoder();
  {
    // Multi-byte UTF-8 split ACROSS chunk boundaries: the text must equal the original exactly.
    const text = JSON.stringify({ type: "email.delivered", data: { email_id: "m-1", note: "naïve — ünïcødé ✓ 🚀" } });
    const bytes = enc.encode(text);
    const parts = [bytes.slice(0, 7), bytes.slice(7, 40), bytes.slice(40, 41), bytes.slice(41)];
    const { stream } = chunked(parts);
    const r = await readBodyCapped(stream, MAX_WEBHOOK_BODY_BYTES);
    check("a chunked body under the cap is returned byte-exact (multi-byte chars split across chunks)", r.ok && r.text === text);
    const key = svixKey(`whsec_${Buffer.from("k".repeat(24)).toString("base64")}`)!;
    const ts = "1793448000";
    const sig = svixSign(key, "msg_1", ts, text);
    check("…and its svix signature still verifies", r.ok && verifySvix({ key, headers: { id: "msg_1", timestamp: ts, signature: `v1,${sig}` }, rawBody: r.text, now: new Date(Number(ts) * 1000) }).ok);
  }
  {
    // 70 chunks of 1 KB, no Content-Length anywhere: over the 64 KB cap.
    const parts = Array.from({ length: 70 }, () => new Uint8Array(1024).fill(0x61));
    const { stream, pulled } = chunked(parts);
    const r = await readBodyCapped(stream, MAX_WEBHOOK_BODY_BYTES);
    check("a chunked body with NO Content-Length over the cap is refused (TOO_LARGE)", !r.ok && r.reason === "TOO_LARGE");
    check("…and reading STOPS at the cap (not every chunk pulled)", pulled.n <= 66 && pulled.n < parts.length, pulled.n);
  }
  {
    const exact = new Uint8Array(MAX_WEBHOOK_BODY_BYTES).fill(0x62);
    const r = await readBodyCapped(chunked([exact.slice(0, 1000), exact.slice(1000)]).stream, MAX_WEBHOOK_BODY_BYTES);
    check("exactly the cap is accepted", r.ok && r.text.length === MAX_WEBHOOK_BODY_BYTES);
    const r1 = await readBodyCapped(chunked([exact, new Uint8Array([0x62])]).stream, MAX_WEBHOOK_BODY_BYTES);
    check("cap + 1 byte is refused", !r1.ok);
  }
  {
    // Through a real Request whose body is a stream (duplex half): no content-length header.
    const parts = Array.from({ length: 70 }, () => new Uint8Array(1024).fill(0x63));
    const req = new Request("https://app.test/api/webhooks/resend", { method: "POST", body: chunked(parts).stream, duplex: "half" } as RequestInit & { duplex: "half" });
    check("the Request carries no content-length", req.headers.get("content-length") === null);
    const r = await readBodyCapped(req.body, MAX_WEBHOOK_BODY_BYTES);
    check("…and req.body read through the cap is refused", !r.ok);
    const ok = await readBodyCapped(new Request("https://app.test/x", { method: "POST", body: "{\"a\":1}" }).body, MAX_WEBHOOK_BODY_BYTES);
    check("an ordinary small body reads as its text", ok.ok && ok.text === "{\"a\":1}");
    check("a missing body is the empty string", (await readBodyCapped(null, 10)).ok);
  }
  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall capped-body checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
