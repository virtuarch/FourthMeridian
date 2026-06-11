import { Card, CardTitle } from "@/components/ui/Card";
import { Account } from "@/types";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { exchangeSymbol } from "@/lib/exchangeSymbol";

interface Props {
  title:        string;
  accounts:     Account[];
  color:        string;   // tailwind text colour class
  lastUpdated?: string;
  maxItems?:    number;   // cap visible rows; shows "+N more" if exceeded
  compact?:     boolean;  // tighter layout for side-by-side cards
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(n);

const fmtFull = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);

export function AccountGroupCard({ title, accounts, color, lastUpdated, maxItems, compact }: Props) {
  const total    = accounts.reduce((s, a) => s + a.balance, 0);
  const isCrypto = accounts.some((a) => a.type === "crypto");
  const sorted   = [...accounts].sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
  const visible  = maxItems != null ? sorted.slice(0, maxItems) : sorted;
  const hidden   = maxItems != null ? sorted.length - visible.length : 0;

  return (
    <Card className={compact ? "!p-3" : ""}>
      <CardTitle>{title}</CardTitle>
      <p className={`font-bold mt-0.5 ${compact ? "text-xl" : "text-3xl"} ${color}`}>
        {fmt(total)}
      </p>

      <div className={`flex flex-col ${compact ? "gap-1.5 mt-2" : "gap-2 mt-3"}`}>
        {visible.map((a) => {
          const coinSymbol = a.walletChain ?? exchangeSymbol(a.institution);
          return (
            <div key={a.id} className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                {isCrypto && <CoinIcon symbol={coinSymbol} size={compact ? 14 : 18} />}
                <div className="min-w-0">
                  <p className="text-xs font-medium text-white truncate leading-tight">{a.name}</p>
                  {!compact && (
                    <p className="text-xs text-gray-500 truncate leading-tight">{a.institution}</p>
                  )}
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className={`text-xs font-semibold tabular-nums ${color}`}>{fmtFull(a.balance)}</p>
                {!compact && a.nativeBalance != null && (
                  <p className="text-xs text-gray-600">{a.nativeBalance} {a.walletChain}</p>
                )}
              </div>
            </div>
          );
        })}
        {hidden > 0 && (
          <p className="text-xs text-gray-600">+{hidden} more</p>
        )}
      </div>

      {lastUpdated && !compact && (
        <p className="text-xs text-gray-600 mt-2">Updated {lastUpdated}</p>
      )}
    </Card>
  );
}
