/**
 * components/dashboard/memory-panel.test.ts
 *
 * THE MEMORY PANEL — what it says, and what it deliberately cannot do.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/dashboard/memory-panel.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryPanel } from "@/components/dashboard/MemoryPanel";

let failures = 0;
const check = (name: string, cond: boolean, detail?: string): void => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const raw = readFileSync(path.join(process.cwd(), "components", "dashboard", "MemoryPanel.tsx"), "utf8");
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

console.log("closed, it is one quiet control");
{
  const html = renderToStaticMarkup(h(MemoryPanel, { spaceId: "s1", spaceName: "Mine" }));
  check("renders a Memory button and nothing else", /<button[^>]*>[\s\S]*Memory[\s\S]*<\/button>/.test(html) && !/role="dialog"/.test(html));
  check("…and fetches nothing until it is opened", !/useEffect/.test(src) && /const openPanel = \(\) => \{\s*setOpen\(true\);\s*void call\(/.test(src));
}

console.log("plain language: memory is not current financial truth");
{
  check("says what these are and what they are NOT, every time it opens",
    /They are not your current\s+finances, and nothing here changes any number unless you ask the assistant to use it\./.test(src));
  check("the kept words are 'noted as' — never 'you said'", /noted as: /.test(src) && !/you said/i.test(src));
  check("planning figures are labelled as not measured", /Planning figures you gave — not measured from your accounts/.test(src));
  check("projections are labelled as the assistant's, not the user's", /Projections the assistant made — not things you asked it to remember/.test(src));
  check("unreadable notes are shown with a delete, and said to be used nowhere", /Couldn’t be read reliably/.test(src) && /they are not used anywhere/.test(src));
  check("a stale planning figure says so", /you gave this a while ago/.test(src));
}

console.log("what it cannot do");
{
  check("two verbs only: stop using, and delete", /Stop using/.test(src) && /Delete/.test(src)
    && !/\b(Use this|Use now|Run this|Apply|Edit|Save)\b/.test(src.replace(/Stop using/g, "")));
  check("it talks to the memory routes and nothing else",
    [...src.matchAll(/`(\/api\/[^`?$]*)/g)].every((m) => m[1].startsWith("/api/ai/memory")) && /\/api\/ai\/memory/.test(src));
  check("it never names a user: the owner is the session's", !/userId|ownerUserId/.test(src));
  check("erasing asks first, and says history goes too", /ConfirmDialog/.test(src) && /every earlier version/.test(src));
  check("the mount in the AI page is one element in the existing controls slot",
    (readFileSync(path.join(process.cwd(), "components", "dashboard", "AnalyzeClient.tsx"), "utf8").match(/<MemoryPanel /g) ?? []).length === 1);
}

console.log(failures === 0 ? "\nmemory-panel.test: all passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
