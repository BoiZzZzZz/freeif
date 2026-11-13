// The pricing service's rules (SPEC section 2), with Gemini and the chain replaced by fakes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, toBytes, verifyTypedData, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { quoteDomain, quoteFromJson, quoteTypes, type PublicClient } from "../src/chain.ts";
import type { Depth, GeminiEvent } from "../src/gemini.ts";
import { Pricer, Refusal, type RefusalCode } from "../src/pricer.ts";
import type { PricingParams } from "../src/pricing.ts";
import { Store } from "../src/store.ts";

const USDC = 1_000_000n;
const VAULT: Address = "0x68a00243927f250dBcD9160b5d06623b62B2e06d";
const TOKEN: Address = "0x3600000000000000000000000000000000000000";
const RELAYER: Address = "0xa03aF58DF0B042fFA9342F178bb37F8a9f1E3286";
const MERCHANT: Address = "0xF9Aac480396174FFF98988D25d74c78Af7Abfb88";
const NOW = 1_794_500_000;
const iso = (unix: number) => new Date(unix * 1000).toISOString();

const params: PricingParams = {
  spreadBps: 500,
  thinSpreadBps: 1500,
  minMarkupBps: 200,
  loadingStepBps: 500,
  loadingBpsPerStep: 0,
  maxLockedBps: 6000,
  exposureHeadroomBps: 9000,
};

const game = (over: Partial<GeminiEvent> = {}): GeminiEvent => ({
  id: "362998",
  ticker: "NFL-2610251700-IND-MIN-M",
  title: "Colts at Vikings",
  category: "Sports",
  status: "active",
  startTime: iso(NOW + 3 * 3600),
  expiryDate: iso(NOW + 2 * 86400),
  contracts: [
    {
      id: "362998-1",
      label: "Vikings",
      instrumentSymbol: "GEMI-NFL-2610251700-IND-MIN-M-MIN",
      marketState: "open",
      expiryDate: iso(NOW + 2 * 86400),
      prices: { bestBid: "0.38", bestAsk: "0.39" },
    },
  ],
  ...over,
});

const window5m = (closeIn: number): GeminiEvent => ({
  id: "455093",
  ticker: "BTC05M2611130405",
  title: "BTC price today at 11:05pm EST",
  category: "Crypto",
  status: "active",
  startTime: iso(NOW + closeIn - 300),
  expiryDate: iso(NOW + closeIn),
  contracts: [
    {
      id: "455093-1",
      label: "Up",
      instrumentSymbol: "GEMI-BTC05M2611130405-UP",
      marketState: "open",
      expiryDate: iso(NOW + closeIn),
      prices: { bestBid: "0.49", bestAsk: "0.5" },
    },
  ],
});

type Chain = { balance: bigint; locked: bigint; paused: boolean; used: Set<Hex> };

/**
 * `depth` is the contract's book on Gemini. Left out, it is the event's own best bid and best ask with
 * far more offered at the ask than any test asks for, so the price is the ask.
 */
function setup(event: GeminiEvent | null, chain: Partial<Chain> = {}, depth?: Depth | null) {
  const state: Chain = { balance: 20_000n * USDC, locked: 0n, paused: false, used: new Set(), ...chain };
  const clock = { now: NOW };
  const client = {
    getBlockNumber: async () => 1n,
    multicall: async ({ contracts }: { contracts: { functionName: string; args?: readonly unknown[] }[] }) =>
      contracts[0]?.functionName === "balanceOf"
        ? [state.balance, state.locked, 2000, state.paused]
        : contracts.map((c) => state.used.has(c.args![0] as Hex)),
  } as unknown as PublicClient;
  const account = privateKeyToAccount(generatePrivateKey());
  const store = new Store(null);
  const pricer = new Pricer({
    client,
    vault: VAULT,
    usdc: TOKEN,
    account,
    claimSigner: RELAYER,
    params,
    timing: { quoteTtlSeconds: 90, intervalCutoffSeconds: 60, minClaimWindowSeconds: 30 },
    store,
    now: () => clock.now,
    fetchEvent: async () => event,
    fetchDepth: async (symbol) => {
      if (depth !== undefined) return depth;
      const prices = event?.contracts.find((c) => c.instrumentSymbol === symbol)?.prices;
      return { bid: prices?.bestBid ?? null, asks: prices?.bestAsk ? [{ price: prices.bestAsk, amount: "1000000.0" }] : [] };
    },
  });
  return { pricer, state, clock, store, account };
}

const wings = {
  eventTicker: "NFL-2610251700-IND-MIN-M",
  instrumentSymbol: "GEMI-NFL-2610251700-IND-MIN-M-MIN",
  payoutPerClaim: 20n * USDC,
  maxClaims: 200,
};
const btc = { eventTicker: "BTC05M2611130405", instrumentSymbol: "GEMI-BTC05M2611130405-UP", payoutPerClaim: USDC, maxClaims: 3 };

async function refusal(run: Promise<unknown>, code: RefusalCode): Promise<Refusal> {
  try {
    await run;
  } catch (err) {
    assert.ok(err instanceof Refusal, `expected a Refusal, got ${String(err)}`);
    assert.equal(err.code, code);
    return err;
  }
  assert.fail(`expected a "${code}" refusal`);
}

test("getPrice_workedExample_showsTheMerchantsThreeLines", async () => {
  const { pricer } = setup(game());
  const p = await pricer.getPrice(wings);
  assert.equal(p.breakdown.chance, 0.39);
  assert.equal(p.breakdown.mostOwed, "4000000000");
  assert.equal(p.breakdown.cost, "1638000000");
  assert.equal(p.breakdown.fee, "78000000");
  assert.equal(p.limit, "ok");
  assert.equal(p.claimDeadline, NOW + 3 * 3600);
  assert.equal(p.marketCloseTime, NOW + 2 * 86400);
  // 20,000 free, 20% cap, 90% headroom: 3,600 at risk, at 11.81 of risk per customer.
  assert.equal(p.maxCustomers, 304);
});

test("signQuote_signsExactlyWhatCreatePromoChecks", async () => {
  const { pricer, account, store, clock } = setup(game());
  const res = await pricer.signQuote({ ...wings, merchant: MERCHANT });
  const q = quoteFromJson(res.quote);

  assert.equal(q.merchant, MERCHANT);
  assert.equal(q.claimSigner, RELAYER);
  assert.equal(q.geminiEventId, keccak256(toBytes("362998")));
  assert.equal(q.instrumentSymbol, keccak256(toBytes("GEMI-NFL-2610251700-IND-MIN-M-MIN")));
  assert.equal(q.premium, 1_638n * USDC);
  assert.equal(q.expiry, BigInt(clock.now + 90));
  assert.equal(q.hedgeMode, false);
  assert.ok(
    await verifyTypedData({
      address: account.address,
      domain: quoteDomain(VAULT),
      types: quoteTypes,
      primaryType: "Quote",
      message: q,
      signature: res.signature,
    }),
  );
  // The keeper will need the plain strings behind the two hashes to settle the promo.
  // With them it keeps the words for the card: this fake event has no teams, so the game is its title.
  assert.deepEqual(store.data.events[q.geminiEventId], {
    eventId: "362998",
    eventTicker: wings.eventTicker,
    title: "Colts at Vikings",
    game: "Colts at Vikings",
    league: null,
    startTime: NOW + 3 * 3600,
  });
  assert.equal(store.data.instruments[q.instrumentSymbol]?.symbol, wings.instrumentSymbol);
});

test("signQuote_twoQuotes_haveDifferentNonces", async () => {
  const { pricer } = setup(game());
  const a = await pricer.signQuote({ ...wings, maxClaims: 10, merchant: MERCHANT });
  const b = await pricer.signQuote({ ...wings, maxClaims: 10, merchant: MERCHANT });
  assert.notEqual(a.quote.nonce, b.quote.nonce);
});

test("claimDeadline_game_isKickoffOr30MinutesBefore_neverLater", async () => {
  const { pricer } = setup(game());
  const kickoff = NOW + 3 * 3600;
  assert.equal((await pricer.getPrice({ ...wings, claimDeadline: "start" })).claimDeadline, kickoff);
  assert.equal((await pricer.getPrice({ ...wings, claimDeadline: "30min" })).claimDeadline, kickoff - 1800);
  assert.equal((await pricer.getPrice({ ...wings, claimDeadline: kickoff - 600 })).claimDeadline, kickoff - 600);
  await refusal(pricer.getPrice({ ...wings, claimDeadline: kickoff + 1 }), "deadline-too-late");
});

test("getPrice_gameThatHasStarted_isRefused", async () => {
  const { pricer, clock } = setup(game());
  clock.now = NOW + 3 * 3600;
  await refusal(pricer.getPrice(wings), "event-started");
  clock.now = NOW + 3 * 3600 - 29;
  await refusal(pricer.getPrice(wings), "too-close");
  clock.now = NOW + 3 * 3600 - 30;
  assert.equal((await pricer.getPrice(wings)).limit, "ok");
});

test("anEventWithNoStart_isNotSold_pricedOrSigned", async () => {
  // Not a game, not a day's temperature, not a test window: nothing says when its result begins to be
  // known, so a quote on it could be held while the price moves.
  const { pricer } = setup(game({ startTime: undefined, ticker: "BTC-ABOVE-2611132300" }));
  await refusal(pricer.getPrice(wings), "unknown-event");
  await refusal(pricer.signQuote({ ...wings, merchant: MERCHANT }), "unknown-event");
});

test("getPrice_intervalMarket_isQuotableWhileRunning_until60SecondsBeforeItCloses", async () => {
  // The window is running: it started 100 seconds ago and closes in 200.
  const { pricer, clock } = setup(window5m(200));
  const p = await pricer.getPrice(btc);
  assert.equal(p.claimDeadline, NOW + 140);
  assert.equal(p.marketCloseTime, NOW + 200);
  await refusal(pricer.getPrice({ ...btc, claimDeadline: NOW + 141 }), "deadline-too-late");
  clock.now = NOW + 140;
  await refusal(pricer.getPrice(btc), "event-started");
});

test("getPrice_refusesWhatItCannotPrice", async () => {
  await refusal(setup(null).pricer.getPrice(wings), "unknown-event");
  await refusal(setup(game()).pricer.getPrice({ ...wings, instrumentSymbol: "GEMI-NFL-2610251700-IND-MIN-M-IND" }), "unknown-contract");
  await refusal(setup(game({ status: "settled" })).pricer.getPrice(wings), "market-closed");
  const noAsk = game();
  noAsk.contracts[0]!.prices = { bestBid: "0.38" };
  await refusal(setup(noAsk).pricer.getPrice(wings), "no-price");
  await refusal(setup(game(), { paused: true }).pricer.getPrice(wings), "vault-paused");
  await refusal(setup(game()).pricer.getPrice({ ...wings, maxClaims: 0 }), "bad-request");
  await refusal(setup(game()).pricer.getPrice({ ...wings, payoutPerClaim: 0n }), "bad-request");
});

test("getPrice_noAsk_fallsBackToTheLastTrade_withTheWiderSpread", async () => {
  const event = game();
  event.contracts[0]!.prices = { lastTradePrice: "0.41" };
  const p = await setup(event).pricer.getPrice(wings);
  assert.equal(p.breakdown.chance, 0.41);
  assert.deepEqual([p.mechanics.thin, p.mechanics.spreadBps], [true, 1500]);
  // 41% of 4,000 is 1,640; at 15% the cost is 1,886.
  assert.equal(p.breakdown.cost, "1886000000");
});

test("getPrice_aMarket_carriesTheUsualSpread", async () => {
  const p = await setup(game()).pricer.getPrice(wings);
  assert.deepEqual([p.mechanics.thin, p.mechanics.spreadBps], [false, 500]);
});

test("getPrice_anEmptyBooksAsk_isNotTakenAsTheChance", async () => {
  // Gemini shows an ask of 0.02 and no bid on a result nobody is quoting.
  const stub = game();
  stub.contracts[0]!.prices = { bestAsk: "0.02" };
  await refusal(setup(stub).pricer.getPrice(wings), "no-price");
  await refusal(setup(stub).pricer.signQuote({ ...wings, merchant: MERCHANT }), "no-price");

  // The same book on a result that last traded at 0.40 is priced at 40%, with the wider spread.
  const traded = game();
  traded.contracts[0]!.prices = { bestAsk: "0.02", lastTradePrice: "0.40" };
  const p = await setup(traded).pricer.getPrice(wings);
  assert.equal(p.breakdown.chance, 0.4);
  assert.equal(p.mechanics.thin, true);
  assert.equal(p.breakdown.cost, "1840000000");
});

test("getPrice_aBookWithItsSidesFarApart_isThin", async () => {
  // SPEC's example: an ask of 0.90 against a bid of 0.01 is not a 90% chance at the usual spread.
  const wide = game();
  wide.contracts[0]!.prices = { bestBid: "0.01", bestAsk: "0.90" };
  await refusal(setup(wide).pricer.getPrice(wings), "no-price");
  wide.contracts[0]!.prices = { bestBid: "0.01", bestAsk: "0.60", lastTradePrice: "0.55" };
  const p = await setup(wide).pricer.getPrice(wings);
  assert.deepEqual([p.breakdown.chance, p.mechanics.thin, p.mechanics.spreadBps], [0.6, true, 1500]);
});

test("signQuote_aThinBook_signsThePriceWithTheWiderSpread_andKeepsItsChanceForTheChart", async () => {
  const event = game();
  event.contracts[0]!.prices = { bestAsk: "0.35", lastTradePrice: "0.30" };
  const { pricer, store } = setup(event);
  const res = await pricer.signQuote({ ...wings, merchant: MERCHANT });
  // 35% of 4,000 is 1,400; at 15% the premium is 1,610.
  assert.equal(res.quote.premium, "1610000000");
  assert.deepEqual(store.data.pendingOdds[res.quote.nonce], [NOW, 3500, null, 3500]);
});

test("getPrice_aSmallOfferAtTheTop_doesNotSetThePriceOfABiggerPromo", async () => {
  // Ten contracts are offered at 0.25 and five hundred at 0.35. A promo that can pay $400 would buy the
  // ten and 390 of the rest: $139 for $400 of payout.
  const book: Depth = { bid: "0.24", asks: [{ price: "0.25", amount: "10.0" }, { price: "0.35", amount: "500.0" }] };
  const p = await setup(game(), {}, book).pricer.getPrice({ ...wings, maxClaims: 20 });
  assert.equal(p.breakdown.mostOwed, "400000000");
  assert.equal(p.breakdown.expectedLoss, "139000000");
  assert.equal(p.breakdown.chance, 0.3475);
  assert.equal(p.breakdown.cost, "145950000");
  assert.deepEqual([p.mechanics.thin, p.mechanics.spreadBps, p.mechanics.covered], [false, 500, "400000000"]);
  assert.deepEqual(p.mechanics.offers, [["0.25", "10.0"], ["0.35", "500.0"]]);
  // A promo small enough for the ten contracts is priced on them alone.
  const small = await setup(game(), {}, book).pricer.getPrice({ ...wings, payoutPerClaim: 5n * USDC, maxClaims: 2 });
  assert.equal(small.breakdown.chance, 0.25);
});

test("getPrice_aPayoutPastTheOffers_carriesTheWiderSpreadOnThatPart", async () => {
  // Gemini's Austin temperature book on Nov 13: 100 offered at 0.37, 9 at 0.42, a bid of 0.32. A payout
  // of $250 buys all 109 for $40.78; the other 141 cannot be hedged and are priced at 0.42, $59.22.
  const book: Depth = { bid: "0.32", asks: [{ price: "0.37", amount: "100.0" }, { price: "0.42", amount: "9.0" }] };
  const p = await setup(game(), {}, book).pricer.getPrice({ ...wings, payoutPerClaim: 250n * USDC, maxClaims: 1 });
  assert.equal(p.breakdown.expectedLoss, "100000000");
  assert.equal(p.breakdown.chance, 0.4);
  assert.equal(p.mechanics.covered, "109000000");
  // 5% of $40.78 and 15% of $59.22 is $10.92 on $100: 10.93% once rounded up.
  assert.deepEqual([p.mechanics.thin, p.mechanics.spreadBps], [false, 1093]);
  assert.equal(p.breakdown.cost, "110930000");
});

test("getPrice_anOfferFarAboveTheBid_isNotPartOfTheMarket", async () => {
  // 150 contracts offered at 0.99 against a bid of 0.45 are nobody's price for the result.
  const book: Depth = { bid: "0.45", asks: [{ price: "0.46", amount: "50.0" }, { price: "0.99", amount: "150.0" }] };
  const p = await setup(game(), {}, book).pricer.getPrice({ ...wings, payoutPerClaim: 100n * USDC, maxClaims: 1 });
  assert.equal(p.breakdown.chance, 0.46);
  assert.equal(p.mechanics.covered, "50000000");
  // Half is covered at 5%, half is past the offers at 15%.
  assert.equal(p.mechanics.spreadBps, 1000);
});

test("getPrice_theBookIsThePrice_notTheEventsOwnNumbers", async () => {
  // The event still says 0.38 against 0.39; the book has moved to 0.44 against 0.45.
  const p = await setup(game(), {}, { bid: "0.44", asks: [{ price: "0.45", amount: "9000.0" }] }).pricer.getPrice(wings);
  assert.equal(p.breakdown.chance, 0.45);
  assert.deepEqual([p.mechanics.bestBid, p.mechanics.bestAsk], ["0.44", "0.45"]);
  // No book at all (Gemini does not know the symbol) is no price.
  await refusal(setup(game(), {}, null).pricer.getPrice(wings), "no-price");
});

test("getPrice_maxPayout_isTheMostOnePromoCouldPay", async () => {
  // 20,000 free, 20% cap, 90% headroom: 3,600 at risk. A dollar of payout at 0.39 plus 5% leaves
  // 59.05 cents at risk: 6,096.54 costs 2,496.54 (rounded up to the cent) and puts exactly 3,600 at risk.
  const p = await setup(game()).pricer.getPrice(wings);
  assert.equal(p.maxPayout, "6096540000");
  const one = await setup(game()).pricer.getPrice({ ...wings, payoutPerClaim: 6_096_540_000n, maxClaims: 1 });
  assert.deepEqual([one.limit, one.breakdown.cost], ["ok", "2496540000"]);
  const over = await setup(game()).pricer.getPrice({ ...wings, payoutPerClaim: 6_096_550_000n, maxClaims: 1 });
  assert.equal(over.limit, "exposure");
});

test("getPrice_whenGeminisEventRouteFails_usesTheEventItReadAMomentAgo_andStillReadsTheBook", async () => {
  const book: Depth = { bid: "0.38", asks: [{ price: "0.39", amount: "9000.0" }] };
  const asked = { event: 0, book: 0 };
  let down = false;
  const clock = { now: NOW };
  const pricer = new Pricer({
    client: {
      getBlockNumber: async () => 1n,
      multicall: async ({ contracts }: { contracts: { functionName: string }[] }) =>
        contracts[0]?.functionName === "balanceOf" ? [20_000n * USDC, 0n, 2000, false] : [],
    } as unknown as PublicClient,
    vault: VAULT,
    usdc: TOKEN,
    account: privateKeyToAccount(generatePrivateKey()),
    claimSigner: RELAYER,
    params,
    timing: { quoteTtlSeconds: 90, intervalCutoffSeconds: 60, minClaimWindowSeconds: 30 },
    store: new Store(null),
    now: () => clock.now,
    fetchEvent: async () => {
      asked.event++;
      if (down) throw new Error("The operation was aborted due to timeout");
      // Kickoff is five minutes away.
      return game({ startTime: iso(NOW + 300) });
    },
    fetchDepth: async () => {
      asked.book++;
      return book;
    },
  });

  assert.equal((await pricer.getPrice(wings)).breakdown.chance, 0.39);
  // Fifteen seconds later, the form's next read: the event is not asked for again, the book is.
  clock.now += 15;
  book.asks[0]!.price = "0.41";
  assert.equal((await pricer.getPrice(wings)).breakdown.chance, 0.41);
  assert.deepEqual(asked, { event: 1, book: 2 });

  // Gemini's event route stops answering. The price is still live: it comes from the book.
  down = true;
  clock.now += 60;
  book.asks[0]!.price = "0.44";
  assert.equal((await pricer.getPrice(wings)).breakdown.chance, 0.44);
  assert.equal(asked.event, 2);
  // The kickoff the kept event names still closes the promo.
  clock.now = NOW + 300;
  await refusal(pricer.getPrice(wings), "event-started");

  // Ten minutes without an answer: the event is too old to go by.
  const stale = new Pricer({
    client: { getBlockNumber: async () => 1n, multicall: async () => [20_000n * USDC, 0n, 2000, false] } as unknown as PublicClient,
    vault: VAULT,
    usdc: TOKEN,
    account: privateKeyToAccount(generatePrivateKey()),
    claimSigner: RELAYER,
    params,
    timing: { quoteTtlSeconds: 90, intervalCutoffSeconds: 60, minClaimWindowSeconds: 30 },
    store: new Store(null),
    now: () => clock.now,
    fetchEvent: async () => {
      if (down) throw new Error("timeout");
      return game();
    },
    fetchDepth: async () => book,
  });
  clock.now = NOW;
  down = false;
  await stale.getPrice(wings);
  down = true;
  clock.now = NOW + 601;
  await assert.rejects(stale.getPrice(wings), /timeout/);
});

test("getPrice_theBookRoute_isAskedTwiceBeforeThePriceFails", async () => {
  let tries = 0;
  const flaky = new Pricer({
    client: { getBlockNumber: async () => 1n, multicall: async () => [20_000n * USDC, 0n, 2000, false] } as unknown as PublicClient,
    vault: VAULT,
    usdc: TOKEN,
    account: privateKeyToAccount(generatePrivateKey()),
    claimSigner: RELAYER,
    params,
    timing: { quoteTtlSeconds: 90, intervalCutoffSeconds: 60, minClaimWindowSeconds: 30 },
    store: new Store(null),
    now: () => NOW,
    fetchEvent: async () => game(),
    fetchDepth: async () => {
      if (++tries % 2 === 1) throw new Error("Gemini 503");
      return { bid: "0.38", asks: [{ price: "0.39", amount: "9000.0" }] };
    },
  });
  assert.equal((await flaky.getPrice(wings)).breakdown.chance, 0.39);
  assert.equal(tries, 2);
});

test("signQuote_overCapacity_saysHowManyCustomersFit", async () => {
  const { pricer } = setup(game());
  const err = await refusal(pricer.signQuote({ ...wings, maxClaims: 305, merchant: MERCHANT }), "over-capacity");
  assert.equal(err.maxCustomers, 304);
  assert.equal(err.message, "We can cover up to 304 customers on this game right now.");
  // The unsigned price for the same request is not an error: it reports the limit.
  const p = await pricer.getPrice({ ...wings, maxClaims: 305 });
  assert.equal(p.limit, "exposure");
  assert.equal(p.maxCustomers, 304);
});

test("signQuote_tooLikely_isRefused", async () => {
  const event = game();
  event.contracts[0]!.prices = { bestBid: "0.96", bestAsk: "0.97" };
  await refusal(setup(event).pricer.signQuote({ ...wings, maxClaims: 1, merchant: MERCHANT }), "too-likely");
});

test("signQuote_hedgeMode_needsExactlyOneClaim", async () => {
  const { pricer } = setup(game());
  await refusal(pricer.signQuote({ ...wings, hedgeMode: true, merchant: MERCHANT }), "bad-request");
  const res = await pricer.signQuote({ ...wings, maxClaims: 1, hedgeMode: true, merchant: MERCHANT });
  assert.equal(res.quote.hedgeMode, true);
});

// Gemini's Austin market: no start time, closing 04:59:59 UTC after its day.
const austin = (closeIn: number): GeminiEvent => ({
  id: "456364",
  ticker: "WXHIGH-AUS-2611150459",
  title: "Highest temperature in Austin on November 14, 2026?",
  category: "Weather",
  status: "active",
  expiryDate: iso(NOW + closeIn),
  subcategory: { name: "Daily Temperature" },
  contracts: [
    {
      id: "456364-1129950",
      label: "66°F or below",
      instrumentSymbol: "GEMI-WXHIGH-AUS-2611150459-LO66",
      marketState: "open",
      expiryDate: iso(NOW + closeIn),
      prices: { bestBid: "0.32", bestAsk: "0.37" },
    },
  ],
});
const cover = { eventTicker: "WXHIGH-AUS-2611150459", instrumentSymbol: "GEMI-WXHIGH-AUS-2611150459-LO66", payoutPerClaim: 250n * USDC, maxClaims: 1 };

test("getPrice_dailyHigh_isSoldUntilItsDayBegins", async () => {
  // The market closes in 30 hours, so its day begins in 6.
  const { pricer, clock } = setup(austin(30 * 3600));
  const p = await pricer.getPrice(cover);
  assert.equal(p.claimDeadline, NOW + 6 * 3600);
  assert.equal(p.marketCloseTime, NOW + 30 * 3600);
  assert.equal(p.display.condition, "the high in Austin on November 14 is 66°F or below");
  assert.equal(p.display.startTime, NOW + 6 * 3600);
  // 37% of 250 is 92.50; with 5% it is 97.13 once rounded up.
  assert.equal(p.breakdown.cost, "97130000");
  await refusal(pricer.getPrice({ ...cover, claimDeadline: NOW + 6 * 3600 + 1 }), "deadline-too-late");

  // Once the day has begun the high is being measured: nothing is sold on it.
  clock.now = NOW + 6 * 3600;
  await refusal(pricer.getPrice(cover), "event-started");
  clock.now = NOW + 6 * 3600 - 29;
  await refusal(pricer.getPrice(cover), "too-close");
});

test("signQuote_hedgeMode_overCapacity_saysHowMuchTheVaultCanCover", async () => {
  // 100 in the vault: 18 may be at risk. 29.45 of payout at 0.37 plus 5% costs 11.45 and puts exactly 18 at risk.
  const { pricer } = setup(austin(30 * 3600), { balance: 100n * USDC });
  const err = await refusal(pricer.signQuote({ ...cover, hedgeMode: true, merchant: MERCHANT }), "over-capacity");
  assert.equal(err.maxPayout, 29_450_000n);
  assert.equal(err.message, "We can cover up to $29.45 on this right now.");
  const fits = await pricer.signQuote({ ...cover, payoutPerClaim: 29_450_000n, hedgeMode: true, merchant: MERCHANT });
  assert.deepEqual([fits.quote.hedgeMode, fits.quote.maxClaims, fits.quote.claimDeadline], [true, 1, NOW + 6 * 3600]);

  // A vault with nothing free can cover nothing.
  const none = await refusal(
    setup(austin(30 * 3600), { balance: 0n }).pricer.signQuote({ ...cover, hedgeMode: true, merchant: MERCHANT }),
    "over-capacity",
  );
  assert.equal(none.message, "We cannot cover this right now.");
});

test("signQuote_liveQuotes_countUntilTheyExpireOrAreUsed", async () => {
  const { pricer, clock, state } = setup(game());
  // 280 customers fit once. A second quote for 280 does not: the first may still become a promo.
  const big = { ...wings, maxClaims: 280, merchant: MERCHANT };
  const first = await pricer.signQuote(big);
  const err = await refusal(pricer.signQuote(big), "over-capacity");
  assert.ok(err.maxCustomers! < 280 && err.maxCustomers! > 0);

  // Once the first quote has expired unused, the room is back.
  clock.now += 91;
  const second = await pricer.signQuote(big);

  // The second quote is used on chain: it is in the balance and the lock now, and is not counted twice.
  state.used.add(second.quote.nonce);
  state.balance += BigInt(second.quote.premium);
  state.locked += 280n * 20n * USDC;
  const after = await pricer.getPrice({ ...wings, maxClaims: 1 });
  assert.equal(after.maxCustomers, err.maxCustomers);
  assert.notEqual(first.quote.nonce, second.quote.nonce);
});

test("signQuote_requestsAtTheSameTime_cannotBothTakeTheSameRoom", async () => {
  const { pricer } = setup(game());
  const big = { ...wings, maxClaims: 280, merchant: MERCHANT };
  const results = await Promise.allSettled([pricer.signQuote(big), pricer.signQuote(big)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
});

test("getPrice_game_carriesTheWordsForTheCard", async () => {
  const event = game({
    subcategory: { name: "Pro Football" },
    participants: [{ name: "Minnesota Vikings", side: "home" }],
  });
  event.contracts[0]!.label = "Minnesota";
  event.contracts[0]!.sportsSide = "home";
  event.contracts[0]!.description = { content: [{ value: "If Minnesota wins, this market will resolve to Yes." }] };
  const p = await setup(event).pricer.getPrice(wings);
  assert.equal(p.display.team, "Vikings");
  assert.equal(p.display.condition, "the Vikings win");
  assert.equal(p.display.league, "Pro Football");
  assert.equal(p.display.startTime, NOW + 3 * 3600);
  assert.equal(p.rule, "If Minnesota wins, this market will resolve to Yes.");
});

test("signQuote_thePriceTheQuoteWasMadeOn_isKeptUnderItsNonce_forThePromosChart", async () => {
  const { pricer, store } = setup(game());
  const res = await pricer.signQuote({ ...wings, merchant: MERCHANT });
  // The time Gemini was read, the chance the price was made on (the ask), the bid and the ask.
  assert.deepEqual(store.data.pendingOdds[res.quote.nonce], [NOW, 3900, 3800, 3900]);
  assert.equal(res.breakdown.chance, 0.39);
});

test("signQuote_label_isKeptUnderTheQuotesNonce", async () => {
  const { pricer, store } = setup(game());
  const res = await pricer.signQuote({ ...wings, merchant: MERCHANT, label: { item: "Wings", business: "Tony's Pizza" } });
  const kept = store.data.pendingLabels[res.quote.nonce];
  assert.equal(kept?.item, "Wings");
  assert.equal(kept?.business, "Tony's Pizza");
  assert.equal(kept?.premium, res.quote.premium);
  assert.equal(kept?.merchant, MERCHANT);

  // A quote with nothing to remember keeps nothing.
  const bare = await pricer.signQuote({ ...wings, maxClaims: 10, merchant: MERCHANT, label: { item: "", business: "" } });
  assert.equal(store.data.pendingLabels[bare.quote.nonce], undefined);
});
