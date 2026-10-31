/**
 * lib/email/design/escape.ts
 *
 * The only ways an interpolated value enters an email:
 *   - escapeHtml()   for every piece of text placed in the HTML part;
 *   - safeHttpUrl()  for every URL (href AND visible fallback). Anything that is
 *                    not an absolute http(s) URL throws: a template must never
 *                    emit `javascript:` or a relative link;
 *   - cleanText()    for user-influenced short strings (e.g. a recipient name):
 *                    control characters and line breaks are removed so a value
 *                    cannot forge extra lines in the plain-text part.
 *
 * Pure: no imports, no I/O.
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for an HTML text node or a double-quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Validate an absolute http(s) URL and return its normalised form
 * (WHATWG `href`: characters such as `"` `<` `>` are percent-encoded).
 * Throws on anything else, including credentials in the URL.
 */
export function safeHttpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("email: URL is not absolute");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("email: URL must be http(s)");
  }
  if (url.username || url.password) {
    throw new Error("email: URL must not carry credentials");
  }
  return url.href;
}

/** C0/C1 controls (incl. CR/LF), Unicode line/paragraph separators, bidi controls. */
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

/**
 * Collapse a short user-influenced string to one clean line: strips control
 * characters, line breaks and bidi overrides, collapses whitespace, and caps
 * the length.
 */
export function cleanText(value: string, maxLength = 80): string {
  const cleaned = value.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trimEnd() : cleaned;
}
