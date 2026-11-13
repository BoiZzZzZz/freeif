import assert from "node:assert/strict";
import { test } from "node:test";
import { chanceOf, checkLimits, forBook, isMarket, maxCustomers, price, type PricingParams, type VaultState } from "../src/pricing.ts";

const USDC = 1_000_000n;
const params: PricingParams = {
  spreadBps: 500,
  thinSpreadBps: 1500,
  minMarkupBps: 200,
  loadingStepBps: 500,
  loadingBpsPerStep: 0,
  maxLockedBps: 6000,
  exposureHeadroomBps: 10_000,
};
const vault = (balance: bigint, over: Partial<VaultState> = {}): VaultState => ({
  balance,
  locked: 0n,
  maxExposureBps: 2000,
  liveMaxPayout: 0n,
  livePremium: 0n,
  ...over,
});

test("price_workedExample_matchesTheSpec", () => {
  // SPEC section 2: Lions to win, ask 0.39, $20 each, 200 customers.
  const p = price(3900, 20n * USDC, 200, vault(11_810n * USDC), params);
  assert.equal(p.maxPayout, 4_000n * USDC);
  assert.equal(p.expectedLoss, 1_560n * USDC);
  assert.equal(p.premium, 1_638n * USDC);
  assert.equal(p.fee, 78n * USDC);
  assert.equal(p.loading, 0n);
});

test("checkLimits_workedExample_needsAFreeBalanceOf11810", () => {
  const p = price(3900, 20n * USDC, 200, vault(0n), params);
  assert.equal(checkLimits(p, vault(11_810n * USDC), params), "ok");
  assert.equal(checkLimits(p, vault(11_809n * USDC), params), "exposure");
});

test("checkLimits_headroom_keepsAQuoteBelowTheContractCap", () => {
  const p = price(3900, 20n * USDC, 200, vault(0n), params);
  const withHeadroom = { ...params, exposureHeadroomBps: 9000 };
  // 2,362 at risk needs 2,362 / (20% * 90%) = 13,122.23 free.
  assert.equal(checkLimits(p, vault(13_122n * USDC), withHeadroom), "exposure");
  assert.equal(checkLimits(p, vault(13_123n * USDC), withHeadroom), "ok");
});

test("checkLimits_likelyResultAtTheExposureCap_hitsTheCeiling", () => {
  // SPEC: one promo at the 20% cap with an ask of 0.80 would lock 61% of the vault.
  const v = vault(1_000n * USDC);
  const likely = price(8000, 1_250_000n, 1000, v, params);
  assert.equal(likely.maxPayout, 1_250n * USDC);
  assert.equal(likely.premium, 1_050n * USDC);
  assert.equal(checkLimits(likely, v, params), "ceiling");
  // With an ask of 0.39 the same vault locks about 30% at the cap.
  const even = price(3900, 338n * USDC, 1, v, params);
  assert.equal(checkLimits(even, v, params), "ok");
});

test("checkLimits_premiumAboveThePayout_isTooLikely", () => {
  const v = vault(1_000_000n * USDC);
  const p = price(9700, USDC, 10, v, params);
  assert.ok(p.premium > p.maxPayout);
  assert.equal(checkLimits(p, v, params), "too-likely");
});

test("checkLimits_liveQuotes_countAsIfTheirPromosExisted", () => {
  // Two promos that each fit an empty vault and do not fit together.
  const empty = vault(1_000n * USDC);
  const p = price(5000, USDC, 300, empty, params); // locks 300, premium 157.50, risk 142.50
  assert.equal(checkLimits(p, empty, params), "ok");
  const withLive = vault(1_000n * USDC, { liveMaxPayout: p.maxPayout, livePremium: p.premium });
  // With one live quote, 600 of 1,315 would be locked (45.6%): a second still fits.
  assert.equal(checkLimits(p, withLive, params), "ok");
  // With two, a third would lock 900 of 1,472.50 (61.1%): over the 60% ceiling.
  const withTwoLive = vault(1_000n * USDC, { liveMaxPayout: 2n * p.maxPayout, livePremium: 2n * p.premium });
  assert.equal(checkLimits(p, withTwoLive, params), "ceiling");
  // The same locks already on chain give the same answer as the same locks in live quotes.
  const onChain = vault(1_000n * USDC + 2n * p.premium, { locked: 2n * p.maxPayout });
  assert.equal(checkLimits(p, onChain, params), "ceiling");
  // And the exposure cap sees them too: 20% of what is left free.
  const big = price(5000, USDC, 380, empty, params); // risk 180.50, fits an empty vault (cap 200)
  assert.equal(checkLimits(big, empty, params), "ok");
  assert.equal(checkLimits(big, withLive, params), "exposure"); // cap is now 20% of 857.50 = 171.50
});

test("price_roundsThePremiumUpToACent_andNeverBelowTheFloor", () => {
  const noSpread = { ...params, spreadBps: 0 };
  for (const [askBps, payout, n] of [[3333, 1_234_567n, 7], [101, 999_999n, 3], [5000, 1n, 1]] as const) {
    const p = price(askBps, payout, n, vault(1_000n * USDC), noSpread);
    assert.equal(p.premium % 10_000n, 0n);
    assert.ok(p.premium * 10_000n >= p.expectedLoss * 10_200n, "premium is at least the expected loss plus 2%");
    assert.ok(p.premium - 10_000n < (p.expectedLoss * 10_200n) / 10_000n + 1n, "and less than a cent above it");
  }
});

test("price_loading_addsOnePercentPerFivePercentLocked", () => {
  const loaded = { ...params, loadingBpsPerStep: 100 };
  // 4,000 locked against 11,810 + 1,638 is 29.7% of the vault: five full steps, 5% of the expected loss.
  const p = price(3900, 20n * USDC, 200, vault(11_810n * USDC), loaded);
  assert.equal(p.utilizationBps, 2974);
  assert.equal(p.loading, 78n * USDC);
  assert.equal(p.premium, 1_716n * USDC);
});

test("maxCustomers_isTheLargestCountThatFits", () => {
  let seed = 12345;
  const rand = (max: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % max;
  for (let i = 0; i < 300; i++) {
    const askBps = 100 + rand(9400);
    const payout = BigInt(1 + rand(50_000_000));
    const v = vault(BigInt(rand(50_000)) * USDC, { locked: BigInt(rand(5_000)) * USDC });
    if (v.locked > v.balance) continue;
    const p = { ...params, exposureHeadroomBps: 9000 };
    const n = maxCustomers(askBps, payout, v, p);
    const fits = (k: number) => checkLimits(price(askBps, payout, k, v, p), v, p) === "ok";
    if (n > 0) assert.ok(fits(n), `${n} customers fit`);
    assert.ok(!fits(n + 1), `${n + 1} customers do not fit (ask ${askBps}, payout ${payout})`);
  }
});

test("maxCustomers_emptyVault_isZero", () => {
  assert.equal(maxCustomers(3900, 20n * USDC, vault(0n), params), 0);
});

test("isMarket_needsSomeoneOnEachSide_atMostHalfADollarApart", () => {
  assert.ok(isMarket(4200, 4300));
  assert.ok(isMarket(2000, 7000));
  assert.ok(!isMarket(2000, 7100));
  // A window that has not started: a placeholder on each side.
  assert.ok(!isMarket(100, 9900));
  // An empty book on Gemini: an ask of 0.02 and nobody bidding.
  assert.ok(!isMarket(null, 200));
  assert.ok(!isMarket(4000, null));
  assert.ok(!isMarket(null, null));
});

test("chanceOf_aMarket_isPricedOnItsAsk", () => {
  assert.deepEqual(chanceOf({ bid: 4200, ask: 4300, last: 4100 }), { chanceBps: 4300, thin: false });
  // The last trade plays no part in a market, above the ask or not there at all.
  assert.deepEqual(chanceOf({ bid: 4200, ask: 4300, last: 6000 }), { chanceBps: 4300, thin: false });
  assert.deepEqual(chanceOf({ bid: 4200, ask: 4300, last: null }), { chanceBps: 4300, thin: false });
});

test("chanceOf_aThinBook_isPricedOnTheHighestPriceItShows", () => {
  // The empty book of an underdog that last traded at 0.40: the 0.02 ask is not its chance.
  assert.deepEqual(chanceOf({ bid: null, ask: 200, last: 4000 }), { chanceBps: 4000, thin: true });
  // No ask: the last trade, as before.
  assert.deepEqual(chanceOf({ bid: null, ask: null, last: 4100 }), { chanceBps: 4100, thin: true });
  // An offer above the last trade, a bid above it.
  assert.deepEqual(chanceOf({ bid: null, ask: 3500, last: 3000 }), { chanceBps: 3500, thin: true });
  assert.deepEqual(chanceOf({ bid: 6000, ask: null, last: 5000 }), { chanceBps: 6000, thin: true });
  // Two sides that are too far apart to be a market.
  assert.deepEqual(chanceOf({ bid: 100, ask: 9000, last: 5000 }), { chanceBps: 9000, thin: true });
});

test("chanceOf_aThinBookThatNeverTraded_isNoPrice", () => {
  assert.equal(chanceOf({ bid: null, ask: 200, last: null }), null);
  assert.equal(chanceOf({ bid: 3800, ask: null, last: null }), null);
  assert.equal(chanceOf({ bid: 100, ask: 9900, last: null }), null);
  assert.equal(chanceOf({ bid: null, ask: null, last: null }), null);
});

test("forBook_aThinBookCarriesTheWiderSpread_neverANarrowerOne", () => {
  assert.equal(forBook(params, false).spreadBps, 500);
  assert.equal(forBook(params, true).spreadBps, 1500);
  assert.equal(forBook({ ...params, spreadBps: 2000 }, true).spreadBps, 2000);
  // 39% of 4,000 is 1,560; at 15% the cost is 1,794.
  assert.equal(price(3900, 20n * USDC, 200, vault(20_000n * USDC), forBook(params, true)).premium, 1_794n * USDC);
});
