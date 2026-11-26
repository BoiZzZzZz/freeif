// A promo night the bar covers itself: the bar buys the cover with one order in its own exchange account,
// and this app only does the sizing and the vouchers. No vault, no keys, no order placed by us.
//
// This file is the shared part: the shapes the page and its routes pass around, and the arithmetic, as
// pure functions. Dollar amounts are base units (6 decimals) like everywhere else in the app, so `usd()`
// formats them; a price is dollars per contract (0.61), and a contract pays $1.00 if the team wins.

export type League = { key: string; name: string };

/** One offer on an exchange's book: `size` contracts at `price` dollars each. */
export type Level = { price: number; size: number };

/** One team's side of a game on one exchange: the best bid, and every offer from the cheapest up. */
export type Book = { bid: number | null; asks: Level[] };

/**
 * Where the same team trades on Polymarket US: one market per game, the away team its "long" side.
 * `event` names the game's page on its site.
 */
export type PolymarketSide = { slug: string; long: boolean; event: string };

/** A game's own page on each exchange's site. Both were opened and land on the game (Nov 25 2026). */
export const kalshiPage = (eventTicker: string): string => `https://kalshi.com/events/${eventTicker}`;
export const polymarketPage = (event: string): string => `https://polymarket.us/event/${event}`;

export type PlanTeam = {
  /** "Knicks": the word for the voucher and the page. */
  name: string;
  home: boolean;
  /** Kalshi's market for this team winning. */
  ticker: string;
  /** What Kalshi's own screen calls the team: "New York". */
  kalshiName: string;
  /** Kalshi's best offer and best bid in dollars, null when there is none. */
  ask: number | null;
  bid: number | null;
  polymarket: PolymarketSide | null;
};

export type PlanGame = {
  /** Kalshi's event ticker. */
  id: string;
  /** "Heat at Knicks". */
  game: string;
  /** What Kalshi's own screen calls the game: "Miami vs New York". */
  kalshiTitle: string;
  /** Unix seconds. */
  startTime: number;
  /** Away first, then home. */
  teams: PlanTeam[];
};

export type GamesReply = { league: string; leagues: League[]; games: PlanGame[] };

export type BooksReply = {
  kalshi: Book;
  /** Null when the game was not found on Polymarket US or its book did not answer. */
  polymarket: Book | null;
  /** The taker fee rate on each exchange: the fee is `rate x contracts x price x (1 - price)`. */
  fees: { kalshi: number; polymarket: number };
  /** When the books were read, unix milliseconds. */
  at: number;
};

/** What a voucher's page needs: the words, and the result once the exchange has one. */
export type VoucherMarket = {
  ticker: string;
  /** "Knicks". */
  team: string;
  /** "Heat at Knicks". */
  game: string;
  /** Unix seconds, null when the exchange no longer says. */
  startTime: number | null;
  /** True once the exchange has a result for the game. */
  final: boolean;
  /** True when the team won. Meaningful only when `final`. */
  won: boolean;
};

const BASE = 1_000_000;
const CENT = 10_000n;

/** A whole promo in contracts: one per dollar the bar gives away if the team wins. Rounded up. */
export function contractsFor(valueEach: bigint, customers: number): number {
  if (valueEach <= 0n || customers <= 0) return 0;
  const total = valueEach * BigInt(customers);
  return Number((total + BigInt(BASE) - 1n) / BigInt(BASE));
}

export type Order = {
  /** Contracts the promo needs. */
  wanted: number;
  /** Contracts the book offers, at any price. Less than `wanted` when the book is too thin. */
  filled: number;
  /** What the filled contracts cost, before the fee. */
  cost: bigint;
  /** The exchange's fee on them. */
  fee: bigint;
  /** The cheapest offer, the average paid, and the dearest offer taken (the limit price to set). */
  best: number | null;
  average: number | null;
  limit: number | null;
  /** The offers taken, cheapest first, each with the amount taken from it. */
  steps: Level[];
};

/**
 * Buys `contracts` from a book's offers, cheapest first. `feeRate` is the exchange's taker rate; the fee
 * on each fill is `rate x contracts x price x (1 - price)`, and the total is rounded up to a cent, as
 * Kalshi's fee schedule does it.
 */
export function order(book: Book, contracts: number, feeRate: number): Order {
  const steps: Level[] = [];
  let left = contracts;
  let cost = 0;
  let fee = 0;
  for (const level of book.asks) {
    if (left <= 0) break;
    if (!(level.size > 0) || !(level.price > 0) || level.price >= 1) continue;
    const take = Math.min(left, level.size);
    steps.push({ price: level.price, size: take });
    cost += take * level.price;
    fee += feeRate * take * level.price * (1 - level.price);
    left -= take;
  }
  const filled = contracts - Math.max(left, 0);
  return {
    wanted: contracts,
    filled,
    cost: upToCent(cost),
    fee: upToCent(fee),
    best: steps[0]?.price ?? null,
    average: filled > 0 ? cost / filled : null,
    limit: steps[steps.length - 1]?.price ?? null,
    steps,
  };
}

/** Dollars as base units, rounded up to a whole cent (a hair under a cent's edge counts as on it). */
function upToCent(dollars: number): bigint {
  const base = BigInt(Math.round(dollars * BASE));
  return ((base + CENT - 1n) / CENT) * CENT;
}

/** True when the whole order is offered, and within `maxSlip` dollars of the cheapest offer. */
export function fillsCleanly(o: Order, maxSlip = 0.05): boolean {
  return o.filled >= o.wanted && o.best !== null && o.limit !== null && o.limit - o.best <= maxSlip + 1e-9;
}

/** 0.61 -> "61¢"; 0.5225 -> "52.25¢". */
export function cents(price: number): string {
  const c = Math.round(price * 10_000) / 100;
  return `${Number.isInteger(c) ? c : c.toFixed(2).replace(/0$/, "")}¢`;
}

/** 1234.5 -> "1,234.5"; whole numbers stay whole. */
export function count(contracts: number): string {
  return (Math.floor(contracts * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** The address a voucher's code opens: everything the voucher says, and the market that decides it. */
export type Voucher = {
  ticker: string;
  item: string;
  business: string;
  number: number;
  of: number;
  /** The last moment the voucher is good, unix seconds; 0 when the bar set no end. */
  until: number;
};

export function voucherUrl(origin: string, v: Voucher): string {
  const q = new URLSearchParams({ t: v.ticker, i: v.item, b: v.business, n: String(v.number), of: String(v.of) });
  if (v.until > 0) q.set("u", String(v.until));
  return `${origin}/voucher?${q}`;
}

/** Kalshi's market for one team winning one game, in the three leagues the page offers. */
export const TICKER = /^KX(NBA|NHL|NFL)GAME-[0-9A-Z]{6,24}-[0-9A-Z]{2,6}$/;

export function readVoucher(q: Record<string, string | string[] | undefined>): Voucher | null {
  const one = (name: string): string => {
    const value = q[name];
    return (Array.isArray(value) ? value[0] : value) ?? "";
  };
  const ticker = one("t");
  if (!TICKER.test(ticker)) return null;
  const whole = (name: string): number => {
    const n = Number(one(name));
    return Number.isInteger(n) && n >= 0 ? n : 0;
  };
  return {
    ticker,
    item: one("i").slice(0, 40),
    business: one("b").slice(0, 60),
    number: whole("n"),
    of: whole("of"),
    until: whole("u"),
  };
}
