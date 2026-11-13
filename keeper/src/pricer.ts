// The pricing service (SPEC section 2): reads Gemini's ask and the vault, prices a promo, and signs the
// EIP-712 quote that `createPromo` checks.
import { randomBytes } from "node:crypto";
import { erc20Abi, keccak256, toBytes, toHex, type Address, type Hex, type PrivateKeyAccount } from "viem";
import { promoVaultAbi } from "./abi.ts";
import { quoteDomain, quoteToJson, quoteTypes, type PublicClient, type Quote } from "./chain.ts";
import {
  contractsToUnits,
  eventStart,
  getDepth,
  getEvent,
  isIntervalMarket,
  priceToBps,
  ruleText,
  toUnix,
  type Depth,
  type GeminiContract,
  type GeminiEvent,
} from "./gemini.ts";
import { pendingLabel, prunePending, type Label } from "./labels.ts";
import { displayNames } from "./names.ts";
import { keepPending } from "./odds.ts";
import {
  CENT,
  checkLimits,
  largest,
  price,
  readingFor,
  type DeepBook,
  type Limit,
  type Price,
  type PricingParams,
  type Reading,
  type VaultState,
} from "./pricing.ts";
import type { Store } from "./store.ts";

export type PriceRequest = {
  /** Gemini's full event ticker, e.g. `NFL-2610251700-IND-MIN-M`. */
  eventTicker: string;
  /** The contract inside that event, e.g. `GEMI-NFL-2610251700-IND-MIN-M-MIN`. */
  instrumentSymbol: string;
  /** USDC base units paid to each customer on a "yes". */
  payoutPerClaim: bigint;
  maxClaims: number;
  /** When the promo stops taking customers: at the start (default), 30 minutes before, or a unix time. */
  claimDeadline?: "start" | "30min" | number;
};

export type QuoteRequest = PriceRequest & {
  merchant: Address;
  hedgeMode?: boolean;
  /** What is free and the shop's name, for the promo's card. Kept with the quote. */
  label?: Label;
};

export type RefusalCode =
  | "bad-request"
  | "unknown-event"
  | "unknown-contract"
  | "market-closed"
  | "no-price"
  | "event-started"
  | "deadline-too-late"
  | "too-close"
  | "vault-paused"
  | "too-likely"
  | "over-capacity";

/** A price or a quote the service will not give. `message` is written for the merchant's form. */
export class Refusal extends Error {
  code: RefusalCode;
  maxCustomers?: number;
  /** With "over-capacity" in hedge mode: the most the vault could pay on this result, in base units. */
  maxPayout?: bigint;
  constructor(code: RefusalCode, message: string, maxCustomers?: number, maxPayout?: bigint) {
    super(message);
    this.code = code;
    this.maxCustomers = maxCustomers;
    this.maxPayout = maxPayout;
  }
}

/** 12010000 -> "$12.01". */
const dollars = (units: bigint): string => `$${units / 1_000_000n}.${((units % 1_000_000n) / CENT).toString().padStart(2, "0")}`;

type Timing = { quoteTtlSeconds: number; intervalCutoffSeconds: number; minClaimWindowSeconds: number };

type Deps = {
  client: PublicClient;
  vault: Address;
  usdc: Address;
  /** The pricer key. Its address must be `vault.pricer()`. */
  account: PrivateKeyAccount;
  /** The relayer address: every quote names it as the promo's claim signer (F17). */
  claimSigner: Address;
  params: PricingParams;
  timing: Timing;
  store: Store;
  /** Unix seconds. Replaceable in tests. */
  now?: () => number;
  /** Replaceable in tests. */
  fetchEvent?: (ticker: string) => Promise<GeminiEvent | null>;
  /** The contract's book with every offer on it. Replaceable in tests. */
  fetchDepth?: (symbol: string) => Promise<Depth | null>;
};

/** The search for the most one promo could pay stops at ten million dollars. */
const MOST_CENTS = 1_000_000_000;

/** Gemini's book in the pricing math's units. The last trade comes from the event: the book route has none. */
function bookOf(depth: Depth | null, contract: GeminiContract): DeepBook {
  return {
    bid: priceToBps(depth?.bid ?? undefined),
    asks: (depth?.asks ?? []).flatMap((offer) => {
      const priceBps = priceToBps(offer.price);
      const size = contractsToUnits(offer.amount);
      return priceBps !== null && size !== null && size > 0n ? [{ priceBps, size }] : [];
    }),
    last: priceToBps(contract.prices?.lastTradePrice),
  };
}

type Prepared = {
  event: GeminiEvent;
  contract: GeminiContract;
  /** The book the price is made on: Gemini's best bid and every offer. */
  depth: Depth | null;
  book: DeepBook;
  /** The chance and the spread for a promo of this size, and how much of it the offers cover. */
  reading: Reading;
  fetchedAt: number;
  claimDeadline: number;
  marketCloseTime: number;
  vault: VaultState;
  price: Price;
  limit: Limit;
  maxCustomers: number;
  /** The most one promo on this result could pay right now, whatever it pays each customer. */
  maxPayout: bigint;
};

export class Pricer {
  readonly #d: Deps;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: Deps) {
    this.#d = deps;
  }

  get address(): Address {
    return this.#d.account.address;
  }

  #now(): number {
    return this.#d.now ? this.#d.now() : Math.floor(Date.now() / 1000);
  }

  /** The price of a promo, unsigned. Works without a merchant, so the form can show it before login. */
  async getPrice(req: PriceRequest) {
    return this.#toJson(await this.#prepare(req));
  }

  /** A signed quote the merchant can pass to `createPromo`. Refuses a promo the vault cannot take. */
  async signQuote(req: QuoteRequest) {
    // One at a time: two quotes priced against the same vault state could each fit and together not.
    const run = this.#queue.then(() => this.#sign(req));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #sign(req: QuoteRequest) {
    const hedgeMode = req.hedgeMode ?? false;
    if (hedgeMode && req.maxClaims !== 1) throw new Refusal("bad-request", "A hedge covers exactly one payout.");

    const p = await this.#prepare(req);
    if (p.limit === "too-likely") {
      throw new Refusal("too-likely", "This result is too likely to offer as a promotion.");
    }
    if (p.limit !== "ok" && hedgeMode) {
      // One payout to the business itself: what the vault can cover is an amount, not a head count.
      const message = p.maxPayout > 0n ? `We can cover up to ${dollars(p.maxPayout)} on this right now.` : "We cannot cover this right now.";
      throw new Refusal("over-capacity", message, p.maxCustomers, p.maxPayout);
    }
    if (p.limit !== "ok") {
      const n = p.maxCustomers;
      const message =
        n > 0
          ? `We can cover up to ${n} customer${n === 1 ? "" : "s"} on this game right now.`
          : "We cannot cover this game right now.";
      throw new Refusal("over-capacity", message, n);
    }

    const quote: Quote = {
      merchant: req.merchant,
      claimSigner: this.#d.claimSigner,
      // The contract's `settle` hashes the plain event id and compares it with this, so the keeper must
      // pass the same string later: Gemini's event id, e.g. "455065".
      geminiEventId: keccak256(toBytes(p.event.id)),
      instrumentSymbol: keccak256(toBytes(p.contract.instrumentSymbol)),
      payoutPerClaim: req.payoutPerClaim,
      maxClaims: req.maxClaims,
      premium: p.price.premium,
      claimDeadline: BigInt(p.claimDeadline),
      marketCloseTime: BigInt(p.marketCloseTime),
      hedgeMode,
      expiry: BigInt(this.#now() + this.#d.timing.quoteTtlSeconds),
      nonce: toHex(randomBytes(32)),
    };
    const signature = await this.#d.account.signTypedData({
      domain: quoteDomain(this.#d.vault),
      types: quoteTypes,
      primaryType: "Quote",
      message: quote,
    });

    const { store } = this.#d;
    const names = displayNames(p.event, p.contract);
    store.data.events[quote.geminiEventId] = {
      eventId: p.event.id,
      eventTicker: p.event.ticker,
      title: p.event.title,
      game: names.game,
      league: names.league,
      startTime: names.startTime,
    };
    store.data.instruments[quote.instrumentSymbol] = {
      symbol: p.contract.instrumentSymbol,
      label: p.contract.label,
      team: names.team,
      subject: names.subject,
      condition: names.condition,
      rule: ruleText(p.contract.description),
    };
    if (req.label && (req.label.item !== "" || req.label.business !== "")) {
      store.data.pendingLabels[quote.nonce] = pendingLabel(quote, req.label, this.#now());
      prunePending(store.data.pendingLabels);
    }
    // The price this quote was made on is the first point of the promo's chart, if the quote is used.
    keepPending(store.data.pendingOdds, quote.nonce, [p.fetchedAt, p.reading.chanceBps, p.book.bid, p.book.asks[0]?.priceBps ?? null]);
    store.data.liveQuotes[quote.nonce] = {
      maxPayout: p.price.maxPayout.toString(),
      premium: p.price.premium.toString(),
      expiry: Number(quote.expiry),
    };
    store.save();

    return { ...this.#toJson(p), quote: quoteToJson(quote), signature };
  }

  async #prepare(req: PriceRequest): Promise<Prepared> {
    if (req.payoutPerClaim <= 0n) throw new Refusal("bad-request", "The amount per customer must be more than zero.");
    if (!Number.isInteger(req.maxClaims) || req.maxClaims < 1 || req.maxClaims > 0xffffffff) {
      throw new Refusal("bad-request", "The number of customers must be at least 1.");
    }

    const [event, depth] = await Promise.all([
      (this.#d.fetchEvent ?? getEvent)(req.eventTicker),
      (this.#d.fetchDepth ?? getDepth)(req.instrumentSymbol),
    ]);
    const fetchedAt = this.#now();
    if (!event) throw new Refusal("unknown-event", "We could not find this event.");
    const contract = event.contracts.find((c) => c.instrumentSymbol === req.instrumentSymbol);
    if (!contract) throw new Refusal("unknown-contract", "We could not find this result on the event.");
    if (event.status !== "active" || (contract.marketState !== undefined && contract.marketState !== "open")) {
      throw new Refusal("market-closed", "This event is no longer open.");
    }

    // The price is what the promo's payout would cost on Gemini's book, offer by offer (the depth rule).
    // A book that is not a market (a side missing, or the two sides far apart) is priced on the highest
    // price it shows, with the wider spread, and only when there has been a trade.
    const book = bookOf(depth, contract);
    const reading = readingFor(book, req.payoutPerClaim * BigInt(req.maxClaims), this.#d.params);
    if (reading === null) throw new Refusal("no-price", "There is no price for this result right now.");

    // The latest moment a promo may take customers: kickoff for a game. An interval market (the test loop)
    // has no kickoff worth waiting for, so it takes customers until shortly before it closes.
    const now = fetchedAt;
    const { intervalCutoffSeconds, minClaimWindowSeconds } = this.#d.timing;
    const marketCloseTime = toUnix(contract.expiryDate ?? event.expiryDate);
    const interval = isIntervalMarket(event);
    // A game is sold until kickoff, a temperature market until its day begins.
    const start = eventStart(event);
    const latest = interval || start === null ? marketCloseTime - intervalCutoffSeconds : start;
    if (now >= latest) throw new Refusal("event-started", "This event has already started.");

    let claimDeadline = latest;
    if (req.claimDeadline === "30min" && !interval) claimDeadline = latest - 30 * 60;
    else if (typeof req.claimDeadline === "number") {
      if (req.claimDeadline > latest) {
        throw new Refusal("deadline-too-late", "A promotion must stop taking customers before the event starts.");
      }
      claimDeadline = req.claimDeadline;
    }
    if (claimDeadline - now < minClaimWindowSeconds) {
      throw new Refusal("too-close", "This event starts too soon to set up a promotion.");
    }

    const vault = await this.#readVault(now);
    // A promo of another size costs another price per dollar: more customers reach deeper offers.
    const at = (payoutPerClaim: bigint, maxClaims: number) => {
      const r = readingFor(book, payoutPerClaim * BigInt(maxClaims), this.#d.params);
      if (r === null) return null;
      const params = { ...this.#d.params, spreadBps: r.spreadBps };
      const computed = price(r.chanceBps, payoutPerClaim, maxClaims, vault, params);
      return { computed, limit: checkLimits(computed, vault, params) };
    };
    const here = at(req.payoutPerClaim, req.maxClaims)!;
    return {
      event,
      contract,
      depth,
      book,
      reading,
      fetchedAt,
      claimDeadline,
      marketCloseTime,
      vault,
      price: here.computed,
      limit: here.limit,
      maxCustomers: largest((n) => at(req.payoutPerClaim, n)?.limit === "ok"),
      maxPayout: BigInt(largest((cents) => at(BigInt(cents) * CENT, 1)?.limit === "ok", MOST_CENTS)) * CENT,
    };
  }

  /** The vault's balance and lock, plus the quotes that are signed and could still become promos. */
  async #readVault(now: number): Promise<VaultState> {
    const { client, vault, usdc, store } = this.#d;
    const live = store.data.liveQuotes;
    for (const nonce of Object.keys(live) as Hex[]) {
      if (live[nonce]!.expiry <= now) delete live[nonce];
    }
    const nonces = Object.keys(live) as Hex[];

    // Everything is read at one block: a quote that was just used is then in `lockedCollateral` and
    // marked used, never counted twice and never missed.
    const blockNumber = await client.getBlockNumber();
    const vaultCall = { address: vault, abi: promoVaultAbi } as const;
    const [[balance, locked, maxExposureBps, paused], used] = await Promise.all([
      client.multicall({
        allowFailure: false,
        blockNumber,
        contracts: [
          { address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [vault] },
          { ...vaultCall, functionName: "lockedCollateral" },
          { ...vaultCall, functionName: "maxExposureBps" },
          { ...vaultCall, functionName: "paused" },
        ],
      }),
      client.multicall({
        allowFailure: false,
        blockNumber,
        contracts: nonces.map((nonce) => ({ ...vaultCall, functionName: "usedQuoteNonce", args: [nonce] }) as const),
      }),
    ]);
    if (paused) throw new Refusal("vault-paused", "New promotions are paused right now.");

    let liveMaxPayout = 0n;
    let livePremium = 0n;
    nonces.forEach((nonce, i) => {
      if (used[i]) delete live[nonce];
      else {
        liveMaxPayout += BigInt(live[nonce]!.maxPayout);
        livePremium += BigInt(live[nonce]!.premium);
      }
    });
    return { balance, locked, maxExposureBps, liveMaxPayout, livePremium };
  }

  #toJson(p: Prepared) {
    const { params, timing } = this.#d;
    return {
      eventTicker: p.event.ticker,
      eventId: p.event.id,
      eventTitle: p.event.title,
      instrumentSymbol: p.contract.instrumentSymbol,
      contractLabel: p.contract.label,
      /** The words for the card: "Cavaliers at Heat", "the Heat win", the league and the start time. */
      display: displayNames(p.event, p.contract),
      /** Gemini's rule for this result, word for word. */
      rule: ruleText(p.contract.description),
      /** Unix seconds: the promo takes customers until then, and can be settled from then. */
      claimDeadline: p.claimDeadline,
      marketCloseTime: p.marketCloseTime,
      /** The three lines of the price card, in USDC base units (6 decimals). */
      breakdown: {
        /** The chance of a "yes": what a dollar of this payout costs on Gemini's offers. 0.39 is 39%. */
        chance: p.reading.chanceBps / 10_000,
        mostOwed: p.price.maxPayout.toString(),
        expectedLoss: p.price.expectedLoss.toString(),
        fee: p.price.fee.toString(),
        cost: p.price.premium.toString(),
      },
      /** The largest number of customers the vault can cover on this result at this payout right now. */
      maxCustomers: p.maxCustomers,
      /** The most one promo on this result could pay in all right now: the most a business can buy in hedge mode. */
      maxPayout: p.maxPayout.toString(),
      /** "ok", or the limit this request is over: "exposure", "ceiling" or "too-likely". */
      limit: p.limit,
      mechanics: {
        bestAsk: p.depth?.asks[0]?.price ?? null,
        bestBid: p.depth?.bid ?? null,
        lastTradePrice: p.contract.prices?.lastTradePrice ?? null,
        askFetchedAt: p.fetchedAt,
        /**
         * The spread this price carries: the usual one, the wider one of a thin book, or a mix of the two
         * when Gemini's offers cover only part of the payout.
         */
        spreadBps: p.reading.spreadBps,
        /** True when the book is not a market: a side is missing, or its sides are more than half a dollar apart. */
        thin: p.reading.thin,
        /** The depth rule: how much of this payout Gemini's offers cover, and the cheapest offers as `[price, contracts]`. */
        covered: p.reading.covered.toString(),
        offers: (p.depth?.asks ?? []).slice(0, 5).map((o) => [o.price, o.amount]),
        loading: p.price.loading.toString(),
        utilizationBps: p.price.utilizationBps,
        maxLockedBps: params.maxLockedBps,
        pricer: this.address,
        vault: this.#d.vault,
        quoteTtlSeconds: timing.quoteTtlSeconds,
      },
    };
  }
}
