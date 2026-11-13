import type { ButtonHTMLAttributes } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** `primary` is solid ink, the one main action on a screen. */
  variant?: "primary" | "secondary" | "chip";
  /** For `chip`: the chosen one of a group turns solid ink. */
  selected?: boolean;
};

const base =
  "inline-flex items-center justify-center gap-2 font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed";

const styles = {
  primary: "h-12 w-full rounded-[10px] bg-ink px-5 text-white hover:bg-ink/85 disabled:bg-ink/25",
  secondary: "h-12 w-full rounded-[10px] border border-line bg-card px-5 text-ink hover:border-ink/40 disabled:text-ink/40",
  chip: "h-9 shrink-0 rounded-full border px-4 text-[14px] disabled:opacity-40",
};

export function Button({ variant = "primary", selected = false, className = "", type = "button", ...props }: Props) {
  const chip = selected ? "border-ink bg-ink text-white" : "border-line bg-card text-ink hover:border-ink/40";
  return (
    <button
      type={type}
      aria-pressed={variant === "chip" ? selected : undefined}
      className={`${base} ${styles[variant]} ${variant === "chip" ? chip : ""} ${className}`}
      {...props}
    />
  );
}
