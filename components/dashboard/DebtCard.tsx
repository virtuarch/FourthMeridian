import { Card, CardTitle } from "@/components/ui/Card";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { AlertTriangle, CheckCircle, MinusCircle } from "lucide-react";
import { Account } from "@/types";

interface Props {
  accounts:     Account[];   // debt-type accounts only
  lastUpdated?: string;
}

function getStatus(total: number): { label: string; cls: string; icon: React.ElementType } {
  if (total === 0)    return { label: "DEBT FREE",   cls: "bg-emerald-500/20 text-emerald-400", icon: CheckCircle    };
  if (total < 5000)   return { label: "LOW DEBT",    cls: "bg-blue-500/20    text-blue-400",    icon: MinusCircle    };
  if (total < 15000)  return { label: "MODERATE",    cls: "bg-yellow-500/20  text-yellow-400",  icon: AlertTriangle  };
  return               { label: "HIGH DEBT",          cls: "bg-red-500/20     text-red-400",     icon: AlertTriangle  };
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, notation: "compact", maximumFractionDigits: 1 }).format(Math.abs(n));

const fmtFull = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(Math.abs(n));

export function DebtCard({ accounts, lastUpdated }: Props) {
  // Net debt: positive = you owe, negative = bank owes you
  const total  = accounts.reduce((s, a) => s + a.balance, 0);
  const status = getStatus(Math.max(0, total));
  const StatusIcon = status.icon;

  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <CardTitle>Debt</CardTitle>
        <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold shrink-0 ${status.cls}`}>
          <StatusIcon size={11} />
          {status.label}
        </div>
      </div>

      <p className={`text-3xl font-bold mt-1 ${total > 0 ? "text-red-400" : "text-emerald-400"}`}>
        {fmt(total)}
      </p>

      {/* Per-account breakdown */}
      <div className="flex flex-col gap-2 mt-2">
        {accounts.map((a) => (
          <div key={a.id}>
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500 truncate">{a.name}</p>
              <p className={`text-xs font-semibold tabular-nums shrink-0 ml-2 ${a.balance > 0 ? "text-red-400" : "text-emerald-400"}`}>
                {a.balance > 0 ? "-" : "+"}{fmtFull(a.balance)}
              </p>
            </div>
            {(a.interestRate != null || a.minimumPayment != null) && (
              <div className="flex gap-3 mt-0.5">
                {a.interestRate != null && (
                  <span className="text-[10px] text-gray-600">
                    {a.interestRate.toFixed(2)}% APR
                  </span>
                )}
                {a.minimumPayment != null && (
                  <span className="text-[10px] text-gray-600">
                    {fmtFull(a.minimumPayment)}/mo min
                  </span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {lastUpdated && <p className="text-xs text-gray-600 mt-2">Updated {lastUpdated}</p>}
    </Card>
  );
}
