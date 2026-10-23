/**
 * PROOF — the acquisition forwarder is a bounded, pure string transformation:
 * an allowlist of query keys, clipped values, a site-relative `from` path, and
 * nothing else leaves the site on a CTA click.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACQUISITION_QUERY_KEYS, ACQUISITION_VALUE_MAX, FROM_PATH_MAX, acquisitionParams, withAcquisition,
} from "../lib/acquisition.ts";

const APP = "https://preview-app.fourthmeridian.com/request-access";

test("only allowlisted keys are forwarded, first occurrence wins, values clipped", () => {
  const p = acquisitionParams("?utm_source=tw&utm_source=second&gclid=abc&fbclid=x&email=a@b.c&utm_campaign=" + "c".repeat(300), "/");
  assert.equal(p.get("utm_source"), "tw");
  assert.equal(p.get("gclid"), null);
  assert.equal(p.get("fbclid"), null);
  assert.equal(p.get("email"), null);
  assert.equal(p.get("utm_campaign")?.length, ACQUISITION_VALUE_MAX);
  assert.deepEqual([...ACQUISITION_QUERY_KEYS], ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref", "source"]);
});

test("`from` is the site path only — never a protocol-relative, query or fragment shape", () => {
  assert.equal(acquisitionParams("", "/about").get("from"), "/about");
  assert.equal(acquisitionParams("", "/").get("from"), "/");
  for (const bad of ["//evil.com/x", "/about?x=1", "/about#f", "about", "", "/a b"]) {
    assert.equal(acquisitionParams("", bad).get("from"), null, bad);
  }
  assert.equal(acquisitionParams("", "/" + "a".repeat(500)).get("from")?.length, FROM_PATH_MAX);
});

test("control characters and whitespace never travel", () => {
  assert.equal(acquisitionParams("?ref=%20a%00b%1Fc%20", "/").get("ref"), "abc");
  assert.equal(acquisitionParams("?ref=%20%20", "/").get("ref"), null);
});

test("withAcquisition appends to the app href, keeps existing params and fragment, and is a no-op with nothing to forward", () => {
  assert.equal(withAcquisition(APP, "", "about"), APP);
  assert.equal(withAcquisition(APP, "?utm_source=nl", "/security"), `${APP}?utm_source=nl&from=%2Fsecurity`);
  assert.equal(withAcquisition(`${APP}?utm_source=fixed#top`, "?utm_source=nl&ref=r", "/"), `${APP}?utm_source=fixed&ref=r&from=%2F#top`);
  const out = new URL(withAcquisition(APP, "?utm_source=nl&utm_medium=//evil.com", "/x"));
  assert.equal(out.origin, new URL(APP).origin, "the destination origin is never changed");
  assert.equal(out.searchParams.get("utm_medium"), "//evil.com", "a value is data, not a destination");
});
