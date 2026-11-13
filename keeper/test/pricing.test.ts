import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkLimits,
  isMarket,
  largest,
  maxCustomers,
  price,
  readingFor,
  type DeepBook,
  type PricingParams,
  type VaultState,
} from "../src/pricing.ts";

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

/** A book with one price on the offer side and far more there than any promo here needs. */
const book = (bid: number | null, ask: number | null, last: number | null): DeepBook => ({
  bid,
  asks: ask === null ? [] : [{ priceBps: ask, size: 1_000_000n * USDC }],
  last,
});
const reading = (b: DeepBook, payout = 100n * USDC) => {
  const r = readingFor(b, payout, params);
  return r === null ? null : [r.chanceBps, r.spreadBps, r.thin];
};

test("readingFor_aMarket_isPricedOnItsAsk_withTheUsualSpread", () => {
  assert.deepEqual(reading(book(4200, 4300, 4100)), [4300, 500, false]);
  // The last trade plays no part in a market, above the ask or not there at all.
  assert.deepEqual(reading(book(4200, 4300, 6000)), [4300, 500, false]);
  assert.deepEqual(reading(book(4200, 4300, null)), [4300, 500, false]);
});

test("readingFor_aThinBook_isPricedOnTheHighestPriceItShows_withTheWiderSpread", () => {
  // The empty book of an underdog that last traded at 0.40: the 0.02 ask is not its chance.
  assert.deepEqual(reading(book(null, 200, 4000)), [4000, 1500, true]);
  // No ask: the last trade.
  assert.deepEqual(reading(book(null, null, 4100)), [4100, 1500, true]);
  // An offer above the last trade, a bid above it.
  assert.deepEqual(reading(book(null, 3500, 3000)), [3500, 1500, true]);
  assert.deepEqual(reading(book(6000, null, 5000)), [6000, 1500, true]);
  // Two sides that are too far apart to be a market.
  assert.deepEqual(reading(book(100, 9000, 5000)), [9000, 1500, true]);
  // A thin spread set below the usual one is never used.
  assert.equal(readingFor(book(null, null, 4100), 100n * USDC, { ...params, spreadBps: 2000 })?.spreadBps, 2000);
});

test("readingFor_aThinBookThatNeverTraded_isNoPrice", () => {
  assert.equal(reading(book(null, 200, null)), null);
  assert.equal(reading(book(3800, null, null)), null);
  assert.equal(reading(book(100, 9900, null)), null);
  assert.equal(reading(book(null, null, null)), null);
});

test("readingFor_aThinBook_pricesTheWorkedExampleAt15Percent", () => {
  const r = readingFor(book(null, null, 3900), 4_000n * USDC, params)!;
  // 39% of 4,000 is 1,560; at 15% the cost is 1,794.
  assert.equal(price(r.chanceBps, 20n * USDC, 200, vault(20_000n * USDC), { ...params, spreadBps: r.spreadBps }).premium, 1_794n * USDC);
});

test("readingFor_walksTheOffers_cheapestFirst", () => {
  const b: DeepBook = {
    bid: 2400,
    asks: [
      { priceBps: 2500, size: 10n * USDC },
      { priceBps: 3500, size: 500n * USDC },
    ],
    last: null,
  };
  // Inside the first offer the price is that offer.
  assert.deepEqual(readingFor(b, 10n * USDC, params), { chanceBps: 2500, spreadBps: 500, thin: false, covered: 10n * USDC });
  // $400: ten at 0.25 and 390 at 0.35 is $139, or 34.75 cents on the dollar.
  assert.deepEqual(readingFor(b, 400n * USDC, params), { chanceBps: 3475, spreadBps: 500, thin: false, covered: 400n * USDC });
  // An average that is not a whole basis point is rounded up: 11 for 2.85 is 25.909...
  assert.equal(readingFor(b, 11n * USDC, params)?.chanceBps, 2591);
});

test("readingFor_pastTheOffers_theRestIsPricedAtTheDearestOne_withTheThinSpread", () => {
  const b: DeepBook = {
    bid: 3200,
    asks: [
      { priceBps: 3700, size: 100n * USDC },
      { priceBps: 4200, size: 9n * USDC },
    ],
    last: null,
  };
  // $250: 109 covered for $40.78, 141 past the offers at 0.42 for $59.22.
  assert.deepEqual(readingFor(b, 250n * USDC, params), { chanceBps: 4000, spreadBps: 1093, thin: false, covered: 109n * USDC });
  // The more of it is past the offers, the closer the spread is to 15%, and it never passes it.
  const far = readingFor(b, 1_000_000n * USDC, params)!;
  assert.deepEqual([far.chanceBps, far.spreadBps, far.covered], [4200, 1500, 109n * USDC]);
});

test("readingFor_anOfferMoreThanHalfADollarAboveTheBid_isLeftAlone", () => {
  const b: DeepBook = {
    bid: 4500,
    asks: [
      { priceBps: 4600, size: 50n * USDC },
      { priceBps: 9600, size: 50n * USDC },
      { priceBps: 9900, size: 150n * USDC },
    ],
    last: null,
  };
  // Half is bought at 0.46 with 5%; the other half is past the market, at 0.46 with 15%.
  assert.deepEqual(readingFor(b, 100n * USDC, params), { chanceBps: 4600, spreadBps: 1000, thin: false, covered: 50n * USDC });
  // Exactly half a dollar above the bid is still the market.
  b.asks[1]!.priceBps = 9500;
  assert.equal(readingFor(b, 100n * USDC, params)?.covered, 100n * USDC);
});

test("readingFor_aBiggerPromoNeverCostsLessPerDollar", () => {
  let seed = 777;
  const rand = (max: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % max;
  for (let i = 0; i < 200; i++) {
    const bid = 100 + rand(6000);
    let ask = bid + 100;
    const asks = Array.from({ length: 1 + rand(5) }, () => {
      const offer = { priceBps: ask, size: BigInt(1 + rand(500)) * USDC };
      ask += 100 * (1 + rand(8));
      return offer;
    }).filter((o) => o.priceBps < 10_000);
    const b: DeepBook = { bid, asks, last: null };
    let before = 0;
    for (const dollars of [1, 5, 40, 300, 2_000, 30_000]) {
      const r = readingFor(b, BigInt(dollars) * USDC, params)!;
      assert.ok(r.chanceBps >= before, `the price per dollar went down at $${dollars}`);
      assert.ok(r.chanceBps >= asks[0]!.priceBps && r.spreadBps >= 500 && r.spreadBps <= 1500);
      assert.ok(r.covered <= BigInt(dollars) * USDC);
      before = r.chanceBps;
    }
  }
});

test("largest_findsTheLastNumberThatFits", () => {
  assert.equal(largest((n) => n <= 37), 37);
  assert.equal(largest(() => false), 0);
  assert.equal(largest(() => true, 500), 500);
  // Not monotonic near the top: the answer itself always fits.
  assert.equal(largest((n) => n <= 40 && n !== 40 && n !== 39), 38);
});
