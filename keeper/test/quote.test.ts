// `POST /quote` through the HTTP app: who may have a signed quote on a 5-minute test market.
// The pricing service is a fake that signs whatever reaches it, so each test sees what the route let through.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import "../src/config.ts";
import { makeApp } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { Feed } from "../src/stream.ts";

const VAULT: Address = "0x68a00243927f250dBcD9160b5d06623b62B2e06d";
const MERCHANT: Address = "0x5442DE8276aB4770a1e4EAAB6E6284c575987440";
const KEY = "the-test-key";

const window5m = { eventTicker: "BTC05M2611130405", instrumentSymbol: "GEMI-BTC05M2611130405-UP", payoutPerClaim: "500000", maxClaims: 3 };
const game = { eventTicker: "NFL-2611151430-NE-DET-M", instrumentSymbol: "GEMI-NFL-2611151430-NE-DET-M-NE", payoutPerClaim: "8000000", maxClaims: 2 };

function route(testKey?: string) {
  const signed: { eventTicker: string; hedgeMode: boolean }[] = [];
  const pricer = {
    signQuote: async (request: { eventTicker: string; hedgeMode: boolean }) => {
      signed.push({ eventTicker: request.eventTicker, hedgeMode: request.hedgeMode });
      return { signed: true };
    },
  } as never;
  const unused = {} as never;
  const store = new Store(null);
  const feed = new Feed({ store, vault: VAULT, log: () => undefined });
  const app = makeApp({ client: unused, vault: VAULT, usdc: VAULT, maxLockedBps: 6000, pricer, games: unused, relayer: unused, oracle: VAULT, store, feed, testKey });
  const post = async (body: object, headers: Record<string, string> = {}) => {
    const res = await app.request("/quote", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ ...body, merchant: MERCHANT }),
    });
    return { status: res.status, body: (await res.json()) as { signed?: boolean; error?: { code: string; message: string } } };
  };
  return { post, signed };
}

test("postQuote_onATestMarket_withoutTheTestKey_isRefused_andNothingIsSigned", async () => {
  const { post, signed } = route(KEY);
  const bare = await post(window5m);
  assert.deepEqual([bare.status, bare.body.error], [422, { code: "test-only", message: "This market is for testing only." }]);
  assert.equal((await post(window5m, { "x-test-key": "a guess" })).status, 422);
  assert.equal((await post(window5m, { "x-test-key": "" })).status, 422);
  // The request that takes the money for itself is refused the same way.
  assert.equal((await post({ ...window5m, maxClaims: 1, hedgeMode: true })).status, 422);
  // A 15-minute market of another coin is one too.
  assert.equal((await post({ ...window5m, eventTicker: "ETH15M2611130415" })).status, 422);
  assert.deepEqual(signed, []);
});

test("postQuote_onATestMarket_withTheTestKey_isSigned", async () => {
  const { post, signed } = route(KEY);
  const res = await post(window5m, { "x-test-key": KEY });
  assert.deepEqual([res.status, res.body.signed], [200, true]);
  assert.deepEqual(signed, [{ eventTicker: "BTC05M2611130405", hedgeMode: false }]);
});

test("postQuote_onAKeeperWithNoTestKey_testMarketsAreNotSoldAtAll", async () => {
  const { post, signed } = route();
  assert.equal((await post(window5m)).status, 422);
  assert.equal((await post(window5m, { "x-test-key": "undefined" })).status, 422);
  assert.equal((await post(window5m, { "x-test-key": "" })).status, 422);
  assert.deepEqual(signed, []);
});

test("postQuote_onAGame_needsNoKey", async () => {
  const { post, signed } = route(KEY);
  assert.equal((await post(game)).status, 200);
  assert.equal((await post({ ...game, maxClaims: 1, hedgeMode: true })).status, 200);
  assert.deepEqual(signed, [
    { eventTicker: "NFL-2611151430-NE-DET-M", hedgeMode: false },
    { eventTicker: "NFL-2611151430-NE-DET-M", hedgeMode: true },
  ]);
});
