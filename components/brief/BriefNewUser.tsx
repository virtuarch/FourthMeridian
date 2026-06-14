"use client";

/**
 * BriefNewUser
 *
 * Shown inside the card grid when the user has no accounts/assets.
 * Glass-consistent with the other cards. No fake numbers.
 */

import Link from "next/link";
import { Link2, PlusCircle } from "lucide-react";

export function BriefNewUser() {
  return (
    <div
      className={[
        "relative rounded-2xl overflow-hidden col-span-full",
        "backdrop-blur-md bg-white/[0.06] border border-white/[0.09]",
        "p-8 md:p-10",
      ].join(" ")}
    >
      {/* Inner top highlight */}
      <div
        className="absolute top-0 left-0 right-0 h-px"
        style={{ background: "linear-gradient(to right, transparent, rgba(255,255,255,0.12), transparent)" }}
      />

      <div className="max-w-md mx-auto text-center">
        <div className="w-12 h-12 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mx-auto mb-5">
          <span className="text-xl">🌐</span>
        </div>
        <h2 className="text-lg font-bold text-white mb-2">
          Let&apos;s build your financial picture
        </h2>
        <p className="text-sm text-gray-400 mb-7 leading-relaxed">
          Connect accounts and add assets to see your real net worth, track trends over time, and unlock personalized insights.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/dashboard/accounts"
            className="flex items-center justify-center gap-2 py-3 px-6 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors"
          >
            <Link2 className="w-4 h-4" />
            Connect an Account
          </Link>
          <Link
            href="/dashboard/accounts"
            className="flex items-center justify-center gap-2 py-3 px-6 rounded-xl bg-white/[0.08] hover:bg-white/[0.12] text-gray-200 text-sm font-semibold transition-colors border border-white/[0.12]"
          >
            <PlusCircle className="w-4 h-4" />
            Add Manual Asset
          </Link>
        </div>
      </div>
    </div>
  );
}
