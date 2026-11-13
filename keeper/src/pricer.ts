// The pricing service (SPEC section 2): reads Gemini's ask and the vault, prices a promo, and signs the
// EIP-712 quote that `createPromo` checks.
import { randomBytes } from "node:crypto";
import { erc20Abi, keccak256, toBytes, toHex, type Address, type Hex, type PrivateKeyAccount } from "viem";
import { promoVaultAbi } from "./abi.ts";
import { quoteDomain, quoteToJson, quoteTypes, type PublicClient, type Quote } from "./chain.ts";
import { getEvent, isIntervalMarket, priceToBps, ruleText, toUnix, type GeminiContract, type GeminiEvent } from "./gemini.ts";
import { pendingLabel, prunePending, type Label } from "./labels.ts";
import { displayNames } from "./names.ts";
import { checkLimits, maxCustomers, price, type Limit, type Price, type PricingParams, type VaultState } from "./pricing.ts";
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
  constructor(code: RefusalCode, message: string, maxCustomers?: number) {
    super(message);
    this.code = code;
    this.maxCustomers = maxCustomers;
  }
}

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
};

type Prepared = {
  event: GeminiEvent;
  contract: GeminiContract;
  askBps: number;
  fetchedAt: number;
  claimDeadline: number;
  marketCloseTime: number;
  vault: VaultState;
  price: Price;
  limit: Limit;
  maxCustomers: number;
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

    const event = await (this.#d.fetchEvent ?? getEvent)(req.eventTicker);
    const fetchedAt = this.#now();
    if (!event) throw new Refusal("unknown-event", "We could not find this event.");
    const contract = event.contracts.find((c) => c.instrumentSymbol === req.instrumentSymbol);
    if (!contract) throw new Refusal("unknown-contract", "We could not find this result on the event.");
    if (event.status !== "active" || (contract.marketState !== undefined && contract.marketState !== "open")) {
      throw new Refusal("market-closed", "This event is no longer open.");
    }

    const askBps = priceToBps(contract.prices?.bestAsk) ?? priceToBps(contract.prices?.lastTradePrice);
    if (askBps === null) throw new Refusal("no-price", "There is no price for this result right now.");

    // The latest moment a promo may take customers: kickoff for a game. An interval market (the test loop)
    // has no kickoff worth waiting for, so it takes customers until shortly before it closes.
    const now = fetchedAt;
    const { intervalCutoffSeconds, minClaimWindowSeconds } = this.#d.timing;
    const marketCloseTime = toUnix(contract.expiryDate ?? event.expiryDate);
    const interval = isIntervalMarket(event);
    const latest = interval || !event.startTime ? marketCloseTime - intervalCutoffSeconds : toUnix(event.startTime);
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
    const { params } = this.#d;
    const computed = price(askBps, req.payoutPerClaim, req.maxClaims, vault, params);
    return {
      event,
      contract,
      askBps,
      fetchedAt,
      claimDeadline,
      marketCloseTime,
      vault,
      price: computed,
      limit: checkLimits(computed, vault, params),
      maxCustomers: maxCustomers(askBps, req.payoutPerClaim, vault, params),
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
        /** The chance of a "yes", from Gemini's ask: 0.39 is 39%. */
        chance: p.askBps / 10_000,
        mostOwed: p.price.maxPayout.toString(),
        expectedLoss: p.price.expectedLoss.toString(),
        fee: p.price.fee.toString(),
        cost: p.price.premium.toString(),
      },
      /** The largest number of customers the vault can cover on this result at this payout right now. */
      maxCustomers: p.maxCustomers,
      /** "ok", or the limit this request is over: "exposure", "ceiling" or "too-likely". */
      limit: p.limit,
      mechanics: {
        bestAsk: p.contract.prices?.bestAsk ?? null,
        bestBid: p.contract.prices?.bestBid ?? null,
        lastTradePrice: p.contract.prices?.lastTradePrice ?? null,
        askFetchedAt: p.fetchedAt,
        spreadBps: params.spreadBps,
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
