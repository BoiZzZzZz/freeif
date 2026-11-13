// The pricing math of SPEC section 2. Pure functions over whole USDC base units (6 decimals), no I/O.

export type PricingParams = {
  /** Margin on top of the expected loss. 500 = 5%. */
  spreadBps: number;
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

const BPS = 10_000n;
const CENT = 10_000n; // one cent in USDC base units

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const ceilToCent = (amount: bigint): bigint => ceilDiv(amount, CENT) * CENT;

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

const MAX_CUSTOMERS = 1_000_000;

/** The largest `maxClaims` the vault can cover at this chance and payout right now. 0 when it can cover none. */
export function maxCustomers(askBps: number, payoutPerClaim: bigint, vault: VaultState, params: PricingParams): number {
  const fits = (n: number) => checkLimits(price(askBps, payoutPerClaim, n, vault, params), vault, params) === "ok";
  let lo = 0;
  let hi = MAX_CUSTOMERS;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  // The loading moves in steps, so the limits are not strictly monotonic. Step down until the answer itself fits.
  while (lo > 0 && !fits(lo)) lo--;
  return lo;
}
