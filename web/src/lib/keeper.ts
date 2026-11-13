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

export type Game = { eventTicker: string; game: string; startTime: number; teams: GameTeam[] };

export type GamesReply = { leagues: League[]; league: string; games: Game[]; fetchedAt: number };

/** One window of a 5-minute crypto market, from the keeper's test-loop helper. */
export type IntervalWindow = {
  eventTicker: string;
  eventTitle: string;
  instrumentSymbol: string;
  /** Unix seconds. */
  closeTime: number;
  bestAsk: string | null;
  quotable: boolean;
};

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
  limit: "ok" | "exposure" | "ceiling" | "too-likely";
  mechanics: {
    bestAsk: string | null;
    bestBid: string | null;
    lastTradePrice: string | null;
    askFetchedAt: number;
    spreadBps: number;
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
  /** Base units: the cost, the payout, the refund, by event. */
  amount?: string;
  claimCount?: number;
  outcomeYes?: boolean;
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
  /** The promo's events on the vault, oldest first. */
  events: FeedEvent[];
  /** The QuickNode Stream's record: deliveries so far, and when the last one came (unix seconds). */
  stream: { deliveries: number; lastDeliveryAt: number | null };
  customer: { address: string; number: number | null; paid: boolean; owed: string } | null;
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

  /** The next 5-minute BTC windows: the test loop, never offered to a merchant. */
  intervals: (signal?: AbortSignal) => call<{ windows: IntervalWindow[] }>("/intervals?series=BTC05M", undefined, signal),

  /** The price of a promo, unsigned. Needs no login. */
  price: (req: PriceRequest, signal?: AbortSignal) => call<Price>(`/price?${query(req)}`, undefined, signal),

  /** A signed quote, good for 90 seconds, for this merchant only. */
  quote: (req: PriceRequest & { merchant: string; item: string; business: string }) => call<Quoted>("/quote", req),

  /** Covers `customer` on a promo. `userToken` is the login: the keeper asks Circle whose it is. */
  claim: (req: { promoId: string; customer: string; userToken: string }) => call<ClaimResult>("/claims", req),

  promo: (id: string, customer?: string | null, signal?: AbortSignal) =>
    call<Promo>(`/promos/${encodeURIComponent(id)}${customer ? `?customer=${customer}` : ""}`, undefined, signal),
};
