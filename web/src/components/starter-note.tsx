"use client";

// On the home page, under "Run a promo": a new account gets test dollars to try this with. Shown only
// while the keeper is giving them (its `/health` says how much and how many are left).
import { useEffect, useState } from "react";
import { usd } from "@/lib/format";
import { keeper, type StarterInfo } from "@/lib/keeper";

export function StarterNote() {
  const [starter, setStarter] = useState<StarterInfo | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    keeper.health(controller.signal).then(
      (health) => setStarter(health.starter ?? null),
      () => undefined,
    );
    return () => controller.abort();
  }, []);

  // The line keeps its height while the keeper is asked, so the page below it does not move.
  return (
    <p className="mt-3 min-h-[22px] text-[15px] text-ink/60">
      {starter !== null && starter.left > 0 && `Try it with ${usd(starter.amount)} in test dollars. No card, no real money.`}
    </p>
  );
}
