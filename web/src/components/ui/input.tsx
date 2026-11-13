import type { InputHTMLAttributes } from "react";

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-12 w-full rounded-[10px] border border-line bg-card px-3 text-base text-ink placeholder:text-ink/40 focus:border-ink focus:outline-none ${className}`}
      {...props}
    />
  );
}
