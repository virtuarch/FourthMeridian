/**
 * lib/platform/intelligence/ai/compose/sanitise.ts — the link sanitiser (S2 binding 5): sanitiseAnswer, the absolute-link
 * rewrite, and the counts-only stripped-link-target diagnosis.
 *
 * P1a (Platform AI modular architecture, 2026-11-09): MOVED VERBATIM from core.ts — a pure
 * move, no behaviour change. core.ts re-exports every exported symbol (the facade), so
 * importers and tests are unchanged. compose/* never imports ../core.
 */

import type { MetricEnvelope } from "@/lib/platform/intelligence/metrics/retrieve-core";
import { KNOWN_IDS, KNOWN_KEYS } from "./keys";
import type { AnswerSegment } from "./segments";

// ── Link sanitiser (S2 binding 5) ───────────────────────────────────────────

export const LINK_REMOVED = "[link removed]";
const SENTINEL = "\u0000";

/**
 * The model's text as segments: a link ONLY where its target is exactly one of
 * this turn's resolver hrefs (or, for a Markdown link, an absolute http(s) URL
 * whose exact pathname is one — rendered as that href, rewriteAbsoluteLink, S2
 * ruling 2026-11-05); every other URL, Markdown link / image, HTML tag and raw
 * href is stripped. Rendered as plain text by the UI (no Markdown parser
 * runs on model output at all), so an image can never be fetched.
 */
/** What the sanitiser stripped, by CATEGORY (counts only — never the stripped text). */
export const SANITISE_KINDS = ["url", "html", "image", "reference", "link", "path"] as const;
export type SanitiseKind = (typeof SANITISE_KINDS)[number];

/**
 * S2 ruling 2026-11-05 (FIX 3, re-ruled): an ABSOLUTE Markdown link target whose
 * PATH + QUERY is exactly one of this turn's resolver hrefs renders as OUR href —
 * or null (strip as before). Only `[label](url)` link targets reach this (images are stripped
 * earlier, unconditionally; raw URLs / autolinks keep their own handling).
 *   · a scheme is required (relative and protocol-relative `//host/…` ⇒ null);
 *     the WHATWG parser (`new URL`, no base) must accept it, protocol http: / https: only
 *   · `url.pathname + url.search` — WHATWG's serialised form, as-is — is compared
 *     EXACTLY with `allowed` (this turn's hrefs only): no decoding (an encoded
 *     variant keeps its encoding ⇒ no match), no param reordering, no trailing-
 *     slash folding, nothing normalised to force a match (the parser's own dot-
 *     segment handling, and an empty `?` serialising as no search, are its form)
 *   · a query-carrying URL can therefore never land on a bare href, nor a bare URL
 *     on a query-carrying one (no misroute to another workspace)
 *   · the returned string is the allowed href itself, byte for byte — host, port,
 *     userinfo and fragment of the model's URL are never emitted
 */
export function rewriteAbsoluteLink(href: string, allowed: ReadonlySet<string>): string | null {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  let url: URL;
  try { url = new URL(href); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const key = url.pathname + url.search;
  for (const h of allowed) if (h === key) return h;
  return null;
}

/**
 * S2 ruling 2026-11-05 (i): a Markdown link whose sanitised label is longer than
 * this renders as that label in plain text, with no link (counted as a stripped link).
 */
export const LINK_LABEL_MAX = 120;

/** The sanitiser's URL scrub (one definition: sanitiseAnswer's text and labels, and the link-target diagnosis). */
function scrubUrls(s: string, onStrip: () => void): string {
  return s
    .replace(/\b(?:https?|ftp|data|javascript|vbscript|file|mailto):[^\s)\]>]*/gi, () => { onStrip(); return LINK_REMOVED; })
    .replace(/\bwww\.[^\s)\]>]+/gi, () => { onStrip(); return LINK_REMOVED; })
    .replace(/(^|[\s(])\/\/[^\s)\]>]+/g, (_m, pre: string) => { onStrip(); return `${pre}${LINK_REMOVED}`; });
}

export function sanitiseAnswer(raw: string, allowed: ReadonlySet<string>): { segments: AnswerSegment[]; removed: number; kinds: Partial<Record<SanitiseKind, number>> } {
  const kinds: Partial<Record<SanitiseKind, number>> = {};
  const strip = (k: SanitiseKind) => { kinds[k] = (kinds[k] ?? 0) + 1; };
  const links: { text: string; href: string }[] = [];
  const keep = (text: string, href: string) => { links.push({ text, href }); return `${SENTINEL}${links.length - 1}${SENTINEL}`; };
  const stripUrls = (s: string) => scrubUrls(s, () => strip("url"));

  let s = String(raw ?? "").split(SENTINEL).join("");
  s = s.replace(/<!--[\s\S]*?-->/g, () => { strip("html"); return ""; });
  s = s.replace(/<\/?[A-Za-z!][^>]*>/g, () => { strip("html"); return ""; });
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, () => { strip("image"); return ""; });
  s = s.replace(/!\[[^\]]*\]\[[^\]]*\]/g, () => { strip("image"); return ""; });
  s = s.replace(/^[ \t]*\[[^\]]+\]:[ \t]*\S+.*$/gm, () => { strip("reference"); return ""; });
  s = s.replace(/\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+["'][^"']*["'])?\s*\)/g, (_m, label: string, href: string) => {
    const text = stripUrls(label).trim();
    // S2 ruling 2026-11-05 (FIX 3): an absolute URL whose exact path + query this turn returned ⇒ OUR href (not counted as removed).
    const ours = allowed.has(href) ? href : rewriteAbsoluteLink(href, allowed);
    // S2 ruling 2026-11-05 (i): a label over LINK_LABEL_MAX ⇒ plain text, no link.
    if (ours !== null && text.length <= LINK_LABEL_MAX) return keep(text || ours, ours);
    strip("link");
    return text;
  });
  s = s.replace(/\[([^\]]*)\]\[[^\]]*\]/g, (_m, label: string) => { strip("reference"); return label; });
  s = stripUrls(s);
  // A raw relative href: a link only when it is exactly a resolver href of this turn.
  s = s.replace(/(^|[\s(:])(\/[A-Za-z0-9_\-./?=&%+~]+)/g, (_m, pre: string, path: string) => {
    const trimmed = path.replace(/[.,;:!?]+$/, "");
    const tail = path.slice(trimmed.length);
    if (allowed.has(trimmed)) return `${pre}${keep(trimmed, trimmed)}${tail}`;
    strip("path");
    return `${pre}${LINK_REMOVED}${tail}`;
  });
  // Markdown emphasis / code / heading markers read as noise in plain text.
  s = s.replace(/\*\*|__|`/g, "").replace(/^#{1,6}[ \t]+/gm, "");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  const segments: AnswerSegment[] = [];
  const parts = s.split(SENTINEL);
  parts.forEach((p, i) => {
    if (i % 2 === 1) {
      const l = links[Number(p)];
      if (l) segments.push({ kind: "link", text: l.text, href: l.href });
    } else if (p) segments.push({ kind: "text", text: p });
  });
  const removed = Object.values(kinds).reduce((a, n) => a + n, 0);
  return { segments, removed, kinds };
}

/**
 * DIAGNOSIS ONLY (2026-11-04, Preview finding: every turn logs removed=1(link:1)):
 * WHAT KIND of target each Markdown link the sanitiser strips as category "link"
 * pointed at — a closed enum and counts, never the target text. It does not change
 * what is stripped or shown (sanitiseAnswer is unchanged and alone decides); it
 * re-reads the same raw text with the sanitiser's own pre-steps and link pattern.
 *   DRILL_HREF        — exactly the drill.href (API route) of an envelope get_metric returned this turn
 *   API_PATH          — another /api/ path
 *   PAGE_VARIANT      — a root-relative path whose pathname is a returned link's, with a different query / suffix
 *   PAGE_NOT_RETURNED — another root-relative path (a page this turn never returned)
 *   LABEL_OVER_CAP    — a returned (or rewritable) target whose label is over LINK_LABEL_MAX (S2 ruling 2026-11-05 (i))
 *   ABSOLUTE_URL_REWRITTEN — NOT stripped: an absolute URL rendered as this turn's href (rewriteAbsoluteLink, S2 ruling 2026-11-05)
 *   ABSOLUTE_URL      — a scheme, protocol-relative or www. target (stripped)
 *   PLACEHOLDER       — a {{…}} placeholder written as the target
 *   METRIC_ID         — a registry metric id / key written as the target
 *   EMPTY             — no target
 *   OTHER             — anything else (e.g. a page id, a word)
 */
export const LINK_TARGET_KINDS = ["DRILL_HREF", "API_PATH", "PAGE_VARIANT", "PAGE_NOT_RETURNED", "LABEL_OVER_CAP", "ABSOLUTE_URL_REWRITTEN", "ABSOLUTE_URL", "PLACEHOLDER", "METRIC_ID", "EMPTY", "OTHER"] as const;
export type LinkTargetKind = (typeof LINK_TARGET_KINDS)[number];

export function strippedLinkTargets(raw: string, allowed: ReadonlySet<string>, envelopes: readonly MetricEnvelope[]): Partial<Record<LinkTargetKind, number>> {
  const out: Partial<Record<LinkTargetKind, number>> = {};
  const add = (k: LinkTargetKind) => { out[k] = (out[k] ?? 0) + 1; };
  const drillHrefs = new Set(envelopes.flatMap((e) => (e.drill && "href" in e.drill && typeof e.drill.href === "string" ? [e.drill.href] : [])));
  const pathOf = (h: string) => h.split(/[?#]/)[0];
  const allowedPaths = new Set([...allowed].map(pathOf));
  // The sanitiser's own steps before its link step (same patterns, same order), so the links seen are the ones it sees.
  let s = String(raw ?? "").split(SENTINEL).join("");
  s = s.replace(/<!--[\s\S]*?-->/g, "").replace(/<\/?[A-Za-z!][^>]*>/g, "");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/!\[[^\]]*\]\[[^\]]*\]/g, "").replace(/^[ \t]*\[[^\]]+\]:[ \t]*\S+.*$/gm, "");
  for (const m of s.matchAll(/\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+["'][^"']*["'])?\s*\)/g)) {
    const href = m[2];
    const exact = allowed.has(href), rewritten = !exact && rewriteAbsoluteLink(href, allowed) !== null;
    if ((exact || rewritten) && scrubUrls(m[1], () => {}).trim().length > LINK_LABEL_MAX) { add("LABEL_OVER_CAP"); continue; }
    if (exact) continue;
    if (rewritten) { add("ABSOLUTE_URL_REWRITTEN"); continue; }
    if (href === "") add("EMPTY");
    else if (drillHrefs.has(href)) add("DRILL_HREF");
    else if (/\{\{/.test(href)) add("PLACEHOLDER");
    else if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|www\.)/i.test(href)) add("ABSOLUTE_URL");
    else if (href.startsWith("/api/")) add("API_PATH");
    else if (href.startsWith("/")) add(allowedPaths.has(pathOf(href)) ? "PAGE_VARIANT" : "PAGE_NOT_RETURNED");
    else if (KNOWN_KEYS.has(href) || KNOWN_IDS.has(href)) add("METRIC_ID");
    else add("OTHER");
  }
  return out;
}

/** Module-internal to compose/* (not part of core.ts's facade). */
export { SENTINEL };
