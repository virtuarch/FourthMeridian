import { Card, CardTitle } from "@/components/ui/Card";
import { Account } from "@/types";
import { Building2, TrendingUp, Bitcoin, CreditCard, PiggyBank } from "lucide-react";

const icons: Record<string, React.ElementType> = {
  checking: Building2,
  savings: PiggyBank,
  investment: TrendingUp,
  crypto: Bitcoin,
  debt: CreditCard,
  other: Building2,
};

const colors: Record<string, string> = {
  checking: "text-blue-400",
  savings: "text-emerald-400",
  investment: "text-violet-400",
  crypto: "text-yellow-400",
  debt: "text-red-400",
  other: "text-gray-400",
};

interface Props {
  account: Account;
}

export function AccountCard({ account }: Props) {
  const Icon = icons[account.type] ?? Building2;
  const color = colors[account.type] ?? "text-gray-400";
  const isDebt = account.type === "debt";
  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(Math.abs(n));

  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className={`p-2 rounded-xl bg-gray-800 ${color}`}>
          <Icon size={16} />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-gray-400 truncate">{account.institution}</p>
          <p className="text-sm font-semibold text-white truncate">{account.name}</p>
        </div>
      </div>
      <p className={`text-2xl font-bold ${isDebt ? "text-red-400" : "text-white"}`}>
        {isDebt ? "-" : ""}{fmt(account.balance)}
      </p>
      <p className="text-xs text-gray-500">
        Updated {new Date(account.lastUpdated).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
      </p>
    </Card>
  );
}
