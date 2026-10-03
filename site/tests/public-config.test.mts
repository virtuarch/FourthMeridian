/**
 * The public origins: development gets loopback defaults (never Production),
 * a production build fails closed, and a Preview build cannot point at
 * Production.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEV_APP_ORIGIN, DEV_SITE_ORIGIN, PRODUCTION_APP_ORIGIN, PRODUCTION_SITE_ORIGIN, appUrl, resolvePublicConfig,
} from "../lib/public-config.ts";

const PROD = { NEXT_PUBLIC_SITE_ORIGIN: PRODUCTION_SITE_ORIGIN, NEXT_PUBLIC_APP_ORIGIN: PRODUCTION_APP_ORIGIN, NODE_ENV: "production" };
const PREVIEW = { NEXT_PUBLIC_SITE_ORIGIN: "https://preview.fourthmeridian.com", NEXT_PUBLIC_APP_ORIGIN: "https://preview-app.fourthmeridian.com", NODE_ENV: "production" };

test("development defaults are loopback, never Production", () => {
  for (const NODE_ENV of ["development", "test", undefined]) {
    const c = resolvePublicConfig({ NODE_ENV });
    assert.equal(c.appOrigin, DEV_APP_ORIGIN);
    assert.equal(c.siteOrigin, DEV_SITE_ORIGIN);
    assert.equal(c.indexable, false);
  }
  assert.ok(new URL(DEV_APP_ORIGIN).hostname === "localhost" && new URL(DEV_SITE_ORIGIN).hostname === "localhost");
});

test("a production build without both origins refuses to build", () => {
  assert.throws(() => resolvePublicConfig({ NODE_ENV: "production" }), /requires NEXT_PUBLIC_APP_ORIGIN/);
  assert.throws(() => resolvePublicConfig({ NODE_ENV: "production", NEXT_PUBLIC_SITE_ORIGIN: PRODUCTION_SITE_ORIGIN }), /requires/);
  assert.throws(() => resolvePublicConfig({ NODE_ENV: "production", NEXT_PUBLIC_APP_ORIGIN: "  " , NEXT_PUBLIC_SITE_ORIGIN: PRODUCTION_SITE_ORIGIN }), /requires/);
});

test("a production build refuses http, loopback, paths, credentials and non-URLs", () => {
  const bad = [
    "http://app.fourthmeridian.com", "https://localhost:3000", "https://127.0.0.1", "https://app.fourthmeridian.com/dashboard",
    "https://app.fourthmeridian.com/?x=1", "https://app.fourthmeridian.com/#x", "https://user:pw@app.fourthmeridian.com",
    "app.fourthmeridian.com", "//app.fourthmeridian.com", "javascript:alert(1)", "ftp://app.fourthmeridian.com",
  ];
  for (const v of bad) assert.throws(() => resolvePublicConfig({ ...PROD, NEXT_PUBLIC_APP_ORIGIN: v }), Error, v);
});

test("development allows http only on loopback", () => {
  assert.equal(resolvePublicConfig({ NODE_ENV: "development", NEXT_PUBLIC_APP_ORIGIN: "http://127.0.0.1:3000" }).appOrigin, "http://127.0.0.1:3000");
  assert.throws(() => resolvePublicConfig({ NODE_ENV: "development", NEXT_PUBLIC_APP_ORIGIN: "http://app.example.com" }), /loopback/);
});

test("Production configuration: canonical origins, indexable", () => {
  const c = resolvePublicConfig({ ...PROD, VERCEL_ENV: "production" });
  assert.deepEqual(c, { appOrigin: PRODUCTION_APP_ORIGIN, siteOrigin: PRODUCTION_SITE_ORIGIN, indexable: true });
  assert.equal(resolvePublicConfig({ ...PROD, NEXT_PUBLIC_APP_ORIGIN: "https://app.fourthmeridian.com/" }).appOrigin, PRODUCTION_APP_ORIGIN);
});

test("Preview configuration: own origins, never indexable", () => {
  const c = resolvePublicConfig({ ...PREVIEW, VERCEL_ENV: "preview" });
  assert.equal(c.appOrigin, "https://preview-app.fourthmeridian.com");
  assert.equal(c.indexable, false);
});

test("a Preview (or Vercel development) build that names a Production origin is refused", () => {
  for (const VERCEL_ENV of ["preview", "development"]) {
    assert.throws(() => resolvePublicConfig({ ...PREVIEW, VERCEL_ENV, NEXT_PUBLIC_APP_ORIGIN: PRODUCTION_APP_ORIGIN }), /must not name a Production origin/);
    assert.throws(() => resolvePublicConfig({ ...PREVIEW, VERCEL_ENV, NEXT_PUBLIC_SITE_ORIGIN: PRODUCTION_SITE_ORIGIN }), /must not name a Production origin/);
  }
});

test("only the Production site origin on a Production build is indexable", () => {
  assert.equal(resolvePublicConfig({ ...PROD, VERCEL_ENV: "preview", NEXT_PUBLIC_SITE_ORIGIN: "https://x.vercel.app", NEXT_PUBLIC_APP_ORIGIN: "https://y.vercel.app" }).indexable, false);
  assert.equal(resolvePublicConfig({ ...PROD, NEXT_PUBLIC_SITE_ORIGIN: "https://fm-site.vercel.app" }).indexable, false);
});

test("the app and the site must be different hosts", () => {
  assert.throws(() => resolvePublicConfig({ ...PROD, NEXT_PUBLIC_APP_ORIGIN: PRODUCTION_SITE_ORIGIN }), /different hosts/);
});

test("app links are absolute, on the app origin, and only ever paths", () => {
  const c = resolvePublicConfig({ ...PROD });
  assert.equal(appUrl("/login", c), "https://app.fourthmeridian.com/login");
  assert.equal(appUrl("/request-access", c), "https://app.fourthmeridian.com/request-access");
  assert.throws(() => appUrl("//evil.example/x" as `/${string}`, c), /protocol-relative/);
});
