"use client";

// /merchant (prep/WIREFRAMES.md section 7): a shop owner sets up a promo in under a minute. The screen
// shows a game, a team, a chance and a cost in dollars. The form and the live price work logged out;
// login happens when the merchant taps Pay.
//
// The same form sells a cover (section 7.5, "My business gets paid"): one payout to the business itself
// if a day's high temperature lands in a range. It is the same contract with one claimant.
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { GamePicker, type Pick } from "@/components/merchant/game-picker";
import { PaySheet, type Order } from "@/components/merchant/pay-sheet";
import { PriceCard, usePrice } from "@/components/merchant/price-card";
import { WeatherPicker } from "@/components/merchant/weather-picker";
import { ReceiptCard } from "@/components/receipt-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { EmailStep } from "@/components/email-step";
import { usdcBalance } from "@/lib/balance";
import { parseDollars, timeOf, usd } from "@/lib/format";
import { keeper, type Price, type PriceRequest, type Promo } from "@/lib/keeper";
import { KEYS, NO_PROMOS, useLocal, type MyPromo } from "@/lib/local";
import { promoTitle, statusLine, titleOf } from "@/lib/promo";
import { useNow } from "@/lib/use-now";
import { useWallet } from "@/lib/wallet";

// What is free. "Other" leaves the name to the merchant. No "whole order": each customer gets a fixed amount.
const ITEMS = ["Wings", "Dessert", "Drink", "Delivery fee", "Other"] as const;
const COUNTS = [12, 25, 50, 100];
const MOST = 500;
const DOLLAR = 1_000_000n;

type Mode = "promo" | "cover";

const noop = () => () => {};
/** `/merchant?cover=1` opens the form on "My business gets paid". */
const useCoverLink = () =>
  useSyncExternalStore(
    noop,
    () => new URLSearchParams(window.location.search).get("cover") === "1",
    () => false,
  );

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="label flex gap-3">
        <span className="text-ink">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

export function MerchantForm() {
  const wallet = useWallet();
  const business = useLocal<string>(KEYS.business, "");
  const coverLink = useCoverLink();
  const [chosen, setChosen] = useState<Mode | null>(null);
  const mode: Mode = chosen ?? (coverLink ? "cover" : "promo");
  const cover = mode === "cover";

  // A promo: which team, what is free, for how many customers, until when.
  const [pick, setPick] = useState<Pick | null>(null);
  const [chip, setChip] = useState<(typeof ITEMS)[number]>("Wings");
  const [item, setItem] = useState("Wings");
  const [priceText, setPriceText] = useState("8.00");
  const [count, setCount] = useState(12);
  const [deadline, setDeadline] = useState<"start" | "30min">("start");
  // A cover: which day and range, and how much the business gets.
  const [day, setDay] = useState<Pick | null>(null);
  const [amountText, setAmountText] = useState("250.00");
  const [amountTyped, setAmountTyped] = useState(false);

  const [order, setOrder] = useState<Order | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);

  useEffect(() => wallet.warm(), [wallet]);

  const payout = parseDollars(cover ? amountText : priceText);
  const picked = cover ? day : pick;
  const request: PriceRequest | null =
    picked && payout !== null
      ? {
          eventTicker: picked.game.eventTicker,
          instrumentSymbol: picked.team.instrumentSymbol,
          payoutPerClaim: payout.toString(),
          maxClaims: cover ? 1 : count,
          claimDeadline: cover ? "start" : deadline,
        }
      : null;

  // The vault can only cover so much on one result: the customer stepper stops there, and an amount the
  // merchant has not typed themselves comes down to what fits.
  const { price, error, loading, at } = usePrice(
    request,
    (p: Price) => {
      if (!cover) {
        if (p.maxCustomers > 0) setCount((c) => Math.min(c, p.maxCustomers));
        return;
      }
      const fits = BigInt(p.maxPayout ?? "0") / DOLLAR;
      if (!amountTyped && (p.limit === "exposure" || p.limit === "ceiling") && fits >= 1n) setAmountText(`${fits}.00`);
    },
    cover,
  );
  const most = price ? Math.min(price.maxCustomers, MOST) : MOST;
  const atCap = !cover && price !== null && price.maxCustomers > 0 && count >= price.maxCustomers;
  const overSize = price !== null && (price.limit === "exposure" || price.limit === "ceiling");
  const canCover = price?.maxPayout ? BigInt(price.maxPayout) : null;
  // In a cover, the line about what fits shows when the amount is at it or over it.
  const nearCap = cover && canCover !== null && canCover > 0n && payout !== null && payout * 10n >= canCover * 9n;
  const payable = price !== null && price.limit === "ok" && (cover || item.trim() !== "");
  const blocked =
    price === null
      ? null
      : price.limit === "too-likely"
        ? cover
          ? "This is too likely to buy cover on. Pick another range."
          : "This result is too likely to offer as a promotion. Pick the other team."
        : cover
          ? overSize && (canCover === null || canCover === 0n)
            ? "We can't cover this right now. Try another day or range."
            : null
          : price.maxCustomers === 0
            ? "We can't cover this game right now. Try a lower price, or another game."
            : null;

  const kickoff = pick?.game.startTime ?? null;
  const title = promoTitle(item, pick?.team.condition);

  function startPay() {
    if (!request || !price || !picked) return;
    setOrder({
      request,
      item: cover ? "" : item.trim(),
      title,
      cover: cover ? { condition: picked.team.condition } : undefined,
      shownCost: price.breakdown.cost,
      shownChance: price.breakdown.chance,
    });
  }

  const thing = cover ? "cover" : "promo";
  const payButton = (
    <Button disabled={!payable} onClick={startPay}>
      {price && payable ? `Pay ${usd(price.breakdown.cost)} and start the ${thing}` : `Pay and start the ${thing}`}
    </Button>
  );

  return (
    <div className="mx-auto w-full max-w-[1000px] flex-1 px-4 pb-32 md:pb-10">
      <header className="flex h-14 items-center justify-between">
        <Link href="/" className="text-[18px] font-semibold tracking-tight">
          FreeIf
        </Link>
        {wallet.session ? (
          <span className="flex items-center gap-3 text-[14px]">
            <span className="max-w-[160px] truncate text-ink/60">{wallet.session.email}</span>
            <button className="underline underline-offset-2" onClick={wallet.logout}>
              Log out
            </button>
          </span>
        ) : (
          <button className="rounded-full border border-line bg-card px-4 py-1.5 text-[14px] font-medium" onClick={() => setLoginOpen(true)}>
            Log in
          </button>
        )}
      </header>

      <div className="py-6">
        {cover ? (
          <>
            <h1 className="text-[28px] font-semibold leading-tight tracking-tight">Get paid if the weather turns</h1>
            <p className="mt-2 text-[16px] text-ink/60">Your business gets a fixed amount if it happens. You pay one fixed cost today.</p>
          </>
        ) : (
          <>
            <h1 className="text-[28px] font-semibold leading-tight tracking-tight">Run a &ldquo;free if they win&rdquo; promo</h1>
            <p className="mt-2 text-[16px] text-ink/60">Your customers get it free if the team wins. You pay one fixed cost today.</p>
          </>
        )}
      </div>

      <YourPromos />

      <div className="md:grid md:grid-cols-[minmax(0,1fr)_380px] md:gap-10">
        <div className="space-y-8">
          <div className="flex gap-2" role="group" aria-label="Who gets paid">
            <Button variant="chip" selected={!cover} onClick={() => setChosen("promo")}>
              Customers get it free
            </Button>
            <Button variant="chip" selected={cover} onClick={() => setChosen("cover")}>
              My business gets paid
            </Button>
          </div>

          {cover ? (
            <>
              <Step n={1} title="Which day, which temperature">
                <WeatherPicker picked={day} onPick={setDay} />
              </Step>

              <Step n={2} title="How much you get if it happens">
                <label className="block max-w-[200px] space-y-1">
                  <span className="label">Amount</span>
                  <span className="relative block">
                    <span className="num pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink/60">$</span>
                    <Input
                      className="num pl-7"
                      inputMode="decimal"
                      value={amountText}
                      onChange={(e) => {
                        setAmountText(e.target.value);
                        setAmountTyped(true);
                      }}
                    />
                  </span>
                </label>
                {payout === null ? (
                  <p className="text-[14px] text-stop">Enter an amount, like 250.00.</p>
                ) : (
                  <p className="text-[15px] text-ink/60">Paid to your account the morning after, if the high lands in that range.</p>
                )}
                {nearCap && <p className="text-[15px]">We can cover up to {usd(canCover)} on this right now.</p>}
              </Step>
            </>
          ) : (
            <>
              <Step n={1} title="Which game, which team">
                <GamePicker picked={pick} onPick={setPick} />
              </Step>

              <Step n={2} title="What's free">
                <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
                  {ITEMS.map((name) => (
                    <Button
                      key={name}
                      variant="chip"
                      selected={chip === name}
                      onClick={() => {
                        setChip(name);
                        setItem(name === "Other" ? "" : name);
                      }}
                    >
                      {name}
                    </Button>
                  ))}
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3">
                  <label className="space-y-1">
                    <span className="label">Item</span>
                    <Input maxLength={40} placeholder="What's free" value={item} onChange={(e) => setItem(e.target.value)} />
                  </label>
                  <label className="space-y-1">
                    <span className="label">Price</span>
                    <span className="relative block">
                      <span className="num pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink/60">$</span>
                      <Input className="num pl-7" inputMode="decimal" value={priceText} onChange={(e) => setPriceText(e.target.value)} />
                    </span>
                  </label>
                </div>
                {payout === null && <p className="text-[14px] text-stop">Enter the item&apos;s price, like 8.00.</p>}
              </Step>

              <Step n={3} title="How many customers">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center rounded-[10px] border border-line bg-card">
                    <button
                      aria-label="Fewer customers"
                      className="grid size-12 place-items-center text-[20px] disabled:opacity-30"
                      disabled={count <= 1}
                      onClick={() => setCount((c) => Math.max(c - 1, 1))}
                    >
                      −
                    </button>
                    <span className="num w-12 text-center text-[18px]" aria-live="polite">
                      {count}
                    </span>
                    <button
                      aria-label="More customers"
                      className="grid size-12 place-items-center text-[20px] disabled:opacity-30"
                      disabled={count >= most}
                      onClick={() => setCount((c) => Math.min(c + 1, most))}
                    >
                      +
                    </button>
                  </div>
                  {COUNTS.map((n) => (
                    <Button key={n} variant="chip" className="num" selected={count === n} disabled={n > most} onClick={() => setCount(n)}>
                      {n}
                    </Button>
                  ))}
                </div>
                <p className="text-[15px] text-ink/60">
                  The first {count} customer{count === 1 ? "" : "s"} who scan {count === 1 ? "is" : "are"} covered. One per customer.
                </p>
                {atCap && (
                  <p className="text-[15px]">
                    We can cover up to {price.maxCustomers} customer{price.maxCustomers === 1 ? "" : "s"} on this game right now.
                  </p>
                )}
              </Step>

              <Step n={4} title="Stop accepting customers">
                <div className="space-y-2">
                  {(["start", "30min"] as const).map((choice) => (
                    <label key={choice} className="flex h-12 cursor-pointer items-center gap-3 rounded-[10px] border border-line bg-card px-3">
                      <input
                        type="radio"
                        name="deadline"
                        className="size-4 accent-ink"
                        checked={deadline === choice}
                        onChange={() => setDeadline(choice)}
                      />
                      <span className="text-[15px]">
                        {choice === "start" ? "At kickoff" : "30 minutes before"}
                        {kickoff !== null && (
                          <>
                            , <span className="num text-ink/60">{timeOf(choice === "start" ? kickoff : kickoff - 1800)}</span>
                          </>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              </Step>
            </>
          )}
        </div>

        <aside className="mt-8 space-y-6 md:sticky md:top-6 md:mt-0 md:self-start">
          <section>
            <h2 className="label mb-2">{cover ? "What you're buying" : "What your customer sees"}</h2>
            {cover ? (
              <ReceiptCard
                state="preview"
                cover
                business={business}
                amount={payout}
                condition={day?.team.condition}
                game={day?.game.game}
                startTime={day?.game.startTime}
              />
            ) : (
              <ReceiptCard
                state="preview"
                business={business}
                item={item}
                amount={payout}
                condition={pick?.team.condition}
                game={pick?.game.game}
                startTime={kickoff}
                maxClaims={count}
              />
            )}
          </section>
          <PriceCard price={price} error={blocked ?? error} loading={loading} at={at} payout={payout} count={count} cover={cover} />
          <div className="hidden md:block">{payButton}</div>
        </aside>
      </div>

      {/* On a phone the Pay button stays at the bottom of the screen. */}
      <div className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-line bg-paper/95 p-4 backdrop-blur md:hidden">{payButton}</div>

      {order && <PaySheet order={order} onClose={() => setOrder(null)} />}
      <Sheet open={loginOpen && !wallet.session} onClose={() => setLoginOpen(false)} title="Log in">
        <div className="space-y-3">
          <p className="text-[15px]">Enter your email. We&apos;ll send a 6-digit code.</p>
          <EmailStep cta="Continue" hint="No password. Your promos are kept under this email." onDone={() => setLoginOpen(false)} />
        </div>
      </Sheet>
    </div>
  );
}

/** A returning merchant's promos, from what this browser remembers paying for, and their balance. */
function YourPromos() {
  const wallet = useWallet();
  const mine = useLocal<MyPromo[]>(KEYS.promos, NO_PROMOS);
  const [promos, setPromos] = useState<Promo[]>([]);
  const [balance, setBalance] = useState<bigint | null>(null);
  const now = useNow(30_000);
  const ids = mine
    .slice(0, 5)
    .map((p) => p.id)
    .join(",");
  const address = wallet.session?.address ?? null;

  useEffect(() => {
    if (ids === "") return;
    let live = true;
    Promise.allSettled(ids.split(",").map((id) => keeper.promo(id))).then((results) => {
      if (live) setPromos(results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])));
    });
    return () => {
      live = false;
    };
  }, [ids]);

  useEffect(() => {
    if (!address) return;
    let live = true;
    usdcBalance(address).then(
      (value) => live && setBalance(value),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [address]);

  if (promos.length === 0 && !address) return null;
  return (
    <section className="mb-8 space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="label">{promos.length > 0 ? "Your promos" : "Your account"}</h2>
        {address && balance !== null && (
          <span className="text-[14px]">
            Balance <span className="num">{usd(balance)}</span>
          </span>
        )}
      </div>
      {promos.map((p) => (
        <Link
          key={p.promoId}
          href={`/promo/${p.promoId}`}
          className="flex items-center justify-between gap-3 rounded-[10px] border border-line bg-card px-4 py-3 text-[15px] hover:border-ink/40"
        >
          <span className="min-w-0 truncate">{titleOf(p)}</span>
          <span className="num shrink-0 text-[13px] text-ink/60">
            {p.hedgeMode ? "" : `${p.claimCount} of ${p.maxClaims} · `}
            {statusLine(p, Math.floor((now || 0) / 1000), true).badge} ›
          </span>
        </Link>
      ))}
    </section>
  );
}
