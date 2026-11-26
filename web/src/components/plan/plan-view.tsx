"use client";

// /plan: a "free if they win" night the bar covers itself. The owner says what is free and for how many
// customers, then picks a game and a team, and the page reads the exchange's offers and says what one
// order costs: so many contracts of the team, each paying a dollar if it wins. The owner places that order in
// their own Kalshi account; this app places nothing and holds nothing. Then it prints the vouchers.
//
// Unlike the merchant form, this page names the exchange and speaks of contracts: the owner has to type
// those words into the exchange's own screen.
import Link from "next/link";
import { useDeferredValue, useEffect, useState, useSyncExternalStore } from "react";
import { GameList, type Choice } from "@/components/plan/game-list";
import { VoucherSheet, VoucherSlip, type VoucherWords } from "@/components/plan/voucher-slip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { dayTime, parseDollars, timeOf, usd } from "@/lib/format";
import { KEYS, saveLocal, useLocal } from "@/lib/local";
import { cents, contractsFor, count as amountOf, fillsCleanly, kalshiPage, order, polymarketPage, voucherUrl, type BooksReply, type Order } from "@/lib/plan";
import { plan, PlanError } from "@/lib/plan-client";
import { useNow } from "@/lib/use-now";

// What is free. "Other" leaves the name to the owner.
const ITEMS = ["Wings", "Dessert", "Drink", "Appetizer", "Other"] as const;
const COUNTS = [25, 50, 100, 200];
const MOST = 500;
const DOLLAR = 1_000_000n;
/** How long after the game a winning voucher is good. */
const GOOD_FOR = [
  { key: "night", label: "That night only", days: 0 },
  { key: "week", label: "7 days", days: 7 },
  { key: "month", label: "30 days", days: 30 },
] as const;

const NO_PRICE = "We can't get a live price right now. Try again in a moment.";

const people = (n: number) => `${n} customer${n === 1 ? "" : "s"}`;
const freeOrders = (n: number) => (n === 1 ? "one free order" : `${n} free orders`);

const noop = () => () => {};
const useOrigin = () =>
  useSyncExternalStore(
    noop,
    () => window.location.origin,
    () => "",
  );

/** The end of the day `days` after the game, in this browser's time zone, as unix seconds. */
function endOfDay(startTime: number, days: number): number {
  const day = new Date((startTime + days * 86_400) * 1000);
  day.setHours(23, 59, 59, 0);
  return Math.floor(day.getTime() / 1000);
}

type Held = { key: string; books: BooksReply | null; error: string | null };

/**
 * One team's offers on the exchanges: asked for when the team changes and again every 15 seconds. The
 * order is worked out from them in the page, so changing the number of customers asks nothing new. A
 * stale book is never shown: when the server cannot give one, the card says so.
 */
function useBooks(ticker: string | null, slug: string | null, long: boolean) {
  const key = ticker ? `${ticker} ${slug ?? ""} ${long}` : "";
  const [held, setHeld] = useState<Held | null>(null);

  useEffect(() => {
    if (!ticker) return;
    const controller = new AbortController();
    const load = () =>
      plan.books(ticker, slug === null ? null : { slug, long }, controller.signal).then(
        (books) => setHeld({ key, books, error: null }),
        (err) => {
          if (!controller.signal.aborted) setHeld({ key, books: null, error: err instanceof PlanError && err.status === 429 ? err.message : NO_PRICE });
        },
      );
    load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [key, ticker, slug, long]);

  const current = held && held.key === key ? held : null;
  return { books: current?.books ?? null, error: current?.error ?? null, loading: key !== "" && current === null };
}

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

export function PlanView() {
  const business = useLocal<string>(KEYS.business, "");
  const origin = useOrigin();
  const now = useNow(30_000);

  const [pick, setPick] = useState<Choice | null>(null);
  const [chip, setChip] = useState<(typeof ITEMS)[number]>("Wings");
  const [item, setItem] = useState("Wings");
  const [priceText, setPriceText] = useState("8.00");
  // Most owners cover the menu price. One who would rather cover only what the item costs to make says so.
  const [ownCost, setOwnCost] = useState(false);
  const [costText, setCostText] = useState("3.00");
  const [customers, setCustomers] = useState(50);
  const [goodFor, setGoodFor] = useState<(typeof GOOD_FOR)[number]["key"]>("week");
  const [details, setDetails] = useState(false);

  const menuPrice = parseDollars(priceText);
  const each = ownCost ? parseDollars(costText) : menuPrice;
  const contracts = each === null ? 0 : contractsFor(each, customers);
  const payout = BigInt(contracts) * DOLLAR;

  const team = pick?.team ?? null;
  const { books, error, loading } = useBooks(team?.ticker ?? null, team?.polymarket?.slug ?? null, team?.polymarket?.long ?? false);
  const started = pick !== null && now > 0 && pick.game.startTime * 1000 <= now;
  const kalshi = books && contracts > 0 ? order(books.kalshi, contracts, books.fees.kalshi) : null;
  const other = books?.polymarket && contracts > 0 ? order(books.polymarket, contracts, books.fees.polymarket) : null;

  const days = GOOD_FOR.find((g) => g.key === goodFor)!.days;
  const until = pick && days > 0 ? endOfDay(pick.game.startTime, days) : 0;
  const words: VoucherWords | null = pick
    ? { business, item, value: menuPrice, team: pick.team.name, game: pick.game.game, startTime: pick.game.startTime, until }
    : null;
  // The printer's sheet is up to 500 vouchers, each with its own code: it follows the form a beat behind,
  // so typing a name does not redraw every one of them on every key.
  const sheet = useDeferredValue(words);
  const sheetCount = useDeferredValue(customers);

  const missing =
    pick === null ? "Pick a game and a team first." : item.trim() === "" ? "Say what's free." : business.trim() === "" ? "Add your place's name." : null;
  const canPrint = missing === null && !started && origin !== "";
  const barCost = kalshi !== null && kalshi.filled > 0 && !started && error === null ? kalshi.cost + kalshi.fee : null;

  return (
    <>
      <div className="no-print mx-auto w-full max-w-[1000px] flex-1 px-4 pb-28 md:pb-10">
        <header className="flex h-14 items-center justify-between">
          <Link href="/" className="text-[18px] font-semibold tracking-tight">
            FreeIf
          </Link>
          <span className="label">For bars and restaurants</span>
        </header>

        <div className="py-6">
          <h1 className="text-[28px] font-semibold leading-tight tracking-tight">Run a &ldquo;free if they win&rdquo; night</h1>
          <p className="mt-2 max-w-[640px] text-[16px] text-ink/60">
            Your customers get it free if the team wins. You cover it with one order in your own Kalshi account, so you know what the night costs
            before the game starts.
          </p>
        </div>

        <div className="md:grid md:grid-cols-[minmax(0,1fr)_380px] md:gap-10">
          <div className="space-y-8">
            {/* What is free and for how many come first: the price that a team brings up is then a price for something. */}
            <Step n={1} title="What's free">
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
                  <span className="label">Menu price</span>
                  <span className="relative block">
                    <span className="num pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink/60">$</span>
                    <Input className="num pl-7" inputMode="decimal" value={priceText} onChange={(e) => setPriceText(e.target.value)} />
                  </span>
                </label>
              </div>
              {menuPrice === null && <p className="text-[14px] text-stop">Enter the item&apos;s menu price, like 8.00.</p>}
              <label className="flex cursor-pointer items-start gap-3 text-[15px]">
                <input type="checkbox" className="mt-1 size-4 accent-ink" checked={ownCost} onChange={(e) => setOwnCost(e.target.checked)} />
                <span>
                  Cover only what one costs me to make
                  <span className="block text-[14px] text-ink/60">A smaller order. You get back your cost of the free items, not their menu price.</span>
                </span>
              </label>
              {ownCost && (
                <label className="block max-w-[160px] space-y-1">
                  <span className="label">Your cost of one</span>
                  <span className="relative block">
                    <span className="num pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink/60">$</span>
                    <Input className="num pl-7" inputMode="decimal" value={costText} onChange={(e) => setCostText(e.target.value)} />
                  </span>
                </label>
              )}
              {ownCost && each === null && <p className="text-[14px] text-stop">Enter what one costs you, like 3.00.</p>}
            </Step>

            <Step n={2} title="How many customers">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center rounded-[10px] border border-line bg-card">
                  <button
                    aria-label="Fewer customers"
                    className="grid size-12 place-items-center text-[20px] disabled:opacity-30"
                    disabled={customers <= 1}
                    onClick={() => setCustomers(Math.max(customers - 1, 1))}
                  >
                    −
                  </button>
                  <span className="num w-12 text-center text-[18px]" aria-live="polite">
                    {customers}
                  </span>
                  <button
                    aria-label="More customers"
                    className="grid size-12 place-items-center text-[20px] disabled:opacity-30"
                    disabled={customers >= MOST}
                    onClick={() => setCustomers(Math.min(customers + 1, MOST))}
                  >
                    +
                  </button>
                </div>
                {COUNTS.map((n) => (
                  <Button key={n} variant="chip" className="num" selected={customers === n} onClick={() => setCustomers(n)}>
                    {n}
                  </Button>
                ))}
              </div>
              <p className="text-[15px] text-ink/60">You print {customers === 1 ? "one voucher" : `${customers} vouchers`} and hand one to each customer. One per customer.</p>
            </Step>

            <Step n={3} title="Which game, which team">
              <p className="text-[15px] text-ink/60">
                {each === null
                  ? "Pick the team your customers win with."
                  : `Pick the team your customers win with. You'll see what it costs to cover ${freeOrders(customers)} at ${usd(each)} each.`}
              </p>
              <GameList picked={pick} onPick={setPick} />
            </Step>

            <Step n={4} title="Your place">
              <label className="block space-y-1">
                <span className="label">Name on the voucher</span>
                <Input maxLength={60} placeholder="Tony's Sports Bar" value={business} onChange={(e) => saveLocal(KEYS.business, e.target.value)} />
              </label>
              <div className="space-y-2">
                <span className="label">A winning voucher is good for</span>
                <div className="flex flex-wrap gap-2">
                  {GOOD_FOR.map((g) => (
                    <Button key={g.key} variant="chip" selected={goodFor === g.key} onClick={() => setGoodFor(g.key)}>
                      {g.label}
                    </Button>
                  ))}
                </div>
              </div>
            </Step>
          </div>

          {/* Taller than a small laptop's screen once there is an order: it scrolls inside itself, so Print is always in reach. */}
          <aside className="mt-8 space-y-6 md:sticky md:top-6 md:mt-0 md:max-h-[calc(100dvh-48px)] md:self-start md:overflow-y-auto md:pb-1 md:pr-1 [scrollbar-width:thin]">
            <section>
              <h2 className="label mb-2">What your customer gets</h2>
              {words ? (
                <VoucherSlip
                  {...words}
                  url={origin === "" ? "" : voucherUrl(origin, { ticker: pick!.team.ticker, item: item.trim(), business: business.trim(), number: 1, of: customers, until })}
                  number={1}
                  total={customers}
                />
              ) : (
                <p className="rounded-[10px] border border-dashed border-ink/30 bg-card p-4 text-[15px] text-ink/60">Pick a game and a team to see the voucher.</p>
              )}
            </section>

            <section id="order" className="scroll-mt-4">
              <h2 className="label mb-2">Your order</h2>
              <OrderCard
                pick={pick}
                started={started}
                loading={loading}
                error={error}
                kalshi={kalshi}
                other={other}
                customers={customers}
                each={each}
                ownCost={ownCost}
                item={item}
                payout={payout}
                onDetails={() => setDetails(true)}
              />
            </section>

            <div className="space-y-2">
              <Button variant="secondary" disabled={!canPrint} onClick={() => window.print()}>
                Print {customers === 1 ? "the voucher" : `${customers} vouchers`}
              </Button>
              {missing !== null && <p className="text-[14px] text-ink/60">{missing}</p>}
              {missing === null && <p className="text-[14px] text-ink/60">Eight to a page. Place your order first: the vouchers are your promise.</p>}
            </div>
          </aside>
        </div>

        <p className="mt-12 max-w-[640px] border-t border-line pt-6 text-[13px] text-ink/60">
          FreeIf works out the order and prints the vouchers. It does not place orders, hold money or give financial advice. You buy on Kalshi in your
          own account and you give the free item yourself. Prices move until your order is placed. Kalshi decides who can open an account and where
          its sports markets are offered.
        </p>
      </div>

      {/* On a phone the order is a long way below the games: the cost stays at the bottom of the screen. */}
      {barCost !== null && (
        <div className="no-print fixed inset-x-0 bottom-0 z-30 flex items-center justify-between gap-4 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur md:hidden">
          <span>
            <span className="label block">Your cost today</span>
            <span className="num text-[20px] font-semibold leading-6">{usd(barCost)}</span>
            {each !== null && (
              <span className="block text-[13px] leading-4 text-ink/60">
                {people(customers)} at <span className="num">{usd(each)}</span> each
              </span>
            )}
          </span>
          <a href="#order" className="inline-flex h-11 shrink-0 items-center justify-center rounded-[10px] bg-ink px-5 font-medium text-white">
            See your order
          </a>
        </div>
      )}

      {sheet && pick && <VoucherSheet {...sheet} ticker={pick.team.ticker} origin={origin} total={sheetCount} />}

      <Sheet open={details && kalshi !== null && pick !== null} onClose={() => setDetails(false)} title="How this is worked out">
        {kalshi && pick && books && (
          <Details kalshi={kalshi} other={other} books={books} team={pick.team.name} customers={customers} each={each} ownCost={ownCost} payout={payout} />
        )}
      </Sheet>
    </>
  );
}

type OrderCardProps = {
  pick: Choice | null;
  started: boolean;
  loading: boolean;
  error: string | null;
  kalshi: Order | null;
  other: Order | null;
  customers: number;
  each: bigint | null;
  ownCost: boolean;
  item: string;
  payout: bigint;
  onDetails: () => void;
};

function OrderCard({ pick, started, loading, error, kalshi, other, customers, each, ownCost, item, payout, onDetails }: OrderCardProps) {
  const box = "rounded-[10px] border border-line bg-card p-5";
  if (pick === null) return <p className={`${box} text-[15px] text-ink/60`}>Pick a game and a team to see what the night costs.</p>;
  if (started) return <p className={`${box} text-[15px]`}>This game has started. Pick another game.</p>;
  if (each === null) return <p className={`${box} text-[15px] text-ink/60`}>Enter a price to see what the night costs.</p>;
  if (loading) return <div className="h-[260px] animate-pulse rounded-[10px] border border-line bg-card" aria-label="Loading the price" />;
  if (error !== null || kalshi === null) return <p className={`${box} text-[15px]`}>{error ?? NO_PRICE}</p>;

  const team = pick.team.name;
  if (kalshi.filled <= 0 || kalshi.average === null || kalshi.limit === null) {
    return <p className={`${box} text-[15px]`}>Nobody is offering the {team} on Kalshi right now. Check again closer to the game, or pick the other team.</p>;
  }

  const total = kalshi.cost + kalshi.fee;
  const whole = kalshi.filled >= kalshi.wanted;
  const paid = whole ? payout : BigInt(Math.floor(kalshi.filled)) * DOLLAR;
  const thing = item.trim().toLowerCase() || "free items";
  // What the offers on the book stretch to, when they do not cover the whole night.
  const stretch = whole ? customers : Math.floor((kalshi.filled * 1_000_000) / Number(each));
  const otherTotal = other && other.filled >= other.wanted ? other.cost + other.fee : null;

  return (
    <div className="overflow-hidden rounded-[10px] border border-line bg-card">
      <div className="px-5 pt-4">
        <div className="flex items-baseline justify-between gap-4">
          <span className="label">Your cost today</span>
          <span className="num text-[28px] font-semibold leading-8">{usd(total)}</span>
        </div>
        {/* What the money is for, before how it is spent. */}
        <p className="mt-1 text-[15px]">
          {ownCost ? "To cover your cost of " : "To cover "}
          {freeOrders(customers)} of {thing}
          {ownCost ? ", " : " at "}
          <span className="num">{usd(each)}</span> each{ownCost ? "," : ""} if the {team} win.
        </p>
        <dl className="mt-3 space-y-1 text-[14px] text-ink/60">
          <div className="flex justify-between gap-4">
            <dt>
              <span className="num">{amountOf(kalshi.filled)}</span> contracts at about <span className="num">{cents(kalshi.average)}</span>
            </dt>
            <dd className="num">{usd(kalshi.cost)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>Kalshi&apos;s fee</dt>
            <dd className="num">{usd(kalshi.fee)}</dd>
          </div>
        </dl>

        <div className="mt-4 space-y-1.5 border-t border-dashed border-line pt-4 text-[15px]">
          <p>
            <span className="font-medium">If the {team} win,</span> Kalshi pays you <span className="num">{usd(paid)}</span>
            .
            {whole && (
              <>
                {" "}
                That covers <span className="num">{customers}</span> × <span className="num">{usd(each)}</span>.
              </>
            )}
          </p>
          <p>
            <span className="font-medium">If they lose,</span> nothing comes back and you give nothing away.
          </p>
          <p className="text-ink/60">
            Either way the night costs you <span className="num">{usd(total)}</span>.
          </p>
        </div>

        {!whole && (
          <p className="mt-4 rounded-[10px] border border-stop/30 bg-stop-tint px-3 py-2 text-[14px]" role="status">
            Kalshi has <span className="num">{amountOf(kalshi.filled)}</span> contracts on offer for the {team} right now, enough for about{" "}
            {people(Math.max(stretch, 0))}. You asked for <span className="num">{amountOf(kalshi.wanted)}</span>. More is offered closer to the game.
          </p>
        )}
        {whole && !fillsCleanly(kalshi) && kalshi.best !== null && (
          <p className="mt-4 rounded-[10px] border border-line bg-paper px-3 py-2 text-[14px]" role="status">
            This is more than what is offered at the best price. The order takes offers from <span className="num">{cents(kalshi.best)}</span> up to{" "}
            <span className="num">{cents(kalshi.limit)}</span>. More is offered closer to the game.
          </p>
        )}
      </div>

      {/* The perforation, as on the ticket. Below it: what to type into Kalshi. */}
      <div className="relative my-4 h-[18px]">
        <span className="absolute -left-[10px] top-0 size-[18px] rounded-full border border-line bg-paper" />
        <span className="absolute -right-[10px] top-0 size-[18px] rounded-full border border-line bg-paper" />
        <span className="absolute left-4 right-4 top-1/2 border-t border-dashed border-line" />
      </div>

      <div className="space-y-3 px-5 pb-5">
        <h3 className="label">Place this order on Kalshi</h3>
        <dl className="space-y-1.5">
          <Row label="Game">
            {pick.game.game} <span className="num text-ink/60">· {dayTime(pick.game.startTime)}</span>
          </Row>
          <Row label="Buy">The {team} to win</Row>
          <Row label="Contracts">
            <span className="num">{amountOf(Math.floor(kalshi.filled))}</span>
          </Row>
          <Row label="Limit price">
            <span className="num">{cents(kalshi.limit)}</span>
          </Row>
        </dl>
        <a
          href={kalshiPage(pick.game.id)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-12 w-full items-center justify-center rounded-[10px] bg-ink px-5 font-medium text-white hover:bg-ink/85"
        >
          Open this game on Kalshi
        </a>
        <p className="text-[14px] text-ink/60">
          You place the order yourself, in your own Kalshi account, with about <span className="num">{usd(total)}</span> in it.
        </p>
        {otherTotal !== null && pick.team.polymarket && (
          <p className="text-[14px] text-ink/60">
            The same order on Polymarket US is about <span className="num">{usd(otherTotal)}</span>.{" "}
            <a className="underline underline-offset-2" href={polymarketPage(pick.team.polymarket.event)} target="_blank" rel="noopener noreferrer">
              See it there
            </a>
          </p>
        )}
        <button className="text-[14px] underline underline-offset-2" onClick={onDetails}>
          How this is worked out
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-4">
      <dt className="label w-[92px] shrink-0">{label}</dt>
      <dd className="min-w-0 text-[15px]">{children}</dd>
    </div>
  );
}

type DetailsProps = {
  kalshi: Order;
  other: Order | null;
  books: BooksReply;
  team: string;
  customers: number;
  each: bigint | null;
  ownCost: boolean;
  payout: bigint;
};

/** The sum behind the order card: the size, the offers it takes, and the fee. */
function Details({ kalshi, other, books, team, customers, each, ownCost, payout }: DetailsProps) {
  const rate = (r: number) => `${Math.round(r * 10_000) / 100}%`;
  return (
    <div className="space-y-5 text-[15px]">
      <section className="space-y-1">
        <h3 className="label">The size</h3>
        <p>
          {people(customers)} at <span className="num">{usd(each)}</span> each{ownCost ? " (your cost)" : ""} is <span className="num">{usd(payout)}</span> to
          give away if the {team} win. One contract pays <span className="num">$1.00</span> if they win, so the order is{" "}
          <span className="num">{amountOf(kalshi.wanted)}</span> contracts.
        </p>
      </section>

      <section className="space-y-1">
        <h3 className="label">The offers it takes on Kalshi</h3>
        <ul className="num text-[14px]">
          {kalshi.steps.map((step) => (
            <li key={step.price} className="flex justify-between gap-4">
              <span>
                {amountOf(step.size)} at {cents(step.price)}
              </span>
              <span>{usd(BigInt(Math.round(step.size * step.price * 1_000_000)))}</span>
            </li>
          ))}
        </ul>
        <p className="text-[14px] text-ink/60">
          The cheapest offers first. The limit price is the dearest one the order needs. Set it and the order pays no more than that for any contract.
        </p>
      </section>

      <section className="space-y-1">
        <h3 className="label">The fee</h3>
        <p>
          Kalshi charges <span className="num">{rate(books.fees.kalshi)}</span> of contracts × price × (1 − price), rounded up to a cent:{" "}
          <span className="num">{usd(kalshi.fee)}</span> here. It charges nothing when the game is settled.
        </p>
      </section>

      {other && other.filled >= other.wanted && (
        <section className="space-y-1">
          <h3 className="label">Polymarket US</h3>
          <p>
            The same <span className="num">{amountOf(other.wanted)}</span> contracts there cost <span className="num">{usd(other.cost)}</span> and a fee of{" "}
            <span className="num">{usd(other.fee)}</span> (<span className="num">{rate(books.fees.polymarket)}</span> on the same sum, in its app).
          </p>
        </section>
      )}

      <p className="text-[13px] text-ink/60">
        Read from each exchange&apos;s public order book at <span className="num">{timeOf(Math.floor(books.at / 1000))}</span>, and again every 15 seconds. Prices
        move until your order is placed.
      </p>
    </div>
  );
}
