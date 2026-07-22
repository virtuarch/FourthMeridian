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
    check("spend UNKNOWN with no pricing (null, not 0)", d16.estimatedSpendUsd === null && t.totals.estimatedSpendUsd === null);
    check("tier observed when unpriced (counts are observed)", t.tier === "observed" && t.pricingConfigured === false);
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
    check("reuses the ONE pricing helper (no bespoke price map)", /estimateUnitSpendUsd|isPricingConfigured/.test(src) && !/UNIT_PRICES_USD\s*=/.test(src));
    check("reads only ApiUsageCounter (no per-user/space dimension claimed)", /apiUsageCounter/.test(src) && !/userId|spaceId/.test(src));
    check("writes nothing", !/\.(create|update|delete|upsert)\(/.test(src));
  }

  if (failures > 0) { console.error(`\nai-usage.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nai-usage.test: all passed.");
}

void main();
