// The odds history (SPEC section 3): the keeper's readings of Gemini's order book for each open promo,
// with Gemini replaced by a fake whose book the test moves.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import { Status, type PublicClient, type WalletClient } from "../src/chain.ts";
import { topOfBook, type TopOfBook } from "../src/gemini.ts";
import { Keeper } from "../src/keeper.ts";
import { Odds, keepPending, readBook, thin, type OddsPoint, type OpenPromo } from "../src/odds.ts";
import { makeApp } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { Feed } from "../src/stream.ts";

const VAULT: Address = "0x68a00243927f250dBcD9160b5d06623b62B2e06d";
const GAME: Hex = `0x${"11".repeat(32)}`;
const LIONS: Hex = `0x${"22".repeat(32)}`;
const BEARS: Hex = `0x${"33".repeat(32)}`;
const UP: Hex = `0x${"55".repeat(32)}`;
const NOW = 1_794_500_000;

function setup() {
  const clock = { now: NOW };
  // What Gemini's book shows for each symbol. Null is a symbol Gemini does not have.
  const books: Record<string, TopOfBook | null> = {
    "GEMI-DET": { bid: "0.39", ask: "0.41" },
    "GEMI-CHI": { bid: "0.58", ask: "0.60" },
    "GEMI-UP": { bid: "0.49", ask: "0.5" },
  };
  const gemini: { down: boolean; hold: Promise<void> | null } = { down: false, hold: null };
  const fetched: string[] = [];
  const logged: string[] = [];
  const store = new Store(null);
  store.data.instruments[LIONS] = { symbol: "GEMI-DET", label: "Detroit" };
  store.data.instruments[BEARS] = { symbol: "GEMI-CHI", label: "Chicago" };
  store.data.instruments[UP] = { symbol: "GEMI-UP", label: "Up" };
  const odds = new Odds({
    store,
    everySeconds: 30,
    now: () => clock.now,
    log: (line) => logged.push(line),
    fetchBook: async (symbol) => {
      fetched.push(symbol);
      if (gemini.hold) await gemini.hold;
      if (gemini.down) throw new Error("Gemini 503 on /v1/book");
      return books[symbol] ?? null;
    },
  });
  const lions: OpenPromo = { promoId: "0", instrumentSymbol: LIONS };
  const bears: OpenPromo = { promoId: "1", instrumentSymbol: BEARS };
  const btc: OpenPromo = { promoId: "2", instrumentSymbol: UP };
  /** One pass of the loop, `seconds` after the last one. */
  const pass = (seconds: number, promos: OpenPromo[] = [lions]) => {
    clock.now += seconds;
    return odds.sample(promos);
  };
  return { odds, store, books, gemini, clock, fetched, logged, lions, bears, btc, pass };
}

test("topOfBook_readsGeminisOrderBook_asItAnswers", () => {
  // Three answers of GET /v1/book/<symbol>?limit_bids=1&limit_asks=1, read on Nov 13.
  const game = { bids: [{ price: "0.42", amount: "213.0", timestamp: "1794586349" }], asks: [{ price: "0.43", amount: "5138.12", timestamp: "1794586349" }] };
  assert.deepEqual(topOfBook(game), { bid: "0.42", ask: "0.43" });
  assert.deepEqual(topOfBook({ bids: [], asks: [] }), { bid: null, ask: null });
  assert.deepEqual(topOfBook({ bids: [], asks: [{ price: "0.02", amount: "10.0", timestamp: "1" }] }), { bid: null, ask: "0.02" });
  assert.deepEqual(topOfBook(null), { bid: null, ask: null });
  assert.deepEqual(topOfBook({ result: "error" }), { bid: null, ask: null });
});

test("readBook_theChanceIsTheAsk_ofABookWithTwoSides", () => {
  assert.deepEqual(readBook({ bid: "0.39", ask: "0.41" }, NOW), [NOW, 4100, 3900, 4100]);
  assert.deepEqual(readBook({ bid: "0.4200", ask: "0.4300" }, NOW), [NOW, 4300, 4200, 4300]);
});

test("readBook_aBookThatIsNoPrice_isNull", () => {
  // An empty book on Gemini: an ask of 0.02 and no bid. And the other way round.
  assert.equal(readBook({ bid: null, ask: "0.02" }, NOW), null);
  assert.equal(readBook({ bid: "0.40", ask: null }, NOW), null);
  // A settled contract's book.
  assert.equal(readBook({ bid: null, ask: null }, NOW), null);
  // A window that has not started: a placeholder on each side.
  assert.equal(readBook({ bid: "0.01", ask: "0.99" }, NOW), null);
  // A wide book that is still a market: half a dollar apart, not more.
  assert.deepEqual(readBook({ bid: "0.20", ask: "0.70" }, NOW), [NOW, 7000, 2000, 7000]);
  // 1 and 0 are a result, not a chance.
  assert.equal(readBook({ bid: "0.99", ask: "1" }, NOW), null);
});

test("sample_readsEachContractOnce_andTwoPromosOnOneTeamShareTheRead", async () => {
  const { store, fetched, lions, bears, btc, pass } = setup();
  const lionsAgain: OpenPromo = { promoId: "3", instrumentSymbol: LIONS };
  assert.equal(await pass(30, [lions, bears, btc, lionsAgain]), 4);
  assert.deepEqual(fetched, ["GEMI-DET", "GEMI-CHI", "GEMI-UP"]);
  assert.deepEqual(store.data.odds["0"], [[NOW + 30, 4100, 3900, 4100]]);
  assert.deepEqual(store.data.odds["1"], [[NOW + 30, 6000, 5800, 6000]]);
  assert.deepEqual(store.data.odds["2"], [[NOW + 30, 5000, 4900, 5000]]);
  assert.deepEqual(store.data.odds["3"], store.data.odds["0"]);
});

test("sample_aReadingThatMoved_isKept_andOneThatDidNot_isKeptEveryFiveMinutes", async () => {
  const { odds, store, books, pass } = setup();
  await pass(30);
  books["GEMI-DET"] = { bid: "0.40", ask: "0.42" };
  assert.equal(await pass(30), 1);
  // Nine passes with the same book: four and a half minutes, nothing kept.
  for (let i = 0; i < 9; i++) assert.equal(await pass(30), 0);
  assert.equal(store.data.odds["0"]!.length, 2);
  // The page still gets the newest reading, so its line reaches the present.
  assert.deepEqual(odds.history("0").latest, [NOW + 330, 4200, 4000, 4200]);
  // The tenth is five minutes after the last one kept.
  assert.equal(await pass(30), 1);
  assert.deepEqual(store.data.odds["0"]!.at(-1), [NOW + 360, 4200, 4000, 4200]);
});

test("sample_aChangeAfterAQuietStretch_keepsTheReadingBeforeIt_soTheLineStaysFlatUpToTheChange", async () => {
  const { store, books, pass } = setup();
  await pass(30);
  await pass(30);
  await pass(30);
  books["GEMI-DET"] = { bid: "0.55", ask: "0.57" };
  assert.equal(await pass(30), 1);
  assert.deepEqual(store.data.odds["0"], [
    [NOW + 30, 4100, 3900, 4100],
    [NOW + 90, 4100, 3900, 4100],
    [NOW + 120, 5700, 5500, 5700],
  ]);
});

test("sample_aBookThatIsNoPrice_orASymbolGeminiDoesNotHave_addsNothing", async () => {
  const { store, books, pass } = setup();
  await pass(30);
  books["GEMI-DET"] = { bid: null, ask: null };
  assert.equal(await pass(30), 0);
  books["GEMI-DET"] = null;
  assert.equal(await pass(30), 0);
  assert.equal(store.data.odds["0"]!.length, 1);
});

test("sample_aPromoWhoseSymbolTheKeeperDoesNotHave_isSkipped", async () => {
  const { store, fetched, pass } = setup();
  const unknown: OpenPromo = { promoId: "9", instrumentSymbol: `0x${"99".repeat(32)}` };
  assert.equal(await pass(30, [unknown]), 0);
  assert.deepEqual(fetched, []);
  assert.equal(store.data.odds["9"], undefined);
});

test("sample_whenGeminiFails_doesNotThrow_andSaysSoOnce", async () => {
  const { gemini, logged, lions, pass } = setup();
  gemini.down = true;
  assert.equal(await pass(30, [lions]), 0);
  assert.equal(await pass(30, [lions]), 0);
  assert.equal(logged.length, 1);
  gemini.down = false;
  assert.equal(await pass(30, [lions]), 1);
});

test("sample_calledWhileTheLastOneIsWaitingForGemini_doesNothing", async () => {
  const { gemini, fetched, pass } = setup();
  let release = () => {};
  gemini.hold = new Promise((resolve) => { release = resolve; });
  const first = pass(30);
  assert.equal(await pass(30), 0);
  gemini.hold = null;
  release();
  assert.equal(await first, 1);
  assert.equal(fetched.length, 1);
});

test("start_theReadingTheQuoteWasPricedOn_isTheFirstPoint_atTheTimeThePromoStarted", async () => {
  const { odds, store, pass } = setup();
  const nonce: Hex = `0x${"ab".repeat(32)}`;
  keepPending(store.data.pendingOdds, nonce, [NOW - 40, 3900, 3800, 3900]);
  // The loop reads the new promo before the feed has its PromoCreated.
  await pass(5);
  odds.start("0", nonce, NOW + 2);
  assert.deepEqual(store.data.oddsStart["0"], [NOW + 2, 3900, 3800, 3900]);
  assert.equal(store.data.pendingOdds[nonce], undefined);
  assert.deepEqual(odds.history("0"), {
    everySeconds: 30,
    start: [NOW + 2, 3900, 3800, 3900],
    points: [[NOW + 5, 4100, 3900, 4100]],
    latest: [NOW + 5, 4100, 3900, 4100],
  });
  // A nonce with no reading kept for it changes nothing.
  odds.start("0", `0x${"cd".repeat(32)}`, NOW + 500);
  assert.deepEqual(store.data.oddsStart["0"], [NOW + 2, 3900, 3800, 3900]);
});

test("history_aPromoThatHasOnlyItsFirstReading_hasItAsTheLatest", () => {
  const { odds, store } = setup();
  const nonce: Hex = `0x${"ab".repeat(32)}`;
  keepPending(store.data.pendingOdds, nonce, [NOW - 40, 3900, 3800, 3900]);
  odds.start("0", nonce, NOW);
  assert.deepEqual(odds.history("0"), { everySeconds: 30, start: [NOW, 3900, 3800, 3900], points: [], latest: [NOW, 3900, 3800, 3900] });
  assert.deepEqual(odds.chance("0"), { chance: 0.39, at: NOW });
});

test("history_after_givesOnlyTheReadingsLaterThanThat", async () => {
  const { odds, books, pass } = setup();
  await pass(30);
  books["GEMI-DET"] = { bid: "0.45", ask: "0.47" };
  await pass(30);
  books["GEMI-DET"] = { bid: "0.50", ask: "0.52" };
  await pass(30);
  assert.equal(odds.history("0").points.length, 3);
  assert.deepEqual(odds.history("0", NOW + 60).points, [[NOW + 90, 5200, 5000, 5200]]);
  assert.deepEqual(odds.history("0", NOW + 90).points, []);
  assert.deepEqual(odds.chance("0"), { chance: 0.52, at: NOW + 90 });
});

test("history_aPromoWithNoReadings_isEmpty", () => {
  const { odds } = setup();
  assert.deepEqual(odds.history("7"), { everySeconds: 30, start: null, points: [], latest: null });
  assert.equal(odds.chance("7"), null);
});

test("history_afterARestart_theLastReadingKeptIsTheLatest", async () => {
  const { store, pass } = setup();
  await pass(30);
  const again = new Odds({ store, everySeconds: 30 });
  assert.deepEqual(again.history("0").latest, [NOW + 30, 4100, 3900, 4100]);
});

test("thin_dropsEverySecondReadingOfTheOlderHalf_neverTheFirstOrTheNewest", () => {
  const points: OddsPoint[] = Array.from({ length: 10 }, (_, i) => [NOW + i, 4000 + i, null, null]);
  thin(points);
  assert.deepEqual(points.map((p) => p[0] - NOW), [0, 2, 4, 5, 6, 7, 8, 9]);
});

test("sample_keepsAtMost4000ReadingsOfOnePromo", async () => {
  const { store, books, pass } = setup();
  for (let i = 0; i < 4_010; i++) {
    books["GEMI-DET"] = { bid: "0.40", ask: `0.${41 + (i % 40)}` };
    await pass(30);
  }
  const points = store.data.odds["0"]!;
  assert.ok(points.length <= 4_000 && points.length > 1_900, `${points.length} readings`);
  assert.equal(points[0]![0], NOW + 30);
  assert.equal(points.at(-1)![0], NOW + 4_010 * 30);
});

test("keepPending_dropsAReadingOfAQuoteThatIsADayOld", () => {
  const pending: Record<Hex, OddsPoint> = {};
  keepPending(pending, "0x01", [NOW, 3900, 3800, 3900]);
  keepPending(pending, "0x02", [NOW + 86_000, 4000, 3900, 4000]);
  assert.deepEqual(Object.keys(pending), ["0x01", "0x02"]);
  keepPending(pending, "0x03", [NOW + 86_500, 4100, 4000, 4100]);
  assert.deepEqual(Object.keys(pending), ["0x02", "0x03"]);
});

// The loop: every promo that is open goes to the sampler, on every pass, and no other.
test("tick_handsThePromosWithNoResultYet_toTheSampler", async () => {
  const promo = (status: number, symbol: Hex) => ({
    merchant: VAULT,
    geminiEventId: GAME,
    instrumentSymbol: symbol,
    claimCount: 0,
    claimDeadline: BigInt(NOW + 3600),
    settledAt: 0n,
    status,
    paidCount: 0,
  });
  const promos = [promo(Status.Open, LIONS), promo(Status.FinalizedNo, BEARS), promo(Status.Open, BEARS), promo(Status.Vetoed, LIONS)];
  const client = {
    readContract: async ({ functionName }: { functionName: string }) => (functionName === "promoCount" ? BigInt(promos.length) : 30),
    getBlock: async () => ({ timestamp: BigInt(NOW) }),
    multicall: async ({ contracts }: { contracts: { args: readonly bigint[] }[] }) => contracts.map((c) => promos[Number(c.args[0])]),
  } as unknown as PublicClient;
  const seen: OpenPromo[][] = [];
  const keeper = new Keeper({
    client,
    wallet: { account: { address: VAULT } } as unknown as WalletClient,
    vault: VAULT,
    store: new Store(null),
    odds: { sample: async (open) => void seen.push([...open]) },
    log: () => undefined,
  });
  assert.equal(await keeper.tick(), 0);
  assert.deepEqual(seen, [[
    { promoId: "0", instrumentSymbol: LIONS },
    { promoId: "2", instrumentSymbol: BEARS },
  ]]);
});

// The route the promo page reads.
test("GET /promos/:id/odds_givesTheReadings_andOnlyTheNewOnesWithAfter", async () => {
  const { odds, store, books, pass } = setup();
  await pass(30);
  books["GEMI-DET"] = { bid: "0.45", ask: "0.47" };
  await pass(30);
  const feed = new Feed({ store, vault: VAULT, log: () => undefined });
  const unused = {} as never;
  const app = makeApp({ client: unused, vault: VAULT, usdc: VAULT, maxLockedBps: 6000, pricer: unused, games: unused, relayer: unused, oracle: VAULT, store, feed, odds });

  const all = await app.request("/promos/0/odds");
  assert.equal(all.status, 200);
  assert.deepEqual(await all.json(), {
    promoId: "0",
    everySeconds: 30,
    start: null,
    points: [[NOW + 30, 4100, 3900, 4100], [NOW + 60, 4700, 4500, 4700]],
    latest: [NOW + 60, 4700, 4500, 4700],
  });
  const newer = (await (await app.request(`/promos/0/odds?after=${NOW + 30}`)).json()) as { points: OddsPoint[] };
  assert.deepEqual(newer.points, [[NOW + 60, 4700, 4500, 4700]]);

  assert.deepEqual(((await (await app.request("/promos/5/odds")).json()) as { points: OddsPoint[] }).points, []);
  assert.equal((await app.request("/promos/x/odds")).status, 400);
  assert.equal((await app.request("/promos/0/odds?after=soon")).status, 400);
});
