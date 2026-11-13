"use client";

// "Your price": three lines on a receipt-style card. The cost is the large number, the fee is one
// small line under it, and everything else is behind "How this price is set".
import { useEffect, useState } from "react";
import { useMechanics } from "@/components/mechanics";
import { Sheet } from "@/components/ui/sheet";
import { capitalize, pct, shortAddress, timeOf, usd } from "@/lib/format";
import { keeper, KeeperError, type Price, type PriceRequest } from "@/lib/keeper";
import { useNow } from "@/lib/use-now";

const NO_PRICE = "We can't get a live price right now. Try again in a moment.";

function messageFor(err: unknown): string {
  if (!(err instanceof KeeperError)) return NO_PRICE;
  if (err.code === "event-started" || err.code === "too-close" || err.code === "market-closed") {
    return "This game has started. Pick another game.";
  }
  // Refusals a merchant can act on keep the keeper's own words; the rest are "no live price".
  return err.status === 422 ? err.message : NO_PRICE;
}

type Held = { key: string; price: Price | null; error: string | null; at: number };

/**
 * The live price for a request: asked for when the request changes (after a short pause, so typing a
 * price does not ask on every key) and again every 15 seconds. A stale price is never shown: when
 * the keeper cannot give one, the card says so.
 */
export function usePrice(request: PriceRequest | null, onPrice?: (price: Price) => void) {
  const key = request ? JSON.stringify(request) : "";
  const [held, setHeld] = useState<Held | null>(null);

  useEffect(() => {
    if (key === "") return;
    const controller = new AbortController();
    const load = () =>
      keeper.price(JSON.parse(key) as PriceRequest, controller.signal).then(
        (price) => {
          setHeld({ key, price, error: null, at: Date.now() });
          onPrice?.(price);
        },
        (err) => {
          if (!controller.signal.aborted) setHeld({ key, price: null, error: messageFor(err), at: Date.now() });
        },
      );
    const first = window.setTimeout(load, 250);
    const timer = window.setInterval(load, 15_000);
    return () => {
      controller.abort();
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
    // `onPrice` is left out on purpose: a new function each render must not restart the price.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const current = held && held.key === key ? held : null;
  return {
    price: current?.price ?? null,
    error: current?.error ?? null,
    loading: key !== "" && current === null,
    at: current?.at ?? 0,
  };
}

function Line({ label, value, strong = false }: { label: React.ReactNode; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className={strong ? "text-[16px] font-medium" : "text-[15px]"}>{label}</span>
      <span className={`num shrink-0 ${strong ? "text-[44px] font-semibold leading-none" : "text-[15px]"}`}>{value}</span>
    </div>
  );
}

type CardProps = {
  price: Price | null;
  error: string | null;
  loading: boolean;
  /** When the price was fetched, in milliseconds. */
  at: number;
  /** What the merchant is giving away each time, in base units, for the "(12 × $8.00)" note. */
  payout: bigint | null;
  count: number;
};

export function PriceCard({ price, error, loading, at, payout, count }: CardProps) {
  const [open, setOpen] = useState(false);
  const mechanics = useMechanics();
  const now = useNow(1000);
  const age = now && at ? Math.max(Math.round((now - at) / 1000), 0) : null;

  return (
    <section aria-label="Your price">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="label">Your price</h2>
        {price && age !== null && <span className="num text-[12px] text-ink/60">updated {age}s ago</span>}
      </div>
      <div className="rounded-[10px] border border-line bg-card p-4">
        {error && (
          <p role="alert" className="text-[15px]">
            {error}
          </p>
        )}
        {!error && !price && (
          <p className="text-[15px] text-ink/60">{loading ? "Getting your price…" : "Pick a team and set a price to see what this costs."}</p>
        )}
        {price && (
          <div className="space-y-2">
            <Line label={`Chance ${price.display.subject ? price.display.condition : "this happens"}`} value={pct(price.breakdown.chance)} />
            <Line
              label={
                <>
                  Most you could owe{" "}
                  {payout !== null && (
                    <span className="num text-ink/60">
                      ({count} × {usd(payout)})
                    </span>
                  )}
                </>
              }
              value={usd(price.breakdown.mostOwed)}
            />
            <div className="border-t border-line pt-3">
              <Line label="Your cost today" value={usd(price.breakdown.cost)} strong />
            </div>
            <p className="pt-1 text-[14px] text-ink/60">Includes our {usd(price.breakdown.fee)} fee. This is all you pay, win or lose.</p>
            {mechanics && (
              <p className="num inline-block rounded-full bg-go-tint px-2.5 py-0.5 text-[12px] text-ink">
                Live price: Gemini Prediction Markets API
              </p>
            )}
            <button className="block text-[14px] underline underline-offset-2" onClick={() => setOpen(true)}>
              How this price is set ›
            </button>
          </div>
        )}
      </div>
      {price && <HowSheet open={open} onClose={() => setOpen(false)} price={price} mechanics={mechanics} />}
    </section>
  );
}

function HowSheet({ open, onClose, price, mechanics }: { open: boolean; onClose: () => void; price: Price; mechanics: boolean }) {
  const b = price.breakdown;
  const m = price.mechanics;
  const subject = price.display.subject;
  const feePct = Math.round(m.spreadBps / 100);
  return (
    <Sheet open={open} onClose={onClose} title="How this price is set">
      <div className="space-y-2 rounded-[10px] border border-line bg-card p-4">
        <Line label={`${pct(b.chance)} of ${usd(b.mostOwed)}`} value={usd(b.expectedLoss)} />
        <Line label={`Our fee (${feePct}%)`} value={usd(b.fee)} />
        <div className="border-t border-line pt-2">
          <Line label="Your cost" value={usd(b.cost)} />
        </div>
      </div>
      <div className="mt-4 space-y-3 text-[15px]">
        <p>
          {subject ? `If ${price.display.condition}` : "If it happens"}, we pay your customers, up to {usd(b.mostOwed)}.{" "}
          {subject ? `If ${subject.startsWith("the ") ? "they lose" : `${subject} loses`}` : "If it doesn't"}, nobody is owed anything and we
          keep the {usd(b.cost)}.
        </p>
        <p>
          Where {pct(b.chance)} comes from: live prices on Gemini, where people trade on{" "}
          {subject ? "who wins this game" : "whether this happens"}. The price moves until you pay.
        </p>
      </div>
      {mechanics && (
        <dl className="num mt-5 space-y-1.5 border-t border-dashed border-line pt-4 text-[13px]">
          <Fact label="Source" value="Gemini Prediction Markets API" />
          <Fact label="Instrument" value={price.instrumentSymbol} />
          <Fact label="Best ask" value={`${m.bestAsk ?? "none"} · bid ${m.bestBid ?? "none"} · last trade ${m.lastTradePrice ?? "none"} · ${timeOf(m.askFetchedAt)}`} />
          <Fact label="Spread" value={`${m.spreadBps} bps${m.thin ? " (thin book: priced on the highest price it shows)" : ""} · loading ${usd(m.loading)}`} />
          <Fact label="Quote" value={`signed by pricer ${shortAddress(m.pricer)}, valid ${m.quoteTtlSeconds} s`} />
          <Fact label="On pay" value={`${usd(b.mostOwed)} is locked on Arc until the result`} />
          <Fact label="Rule" value={capitalize(price.rule)} />
        </dl>
      )}
    </Sheet>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-[84px] shrink-0 text-ink/60">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  );
}
