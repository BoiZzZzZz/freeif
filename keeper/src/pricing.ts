// The pricing math of SPEC section 2. Pure functions over whole USDC base units (6 decimals), no I/O.

export type PricingParams = {
  /** Margin on top of the expected loss. 500 = 5%. */
  spreadBps: number;
  /** The margin when the book is thin, and on the part of a payout past the book's offers (see `readingFor`). 1500 = 15%. */
  thinSpreadBps: number;
  /** The premium is never below the expected loss plus this. 200 = 2%. */
  minMarkupBps: number;
  /** Size of one loading step, as a share of the vault that is locked. 500 = every 5%. */
  loadingStepBps: number;
  /** Added to the premium per step, as a share of the expected loss. 100 = 1%. */
  loadingBpsPerStep: number;
  /** The pricer signs nothing that would leave more than this share of the vault locked. 6000 = 60%. */
  maxLockedBps: number;
  /** Share of the contract's exposure cap a quote may use, so a small withdrawal does not make it revert. */
  exposureHeadroomBps: number;
};

/** What the vault holds when a price is made. */
export type VaultState = {
  /** `usdc.balanceOf(vault)` */
  balance: bigint;
  /** `lockedCollateral()` */
  locked: bigint;
  /** `maxExposureBps()` */
  maxExposureBps: number;
  /** Sum of `maxPayout` over quotes that are signed, not expired and not used yet. */
  liveMaxPayout: bigint;
  /** Sum of `premium` over the same quotes. */
  livePremium: bigint;
};

export type Price = {
  maxPayout: bigint;
  expectedLoss: bigint;
  /** The part of the premium added because the vault is busy. */
  loading: bigint;
  premium: bigint;
  /** premium - expectedLoss: what the merchant pays above the odds. */
  fee: bigint;
  /** Share of the vault that would be locked with this promo in it, before any loading. */
  utilizationBps: number;
};

export type Limit = "ok" | "too-likely" | "exposure" | "ceiling";

/** A bid and an ask further apart than this are not a market. */
export const MAX_BOOK_WIDTH_BPS = 5_000;

/**
 * A book is a market when someone is on each side of it, at most half a dollar apart. Prices are basis
 * points of a dollar (3900 is 0.39), null where the book shows none. Any other book is thin: an empty
 * book on Gemini shows an ask of 0.02 and no bid, and a window that has not started shows 0.01 against
 * 0.99. One offer with nobody on the other side says little.
 */
export const isMarket = (bid: number | null, ask: number | null): boolean =>
  bid !== null && ask !== null && ask - bid <= MAX_BOOK_WIDTH_BPS;

const BPS = 10_000n;
/** One cent in USDC base units. */
export const CENT = 10_000n;
const MAX_CUSTOMERS = 1_000_000;

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const ceilToCent = (amount: bigint): bigint => ceilDiv(amount, CENT) * CENT;

/**
 * One price of the offers on a result, and how much is offered there. A contract pays $1 on a "yes", so
 * the size is in USDC base units of payout: 6,015.12 contracts are 6_015_120_000.
 */
export type Offer = { priceBps: number; size: bigint };

/** A book with every offer on it, cheapest first. */
export type DeepBook = { bid: number | null; asks: Offer[]; last: number | null };

/** What a promo of one size is priced on. */
export type Reading = {
  /** The chance: what a dollar of the promo's payout costs on this book, in 10,000, rounded up. */
  chanceBps: number;
  /** The spread the price carries: the usual one on what the offers cover, the thin one on the rest. */
  spreadBps: number;
  /** True when the book is not a market. */
  thin: boolean;
  /** The part of the payout the book's offers cover. */
  covered: bigint;
};

/**
 * Buys `maxPayout` of "yes" from the offers, cheapest first. An offer more than half a dollar above the
 * bid is not part of the market (the same line as `isMarket`) and is left alone.
 */
function take(book: DeepBook, maxPayout: bigint): { covered: bigint; cost: bigint; deepestBps: number } {
  let left = maxPayout;
  let cost = 0n; // base units times basis points
  let deepestBps = book.asks[0]?.priceBps ?? 0;
  for (const offer of book.asks) {
    if (left === 0n) break;
    if (book.bid !== null && offer.priceBps - book.bid > MAX_BOOK_WIDTH_BPS) break;
    const taken = offer.size < left ? offer.size : left;
    if (taken <= 0n) continue;
    cost += taken * BigInt(offer.priceBps);
    left -= taken;
    deepestBps = offer.priceBps;
  }
  return { covered: maxPayout - left, cost, deepestBps };
}

/**
 * The chance and the spread for a promo that can pay `maxPayout`, from the whole book (SPEC section 2,
 * "The depth rule"). The price is what the hedge would cost: the payout bought as "yes" contracts from
 * the offers, cheapest first. So ten contracts offered low do not set the price of a promo of 400.
 * - A market: the part the offers cover carries the usual spread. The part past them cannot be hedged;
 *   it is priced at the dearest offer taken and carries the thin spread.
 * - Any other book is thin: the highest of what the offers cost, the bid and the last trade, all of it at
 *   the thin spread, and no price (null) when the result has never traded.
 */
export function readingFor(book: DeepBook, maxPayout: bigint, params: PricingParams): Reading | null {
  const top = book.asks[0]?.priceBps ?? null;
  const market = isMarket(book.bid, top);
  if (!market && book.last === null) return null;
  if (maxPayout <= 0n) return null;

  const { covered, cost, deepestBps } = take(book, maxPayout);
  const restCost = (maxPayout - covered) * BigInt(deepestBps);
  const total = cost + restCost;
  const offered = Number(ceilDiv(total, maxPayout));
  const thinSpread = BigInt(Math.max(params.spreadBps, params.thinSpreadBps));

  if (!market) {
    return { chanceBps: Math.max(book.last!, book.bid ?? 0, offered), spreadBps: Number(thinSpread), thin: true, covered };
  }
  const spreadBps = Number(ceilDiv(cost * BigInt(params.spreadBps) + restCost * thinSpread, total));
  return { chanceBps: offered, spreadBps, thin: false, covered };
}

/** The largest whole number from 0 to `most` that `fits`. `fits` should hold up to a point and not after it. */
export function largest(fits: (n: number) => boolean, most = MAX_CUSTOMERS): number {
  let lo = 0;
  let hi = most;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  // The loading moves in steps and a deeper offer costs more, so the limits are not strictly monotonic.
  // Step down until the answer itself fits.
  while (lo > 0 && !fits(lo)) lo--;
  return lo;
}

/** The premium for `maxClaims` customers at `payoutPerClaim` each, at a chance of `askBps` in 10,000. */
export function price(
  askBps: number,
  payoutPerClaim: bigint,
  maxClaims: number,
  vault: VaultState,
  params: PricingParams,
): Price {
  const maxPayout = payoutPerClaim * BigInt(maxClaims);
  const expectedLoss = ceilDiv(maxPayout * BigInt(askBps), BPS);
  const base = ceilDiv(expectedLoss * (BPS + BigInt(params.spreadBps)), BPS);

  // Loading: 1% of the expected loss for every full 5% of the vault this promo would leave locked.
  const lockedAfter = vault.locked + vault.liveMaxPayout + maxPayout;
  const balanceAfter = vault.balance + vault.livePremium + base;
  const utilizationBps = balanceAfter === 0n ? 0 : Number((lockedAfter * BPS) / balanceAfter);
  const steps = BigInt(Math.floor(utilizationBps / params.loadingStepBps));
  const loading = (expectedLoss * steps * BigInt(params.loadingBpsPerStep)) / BPS;

  const floor = ceilDiv(expectedLoss * (BPS + BigInt(params.minMarkupBps)), BPS);
  const raw = base + loading > floor ? base + loading : floor;
  const premium = ceilToCent(raw);

  return { maxPayout, expectedLoss, loading, premium, fee: premium - expectedLoss, utilizationBps };
}

/**
 * Whether the vault can take a promo at this price. Three limits:
 * - too-likely: the premium would be more than the payout (the contract refuses that).
 * - exposure: the contract's cap, `maxPayout - premium <= freeBalance * maxExposureBps`, with headroom.
 * - ceiling: with this promo, no more than `maxLockedBps` of the vault is locked (SPEC "Ceiling across promos").
 * Quotes that are signed and still usable count as if their promos existed.
 */
export function checkLimits(p: Price, vault: VaultState, params: PricingParams): Limit {
  if (p.premium > p.maxPayout) return "too-likely";

  const balance = vault.balance + vault.livePremium;
  const locked = vault.locked + vault.liveMaxPayout;
  const free = balance > locked ? balance - locked : 0n;

  const vaultRisk = p.maxPayout - p.premium;
  const cap = (free * BigInt(vault.maxExposureBps) * BigInt(params.exposureHeadroomBps)) / (BPS * BPS);
  if (vaultRisk > cap) return "exposure";

  if ((locked + p.maxPayout) * BPS > BigInt(params.maxLockedBps) * (balance + p.premium)) return "ceiling";
  return "ok";
}

/** The largest `maxClaims` the vault can cover at this chance and payout right now. 0 when it can cover none. */
export function maxCustomers(askBps: number, payoutPerClaim: bigint, vault: VaultState, params: PricingParams): number {
  return largest((n) => checkLimits(price(askBps, payoutPerClaim, n, vault, params), vault, params) === "ok");
}
