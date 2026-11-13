// The limits on the open routes: the counting itself with a clock the test moves, and the routes through
// the HTTP app with small limits.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import "../src/config.ts";
import { Gate, LIMITS, Limiter, type Limits, type Rule } from "../src/limit.ts";
import { makeApp } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { Feed } from "../src/stream.ts";

const VAULT: Address = "0x68a00243927f250dBcD9160b5d06623b62B2e06d";
const SIX_A_MINUTE: Rule = { name: "six", max: 6, windowMs: 60_000 };

function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, pass: (ms: number) => { at += ms; } };
}

// ---- The counting ----

test("take_aQuietClient_maySendTheWholeAllowanceAtOnce_andThenWaits", () => {
  const { now } = clock();
  const limiter = new Limiter(now);
  for (let i = 0; i < 6; i++) assert.equal(limiter.take(SIX_A_MINUTE, "a"), 0);
  // Six a minute is one every ten seconds.
  assert.equal(limiter.take(SIX_A_MINUTE, "a"), 10);
});

test("take_theAllowanceComesBackEvenly_notAllAtTheEndOfTheMinute", () => {
  const { now, pass } = clock();
  const limiter = new Limiter(now);
  for (let i = 0; i < 6; i++) limiter.take(SIX_A_MINUTE, "a");
  pass(9_000);
  assert.equal(limiter.take(SIX_A_MINUTE, "a"), 1);
  pass(1_000);
  assert.equal(limiter.take(SIX_A_MINUTE, "a"), 0);
  assert.equal(limiter.take(SIX_A_MINUTE, "a"), 10);
  // A minute of quiet gives back six, never more.
  pass(600_000);
  for (let i = 0; i < 6; i++) assert.equal(limiter.take(SIX_A_MINUTE, "a"), 0);
  assert.ok(limiter.take(SIX_A_MINUTE, "a") > 0);
});

test("take_aRefusedRequest_costsNothing", () => {
  const { now, pass } = clock();
  const limiter = new Limiter(now);
  for (let i = 0; i < 6; i++) limiter.take(SIX_A_MINUTE, "a");
  // Asking again and again while refused does not push the wait out.
  for (let i = 0; i < 50; i++) assert.equal(limiter.take(SIX_A_MINUTE, "a"), 10);
  pass(10_000);
  assert.equal(limiter.take(SIX_A_MINUTE, "a"), 0);
});

test("take_countsEachClientAndEachRuleOnItsOwn", () => {
  const { now } = clock();
  const limiter = new Limiter(now);
  for (let i = 0; i < 6; i++) limiter.take(SIX_A_MINUTE, "a");
  assert.ok(limiter.take(SIX_A_MINUTE, "a") > 0);
  assert.equal(limiter.take(SIX_A_MINUTE, "b"), 0);
  assert.equal(limiter.take({ ...SIX_A_MINUTE, name: "other" }, "a"), 0);
});

test("take_dropsTheBucketsThatAreFullAgain", () => {
  const { now, pass } = clock();
  const limiter = new Limiter(now);
  for (let i = 0; i < 6_000; i++) limiter.take(SIX_A_MINUTE, `client-${i}`);
  assert.equal(limiter.size, 6_000);
  // Each of them used one of six: full again ten seconds later.
  pass(11_000);
  limiter.take(SIX_A_MINUTE, "one more");
  assert.equal(limiter.size, 1);
});

test("gate_lets_soManyInPerClient_andSoManyInAll", () => {
  const gate = new Gate(2, 3);
  const first = gate.enter("a");
  assert.ok(first !== null);
  assert.ok(gate.enter("a") !== null);
  assert.equal(gate.enter("a"), null);
  assert.ok(gate.enter("b") !== null);
  // Three are open: nobody gets a fourth.
  assert.equal(gate.enter("c"), null);
  assert.equal(gate.count, 3);

  first();
  // Giving a place back twice gives back one.
  first();
  assert.equal(gate.count, 2);
  assert.ok(gate.enter("c") !== null);
  assert.equal(gate.enter("b"), null);
});

// ---- The routes ----

function makeHttp(over: Partial<Limits>, now?: () => number) {
  const unused = {} as never;
  const store = new Store(null);
  const feed = new Feed({ store, vault: VAULT, log: () => undefined });
  const client = { getBlockNumber: async () => 1n } as never;
  const app = makeApp({
    client, vault: VAULT, usdc: VAULT, maxLockedBps: 6000, pricer: unused, games: unused, relayer: unused, oracle: VAULT,
    store, feed, streamSecret: "secret", limits: { ...LIMITS, ...over }, now,
  });
  const get = (path: string, ip = "203.0.113.7") => app.request(path, { headers: { "x-real-ip": ip } });
  return { app, get };
}

test("anyRoute_pastItsLimit_is429_withTheWaitAndAMessageThePageCanRead", async () => {
  const { now, pass } = clock();
  const { app, get } = makeHttp({ all: { name: "all", max: 3, windowMs: 60_000 } }, now);
  for (let i = 0; i < 3; i++) assert.equal((await get("/feed")).status, 200);

  const res = await app.request("/feed", { headers: { "x-real-ip": "203.0.113.7", origin: "https://freeif.app" } });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "20");
  // A browser only shows the page a refusal that carries the CORS header.
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await res.json(), { error: { code: "too-many", message: "That's a lot of requests at once. Try again in a minute." } });

  // Another address is not held back by this one, and this one is let in again when its wait is over.
  assert.equal((await get("/feed", "198.51.100.9")).status, 200);
  pass(20_000);
  assert.equal((await get("/feed")).status, 200);
});

test("health_andTheStreamsWebhook_areNeverLimited", async () => {
  const { app, get } = makeHttp({ all: { name: "all", max: 1, windowMs: 60_000 } });
  assert.equal((await get("/feed")).status, 200);
  assert.equal((await get("/feed")).status, 429);
  for (let i = 0; i < 5; i++) {
    const res = await app.request("/stream", { method: "POST", headers: { "x-real-ip": "203.0.113.7", "x-stream-secret": "secret" }, body: "{}" });
    assert.equal(res.status, 200);
  }
  for (let i = 0; i < 5; i++) assert.equal((await get("/health")).status, 200);
});

test("quote_hasItsOwnSmallerLimit_whichLeavesTheOtherRoutesOpen", async () => {
  const { app, get } = makeHttp({ quote: { name: "quote", max: 2, windowMs: 60_000 } });
  const quote = () =>
    app.request("/quote", { method: "POST", headers: { "x-real-ip": "203.0.113.7", "content-type": "application/json" }, body: JSON.stringify({ merchant: "nobody" }) });
  // Two get as far as the route (which refuses the body), the third does not.
  assert.equal((await quote()).status, 400);
  assert.equal((await quote()).status, 400);
  assert.equal((await quote()).status, 429);
  assert.equal((await get("/feed")).status, 200);
  assert.equal((await get("/promos/1/odds")).status, 200);
});

test("eventStreams_areCountedWhileOpen_andAClosedOneGivesItsPlaceBack", async () => {
  const { get } = makeHttp({ streams: { perClient: 2, inAll: 3 } });
  const first = await get("/promos/1/events");
  const second = await get("/events");
  assert.deepEqual([first.status, second.status], [200, 200]);

  const third = await get("/promos/2/events");
  assert.equal(third.status, 429);
  assert.equal(third.headers.get("retry-after"), "30");

  // Another address has its own count, until three are open in all.
  const other = await get("/events", "198.51.100.9");
  assert.equal(other.status, 200);
  assert.equal((await get("/events", "192.0.2.44")).status, 429);

  // The page went away: its place is free again.
  const reader = first.body!.getReader();
  await reader.read();
  await reader.cancel();
  let again = await get("/promos/1/events");
  for (let i = 0; i < 20 && again.status !== 200; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    again = await get("/promos/1/events");
  }
  assert.equal(again.status, 200);

  await Promise.all([second, other, again].map((res) => res.body!.cancel()));
});
