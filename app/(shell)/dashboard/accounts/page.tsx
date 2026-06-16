import { getAccounts } from "@/lib/data/accounts";
import { AccountCard } from "@/components/dashboard/AccountCard";
import { PlaidLinkButton } from "@/components/plaid/PlaidLinkButton";

export const preferredRegion = "sin1";
export const runtime = "nodejs";

const sections = [
  { label: "Checking", type: "checking" },
  { label: "Savings", type: "savings" },
  { label: "Investments", type: "investment" },
  { label: "Crypto", type: "crypto" },
  { label: "Debt", type: "debt" },
] as const;

export default async function AccountsPage() {
  const t0 = Date.now();
  const allAccounts = await getAccounts();
  console.log(`[page:accounts] total: ${Date.now() - t0}ms`);

  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">Accounts</h1>
        <PlaidLinkButton />
      </div>

      {sections.map(({ label, type }) => {
        const accounts = allAccounts.filter((a) => a.type === type);
        if (!accounts.length) return null;
        return (
          <section key={type}>
            <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2 px-1">{label}</p>
            <div className="grid grid-cols-1 gap-3">
              {accounts.map((a) => <AccountCard key={a.id} account={a} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}
