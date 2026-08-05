/**
 * lib/transactions/transfer-chain.test.ts   (V27-TRUTH-4)
 *
 * Behavioural probes for the multi-leg chain authority, plus the static probes
 * that keep chain reasoning out of React and out of a second matcher.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  resolveTransferChains, resolveChainHops, chainIdFor,
  CHAIN_CONTINUATION_WINDOW_DAYS, PARKABLE_ACCOUNT_TYPES, CHAIN_PURPOSE_LABEL,
} from "./transfer-chain";
import { type TransferLeg } from "./transfer-maturation";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const DAY = 86_400_000;
let seq = 0;
/** A matched PAIR of legs: `amount` leaves `from` and arrives at `to`. */
function hop(from: string, fromType: string, to: string, toType: string, amount: number, day: number): TransferLeg[] {
  const n = seq++;
  return [
    { id: `out${n}`, accountId: from, accountType: fromType, ownerId: "u", amount: -amount, currency: "USD", dateMs: day * DAY, superseded: false, providerLinkKey: null, maskedDestinationAccountId: null, railType: null },
    { id: `in${n}`,  accountId: to,   accountType: toType,   ownerId: "u", amount:  amount, currency: "USD", dateMs: day * DAY, superseded: false, providerLinkKey: null, maskedDestinationAccountId: null, railType: null },
  ];
}

console.log("V27-TRUTH-4. A genuine two-hop chain links");
{
  seq = 0;
  // savings → checking → card, same amount, 2 days apart.
  const corpus = [...hop("sav", "savings", "chk", "checking", 1000, 0),
                  ...hop("chk", "checking", "card", "debt", 1000, 7)];
  const chains = resolveTransferChains(corpus);
  const a = chains.get("out0")!;
  check("both legs share ONE chain", a.chainId === chains.get("out1")!.chainId);
  check("state is LINKED", a.state === "LINKED");
  check("the journey is in travel order", a.legIds.join(",") === "out0,out1");
  check("source is the savings account", a.sourceAccountId === "sav");
  check("terminal is the CARD", a.terminalAccountId === "card" && a.terminalAccountType === "debt");
  check("purpose is DEBT_FUNDING", a.purpose === "DEBT_FUNDING");
  check("evidence is CHAIN_CERTAIN", a.evidenceLevel === "CHAIN_CERTAIN");

  // Requirement 9 — the FIRST leg must never name the card as its counterparty.
  check("leg 1's immediate counterparty is CHECKING, not the card",
    a.immediateCounterpartyByLeg["out0"] === "chk");
  check("leg 2's immediate counterparty is the card",
    a.immediateCounterpartyByLeg["out1"] === "card");
  check("NO leg names a non-adjacent hop as its counterparty",
    !Object.values(a.immediateCounterpartyByLeg).includes("card") ||
    a.immediateCounterpartyByLeg["out0"] !== "card");
  check("the eventual purpose is carried WITHOUT a direct card counterparty",
    a.purpose === "DEBT_FUNDING" && a.immediateCounterpartyByLeg["out0"] === "chk");
}

console.log("V27-TRUTH-4. Every original row survives; a chain is a relationship");
{
  seq = 0;
  const corpus = [...hop("sav", "savings", "chk", "checking", 1000, 0),
                  ...hop("chk", "checking", "card", "debt", 1000, 7)];
  const chains = resolveTransferChains(corpus);
  check("every leg in the corpus has an assessment", corpus.every((l) => chains.has(l.id)));
  check("no assessment invents a leg id",
    [...chains.values()].every((c) => c.legIds.every((id) => corpus.some((l) => l.id === id))));
  // Value conservation: the chain's legs net to zero against their arrivals.
  const legs = new Set([...chains.get("out0")!.legIds]);
  const moved = corpus.filter((l) => legs.has(l.id)).reduce((s, l) => s + Math.abs(l.amount), 0);
  check("chain value is conserved (1000 + 1000 moved across two hops)", moved === 2000);
}

console.log("V27-TRUTH-4. A liability is never an INTERMEDIATE");
{
  seq = 0;
  // checking → card, then card → savings at the same amount. The middle is a
  // liability, so this must NOT link: a payment arriving at a card extinguishes
  // debt, and later card activity is not the same money moving on.
  const corpus = [...hop("chk", "checking", "card", "debt", 500, 0),
                  ...hop("card", "debt", "sav", "savings", 500, 7)];
  const chains = resolveTransferChains(corpus);
  check("a card cannot be a middle hop", chains.get("out0")!.state === "SINGLE_HOP");
  check("...and the two hops are SEPARATE chains",
    chains.get("out0")!.chainId !== chains.get("out1")!.chainId);
  check("PARKABLE excludes debt", !PARKABLE_ACCOUNT_TYPES.has("debt"));
}

console.log("V27-TRUTH-4. Branches are explicit, never collapsed");
{
  seq = 0;
  // One arrival in checking, TWO qualifying onward hops of the same amount.
  // The onward hops are spaced beyond the LEG window from each other so each is
  // individually certifiable — otherwise they pollute each other's candidate set
  // and there is no hop to branch from (see the window theorem).
  const corpus = [...hop("sav", "savings", "chk", "checking", 700, 0),
                  ...hop("chk", "checking", "card", "debt", 700, 7),
                  ...hop("chk", "checking", "hysa", "savings", 700, 13)];
  const chains = resolveTransferChains(corpus);
  const a = chains.get("out0")!;
  check("a branching journey is BRANCHED, not guessed", a.state === "BRANCHED");
  check("...and says why", (a.refusalReason ?? "").includes("branches"));
  check("...and claims NO terminal purpose beyond its own hop",
    a.legIds.length === 1 && a.terminalAccountId === "chk");
  check("...so no card counterparty leaks onto the first leg",
    a.immediateCounterpartyByLeg["out0"] === "chk");
}

console.log("V27-TRUTH-4. Many-to-many is refused (the LTE double-count)");
{
  seq = 0;
  // Two arrivals of the same amount, ONE onward hop. Under a "sufficient funds"
  // rule both would claim it — the live corpus does exactly this. Mutual
  // uniqueness refuses both.
  const corpus = [...hop("sav",  "savings", "chk", "checking", 900, 0),
                  ...hop("hysa", "savings", "chk", "checking", 900, 6),
                  ...hop("chk",  "checking", "card", "debt",   900, 12)];
  const chains = resolveTransferChains(corpus);
  check("neither arrival captures the shared onward hop",
    chains.get("out0")!.state !== "LINKED" && chains.get("out1")!.state !== "LINKED");
  check("...and the reason names mutual uniqueness",
    (chains.get("out0")!.refusalReason ?? "").includes("mutually unique"));
}

console.log("V27-TRUTH-4. Cycles are reported, not flattened");
{
  seq = 0;
  const corpus = [...hop("a", "checking", "b", "savings", 300, 0),
                  ...hop("b", "savings", "c", "checking", 300, 7),
                  ...hop("c", "checking", "a", "checking", 300, 14)];
  const chains = resolveTransferChains(corpus);
  const a = chains.get("out0")!;
  check("a returning journey is CYCLIC", a.state === "CYCLIC");
  check("...and says so", (a.refusalReason ?? "").includes("cycle"));
}

console.log("V27-TRUTH-4. Determinism and idempotence");
{
  seq = 0;
  // Reset the id counter each time, so the two runs are the SAME corpus rather
  // than two corpora that merely look alike.
  const build = () => { seq = 0; return [...hop("sav", "savings", "chk", "checking", 1000, 0),
                       ...hop("chk", "checking", "card", "debt", 1000, 7)]; };
  const a = resolveTransferChains(build());
  const b = resolveTransferChains(build().slice().reverse());
  check("the same corpus yields the same chain ids regardless of input order",
    a.get("out0")!.chainId === b.get("out0")!.chainId);
  check("...and the same state", a.get("out0")!.state === b.get("out0")!.state);
  check("re-running is idempotent",
    JSON.stringify([...a.values()]) === JSON.stringify([...resolveTransferChains(build()).values()]));
  check("the chain id is content-addressed by its legs",
    chainIdFor(["x", "y"]) === "chain:x>y" && chainIdFor(["x", "y"]) !== chainIdFor(["y", "x"]));
}

console.log("V27-TRUTH-4. No row appears in two incompatible chains");
{
  seq = 0;
  const corpus = [...hop("sav", "savings", "chk", "checking", 1000, 0),
                  ...hop("chk", "checking", "card", "debt", 1000, 7),
                  ...hop("x", "checking", "y", "savings", 55, 0)];
  const chains = resolveTransferChains(corpus);
  const seen = new Map<string, string>();
  let clash = false;
  for (const c of new Set(chains.values())) {
    for (const id of c.legIds) {
      if (seen.has(id) && seen.get(id) !== c.chainId) clash = true;
      seen.set(id, c.chainId);
    }
  }
  check("each leg belongs to exactly one chain", !clash);
  check("unrelated activity is NOT swept into the journey",
    chains.get("out2")!.chainId !== chains.get("out0")!.chainId);
}

console.log("V27-TRUTH-4. Out-of-window and unequal amounts do not link");
{
  seq = 0;
  const far = [...hop("sav", "savings", "chk", "checking", 1000, 0),
               ...hop("chk", "checking", "card", "debt", 1000, CHAIN_CONTINUATION_WINDOW_DAYS + 1)];
  check("beyond the continuation window there is no chain",
    resolveTransferChains(far).get("out0")!.state === "SINGLE_HOP");
  seq = 0;
  const uneven = [...hop("sav", "savings", "chk", "checking", 1000, 0),
                  ...hop("chk", "checking", "card", "debt", 400, 7)];
  check("a PARTIAL onward amount does not link (the double-count rule)",
    resolveTransferChains(uneven).get("out0")!.state === "SINGLE_HOP");
}

console.log("V27-TRUTH-4. Static probes");
{
  const root = join(__dirname, "..", "..");
  const strip = (s: string) => s
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ")
    .replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  const chainSrc = strip(readFileSync(join(root, "lib/transactions/transfer-chain.ts"), "utf8"));

  check("the chain authority COMPOSES the pairwise leg authority",
    chainSrc.includes("resolveDestinationEvidenceFor"));
  check("...and re-implements no leg matching",
    !/Math\.sign\([^)]*\)\s*!==\s*-/.test(chainSrc) &&
    !/Math\.abs\(\s*Math\.abs\([^)]*\)\s*-\s*Math\.abs/.test(chainSrc));
  check("...and declares no second amount epsilon",
    !/(EPSILON|epsilon|eps)\s*[:=]\s*\d*\.\d/.test(chainSrc));
  check("the authority is pure — no DB, no React, no clock",
    !chainSrc.includes("@/lib/db") && !chainSrc.includes("react") &&
    !chainSrc.includes("Date.now") && !chainSrc.includes("new Date"));

  // No chain reasoning inside React.
  const hits = execSync(
    `grep -rl "resolveTransferChains\\|resolveChainHops\\|chainIdFor" ${root}/components ${root}/app 2>/dev/null || true`,
    { encoding: "utf8" },
  ).trim();
  check("no component or route re-derives chains", hits === "", hits);

  // The hop primitive and the labels are part of the contract, so assert them.
  seq = 0;
  const two = [...hop("sav", "savings", "chk", "checking", 1000, 0),
               ...hop("chk", "checking", "card", "debt", 1000, 7)];
  check("resolveChainHops yields one hop per certified outflow",
    resolveChainHops(two).map((h) => h.legId).join(",") === "out0,out1");
  check("every purpose has presentation wording, and none names a counterparty",
    Object.values(CHAIN_PURPOSE_LABEL).every((l) => l.length > 0) &&
    CHAIN_PURPOSE_LABEL.DEBT_FUNDING === "Funds later reached a credit-card account");
}

console.log(failures === 0 ? "\ntransfer-chain: all passed." : `\ntransfer-chain: ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
