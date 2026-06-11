import { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}

export function Card({ children, className = "", onClick }: CardProps) {
  const interactive = onClick ? "cursor-pointer" : "";
  return (
    <div
      onClick={onClick}
      className={`rounded-2xl border border-gray-700 bg-gray-900 p-4 ${interactive} ${className}`}
    >
      {children}
    </div>
  );
}

export function CardTitle({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-1">
      {children}
    </p>
  );
}
