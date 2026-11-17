"use client";

// /merchant (prep/WIREFRAMES.md section 7): a shop owner sets up a promo in under a minute. The screen
// shows a game, a team, a chance and a cost in dollars. The form and the live price work logged out;
// login happens when the merchant taps Pay, or before it, from the bar that offers the test dollars.
//
// The account is on the page from the start (`lib/account.tsx`): what a new account gets to try this with,
// the balance once logged in, and a promo sized to what that balance pays for, so nobody builds a promo
// and learns at Pay that it costs more than they hold.
//
// The same form sells a cover (section 7.5, "My business gets paid"): one payout to the business itself
// if a day's high temperature lands in a range. It is the same contract with one claimant.
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { CashOut } from "@/components/cash-out";
import { AddressBox } from "@/components/merchant/add-money";
import { GamePicker, type Pick } from "@/components/merchant/game-picker";
import { PaySheet, type Fit, type Order } from "@/components/merchant/pay-sheet";
import { PriceCard, usePrice } from "@/components/merchant/price-card";
import { WeatherPicker } from "@/components/merchant/weather-picker";
import { ReceiptCard } from "@/components/receipt-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { EmailStep } from "@/components/email-step";
import { AccountProvider, useAccount } from "@/lib/account";
import { amountFor, customersFor, isShort } from "@/lib/fit";
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

/** What the form sizes a promo against: the account's balance, or the test dollars a new visitor will get. */
type Funds = { amount: bigint; from: "balance" | "starter" };

const people = (n: number) => `${n} customer${n === 1 ? "" : "s"}`;

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
  return (
    <AccountProvider>
      <Form />
    </AccountProvider>
  );
}

function Form() {
  const wallet = useWallet();
  const account = useAccount();
  const business = useLocal<string>(KEYS.business, "");
  const mine = useLocal<MyPromo[]>(KEYS.promos, NO_PROMOS);
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
  // True once the merchant has set the number themselves: from then on it is theirs, and only a note says
  // what the balance covers.
  const [countTouched, setCountTouched] = useState(false);
  // Set when the form brought the size down to the balance by itself: the funds it was sized to, and the
  // size the merchant had before, to go back to if the funds turn out bigger (a login with money in it).
  const [sizedAt, setSizedAt] = useState<{ funds: bigint; count: number; amountText: string } | null>(null);
  const sized = sizedAt !== null;
  const [deadline, setDeadline] = useState<"start" | "30min">("start");
  // A cover: which day and range, and how much the business gets.
  const [day, setDay] = useState<Pick | null>(null);
  const [amountText, setAmountText] = useState("250.00");
  const [amountTyped, setAmountTyped] = useState(false);

  const [order, setOrder] = useState<Order | null>(null);
  // The login sheet: opened from the header, or from the bar that offers the test dollars.
  const [loginOpen, setLoginOpen] = useState<"login" | "starter" | null>(null);

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

  // What the promo is sized against. Logged in: the balance, with test dollars that are on their way
  // counted in. Not logged in: the test dollars a new visitor gets at login; a browser that has paid for a
  // promo before is someone with an account of their own, and is left alone until they log in.
  const starterAmount = account.starter ? BigInt(account.starter.amount) : null;
  const funds: Funds | null = account.address
    ? account.balance === null
      ? null
      : { amount: account.balance + (account.grant.state === "asking" && starterAmount !== null ? starterAmount : 0n), from: "balance" }
    : account.offered && starterAmount !== null && mine.length === 0
      ? { amount: starterAmount, from: "starter" }
      : null;
  const cost = price !== null && price.limit === "ok" ? BigInt(price.breakdown.cost) : null;
  const short = funds !== null && cost !== null && isShort(funds.amount, cost);
  const fitCustomers = short && !cover ? Math.min(customersFor(funds.amount, cost, count), Math.max(most, 1)) : null;
  const fitAmount = short && cover && payout !== null ? amountFor(funds.amount, cost, payout) : null;

  // A size the merchant has not set themselves comes down to what the balance pays for. It only ever comes
  // down, and each step is below the last, so it settles. Set while rendering, as React asks for state that
  // follows other state: the price it is worked out from is the price of the size on screen.
  if (funds !== null && sizedAt !== null && funds.amount > sizedAt.funds) {
    // More money than the size was brought down to: back to the size from before, and sized again from there.
    if (!countTouched) setCount(sizedAt.count);
    if (!amountTyped) setAmountText(sizedAt.amountText);
    setSizedAt(null);
  } else if (funds !== null && !countTouched && fitCustomers !== null && fitCustomers >= 1 && fitCustomers < count) {
    setCount(fitCustomers);
    setSizedAt({ funds: funds.amount, count: sizedAt?.count ?? count, amountText: sizedAt?.amountText ?? amountText });
  } else if (funds !== null && !amountTyped && fitAmount !== null && fitAmount >= DOLLAR && payout !== null && fitAmount < payout) {
    setAmountText(`${fitAmount / DOLLAR}.00`);
    setSizedAt({ funds: funds.amount, count: sizedAt?.count ?? count, amountText: sizedAt?.amountText ?? amountText });
  }

  /** The merchant sets the number of customers themselves. */
  function chooseCount(next: number) {
    setCount(next);
    setCountTouched(true);
  }

  const kickoff = pick?.game.startTime ?? null;
  const title = promoTitle(item, pick?.team.condition);
  const fundsText = funds === null ? "" : funds.from === "starter" ? `${usd(funds.amount)} in test dollars` : `balance of ${usd(funds.amount)}`;

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

  /** The balance is short, and the merchant took the size it covers: from the note by the price, or the Pay sheet. */
  function fitTo(fit: Fit) {
    if ("customers" in fit) {
      chooseCount(Math.max(Math.min(fit.customers, most), 1));
      return;
    }
    const dollars = fit.amount / DOLLAR;
    if (dollars < 1n) return;
    setAmountText(`${dollars}.00`);
    // Not typed by the merchant: like the default, it may still come down by itself to what the vault can
    // cover. It never goes up by itself: the price only ever brings an untyped amount down, when it is over
    // the vault's limit.
    setAmountTyped(false);
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
            {account.balance !== null && (
              <span className="num rounded-full border border-line bg-card px-3 py-1" title="Your balance">
                {usd(account.balance)}
              </span>
            )}
            <span className="max-w-[96px] truncate text-ink/60 sm:max-w-[160px]">{wallet.session.email}</span>
            <button className="shrink-0 underline underline-offset-2" onClick={wallet.logout}>
              Log out
            </button>
          </span>
        ) : (
          <button className="rounded-full border border-line bg-card px-4 py-1.5 text-[14px] font-medium" onClick={() => setLoginOpen("login")}>
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

      <AccountBar onStarter={() => setLoginOpen("starter")} />
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
                {sized && !amountTyped && !nearCap && funds !== null && payout !== null && (
                  <p className="text-[15px]">
                    Set to {usd(payout)} to fit your {fundsText}.
                  </p>
                )}
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
                      onClick={() => chooseCount(Math.max(count - 1, 1))}
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
                      onClick={() => chooseCount(Math.min(count + 1, most))}
                    >
                      +
                    </button>
                  </div>
                  {COUNTS.map((n) => (
                    <Button key={n} variant="chip" className="num" selected={count === n} disabled={n > most} onClick={() => chooseCount(n)}>
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
                {sized && !countTouched && !atCap && funds !== null && (
                  <p className="text-[15px]">
                    Set to {people(count)} to fit your {fundsText}.
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
          {funds !== null && cost !== null && (
            <FundsNote funds={funds} short={short} fitCustomers={fitCustomers} fitAmount={fitAmount} cover={cover} onFit={fitTo} />
          )}
          <div className="hidden md:block">{payButton}</div>
        </aside>
      </div>

      {/* On a phone the Pay button stays at the bottom of the screen. */}
      <div className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-line bg-paper/95 p-4 backdrop-blur md:hidden">{payButton}</div>

      {order && <PaySheet order={order} most={most} onFit={fitTo} onClose={() => setOrder(null)} />}
      <Sheet
        open={loginOpen !== null && !wallet.session}
        onClose={() => setLoginOpen(null)}
        title={loginOpen === "starter" ? "Get your test dollars" : "Log in"}
      >
        <div className="space-y-3">
          <p className="text-[15px]">
            Enter your email. We&apos;ll send a 6-digit code
            {account.offered && account.starter ? `, then add ${usd(account.starter.amount)} in test dollars to your account.` : "."}
          </p>
          <EmailStep cta="Continue" hint="No password. Your promos are kept under this email." onDone={() => setLoginOpen(null)} />
        </div>
      </Sheet>
    </div>
  );
}

type FundsNoteProps = {
  funds: Funds;
  /** True when the funds do not pay for the size on screen. */
  short: boolean;
  fitCustomers: number | null;
  fitAmount: bigint | null;
  cover: boolean;
  onFit: (fit: Fit) => void;
};

/** Under the price: whether what the merchant holds pays for it and, when it does not, the size that it pays for. */
function FundsNote({ funds, short, fitCustomers, fitAmount, cover, onFit }: FundsNoteProps) {
  const mine = funds.from === "starter" ? `${usd(funds.amount)} in test dollars` : `balance of ${usd(funds.amount)}`;
  if (!short) {
    return (
      <p className="text-[14px] text-ink/60">
        {funds.from === "starter"
          ? `Your ${mine} cover this. They're added to your account when you log in to pay.`
          : `Paid from your ${mine}.`}
      </p>
    );
  }
  const verb = funds.from === "starter" ? "cover" : "covers";
  const fit: { label: string; size: Fit } | null = cover
    ? fitAmount !== null && fitAmount >= DOLLAR
      ? { label: usd(fitAmount), size: { amount: fitAmount } }
      : null
    : fitCustomers !== null && fitCustomers >= 1
      ? { label: people(fitCustomers), size: { customers: fitCustomers } }
      : null;
  return (
    <div className="space-y-3 rounded-[10px] border border-line bg-card p-4">
      {fit ? (
        <p className="text-[15px]">
          Your {mine} {verb} about {fit.label}.
        </p>
      ) : (
        <p className="text-[15px]">
          {cover
            ? `Your ${mine} ${funds.from === "starter" ? "are" : "is"} too low for this amount. Lower it, or add money.`
            : `Your ${mine} ${funds.from === "starter" ? "don't" : "doesn't"} cover one customer. Lower the item's price, pick the other team, or add money.`}
        </p>
      )}
      {fit && (
        <Button variant="secondary" onClick={() => onFit(fit.size)}>
          Make it {fit.label}
        </Button>
      )}
    </div>
  );
}

/**
 * The account, above the form. Before a login it offers the test dollars a new account gets; after one it
 * shows the balance, the test dollars arriving, and where money goes in and out.
 */
function AccountBar({ onStarter }: { onStarter: () => void }) {
  const account = useAccount();
  const [cashOut, setCashOut] = useState(false);
  const [adding, setAdding] = useState(false);
  const { address, balance, grant, starter } = account;
  const amount = starter ? usd(starter.amount) : "";

  if (!address) {
    if (!account.offered) return null;
    return (
      <section className="mb-8 rounded-[10px] border border-line bg-card p-4 md:flex md:items-center md:justify-between md:gap-6">
        <div>
          <h2 className="text-[16px] font-medium">Try it with {amount} in test dollars</h2>
          <p className="mt-1 text-[15px] text-ink/60">
            This demo runs on test dollars, not real money. Log in with your email and we add {amount} to your account, once per email.
          </p>
        </div>
        <Button className="mt-3 md:mt-0 md:w-auto md:shrink-0" onClick={onStarter}>
          Get {amount} in test dollars
        </Button>
      </section>
    );
  }

  return (
    <section className="mb-8 rounded-[10px] border border-line bg-card p-4" aria-label="Your account">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div>
          <h2 className="label">Your balance</h2>
          <p className="num mt-1 text-[28px] font-semibold leading-none">{balance === null ? "…" : usd(balance)}</p>
        </div>
        <div className="flex items-center gap-4 text-[14px]">
          <button className="underline underline-offset-2" onClick={() => setAdding(true)}>
            Add money
          </button>
          {/* A business that was paid from a cover, or that added more than it used, takes it out here. */}
          {balance !== null && balance > 0n && (
            <button className="underline underline-offset-2" onClick={() => setCashOut(true)}>
              Cash out
            </button>
          )}
        </div>
      </div>
      {grant.state === "asking" && (
        <p className="mt-3 flex items-center gap-2 text-[15px]" role="status">
          <span className="size-3.5 animate-spin rounded-full border-2 border-line border-t-ink" />
          Adding your {amount} in test dollars
        </p>
      )}
      {grant.state === "given" && <p className="mt-3 text-[15px]">We added {amount} in test dollars to your account. This demo runs on test dollars, not real money.</p>}
      {grant.state === "failed" && (
        <p className="mt-3 text-[15px]" role="alert">
          {grant.message}{" "}
          {account.offered && (
            <button className="underline underline-offset-2" onClick={() => void account.claim()}>
              Try again
            </button>
          )}
        </p>
      )}
      {grant.state === "idle" && account.offered && (
        <p className="mt-3 text-[15px]">
          This demo runs on test dollars.{" "}
          <button className="underline underline-offset-2" onClick={() => void account.claim()}>
            Get {amount} to try it
          </button>
        </p>
      )}
      <CashOut open={cashOut} onClose={() => setCashOut(false)} address={address} onSent={() => void account.refresh().catch(() => undefined)} />
      <Sheet open={adding} onClose={() => setAdding(false)} title="Add money">
        <div className="space-y-4">
          <AddressBox address={address} />
          <Button
            variant="secondary"
            onClick={() => {
              void account.refresh().catch(() => undefined);
              setAdding(false);
            }}
          >
            Done
          </Button>
        </div>
      </Sheet>
    </section>
  );
}

/** A returning merchant's promos, from what this browser remembers paying for. */
function YourPromos() {
  const mine = useLocal<MyPromo[]>(KEYS.promos, NO_PROMOS);
  const [promos, setPromos] = useState<Promo[]>([]);
  const now = useNow(30_000);
  const ids = mine
    .slice(0, 5)
    .map((p) => p.id)
    .join(",");

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

  if (promos.length === 0) return null;
  return (
    <section className="mb-8 space-y-2">
      <h2 className="label">Your promos</h2>
      {promos.map((p) => (
        <Link
          key={p.promoId}
          href={`/promo/${p.promoId}`}
          className="flex items-center justify-between gap-3 rounded-[10px] border border-line bg-card px-4 py-3 text-[15px] hover:border-ink/40"
        >
          <span className="min-w-0 truncate">{titleOf(p)}</span>
          <span className="num shrink-0 text-[13px] text-ink/60">
            {p.hedgeMode ? "" : `${p.claimCount} of ${p.maxClaims}${p.cards ? " cards" : ""} · `}
            {statusLine(p, Math.floor((now || 0) / 1000), true).badge} ›
          </span>
        </Link>
      ))}
    </section>
  );
}
