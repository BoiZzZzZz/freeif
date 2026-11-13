// The hedge (SPEC section 2): the order the keeper places on Gemini's sandbox exchange for each open
// promo. Gemini is a fake `fetch` that answers in the shapes the real sandbox gave on Nov 13.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import { Status, type PublicClient, type WalletClient } from "../src/chain.ts";
import { Hedger, Sandbox, SandboxError, contracts, priceOf, type HedgePromo } from "../src/hedge.ts";
import { Keeper } from "../src/keeper.ts";
import { Store } from "../src/store.ts";

const VAULT: Address = "0x68a00243927f250dBcD9160b5d06623b62B2e06d";
const UP: Hex = `0x${"55".repeat(32)}`;
const LIONS: Hex = `0x${"22".repeat(32)}`;
const NOW = 1_794_589_000;
const SECRET = "sandbox-secret";

type Sent = { url: string; headers: Record<string, string>; payload: Record<string, unknown> };

/** Gemini's sandbox as a `fetch`: it keeps what was sent and answers with `reply`. */
function gemini(reply: (payload: Record<string, unknown>) => { status: number; body: string }) {
  const sent: Sent[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const payload = JSON.parse(Buffer.from(headers["X-GEMINI-PAYLOAD"]!, "base64").toString("utf8")) as Record<string, unknown>;
    sent.push({ url: String(url), headers, payload });
    const { status, body } = reply(payload);
    return new Response(body, { status });
  }) as typeof fetch;
  return { fake, sent };
}

// What the sandbox answered to a real order on Nov 13. The id is past what a JSON number keeps.
const PLACED = `{"orderId":145853902318663971,"hashOrderId":"ze3krGLvY28p","clientOrderId":"freeif-14-1","status":"open","symbol":"GEMI-BTC05M2611131710-UP","side":"buy","outcome":"yes","orderType":"limit","quantity":"1.5","filledQuantity":"0","remainingQuantity":"1.5","price":"0.5"}`;
const CANCELLED = `{"result":"ok","message":"Order 145853902318663971 cancelled successfully"}`;

test("call_signsTheRequestAsGeminiWantsIt", async () => {
  const { fake, sent } = gemini(() => ({ status: 200, body: `{"orders":[]}` }));
  const sandbox = new Sandbox({ key: "account-key", secret: SECRET, base: "https://api.sandbox.gemini.com", fetch: fake, now: () => NOW });
  await sandbox.call("/v1/prediction-markets/orders/active");
  const [request] = sent;
  assert.equal(request!.url, "https://api.sandbox.gemini.com/v1/prediction-markets/orders/active");
  assert.equal(request!.headers["X-GEMINI-APIKEY"], "account-key");
  // The JSON travels as a base64 header; the body is empty; the signature is HMAC-SHA384 of that header.
  assert.deepEqual(request!.payload, { request: "/v1/prediction-markets/orders/active", nonce: NOW });
  assert.equal(request!.headers["X-GEMINI-SIGNATURE"], createHmac("sha384", SECRET).update(request!.headers["X-GEMINI-PAYLOAD"]!).digest("hex"));
});

test("call_theNonceIsWholeSeconds_andGrowsWithEveryRequest", async () => {
  const { fake, sent } = gemini(() => ({ status: 200, body: "{}" }));
  const sandbox = new Sandbox({ key: "k", secret: SECRET, base: "https://x", fetch: fake, now: () => NOW });
  // Three requests in the same second, started together.
  await Promise.all([sandbox.call("/a"), sandbox.call("/b"), sandbox.call("/c")]);
  assert.deepEqual(sent.map((s) => s.payload.nonce), [NOW, NOW + 1, NOW + 2]);
  assert.deepEqual(sent.map((s) => s.payload.request), ["/a", "/b", "/c"]);
});

test("buyYes_sendsALimitOrder_andKeepsEveryDigitOfTheOrderId", async () => {
  const { fake, sent } = gemini(() => ({ status: 201, body: PLACED }));
  const sandbox = new Sandbox({ key: "k", secret: SECRET, base: "https://x", fetch: fake, now: () => NOW });
  const order = await sandbox.buyYes({ symbol: "GEMI-BTC05M2611131710-UP", quantity: "1.5", price: "0.50", clientOrderId: "freeif-14-1" });
  // As a JSON number this id would come back as ...970.
  assert.deepEqual(order, { orderId: "145853902318663971", status: "open" });
  assert.deepEqual(sent[0]!.payload, {
    request: "/v1/prediction-markets/order",
    nonce: NOW,
    symbol: "GEMI-BTC05M2611131710-UP",
    outcome: "yes",
    orderType: "limit",
    side: "buy",
    quantity: "1.5",
    price: "0.50",
    clientOrderId: "freeif-14-1",
  });
});

test("call_aRefusal_carriesGeminisWords", async () => {
  const answers = [
    { status: 404, body: `{"error":"Invalid instrument symbol: GEMI-NFL-2611151430-NE-DET-M-NE"}` },
    { status: 400, body: `{"result":"error","reason":"InvalidNonce","message":"Nonce must be increasing"}` },
    { status: 502, body: "<html>bad gateway</html>" },
  ];
  const { fake } = gemini(() => answers.shift()!);
  const sandbox = new Sandbox({ key: "k", secret: SECRET, base: "https://x", fetch: fake, now: () => NOW });
  const refusal = async () => {
    try {
      await sandbox.call("/v1/prediction-markets/order");
    } catch (err) {
      assert.ok(err instanceof SandboxError);
      return [err.status, err.reason, err.message];
    }
    return assert.fail("expected a refusal");
  };
  assert.deepEqual(await refusal(), [404, "404", "Invalid instrument symbol: GEMI-NFL-2611151430-NE-DET-M-NE"]);
  assert.deepEqual(await refusal(), [400, "InvalidNonce", "Nonce must be increasing"]);
  assert.deepEqual(await refusal(), [502, "502", "Gemini answered 502"]);
});

test("contracts_isThePayoutInDollars", () => {
  assert.equal(contracts(1_500_000n), "1.5");
  assert.equal(contracts(16_000_000n), "16");
  assert.equal(contracts(4_000_000_000n), "4000");
  assert.equal(contracts(250_000n), "0.25");
  assert.equal(priceOf(4300), "0.43");
  assert.equal(priceOf(5000), "0.50");
});

/** A hedger over a store that knows two contracts, with a sandbox that lists only the BTC window. */
function setup(withKey = true) {
  const clock = { now: NOW };
  const store = new Store(null);
  store.data.instruments[UP] = { symbol: "GEMI-BTC05M2611131710-UP", label: "Up" };
  store.data.instruments[LIONS] = { symbol: "GEMI-NFL-2611151430-NE-DET-M-NE", label: "New England" };
  const calls: string[] = [];
  const state: { fail: SandboxError | Error | null; hold: Promise<void> | null } = { fail: null, hold: null };
  const sandbox = {
    buyYes: async (order: { symbol: string; quantity: string; price: string; clientOrderId: string }) => {
      calls.push(`buy ${order.quantity} ${order.symbol} at ${order.price} as ${order.clientOrderId}`);
      if (state.hold) await state.hold;
      if (state.fail) throw state.fail;
      if (!order.symbol.includes("BTC")) throw new SandboxError(404, "404", `Invalid instrument symbol: ${order.symbol}`);
      return { orderId: "145853902318663971", status: "open" };
    },
    cancel: async (orderId: string) => {
      calls.push(`cancel ${orderId}`);
      if (state.fail) throw state.fail;
    },
  };
  const logged: string[] = [];
  const hedger = new Hedger({ store, sandbox: withKey ? sandbox : null, now: () => clock.now, log: (line) => logged.push(line) });
  const btc = (status: number = Status.Open): HedgePromo => ({ promoId: "14", status, payoutPerClaim: 500_000n, maxClaims: 3, instrumentSymbol: UP });
  const game = (status: number = Status.Open): HedgePromo => ({ promoId: "9", status, payoutPerClaim: 8_000_000n, maxClaims: 2, instrumentSymbol: LIONS });
  return { hedger, store, calls, state, clock, logged, btc, game };
}

test("sync_anOpenPromo_getsAnOrderForItsFullPayout_atThePriceItWasSoldOn", async () => {
  const { hedger, store, calls, btc } = setup();
  store.data.oddsStart["14"] = [NOW - 20, 5000, 4900, 5000];
  // Later readings do not move the hedge's price: it is the price the promo was sold on.
  store.data.odds["14"] = [[NOW - 5, 8200, 7300, 8200]];
  await hedger.sync([btc()]);
  assert.deepEqual(calls, [`buy 1.5 GEMI-BTC05M2611131710-UP at 0.50 as freeif-14-${NOW}`]);
  assert.deepEqual(store.data.hedges["14"], {
    kind: "sandbox",
    symbol: "GEMI-BTC05M2611131710-UP",
    quantity: "1.5",
    price: "0.50",
    at: NOW,
    orderId: "145853902318663971",
    status: "open",
  });
  // The next pass finds the hedge and places nothing.
  await hedger.sync([btc()]);
  assert.equal(calls.length, 1);
});

test("sync_aContractTheSandboxDoesNotList_isWrittenDownAsSimulated", async () => {
  const { hedger, store, calls, game } = setup();
  // A promo from before readings were kept has no first reading: its newest one is the price.
  store.data.odds["9"] = [[NOW - 600, 4200, 4100, 4200], [NOW - 30, 4300, 4200, 4300]];
  await hedger.sync([game()]);
  assert.deepEqual(store.data.hedges["9"], {
    kind: "simulated",
    symbol: "GEMI-NFL-2611151430-NE-DET-M-NE",
    quantity: "16",
    price: "0.43",
    at: NOW,
    reason: "Gemini's sandbox does not list this contract.",
  });
  await hedger.sync([game()]);
  assert.equal(calls.length, 1, "a simulated hedge is not tried again");
});

test("sync_withNoSandboxKey_everyHedgeIsSimulated", async () => {
  const { hedger, store, calls, btc } = setup(false);
  store.data.oddsStart["14"] = [NOW - 20, 5000, 4900, 5000];
  await hedger.sync([btc()]);
  assert.equal(store.data.hedges["14"]!.kind, "simulated");
  assert.equal(store.data.hedges["14"]!.reason, "The keeper has no sandbox key.");
  assert.deepEqual(calls, []);
});

test("sync_aPromoWithNoReadingYet_orNoSymbol_waitsForTheNextPass", async () => {
  const { hedger, store, calls, btc } = setup();
  await hedger.sync([btc()]);
  await hedger.sync([{ ...btc(), promoId: "15", instrumentSymbol: `0x${"99".repeat(32)}` }]);
  assert.deepEqual(calls, []);
  assert.deepEqual(store.data.hedges, {});
  store.data.oddsStart["14"] = [NOW, 5000, 4900, 5000];
  await hedger.sync([btc()]);
  assert.equal(store.data.hedges["14"]!.kind, "sandbox");
});

test("sync_onlyAnOpenPromoIsHedged", async () => {
  const { hedger, store, calls, btc } = setup();
  store.data.oddsStart["14"] = [NOW, 5000, 4900, 5000];
  for (const status of [Status.Settled, Status.Vetoed, Status.FinalizedYes, Status.FinalizedNo, Status.PaidOut, Status.Voided]) {
    await hedger.sync([btc(status)]);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(store.data.hedges, {});
});

test("sync_whenGeminiCannotBeReached_triesAgainNextPass", async () => {
  const { hedger, store, state, calls, logged, btc } = setup();
  store.data.oddsStart["14"] = [NOW, 5000, 4900, 5000];
  state.fail = new Error("fetch failed");
  for (let i = 0; i < 5; i++) await hedger.sync([btc()]);
  assert.equal(store.data.hedges["14"], undefined);
  assert.equal(calls.length, 5);
  assert.ok(logged.every((line) => line.includes("fetch failed")));
  state.fail = new SandboxError(503, "503", "Gemini answered 503");
  await hedger.sync([btc()]);
  assert.equal(store.data.hedges["14"], undefined, "a 5xx is Gemini's trouble, not a refusal");
  state.fail = null;
  await hedger.sync([btc()]);
  assert.equal(store.data.hedges["14"]!.kind, "sandbox");
});

test("sync_anOrderGeminiRefusesThreeTimes_isSimulated_withGeminisReason", async () => {
  const { hedger, store, state, calls, btc } = setup();
  store.data.oddsStart["14"] = [NOW, 5000, 4900, 5000];
  state.fail = new SandboxError(400, "MarketClosed", "This market is closed");
  await hedger.sync([btc()]);
  await hedger.sync([btc()]);
  assert.equal(store.data.hedges["14"], undefined);
  await hedger.sync([btc()]);
  assert.equal(calls.length, 3);
  assert.equal(store.data.hedges["14"]!.kind, "simulated");
  assert.equal(store.data.hedges["14"]!.reason, "Gemini's sandbox refused the order: This market is closed");
});

test("sync_aPromoThatIsOver_hasItsOrderCancelled_once", async () => {
  const { hedger, store, calls, clock, btc } = setup();
  store.data.oddsStart["14"] = [NOW, 5000, 4900, 5000];
  await hedger.sync([btc()]);
  // Settled: the result is not final yet, the order stays.
  clock.now = NOW + 700;
  await hedger.sync([btc(Status.Settled)]);
  assert.equal(calls.length, 1);
  clock.now = NOW + 760;
  await hedger.sync([btc(Status.FinalizedYes)]);
  await hedger.sync([btc(Status.PaidOut)]);
  assert.deepEqual(calls.slice(1), ["cancel 145853902318663971"]);
  assert.deepEqual([store.data.hedges["14"]!.status, store.data.hedges["14"]!.closedAt], ["cancelled", NOW + 760]);
});

test("sync_anOrderThatWentWithItsMarket_isClosed_notAnError", async () => {
  const { hedger, store, state, btc } = setup();
  store.data.oddsStart["14"] = [NOW, 5000, 4900, 5000];
  await hedger.sync([btc()]);
  // What the sandbox answers for an order that is no longer there.
  state.fail = new SandboxError(404, "404", "Order 145853902318663971 not found");
  await hedger.sync([btc(Status.FinalizedNo)]);
  assert.equal(store.data.hedges["14"]!.status, "closed");
  // Gemini being down is not "closed": the cancel is tried again.
  const again = setup();
  again.store.data.oddsStart["14"] = [NOW, 5000, 4900, 5000];
  await again.hedger.sync([again.btc()]);
  again.state.fail = new Error("fetch failed");
  await again.hedger.sync([again.btc(Status.FinalizedNo)]);
  assert.equal(again.store.data.hedges["14"]!.closedAt, undefined);
  again.state.fail = null;
  await again.hedger.sync([again.btc(Status.FinalizedNo)]);
  assert.equal(again.store.data.hedges["14"]!.status, "cancelled");
});

test("sync_aSimulatedHedge_hasNothingToCancel", async () => {
  const { hedger, store, calls, game } = setup();
  store.data.odds["9"] = [[NOW - 30, 4300, 4200, 4300]];
  await hedger.sync([game()]);
  await hedger.sync([game(Status.PaidOut)]);
  assert.equal(calls.length, 1);
  assert.equal(store.data.hedges["9"]!.closedAt, undefined);
});

test("sync_calledWhileTheLastOneIsTalkingToGemini_doesNothing", async () => {
  const { hedger, store, state, calls, btc } = setup();
  store.data.oddsStart["14"] = [NOW, 5000, 4900, 5000];
  let release = () => {};
  state.hold = new Promise((resolve) => { release = resolve; });
  const first = hedger.sync([btc()]);
  await hedger.sync([btc()]);
  state.hold = null;
  release();
  await first;
  assert.equal(calls.length, 1, "one order, not two");
});

// The loop: every promo it reads on a pass goes to the hedger, with what an order needs.
test("tick_handsEveryPromoItRead_toTheHedger", async () => {
  const promo = (status: number, symbol: Hex) => ({
    merchant: VAULT,
    geminiEventId: UP,
    instrumentSymbol: symbol,
    payoutPerClaim: 500_000n,
    maxClaims: 3,
    claimCount: 0,
    claimDeadline: BigInt(NOW + 3600),
    settledAt: 0n,
    status,
    paidCount: 0,
  });
  const promos = [promo(Status.Open, UP), promo(Status.PaidOut, LIONS)];
  const client = {
    readContract: async ({ functionName }: { functionName: string }) => (functionName === "promoCount" ? BigInt(promos.length) : 30),
    getBlock: async () => ({ timestamp: BigInt(NOW) }),
    multicall: async ({ contracts: calls }: { contracts: { args: readonly bigint[] }[] }) => calls.map((c) => promos[Number(c.args[0])]),
  } as unknown as PublicClient;
  const seen: HedgePromo[][] = [];
  const keeper = new Keeper({
    client,
    wallet: { account: { address: VAULT } } as unknown as WalletClient,
    vault: VAULT,
    store: new Store(null),
    hedge: { sync: async (all) => void seen.push([...all]) },
    log: () => undefined,
  });
  await keeper.tick();
  assert.deepEqual(seen, [[
    { promoId: "0", status: Status.Open, payoutPerClaim: 500_000n, maxClaims: 3, instrumentSymbol: UP },
    { promoId: "1", status: Status.PaidOut, payoutPerClaim: 500_000n, maxClaims: 3, instrumentSymbol: LIONS },
  ]]);
  // A promo that is over is read once more after it ends, then never again.
  await keeper.tick();
  assert.deepEqual(seen[1], [{ promoId: "0", status: Status.Open, payoutPerClaim: 500_000n, maxClaims: 3, instrumentSymbol: UP }]);
});
