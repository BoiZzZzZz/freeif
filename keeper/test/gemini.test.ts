import assert from "node:assert/strict";
import { test } from "node:test";
import { intervalTicker, isIntervalMarket, priceToBps, toUnix, upcomingIntervalTickers } from "../src/gemini.ts";

test("intervalTicker_carriesTheCloseTimeInUtc", () => {
  assert.equal(intervalTicker("BTC05M", new Date("2026-10-25T06:45:00Z")), "BTC05M2610250645");
  assert.equal(intervalTicker("ETH15M", new Date("2027-01-02T00:00:00Z")), "ETH15M2701020000");
});

test("upcomingIntervalTickers_startsWithTheWindowThatIsRunning", () => {
  const windows = upcomingIntervalTickers("BTC05M", new Date("2026-11-13T03:54:41Z"), 3);
  assert.deepEqual(windows.map((w) => w.ticker), ["BTC05M2611130355", "BTC05M2611130400", "BTC05M2611130405"]);
  // Exactly on a boundary, the window that just closed is not offered.
  const onBoundary = upcomingIntervalTickers("BTC15M", new Date("2026-11-13T23:45:00Z"), 2);
  assert.deepEqual(onBoundary.map((w) => w.ticker), ["BTC15M2611140000", "BTC15M2611140015"]);
  assert.throws(() => upcomingIntervalTickers("NFL", new Date(), 1));
});

test("isIntervalMarket_onlyFiveAndFifteenMinuteTickers", () => {
  assert.ok(isIntervalMarket({ ticker: "BTC05M2611130355" }));
  assert.ok(isIntervalMarket({ ticker: "SOL15M2611130400" }));
  assert.ok(!isIntervalMarket({ ticker: "NFL-2610251700-IND-MIN-M" }));
  assert.ok(!isIntervalMarket({ ticker: "WXHIGH-AUS-2611140459" }));
});

test("priceToBps_readsAPrice_andRefusesWhatIsNotOne", () => {
  assert.equal(priceToBps("0.39"), 3900);
  assert.equal(priceToBps("0.5"), 5000);
  assert.equal(priceToBps("0.01"), 100);
  assert.equal(priceToBps(undefined), null);
  assert.equal(priceToBps(""), null);
  assert.equal(priceToBps("0"), null);
  assert.equal(priceToBps("1"), null);
  assert.equal(priceToBps("abc"), null);
});

test("toUnix_readsGeminisTimestamps", () => {
  assert.equal(toUnix("2026-11-13T03:55:00.000Z"), 1794542100);
});
