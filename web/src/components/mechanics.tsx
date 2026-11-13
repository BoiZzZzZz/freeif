"use client";

// The mechanics view (prep/WIREFRAMES.md section 11): one switch that shows what is under the
// merchant's words. Off by default; `?mechanics=1` in a link turns it on.
import { useEffect } from "react";
import { KEYS, saveLocal, useLocal } from "@/lib/local";

export function useMechanics(): boolean {
  return useLocal<string>(KEYS.mechanics, "") === "1";
}

export function MechanicsBar() {
  const on = useMechanics();
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("mechanics") === "1") saveLocal(KEYS.mechanics, "1");
  }, []);
  if (!on) return null;
  return (
    <div className="no-print flex items-center justify-center gap-3 bg-ink px-4 py-1.5 text-[13px] text-white">
      <span className="num uppercase tracking-wider">Mechanics view</span>
      <button className="underline underline-offset-2" onClick={() => saveLocal(KEYS.mechanics, null)}>
        Turn off
      </button>
    </div>
  );
}

export function SiteFooter() {
  const on = useMechanics();
  return (
    <footer className="no-print mx-auto w-full max-w-[1000px] px-4 pb-10 pt-12 text-[13px] text-ink/60">
      <button className="underline underline-offset-2" onClick={() => saveLocal(KEYS.mechanics, on ? null : "1")}>
        {on ? "Hide how it works under the hood" : "See how it works under the hood"}
      </button>
    </footer>
  );
}
