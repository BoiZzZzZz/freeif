// The words on the card, the game list for the merchant form, and the promo labels.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import type { Quote } from "../src/chain.ts";
import { Games, LEAGUES, WEATHER, toGames, toWeather } from "../src/games.ts";
import { eventStart, ruleText, type GeminiContract, type GeminiEvent } from "../src/gemini.ts";
import { cleanText, findLabel, pendingLabel, prunePending, type PendingLabel, type PromoKey } from "../src/labels.ts";
import { displayNames, nickname } from "../src/names.ts";

const NOW = 1_794_500_000;
const iso = (unix: number) => new Date(unix * 1000).toISOString();

const side = (label: string, sportsSide: string, bid?: string, ask?: string): GeminiContract => ({
  id: label,
  label,
  instrumentSymbol: `GEMI-${label.toUpperCase().replace(/\W/g, "")}`,
  marketState: "open",
  sportsSide,
  prices: { bestBid: bid, bestAsk: ask },
});

// As Gemini lists it: the label is the city, the participant has the full name.
const nba = (over: Partial<GeminiEvent> = {}): GeminiEvent => ({
  id: "1",
  ticker: "NBA-2611140100-CLE-MIA-M",
  title: "Cleveland vs Miami",
  category: "Sports",
  status: "active",
  startTime: iso(NOW + 3600),
  expiryDate: iso(NOW + 2 * 86400),
  subcategory: { name: "Pro Basketball" },
  participants: [
    { name: "Miami Heat", side: "home" },
    { name: "Cleveland Cavaliers", side: "away" },
  ],
  contracts: [side("Miami", "home", "0.55", "0.56"), side("Cleveland", "away", "0.44", "0.45")],
  ...over,
});

const college = (): GeminiEvent => ({
  id: "2",
  ticker: "NCAAM-2611140000-UGA-UNC-M",
  title: "Georgia vs North Carolina",
  category: "Sports",
  status: "active",
  startTime: iso(NOW + 7200),
  expiryDate: iso(NOW + 2 * 86400),
  subcategory: { name: "College Basketball" },
  participants: [
    { name: "North Carolina Tar Heels", side: "home" },
    { name: "Georgia Bulldogs", side: "away" },
  ],
  contracts: [side("North Carolina", "home", "0.62", "0.63"), side("Georgia", "away", "0.36", "0.37")],
});

// Gemini's Austin market for Nov 14 as it was listed on Nov 13: no start time, no teams, a contract per
// two-degree range, closing at 04:59:59 UTC the next day. `closeIn` is how far away that close is.
const range = (ticker: string, label: string, bid?: string, ask?: string): GeminiContract => ({
  id: ticker,
  label,
  instrumentSymbol: `GEMI-WXHIGH-AUS-2611150459-${ticker}`,
  marketState: "open",
  prices: { bestBid: bid, bestAsk: ask },
});
const austin = (closeIn: number, over: Partial<GeminiEvent> = {}): GeminiEvent => ({
  id: "456364",
  ticker: "WXHIGH-AUS-2611150459",
  title: "Highest temperature in Austin on November 14, 2026?",
  category: "Weather",
  status: "active",
  series: "WXHIGH",
  expiryDate: iso(NOW + closeIn),
  subcategory: { name: "Daily Temperature" },
  participants: [],
  contracts: [
    range("69TO70", "69°F to 70°F", "0.14", "0.22"),
    range("LO66", "66°F or below", "0.32", "0.37"),
    range("HI75", "75°F or above", undefined, "0.01"),
    range("67TO68", "67°F to 68°F", "0.23", "0.33"),
  ],
  ...over,
});

test("nickname_isWhatIsLeftOfTheFullNameAfterTheSharedWords", () => {
  assert.equal(nickname("Miami", "Miami Heat"), "Heat");
  assert.equal(nickname("New York R", "New York Rangers"), "Rangers");
  assert.equal(nickname("Vegas", "Vegas Golden Knights"), "Golden Knights");
  assert.equal(nickname("Portland", "Portland Trail Blazers"), "Trail Blazers");
  // Nothing shared, or nothing left: keep the label.
  assert.equal(nickname("FIU", "Florida International Panthers"), "FIU");
  assert.equal(nickname("Miami Heat", "Miami Heat"), "Miami Heat");
});

test("displayNames_proTeam_goesByItsNicknameWithThe", () => {
  const event = nba();
  assert.deepEqual(displayNames(event, event.contracts[0]!), {
    game: "Cavaliers at Heat",
    team: "Heat",
    subject: "the Heat",
    condition: "the Heat win",
    league: "Pro Basketball",
    startTime: NOW + 3600,
  });
  assert.equal(displayNames(event, event.contracts[1]!).condition, "the Cavaliers win");
});

test("displayNames_college_goesByItsOwnName", () => {
  const event = college();
  const names = displayNames(event, event.contracts[1]!);
  assert.equal(names.game, "Georgia at North Carolina");
  assert.equal(names.subject, "Georgia");
  assert.equal(names.condition, "Georgia wins");
});

test("displayNames_notAGame_keepsGeminisTitle", () => {
  const event: GeminiEvent = {
    id: "3",
    ticker: "BTC05M2611130515",
    title: "BTC price today at 12:15am EST",
    category: "Crypto",
    status: "active",
    expiryDate: iso(NOW + 300),
    contracts: [{ id: "3-1", label: "Up", instrumentSymbol: "GEMI-BTC05M2611130515-UP" }],
  };
  const names = displayNames(event, event.contracts[0]!);
  assert.equal(names.game, "BTC price today at 12:15am EST");
  assert.equal(names.subject, "");
  assert.equal(names.condition, "BTC price today at 12:15am EST is Up");
  assert.equal(names.startTime, null);
});

test("displayNames_dailyHigh_namesTheCityTheDayAndTheRange", () => {
  const event = austin(30 * 3600);
  const d = displayNames(event, event.contracts[1]!);
  assert.equal(d.game, "Austin high on November 14");
  assert.equal(d.team, "66°F or below");
  assert.equal(d.condition, "the high in Austin on November 14 is 66°F or below");
  // Not a game: the pages do not say "win" or "lose" about it.
  assert.equal(d.subject, "");
  assert.equal(d.league, "Daily Temperature");
  // Its day begins 24 hours before it closes.
  assert.equal(d.startTime, NOW + 6 * 3600);
  // A title Gemini words another way keeps Gemini's words.
  const odd = austin(30 * 3600, { title: "Austin high temp" });
  assert.equal(displayNames(odd, odd.contracts[1]!).condition, "Austin high temp is 66°F or below");
});

test("eventStart_isKickoff_orTheStartOfATemperatureMarketsDay", () => {
  assert.equal(eventStart(nba()), NOW + 3600);
  assert.equal(eventStart(austin(30 * 3600)), NOW + 6 * 3600);
  // Anything else with no start time has none.
  assert.equal(eventStart({ ticker: "GOLD-2611132200", expiryDate: iso(NOW + 3600) }), null);
});

test("toWeather_listsEachCityAndDay_rangesFromTheColdestUp", () => {
  const dallas = austin(30 * 3600, { id: "9", ticker: "WXHIGH-DFW-2611150459", title: "Highest temperature in Dallas on November 14, 2026?" });
  const [first, second] = toWeather([dallas, austin(30 * 3600), austin(30 * 3600)], NOW, rules);
  assert.deepEqual([first!.game, first!.city, first!.day], ["Austin high on November 14", "Austin", "November 14"]);
  assert.equal(second!.city, "Dallas");
  assert.equal(first!.startTime, NOW + 6 * 3600);
  assert.deepEqual(
    first!.teams.map((t) => [t.team, t.chance, t.quotable]),
    [
      ["66°F or below", 0.37, true],
      ["67°F to 68°F", 0.33, true],
      ["69°F to 70°F", 0.22, true],
      // An offer of a cent with nobody bidding is not a 1% chance.
      ["75°F or above", 0.01, false],
    ],
  );
  assert.equal(first!.teams[0]!.condition, "the high in Austin on November 14 is 66°F or below");
});

test("toWeather_aDayThatHasBegun_orWithNoPrice_isLeftOut", () => {
  // The market closes in 20 hours: its day began four hours ago and the high is being measured.
  assert.deepEqual(toWeather([austin(20 * 3600)], NOW, rules), []);
  assert.equal(toWeather([austin(24 * 3600 + 30)], NOW, rules).length, 1);
  assert.deepEqual(toWeather([austin(24 * 3600 + 29)], NOW, rules), []);
  // Most cities' books are one-sided on every range.
  const empty = austin(30 * 3600);
  for (const c of empty.contracts) c.prices = { bestAsk: "0.02" };
  assert.deepEqual(toWeather([empty], NOW, rules), []);
  assert.deepEqual(toWeather([austin(30 * 3600, { status: "under_review" })], NOW, rules), []);
});

test("Games_weather_readsGeminisWeatherCategory", async () => {
  const asked: string[] = [];
  const games = new Games({
    ...rules,
    now: () => NOW,
    fetchPage: async (search, offset) => {
      asked.push(`${search}@${offset}`);
      return { data: [austin(30 * 3600), austin(20 * 3600, { id: "8", ticker: "WXHIGH-AUS-2611140459" })], pagination: { total: 2 } };
    },
  });
  const list = await games.list(WEATHER);
  assert.deepEqual(asked, ["WXHIGH@0"]);
  assert.equal(list.league, "weather");
  assert.deepEqual(list.games.map((g) => g.eventTicker), ["WXHIGH-AUS-2611150459"]);
});

test("ruleText_flattensGeminisRichTextIntoOneLine", () => {
  const description = {
    nodeType: "document",
    content: [
      { nodeType: "text", value: "If Miami wins the game,\n this market" },
      { nodeType: "paragraph", content: [{ nodeType: "text", value: "will resolve to Yes." }] },
    ],
  };
  assert.equal(ruleText(description), "If Miami wins the game, this market will resolve to Yes.");
  assert.equal(ruleText(undefined), "");
});

const rules = { spreadBps: 500, minLeadSeconds: 30 };

test("toGames_listsWinnerMarketsOnly_awayTeamFirst", () => {
  const spread = nba({ ticker: "NBA-2611140100-CLE-MIA-S", title: "Cleveland vs Miami: Point Spread" });
  const games = toGames([spread, nba(), college()], NOW, rules);
  assert.deepEqual(
    games.map((g) => g.eventTicker),
    ["NBA-2611140100-CLE-MIA-M", "NCAAM-2611140000-UGA-UNC-M"],
  );
  assert.equal(games[0]!.game, "Cavaliers at Heat");
  assert.deepEqual(
    games[0]!.teams.map((t) => [t.team, t.chance, t.quotable]),
    [
      ["Cavaliers", 0.45, true],
      ["Heat", 0.56, true],
    ],
  );
});

test("toGames_gameThatHasStartedOrIsAboutTo_isLeftOut", () => {
  assert.equal(toGames([nba({ startTime: iso(NOW - 60) })], NOW, rules).length, 0);
  assert.equal(toGames([nba({ startTime: iso(NOW + 10) })], NOW, rules).length, 0);
  assert.equal(toGames([nba({ status: "settled" })], NOW, rules).length, 0);
  assert.equal(toGames([nba({ startTime: iso(NOW + 9 * 86400) })], NOW, rules).length, 0, "more than 8 days ahead");
});

test("toGames_oneSidedOrTooLikelyPrice_cannotBePicked", () => {
  // Gemini shows an empty book as an ask of 0.02 with no bid, and the favorite with no ask at all.
  const lopsided = nba({ contracts: [side("Miami", "home", "0.98", undefined), side("Cleveland", "away", undefined, "0.02")] });
  assert.equal(toGames([lopsided], NOW, rules).length, 0, "no team can be picked, so the game is not listed");

  // 0.96 with a 5% spread would cost more than it pays.
  const favorite = nba({ contracts: [side("Miami", "home", "0.95", "0.96"), side("Cleveland", "away", "0.04", "0.05")] });
  const [game] = toGames([favorite], NOW, rules);
  assert.deepEqual(
    game!.teams.map((t) => [t.team, t.quotable]),
    [
      ["Cavaliers", true],
      ["Heat", false],
    ],
  );
});

const NBA = LEAGUES.find((l) => l.key === "nba")!;

test("Games_readsALeaguesPagesOnce_thenServesFromMemory", async () => {
  const asked: string[] = [];
  const later = nba({ ticker: "NBA-2611150100-ATL-CHI-M", startTime: iso(NOW + 86400) });
  const filler = (n: number) =>
    Array.from({ length: n }, (_, i) => nba({ ticker: `NBA-2611140100-CLE-MIA-P${i}`, title: "A player market" }));
  const games = new Games({
    ...rules,
    now: () => NOW,
    fetchPage: async (search, offset) => {
      asked.push(`${search}@${offset}`);
      // "NBA" also finds a WNBA season market; it is not a game of this league.
      const wnba = nba({ ticker: "WNBA27MVP-M", startTime: undefined });
      return offset === 0
        ? { data: [nba(), ...filler(99)], pagination: { total: 150 } }
        : { data: [later, wnba], pagination: { total: 150 } };
    },
  });
  const first = await games.list(NBA);
  assert.deepEqual(asked, ["NBA@0", "NBA@100"], "150 events are two pages");
  assert.deepEqual(
    first.games.map((g) => g.eventTicker),
    ["NBA-2611140100-CLE-MIA-M", "NBA-2611150100-ATL-CHI-M"],
  );
  await games.list(NBA);
  assert.equal(asked.length, 2, "the second call is served from memory");
});

test("Games_pageThatFailsTwice_keepsThePagesAlreadyRead", async () => {
  const asked: number[] = [];
  const filler = Array.from({ length: 99 }, (_, i) => nba({ ticker: `NBA-2611140100-CLE-MIA-P${i}` }));
  const games = new Games({
    ...rules,
    now: () => NOW,
    retryPauseMs: 0,
    fetchPage: async (_search, offset) => {
      asked.push(offset);
      if (offset > 0) throw new Error("Gemini 503");
      return { data: [nba(), ...filler], pagination: { total: 300 } };
    },
  });
  assert.equal((await games.list(NBA)).games.length, 1);
  assert.deepEqual(asked, [0, 100, 100], "the second page is tried twice, then the list stops there");

  // The first page failing is a failure: there is nothing to show.
  const down = new Games({ ...rules, retryPauseMs: 0, fetchPage: async () => Promise.reject(new Error("Gemini 503")) });
  await assert.rejects(down.list(NBA), /503/);
});

test("Games_gameThatStartsWhileItsListIsHeld_isNoLongerListed", async () => {
  const clock = { now: NOW };
  const games = new Games({
    ...rules,
    now: () => clock.now,
    fetchPage: async () => ({ data: [nba()], pagination: { total: 1 } }),
  });
  assert.equal((await games.list(NBA)).games.length, 1);
  clock.now = NOW + 3600;
  assert.equal((await games.list(NBA)).games.length, 0);
});

const MERCHANT: Address = "0xF9Aac480396174FFF98988D25d74c78Af7Abfb88";
const hex = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const quote = (over: Partial<Quote> = {}): Quote => ({
  merchant: MERCHANT,
  claimSigner: "0xa03aF58DF0B042fFA9342F178bb37F8a9f1E3286",
  geminiEventId: hex(1),
  instrumentSymbol: hex(2),
  payoutPerClaim: 8_000_000n,
  maxClaims: 12,
  premium: 39_310_000n,
  claimDeadline: BigInt(NOW + 3600),
  marketCloseTime: BigInt(NOW + 2 * 86400),
  hedgeMode: false,
  expiry: BigInt(NOW + 90),
  nonce: hex(100),
  ...over,
});
const promoOf = (q: Quote): PromoKey => ({
  merchant: q.merchant.toLowerCase() as Address,
  geminiEventId: q.geminiEventId,
  instrumentSymbol: q.instrumentSymbol,
  payoutPerClaim: q.payoutPerClaim,
  maxClaims: q.maxClaims,
  premiumPaid: q.premium,
  claimDeadline: q.claimDeadline,
});

test("cleanText_isOneShortLine_whateverIsSent", () => {
  assert.equal(cleanText("  Wings \n and\tfries  "), "Wings and fries");
  assert.equal(cleanText("x".repeat(100)).length, 40);
  assert.equal(cleanText(42), "");
  assert.equal(cleanText(undefined), "");
});

test("findLabel_promo_findsTheLabelSentWithItsQuote", () => {
  const wings = quote();
  const pending: Record<Hex, PendingLabel> = {
    [hex(100)]: pendingLabel(wings, { item: "Wings", business: "Tony's Pizza" }, NOW),
    [hex(101)]: pendingLabel(quote({ maxClaims: 25, nonce: hex(101) }), { item: "Dessert", business: "Tony's Pizza" }, NOW),
  };
  assert.equal(findLabel(pending, promoOf(wings)), hex(100));
  // Another merchant's promo with the same numbers is not a match, and neither is another price.
  assert.equal(findLabel(pending, { ...promoOf(wings), merchant: "0x5442DE8276aB4770a1e4EAAB6E6284c575987440" }), null);
  assert.equal(findLabel(pending, { ...promoOf(wings), premiumPaid: 39_320_000n }), null);
});

test("findLabel_twoIdenticalQuotes_newestWins", () => {
  const q = quote();
  const pending: Record<Hex, PendingLabel> = {
    [hex(100)]: pendingLabel(q, { item: "Wings", business: "" }, NOW),
    [hex(101)]: pendingLabel(q, { item: "Hot wings", business: "" }, NOW + 20),
  };
  assert.equal(findLabel(pending, promoOf(q)), hex(101));
});

test("prunePending_keepsTheNewest2000", () => {
  const pending: Record<Hex, PendingLabel> = {};
  for (let i = 0; i < 2005; i++) pending[hex(i)] = pendingLabel(quote(), { item: "Wings", business: "" }, NOW + i);
  prunePending(pending);
  assert.equal(Object.keys(pending).length, 2000);
  assert.equal(pending[hex(0)], undefined);
  assert.ok(pending[hex(2004)]);
});
