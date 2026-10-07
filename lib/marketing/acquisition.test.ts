/**
 * lib/marketing/acquisition.test.ts — the acquisition shape is bounded on both
 * sides: allowlisted keys only, clipped values, no fingerprint, country only
 * from the server.
 */
import {
  ACQUISITION_PATH_MAX, ACQUISITION_VALUE_MAX, acquisitionFromLocation, boundAcquisitionSource,
  describeAcquisitionSource, withCountry,
} from "./acquisition";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("boundAcquisitionSource");
{
  check("non-object ⇒ null", boundAcquisitionSource("x") === null && boundAcquisitionSource(null) === null && boundAcquisitionSource([1]) === null);
  check("empty object ⇒ null", boundAcquisitionSource({}) === null);
  const b = boundAcquisitionSource({ utmSource: " newsletter ", ip: "1.2.3.4", userAgent: "UA", screen: "1x1", country: "US", utmTerm: 42 });
  check("unknown keys dropped (ip, userAgent, screen), non-strings dropped", JSON.stringify(b) === JSON.stringify({ utmSource: "newsletter" }), JSON.stringify(b));
  check("country is NOT accepted from the client", b !== null && !("country" in b));
  const long = boundAcquisitionSource({ utmCampaign: "x".repeat(500) });
  check("values clipped to ACQUISITION_VALUE_MAX", long?.utmCampaign?.length === ACQUISITION_VALUE_MAX);
  const path = boundAcquisitionSource({ landingPath: "/" + "a".repeat(500) });
  check("landing path clipped to ACQUISITION_PATH_MAX", path?.landingPath?.length === ACQUISITION_PATH_MAX);
  check("control chars stripped", boundAcquisitionSource({ ref: "a\u0000b\u001fc" })?.ref === "abc");
  for (const bad of ["//evil.com/x", "/about?x=1", "/about#frag", "https://evil.com/", "about", "/a b"]) {
    check(`landingPath rejects ${JSON.stringify(bad)}`, boundAcquisitionSource({ landingPath: bad }) === null);
  }
  check("landingPath accepts a site path", boundAcquisitionSource({ landingPath: "/about" })?.landingPath === "/about");
}

console.log("withCountry");
{
  check("two letters uppercased", withCountry(null, "us")?.country === "US");
  check("garbage ignored", withCountry({ ref: "x" }, "USA")?.country === undefined && withCountry(null, "1.2.3.4") === null);
  check("null source + valid country ⇒ country only", JSON.stringify(withCountry(null, "SG")) === JSON.stringify({ country: "SG" }));
}

console.log("acquisitionFromLocation");
{
  const s = acquisitionFromLocation("?utm_source=tw&utm_medium=social&from=/about&ref=r&junk=1", "", "https://app.example");
  check("utm_* / ref / from mapped; junk dropped", JSON.stringify(s) === JSON.stringify({ utmSource: "tw", utmMedium: "social", ref: "r", landingPath: "/about" }), JSON.stringify(s));
  const same = acquisitionFromLocation("", "https://app.example/landing?x=1", "https://app.example");
  check("same-origin referrer ⇒ its PATH is the landing page (no query)", same?.landingPath === "/landing" && same?.referrerHost === undefined);
  const cross = acquisitionFromLocation("", "https://news.example.com/post/1?secret=1", "https://app.example");
  check("cross-origin referrer ⇒ HOST only", JSON.stringify(cross) === JSON.stringify({ referrerHost: "news.example.com" }), JSON.stringify(cross));
  const both = acquisitionFromLocation("?from=/security", "https://app.example/other", "https://app.example");
  check("forwarded `from` beats a same-origin referrer path", both?.landingPath === "/security");
  check("nothing ⇒ null", acquisitionFromLocation("", "", "https://app.example") === null);
  check("unparsable referrer tolerated", acquisitionFromLocation("?ref=x", "not a url", "https://app.example")?.ref === "x");
}

console.log("describeAcquisitionSource");
{
  check("null ⇒ null", describeAcquisitionSource(null) === null && describeAcquisitionSource({}) === null);
  check("campaign summary", describeAcquisitionSource({ utmSource: "nl", utmMedium: "email", utmCampaign: "spring", landingPath: "/about", country: "US" }) === "via nl / email / spring · page /about · US");
  check("referrer-only summary", describeAcquisitionSource({ referrerHost: "news.example.com" }) === "from news.example.com");
}

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll acquisition checks passed.");
