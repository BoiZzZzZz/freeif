"use client";

import { useEffect, type ReactNode } from "react";

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
};

/**
 * A bottom sheet on a phone, a centered panel on a wide screen.
 *
 * It does not trap focus and is not a `<dialog>` on purpose: Circle's code and confirmation window is
 * an iframe added to the page, and it has to sit above this sheet and take the keyboard. A modal
 * dialog would put itself on top and make that window unreachable.
 */
export function Sheet({ open, onClose, title, children }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="no-print fixed inset-0 z-40 flex items-end justify-center sm:items-center">
      <button aria-label="Close" className="absolute inset-0 cursor-default bg-ink/40" onClick={onClose} />
      <div
        role="dialog"
        aria-label={title}
        className="relative max-h-[90dvh] w-full max-w-[440px] overflow-y-auto rounded-t-[16px] bg-paper p-5 pb-8 shadow-2xl sm:rounded-[16px]"
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-[18px] font-semibold">{title}</h2>
          <button aria-label="Close" className="-mr-2 grid size-10 place-items-center text-[20px] text-ink/60 hover:text-ink" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
