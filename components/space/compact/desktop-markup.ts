/**
 * components/space/compact/desktop-markup.ts  (COMPACT DASHBOARD — P0 test support)
 *
 * WHAT A ≥1024px VIEWPORT CAN RENDER, from static markup.
 *
 * The compact redesign is CSS-only at Tailwind `lg` (1024px):
 *   - a compact-only element carries `lg:hidden` → it can never render on desktop;
 *   - a desktop element hidden only on compact carries `max-lg:*` utilities, which
 *     never apply at ≥1024px;
 *   - compact-only markers are `data-compact*` attributes, which no style or
 *     script on desktop reads.
 * `desktopMarkup` removes exactly those three things and leaves everything
 * else byte-for-byte, so "desktop is unchanged" becomes a string comparison
 * against the P0 baseline (desktop-baseline.test.ts).
 */

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

function classTokens(attrs: string): string[] {
  const m = /\sclass="([^"]*)"/.exec(attrs);
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
}

function normalizeAttrs(attrs: string): string {
  return attrs
    // compact-only markers
    .replace(/\sdata-compact[\w-]*="[^"]*"/g, "")
    // utilities that never apply at ≥1024px
    .replace(/\sclass="([^"]*)"/, (_m, cls: string) => {
      const kept = cls.split(/\s+/).filter((t) => t && !t.startsWith("max-lg:")).join(" ");
      return kept ? ` class="${kept}"` : "";
    });
}

/** Static markup as a ≥1024px viewport can render it. */
export function desktopMarkup(html: string): string {
  const out: string[] = [];
  const stack: boolean[] = []; // true = this element opened (or is inside) a compact-only subtree
  let skip = 0;
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>|[^<]+/g;
  for (const m of html.matchAll(re)) {
    const [whole, closeName, openName, attrs = "", selfClose] = m;
    if (closeName) {
      const counted = stack.pop() ?? false;
      if (counted) { skip--; continue; }
      if (skip === 0) out.push(whole);
      continue;
    }
    if (openName) {
      const compactOnly = classTokens(attrs).includes("lg:hidden");
      const isVoid = selfClose === "/" || VOID.has(openName.toLowerCase());
      if (skip > 0 || compactOnly) {
        if (!isVoid) { stack.push(true); skip++; }
        continue;
      }
      if (!isVoid) stack.push(false);
      out.push(`<${openName}${normalizeAttrs(attrs)}${selfClose}>`);
      continue;
    }
    if (skip === 0) out.push(whole);
  }
  return out.join("");
}

/**
 * The desktop-effective class tokens a SOURCE file declares, for files too
 * stateful to render statically (the workspaces, the host). Every string literal
 * inside a `className=` expression counts, except a literal that itself carries
 * `lg:hidden` (compact-only) and tokens prefixed `max-lg:` (never apply ≥1024px).
 * A tripwire: a new or removed desktop class in these files changes the set.
 */
export function desktopClassTokens(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const tokens = new Set<string>();
  const literal = /"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g;
  let i = 0;
  while ((i = code.indexOf("className=", i)) !== -1) {
    i += "className=".length;
    let expr = "";
    if (code[i] === '"') {
      const end = code.indexOf('"', i + 1);
      expr = code.slice(i, end + 1);
      i = end + 1;
    } else if (code[i] === "{") {
      let depth = 0, j = i;
      for (; j < code.length; j++) {
        if (code[j] === "{") depth++;
        else if (code[j] === "}") { depth--; if (depth === 0) break; }
      }
      expr = code.slice(i, j + 1);
      i = j + 1;
    } else continue;
    for (const lm of expr.matchAll(literal)) {
      const text = (lm[1] ?? lm[2] ?? lm[3] ?? "").replace(/\$\{[^}]*\}/g, " ");
      const parts = text.split(/\s+/).filter(Boolean);
      if (parts.includes("lg:hidden")) continue;
      for (const t of parts) if (!t.startsWith("max-lg:")) tokens.add(t);
    }
  }
  return [...tokens].sort();
}
