/**
 * lib/platform/ai/ai-usage.test.ts  (OPS-6D)
 *
 * Behavior guards for the AI usage-trend projection. Standalone tsx (house pattern).
 * NO LIVE DATABASE: pure fold over injected ApiUsageCounter rows. Proves per-day
 * aggregation, model extraction, honest UNKNOWN spend (no pricing → null, never a
 * fabricated 0), and that it stays aggregate-only (no per-user/space claim).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { buildAiUsageTrend, getAiUsageTrend, type AiUsageRow } from "@/lib/platform/ai/ai-usage";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected:", err); process.exit(1);
});

const NOW = new Date("2026-07-17T12:00:00Z");
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
function row(provider: string, metric: string, unit: string, d: string, count: number): AiUsageRow {
  return { provider, metric, unit, day: day(d), count };
}

async function main() {
  console.log("buildAiUsageTrend");
  {
    const rows: AiUsageRow[] = [
      row("OPENAI", "chat.completions:gpt-4o-mini", "calls", "2026-07-16", 3),
      row("OPENAI", "chat.completions:gpt-4o-mini", "prompt_tokens", "2026-07-16", 1500),
      row("OPENAI", "chat.completions:gpt-4o-mini", "completion_tokens", "2026-07-16", 500),
      row("OPENAI", "chat.completions:gpt-4o", "calls", "2026-07-17", 2),
      row("PLAID", "transactionsSync", "calls", "2026-07-17", 10),
    ];
    const t = buildAiUsageTrend(rows, NOW, 30);
    check("aggregates per day (two days)", t.days.length === 2);
    const d16 = t.days.find((d) => d.day === "2026-07-16")!;
    check("per-day calls/tokens summed", d16.calls === 3 && d16.promptTokens === 1500 && d16.completionTokens === 500);
    check("days sorted ascending", t.days[0].day <= t.days[1].day);
    check("distinct OpenAI models extracted from metric", t.models.includes("gpt-4o-mini") && t.models.includes("gpt-4o"));
    check("totals summed across days", t.totals.calls === 15 && t.totals.promptTokens === 1500);
    // ⚠️ RATES ARE CONFIGURED, AND THIS JULY USAGE IS STILL UNPRICED. That is the
    // effective-date mechanism working: the configured rates carry
    // effectiveFrom 2026-09-08, so adding them repriced nothing historical.
    check("spend UNKNOWN for usage predating every rate (null, not 0)",
      d16.estimatedSpendUsd === null && t.totals.estimatedSpendUsd === null);
    check("…even though pricing IS configured", t.pricingConfigured === true);
    check("tier stays observed when nothing priced (counts are observed)", t.tier === "observed");
    // Coverage is stated, not implied: which tokens went unpriced, and on which days.
    check("unpriced usage is reported as coverage",
      t.unpricedTokens === 2000 && t.unpricedDays.includes("2026-07-16"));
  }

  console.log("authority · injected reader");
  {
    let calls = 0;
    const t = await getAiUsageTrend({ now: NOW, days: 7, aiUsageRows: async () => { calls++; return [row("OPENAI", "chat.completions:gpt-4o", "calls", "2026-07-15", 5)]; } });
    check("reads ApiUsageCounter once via the injected reader", calls === 1 && t.days.length === 1);
    check("since is the window start", t.since === "2026-07-11");
  }

  console.log("doctrine · aggregate-only, no second cost engine");
  {
    const src = readFileSync(path.join(process.cwd(), "lib/platform/ai/ai-usage.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("reuses the ONE pricing reducer (no bespoke price map)", /priceAiUsage|isPricingConfigured/.test(src) && !/AI_RATES\s*=|usdPerMillion\s*:/.test(src));
    // ⚠️ SET-BASED, NOT ROW-BASED. Per-row accumulation cannot see that cached
    // tokens are a subset of prompt tokens, so it must either ignore caching or
    // double count it.
    check("prices whole days as a set, never row by row", /priceAiUsage\(rowsByDay/.test(src));
    check("reads only ApiUsageCounter (no per-user/space dimension claimed)", /apiUsageCounter/.test(src) && !/userId|spaceId/.test(src));
    check("writes nothing", !/\.(create|update|delete|upsert)\(/.test(src));
  }

  if (failures > 0) { console.error(`\nai-usage.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nai-usage.test: all passed.");
}

void main();
