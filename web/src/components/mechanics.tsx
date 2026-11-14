"use client";

// The mechanics view (prep/WIREFRAMES.md section 11): one switch that shows what is under the
// merchant's words. Off by default; `?mechanics=1` in a link turns it on.
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { explorerAddress, KEEPER_URL } from "@/lib/config";
import { dayTime, shortAddress } from "@/lib/format";
import { keeper, type Health } from "@/lib/keeper";
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
      {/* The switch's answer sits where it was pressed: the bar at the top is off screen down here, and
          some pages (the home page, a card) have nothing else that changes. */}
      {on && <UnderTheHood />}
      <button className="underline underline-offset-2" onClick={() => saveLocal(KEYS.mechanics, on ? null : "1")}>
        {on ? "Hide how it works under the hood" : "See how it works under the hood"}
      </button>
      {/* The vault's own page speaks DeFi, so it is offered with the mechanics, not to a merchant. */}
      {on && (
        <Link className="ml-4 underline underline-offset-2" href="/lp">
          The vault behind the promos
        </Link>
      )}
    </footer>
  );
}

const link = "underline underline-offset-2";

/** How a promo works, step by step, with the live vault and Stream from the keeper's `/health`. */
function UnderTheHood() {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    keeper.health(controller.signal).then(setHealth, () => undefined);
    return () => controller.abort();
  }, []);
  const last = health?.stream.lastDeliveryAt ?? null;

  return (
    <section className="mb-6 rounded-[10px] border border-line bg-card p-4 text-[14px] text-ink">
      <h2 className="label">Under the hood</h2>
      <p className="mt-1 text-ink/60">
        Mechanics view is on, on every page, until you turn it off. Prices show the offers they were built from, and every
        promo page opens its Proof.
      </p>
      <ol className="mt-4 grid gap-5 md:grid-cols-4">
        <Step n={1} title="The price">
          Gemini&rsquo;s prediction market. A promo costs what its whole payout would cost from the offers on Gemini&rsquo;s
          order book for that result, plus 5%. Pick a game on the{" "}
          <Link className={link} href="/merchant">
            merchant page
          </Link>{" "}
          and open &ldquo;How this price is set&rdquo; to see them.
        </Step>
        <Step n={2} title="The quote">
          The pricing service signs that price for one merchant, good for 90 seconds (an EIP-712 quote). The vault takes only
          quotes its pricer key signed, so the price on screen is the price on chain.
        </Step>
        <Step n={3} title="The vault">
          Paying locks the promo&rsquo;s whole payout in a USDC vault on Arc, funded by liquidity providers. Nobody can withdraw a
          locked payout.{" "}
          {health && (
            <>
              <a className={`${link} num`} href={explorerAddress(health.vault)} target="_blank" rel="noreferrer">
                {shortAddress(health.vault)}
              </a>{" "}
              on Arc&rsquo;s explorer.{" "}
            </>
          )}
          <Link className={link} href="/lp">
            Its books
          </Link>
          .
        </Step>
        <Step n={4} title="The result">
          Gemini settles the market and the keeper posts the result to the vault. After an hour in which a wrong result can be
          vetoed, the vault pays every customer. A QuickNode Stream carries each event from Arc to the page as it happens
          {last !== null ? ` (last delivery ${dayTime(last)})` : ""}; between demos it is paused and the keeper reads the chain
          itself.{" "}
          <a className={link} href={`${KEEPER_URL}/feed`} target="_blank" rel="noreferrer">
            The feed
          </a>
          .
        </Step>
      </ol>
    </section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li>
      <span className="label">{n}</span>
      <h3 className="mt-1 text-[15px] font-semibold">{title}</h3>
      <p className="mt-1 text-ink/70">{children}</p>
    </li>
  );
}
