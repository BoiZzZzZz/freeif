// The keeper's API as the browser uses it. Shapes follow keeper/README.md and keeper/src/server.ts:
// amounts are USDC base units as decimal strings, times are unix seconds.
import { KEEPER_URL } from "./config";

export type League = { key: string; name: string };

export type GameTeam = {
  instrumentSymbol: string;
  /** "Heat". */
  team: string;
  /** "the Heat win": what follows "free if". */
  condition: string;
  /** 0.39 is 39%. Null when Gemini shows no price. */
  chance: number | null;
  /** False when a promo on this team would be refused. */
  quotable: boolean;
};

/**
 * A game with its two teams. The temperature markets of hedge mode come in the same shape: `game` is
 * "Austin high on November 14", `startTime` is when that day begins, and each "team" is a range.
 */
export type Game = { eventTicker: string; game: string; startTime: number; teams: GameTeam[]; city?: string; day?: string };

export type GamesReply = { leagues?: League[]; league: string; games: Game[]; fetchedAt: number };

/** The words for the card, built by the keeper from Gemini's teams. */
export type Display = {
  game: string;
  team: string;
  /** "the Heat", or "" when the event is not a game. */
  subject: string;
  condition: string;
  league: string | null;
  startTime: number | null;
};

export type PriceRequest = {
  eventTicker: string;
  instrumentSymbol: string;
  /** Base units paid to each customer. */
  payoutPerClaim: string;
  maxClaims: number;
  claimDeadline: "start" | "30min";
};

export type Price = {
  eventTicker: string;
  eventId: string;
  eventTitle: string;
  instrumentSymbol: string;
  contractLabel: string;
  display: Display;
  rule: string;
  claimDeadline: number;
  marketCloseTime: number;
  breakdown: { chance: number; mostOwed: string; expectedLoss: string; fee: string; cost: string };
  maxCustomers: number;
  /** The most one promo on this result could pay in all right now, in base units. */
  maxPayout?: string;
  limit: "ok" | "exposure" | "ceiling" | "too-likely";
  mechanics: {
    bestAsk: string | null;
    bestBid: string | null;
    lastTradePrice: string | null;
    askFetchedAt: number;
    /** The spread this price carries: the usual one, the wider one of a thin book, or a mix when the offers cover part of the payout. */
    spreadBps: number;
    /** True when the book is not a market (a side is missing, or its sides are far apart). */
    thin?: boolean;
    /** How much of the payout Gemini's offers cover, in base units. */
    covered?: string;
    /** The cheapest offers on Gemini's book, each `[price, contracts]`. One contract pays $1. */
    offers?: [string, string][];
    loading: string;
    utilizationBps: number;
    maxLockedBps: number;
    pricer: string;
    vault: string;
    quoteTtlSeconds: number;
  };
};

/** The quote as `createPromoWithPermit` takes it, with the three big numbers as strings. */
export type QuoteJson = {
  merchant: `0x${string}`;
  claimSigner: `0x${string}`;
  geminiEventId: `0x${string}`;
  instrumentSymbol: `0x${string}`;
  payoutPerClaim: string;
  maxClaims: number;
  premium: string;
  claimDeadline: number;
  marketCloseTime: number;
  hedgeMode: boolean;
  expiry: number;
  nonce: `0x${string}`;
};

export type Quoted = Price & { quote: QuoteJson; signature: `0x${string}` };

export type PromoStatus = "Open" | "Settled" | "FinalizedYes" | "FinalizedNo" | "Vetoed" | "PaidOut" | "Voided";

/**
 * One event on the vault, as the keeper has it. `via` says how it reached the keeper: "stream" is a
 * delivery from the QuickNode Stream, "rpc" is the keeper's own read of the chain.
 */
export type FeedEvent = {
  id: string;
  event:
    | "PromoCreated"
    | "ClaimRegistered"
    | "Settled"
    | "Vetoed"
    | "SettlementReset"
    | "Finalized"
    | "Voided"
    | "Paid"
    | "PayoutFailed"
    | "Deposited"
    | "Withdrawn";
  promoId: string | null;
  block: number;
  logIndex: number;
  /** The transaction's hash. */
  hash: string;
  /** The block's time, unix seconds. */
  at: number;
  via: "stream" | "rpc";
  /** When the keeper had it, unix milliseconds. */
  seenAt: number;
  customer?: string;
  merchant?: string;
  /** The liquidity provider, on a deposit or a withdrawal. */
  lp?: string;
  /** Base units: the cost, the payout, the refund, the deposit, by event. */
  amount?: string;
  shares?: string;
  claimCount?: number;
  outcomeYes?: boolean;
};

/**
 * A promo's hedge. "sandbox" is an order the keeper placed on Gemini's sandbox exchange; "simulated" is
 * the order it would place, for a contract the sandbox does not list.
 */
export type Hedge = {
  kind: "sandbox" | "simulated";
  /** The contract's instrument symbol. */
  symbol: string;
  /** Contracts to buy: one pays $1 on a "yes", so it is the promo's full payout in dollars. */
  quantity: string;
  /** The limit price, as Gemini writes prices: "0.43". */
  price: string;
  at: number;
  orderId?: string;
  /** "open" while it rests; "cancelled" or "closed" once the promo is over. */
  status?: string;
  reason?: string;
  closedAt?: number;
};

export type Promo = {
  promoId: string;
  status: PromoStatus;
  merchant: string;
  eventId: string | null;
  eventTicker: string | null;
  eventTitle: string | null;
  instrumentSymbol: string | null;
  contractLabel: string | null;
  game: string | null;
  league: string | null;
  eventStartTime: number | null;
  team: string | null;
  subject: string | null;
  condition: string | null;
  rule: string | null;
  item: string | null;
  business: string | null;
  payoutPerClaim: string;
  maxClaims: number;
  claimCount: number;
  paidCount: number;
  premiumPaid: string;
  collateralLocked: string;
  claimDeadline: number;
  marketCloseTime: number;
  settledAt: number;
  outcomeYes: boolean;
  hedgeMode: boolean;
  /** The promo's hedge. Null until the keeper has made it. */
  hedge?: Hedge | null;
  /** The promo's events on the vault, oldest first. */
  events: FeedEvent[];
  /** The QuickNode Stream's record: deliveries so far, and when the last one came (unix seconds). */
  stream: { deliveries: number; lastDeliveryAt: number | null };
  customer: { address: string; number: number | null; paid: boolean; owed: string } | null;
};

/**
 * One reading of a result's price on Gemini: unix seconds, the chance of "yes", the best bid and the best
 * ask. The three prices are basis points of a dollar: 4100 is 0.41, a 41% chance.
 */
export type OddsPoint = [t: number, chance: number, bid: number | null, ask: number | null];

/** How a promo's chance has moved since it started (`GET /promos/:id/odds`). */
export type Odds = {
  promoId: string;
  /** How often the keeper takes a reading. */
  everySeconds: number;
  /** The reading the promo was priced on, at the time it started. Null on a promo from before readings were kept. */
  start: OddsPoint | null;
  /** The readings the keeper kept, oldest first. */
  points: OddsPoint[];
  /** The newest reading. */
  latest: OddsPoint | null;
};

/** One promo as the vault's books have it (`GET /vault`). */
export type VaultPromo = {
  promoId: string;
  status: PromoStatus;
  item: string | null;
  business: string | null;
  game: string | null;
  condition: string | null;
  premium: string;
  /** The most it can pay: what was locked when it was made. */
  maxPayout: string;
  /** What it still locks now. */
  locked: string;
  payoutPerClaim: string;
  claimCount: number;
  maxClaims: number;
  claimDeadline: number;
  marketCloseTime: number;
  settledAt: number;
  outcomeYes: boolean;
  /** True for a promo that pays the business itself. */
  hedgeMode?: boolean;
  /** What the vault made on it: the premium less what its customers get. Null until it has a final result. */
  net: string | null;
  /** The promo's hedge. Null when it has none. */
  hedge?: Hedge | null;
  /** The chance of "yes" at the keeper's newest reading (0.41 is 41%). Null once the promo has a result, or with no reading. */
  chance: number | null;
};

/** The vault as a liquidity provider reads it. Amounts are USDC base units; shares have six decimals too. */
export type Vault = {
  vault: `0x${string}`;
  usdc: `0x${string}`;
  block: number;
  balance: string;
  locked: string;
  /** The part of `locked` held by promos with no final result. */
  pending: string;
  owed: string;
  /** `balance - locked`: what a withdrawal is priced on. */
  free: string;
  /** `free + pending`: what a deposit is priced on. */
  depositBasis: string;
  totalShares: string;
  maxExposureBps: number;
  maxLockedBps: number;
  paused: boolean;
  /** Seconds between a result being posted and it becoming final. */
  disputeWindow: number;
  netEarned: string;
  promos: VaultPromo[];
  /** The newest events on the vault, oldest first. */
  events: FeedEvent[];
};

export type ClaimResult = {
  promoId: string;
  customer: string;
  alreadyRegistered: boolean;
  claimCount: number | null;
  txHash: string | null;
};

/** A refusal from the keeper. `message` is written for the person using the page. */
export class KeeperError extends Error {
  code: string;
  status: number;
  maxCustomers?: number;
  constructor(status: number, code: string, message: string, maxCustomers?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.maxCustomers = maxCustomers;
  }
}

/** The keeper could not be reached, or answered with something that is not its own refusal. */
export const isOutage = (err: unknown): boolean => !(err instanceof KeeperError) || err.status === 0 || err.status >= 500;

const UNREACHABLE = "We can't reach FreeIf right now. Try again in a moment.";

async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${KEEPER_URL}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      cache: "no-store",
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new KeeperError(0, "unreachable", UNREACHABLE);
  }
  const json = (await res.json().catch(() => null)) as
    | (T & { error?: { code: string; message: string; maxCustomers?: number } })
    | null;
  if (!res.ok || json === null || json.error) {
    const error = json?.error;
    throw new KeeperError(res.status, error?.code ?? "internal", error?.message ?? UNREACHABLE, error?.maxCustomers);
  }
  return json;
}

const query = (req: PriceRequest): string =>
  new URLSearchParams({
    eventTicker: req.eventTicker,
    instrumentSymbol: req.instrumentSymbol,
    payoutPerClaim: req.payoutPerClaim,
    maxClaims: String(req.maxClaims),
    claimDeadline: req.claimDeadline,
  }).toString();

export const keeper = {
  games: (league?: string, signal?: AbortSignal) =>
    call<GamesReply>(`/games${league ? `?league=${encodeURIComponent(league)}` : ""}`, undefined, signal),

  /** The price of a promo, unsigned. Needs no login. */
  price: (req: PriceRequest, signal?: AbortSignal) => call<Price>(`/price?${query(req)}`, undefined, signal),

  /** Hedge mode's list: daily temperature markets whose day has not begun, in the shape of the games. */
  weather: (signal?: AbortSignal) => call<GamesReply>("/weather", undefined, signal),

  /** A signed quote, good for 90 seconds, for this merchant only. `hedgeMode` pays the merchant itself. */
  quote: (req: PriceRequest & { merchant: string; item: string; business: string; hedgeMode?: boolean }) => call<Quoted>("/quote", req),

  /** Covers `customer` on a promo. `userToken` is the login: the keeper asks Circle whose it is. */
  claim: (req: { promoId: string; customer: string; userToken: string }) => call<ClaimResult>("/claims", req),

  /** The vault's books, every promo, and the newest events: the page for liquidity providers. */
  vault: (signal?: AbortSignal) => call<Vault>("/vault", undefined, signal),

  /** A promo's readings. With `after`, only the ones later than that time. */
  odds: (id: string, after = 0, signal?: AbortSignal) =>
    call<Odds>(`/promos/${encodeURIComponent(id)}/odds${after > 0 ? `?after=${after}` : ""}`, undefined, signal),

  promo: (id: string, customer?: string | null, signal?: AbortSignal) =>
    call<Promo>(`/promos/${encodeURIComponent(id)}${customer ? `?customer=${customer}` : ""}`, undefined, signal),
};
