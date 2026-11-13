// Claim cards through the HTTP app, with Circle and the chain replaced by fakes: the switch, who may send
// a promo's cards, what is refused before Circle is asked, the relayer's line, and the open claim refused
// on a card promo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import "../src/config.ts";
import { Status, type PublicClient, type WalletClient } from "../src/chain.ts";
import type { CircleUser } from "../src/circle.ts";
import { LIMITS, type Limits } from "../src/limit.ts";
import { Relayer } from "../src/relayer.ts";
import { makeApp } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { Feed } from "../src/stream.ts";

const VAULT: Address = "0x68a00243927f250dBcD9160b5d06623b62B2e06d";
const USDC: Address = "0x3600000000000000000000000000000000000000";
const RELAYER: Address = "0xa03aF58DF0B042fFA9342F178bb37F8a9f1E3286";
const MERCHANT: Address = "0x5442DE8276aB4770a1e4EAAB6E6284c575987440";
const ALICE: Address = "0x6f3DE22768B24a4cAE412BF3575E691488B7d6E4";
const NOW = 1_794_500_000;
const TX: Hex = `0x${"ab".repeat(32)}`;
const KEY = "the-test-key";

/** Card addresses, as a merchant's browser would make them. */
const card = (n: number): Address => getAddress(`0x${n.toString(16).padStart(2, "0").repeat(20)}`);
const [C1, C2, C3, C4] = [card(0xc1), card(0xc2), card(0xc3), card(0xc4)];

const logins: Record<string, CircleUser | null | "down"> = {
  "merchant.token": { userId: "user-merchant", wallets: [ALICE, MERCHANT] },
  "alice.token": { userId: "user-alice", wallets: [ALICE] },
  "expired.token": null,
  "circle.is.down": "down",
};

type FakePromo = {
  merchant: Address;
  claimSigner: Address;
  status: number;
  claimDeadline: bigint;
  claimCount: number;
  maxClaims: number;
  hedgeMode: boolean;
};

function promo(over: Partial<FakePromo> = {}) {
  return {
    merchant: MERCHANT,
    claimSigner: RELAYER,
    geminiEventId: `0x${"11".repeat(32)}` as Hex,
    instrumentSymbol: `0x${"22".repeat(32)}` as Hex,
    payoutPerClaim: 8_000_000n,
    maxClaims: 3,
    claimCount: 0,
    paidCount: 0,
    premiumPaid: 9_000_000n,
    collateralLocked: 24_000_000n,
    claimDeadline: BigInt(NOW + 3600),
    marketCloseTime: BigInt(NOW + 90_000),
    settledAt: 0n,
    status: Status.Open as number,
    outcomeYes: false,
    hedgeMode: false,
    ...over,
  };
}

/**
 * Five promos: 0 was sold before the switch; 1 is a card promo that takes 3 cards; 2 is a cover, whose one
 * claimant is the merchant; 3 is a card promo past its deadline; 4 is a card promo with a result.
 */
function setup(opts: { cardsFrom?: bigint; testKey?: string; limits?: Partial<Limits> } = {}) {
  const promos = [
    promo(),
    promo(),
    promo({ hedgeMode: true, maxClaims: 1, claimCount: 1 }),
    promo({ claimDeadline: BigInt(NOW - 1) }),
    promo({ status: Status.Settled }),
  ];
  const claimants: Address[][] = [[], [], [MERCHANT], [], []];
  const state = {
    /** Every `registerClaim` the relayer sent, as `promoId:address`. */
    sent: [] as string[],
    /** Every token Circle was asked about. */
    asked: [] as string[],
    reads: 0,
    /** Every address the relayer looked up on the chain before registering it. */
    checked: [] as string[],
  };
  // While held, a transaction waits: the cards stay in the relayer's line until `release`.
  let gate: Promise<void> = Promise.resolve();
  let open = () => {};
  const hold = () => {
    gate = new Promise((resolve) => {
      open = resolve;
    });
  };
  const release = () => open();
  const has = (id: bigint, who: string) => claimants[Number(id)]!.some((a) => a.toLowerCase() === who.toLowerCase());
  const client = {
    multicall: async ({ contracts }: { contracts: Array<{ functionName: string; args?: readonly bigint[] }> }) => {
      state.reads++;
      return contracts.map(({ functionName, args }) => {
        if (functionName === "promoCount") return { status: "success", result: BigInt(promos.length) };
        if (functionName === "totalOwedPayouts") return { status: "success", result: 0n };
        const id = Number(args![0]!);
        if (id >= promos.length) return { status: "failure", error: new Error("UnknownPromo") };
        if (functionName === "getPromo") return { status: "success", result: { ...promos[id]! } };
        return { status: "success", result: [...claimants[id]!] };
      });
    },
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "promoCount") return BigInt(promos.length);
      if (functionName === "getPromo") return { ...promos[Number(args![0])]! };
      if (functionName === "hasClaim") {
        state.checked.push(args![1] as string);
        return has(args![0] as bigint, args![1] as string);
      }
      throw new Error(`unexpected read ${functionName}`);
    },
    getBlock: async () => ({ timestamp: BigInt(NOW) }),
    getBlockNumber: async () => 1n,
    simulateContract: async ({ args }: { args: readonly unknown[] }) => ({ request: { args } }),
    waitForTransactionReceipt: async () => ({ status: "success", logs: [] }),
  } as unknown as PublicClient;
  const wallet = {
    account: { address: RELAYER },
    writeContract: async ({ args }: { args: readonly [bigint, Address] }) => {
      await gate;
      const [id, who] = args;
      const p = promos[Number(id)]!;
      if (p.claimCount >= p.maxClaims) throw new Error("PromoFull");
      claimants[Number(id)]!.push(who);
      p.claimCount += 1;
      state.sent.push(`${id}:${who}`);
      return TX;
    },
  } as unknown as WalletClient;
  const identify = async (token: string) => {
    state.asked.push(token);
    const user = logins[token] ?? null;
    if (user === "down") throw new Error("Circle answered 503");
    return user;
  };
  const store = new Store(null);
  const relayer = new Relayer({ client, wallet, vault: VAULT, store, identify });
  const feed = new Feed({ store, vault: VAULT, log: () => undefined });
  // The clock moves on by itself, two seconds a call: no read of the chain is shared from one step to the next.
  let at = NOW * 1000;
  const now = () => (at += 2_000);
  const unused = {} as never;
  const app = makeApp({
    client, vault: VAULT, usdc: USDC, maxLockedBps: 6000, pricer: unused, games: unused, relayer, oracle: RELAYER, store, feed,
    testKey: opts.testKey, cardsFrom: opts.cardsFrom, limits: { ...LIMITS, ...opts.limits }, now,
  });

  type Answer = { status: number; body: Record<string, unknown> & { error?: { code: string; message: string } } };
  const read = async (res: Response): Promise<Answer> => ({ status: res.status, body: (await res.json()) as Answer["body"] });
  const send = async (id: number | string, body: unknown, headers: Record<string, string> = {}) =>
    read(
      await app.request(`/promos/${id}/cards`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7", ...headers },
        body: JSON.stringify(body),
      }),
    );
  const claim = async (body: unknown, headers: Record<string, string> = {}) =>
    read(await app.request("/claims", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  const get = async (path: string) => read(await app.request(path));
  return { app, relayer, state, promos, claimants, send, claim, get, hold, release };
}

const asMerchant = (cards: unknown[]) => ({ cards, userToken: "merchant.token" });

// ---- The switch ----

test("cards_switchOff_noPromoUsesCards_andEverythingIsAsBefore", async () => {
  const { send, claim, get, state } = setup({ testKey: KEY });
  const health = await get("/health");
  assert.equal(health.body.cardsFromPromo, null);
  const one = await get("/promos/1");
  assert.deepEqual([one.body.cards, one.body.cardProgress], [false, null]);
  const refused = await send(1, asMerchant([C1]));
  assert.deepEqual([refused.status, refused.body.error?.code], [409, "not-cards"]);
  // The open claim works as it always has.
  const claimed = await claim({ promoId: "1", customer: ALICE, testUser: "customer1" }, { "x-test-key": KEY });
  assert.equal(claimed.status, 200);
  assert.deepEqual(state.sent, [`1:${ALICE}`]);
  assert.deepEqual(state.asked, []);
});

test("cards_switchOn_fromItsPromoOn_coversExcepted", async () => {
  const { get } = setup({ cardsFrom: 1n });
  assert.equal((await get("/health")).body.cardsFromPromo, 1);
  const before = await get("/promos/0");
  assert.deepEqual([before.body.cards, before.body.cardProgress], [false, null]);
  const first = await get("/promos/1");
  assert.equal(first.body.cards, true);
  assert.deepEqual(first.body.cardProgress, { registered: [], queued: 0 });
  assert.equal(first.body.vault, VAULT);
  const cover = await get("/promos/2");
  assert.deepEqual([cover.body.cards, cover.body.cardProgress], [false, null]);
  // Zero turns it on for every promo on the vault.
  const all = setup({ cardsFrom: 0n });
  assert.equal((await all.get("/promos/0")).body.cards, true);
  assert.equal((await all.get("/health")).body.cardsFromPromo, 0);
});

// ---- Who may send them ----

test("cards_theMerchantsLogin_registersEveryCard_oneAtATime", async () => {
  const { send, relayer, state, get } = setup({ cardsFrom: 1n });
  const res = await send(1, asMerchant([C1, C2, C3]));
  assert.equal(res.status, 202);
  assert.deepEqual(res.body, { promoId: "1", cards: 3, alreadyRegistered: 0, queued: 3, waiting: 3 });
  assert.deepEqual(state.asked, ["merchant.token"]);
  await relayer.drained();
  assert.deepEqual(state.sent, [`1:${C1}`, `1:${C2}`, `1:${C3}`]);
  // The one-claim-per-user rule is not for cards: one merchant, three cards.
  const after = await get("/promos/1");
  assert.deepEqual(after.body.cardProgress, { registered: [C1, C2, C3], queued: 0 });
  assert.equal(after.body.claimCount, 3);
  // A card is a customer like any other: its place in line, by its address.
  const one = await get(`/promos/1?customer=${C2}`);
  assert.deepEqual(one.body.customer, { address: C2, number: 2, paid: false, owed: "0" });
});

test("cards_progress_showsTheCardsStillInTheLine", async () => {
  const { send, relayer, get, hold, release } = setup({ cardsFrom: 1n });
  hold();
  await send(1, asMerchant([C1, C2]));
  // Answered before the line has moved: both wait.
  assert.deepEqual((await get("/promos/1")).body.cardProgress, { registered: [], queued: 2 });
  release();
  await relayer.drained();
  assert.deepEqual((await get("/promos/1")).body.cardProgress, { registered: [C1, C2], queued: 0 });
});

test("cards_aLoginThatIsNotTheMerchants_isRefused_andNothingIsSent", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const { send, state } = setup({ cardsFrom: 1n });
  const other = await send(1, { cards: [C1], userToken: "alice.token" });
  assert.deepEqual([other.status, other.body.error?.code], [403, "not-your-promo"]);
  assert.match(other.body.error!.message, /email you paid with/);
  const expired = await send(1, { cards: [C1], userToken: "expired.token" });
  assert.deepEqual([expired.status, expired.body.error?.code], [401, "login"]);
  const madeUp = await send(1, { cards: [C1], userToken: "made.up" });
  assert.deepEqual([madeUp.status, madeUp.body.error?.code], [401, "login"]);
  const none = await send(1, { cards: [C1] });
  assert.deepEqual([none.status, none.body.error?.code], [401, "login"]);
  const down = await send(1, { cards: [C1], userToken: "circle.is.down" });
  assert.deepEqual([down.status, down.body.error?.code], [502, "failed"]);
  // A token that cannot be one never reaches Circle.
  const spaced = await send(1, { cards: [C1], userToken: "merchant.token and more" });
  assert.deepEqual([spaced.status, spaced.body.error?.code], [401, "login"]);
  assert.deepEqual(state.asked, ["alice.token", "expired.token", "made.up", "circle.is.down"]);
  assert.deepEqual(state.sent, []);
});

test("cards_theTestKey_letsTheTestLoopIn_withoutCircle", async () => {
  const { send, relayer, state } = setup({ cardsFrom: 1n, testKey: KEY });
  const guess = await send(1, { cards: [C1] }, { "x-test-key": "a guess" });
  assert.deepEqual([guess.status, guess.body.error?.code], [401, "login"]);
  const empty = await send(1, { cards: [C1] }, { "x-test-key": "" });
  assert.equal(empty.status, 401);
  const ok = await send(1, { cards: [C1, C2] }, { "x-test-key": KEY });
  assert.equal(ok.status, 202);
  await relayer.drained();
  assert.deepEqual(state.sent, [`1:${C1}`, `1:${C2}`]);
  assert.deepEqual(state.asked, []);
});

test("cards_aKeeperWithNoTestKey_refusesTheHeaderWhateverItSays", async () => {
  const { send, state } = setup({ cardsFrom: 1n });
  for (const header of ["", "undefined", KEY]) {
    assert.equal((await send(1, { cards: [C1] }, { "x-test-key": header })).status, 401);
  }
  assert.deepEqual(state.sent, []);
});

// ---- What is refused before Circle is asked ----

test("cards_promosThatCannotTakeThem_areRefusedBeforeCircleIsAsked", async () => {
  const { send, state } = setup({ cardsFrom: 1n });
  const cases: [number, number, string][] = [
    [0, 409, "not-cards"], // sold before the switch
    [2, 409, "not-cards"], // a cover
    [3, 422, "closed"], // past its deadline
    [4, 422, "closed"], // has a result
    [9, 422, "unknown-promo"],
  ];
  for (const [id, status, code] of cases) {
    const res = await send(id, asMerchant([C1]));
    assert.deepEqual([id, res.status, res.body.error?.code], [id, status, code]);
  }
  assert.deepEqual(state.asked, []);
  assert.deepEqual(state.sent, []);
});

test("cards_aPromoSomeoneElseSigns_isRefused", async () => {
  const { send, promos, state } = setup({ cardsFrom: 1n });
  promos[1]!.claimSigner = ALICE;
  const res = await send(1, asMerchant([C1]));
  assert.deepEqual([res.status, res.body.error?.code], [422, "not-our-promo"]);
  assert.deepEqual(state.asked, []);
});

test("cards_addressesThatCannotBeCards_areRefusedBeforeCircleIsAsked", async () => {
  const { send, state } = setup({ cardsFrom: 1n });
  const bad: unknown[][] = [
    [C1, "0x1234"],
    [C1, 42],
    [zeroAddress],
    [VAULT],
    [USDC.toLowerCase()],
    [C1, C1.toLowerCase()],
  ];
  for (const cards of bad) {
    const res = await send(1, asMerchant(cards));
    assert.deepEqual([res.status, res.body.error?.code], [400, "bad-card"], JSON.stringify(cards));
  }
  const twice = await send(1, asMerchant([C1, C1]));
  assert.equal(twice.body.error?.message, "The same card is in the list twice.");
  // Not a list at all is the request's fault, not a card's.
  for (const body of [{ userToken: "merchant.token" }, asMerchant([]), { cards: "0x", userToken: "merchant.token" }]) {
    assert.equal((await send(1, body)).status, 400);
  }
  assert.equal((await send(1, asMerchant(Array.from({ length: 501 }, (_, i) => card(i % 256))))).status, 400);
  assert.equal((await send("one", asMerchant([C1]))).status, 400);
  assert.deepEqual(state.asked, []);
  assert.deepEqual(state.sent, []);
});

test("cards_moreThanThePromoTakes_isRefused_countingTheCardsAlreadyThere", async () => {
  const { send, relayer, state } = setup({ cardsFrom: 1n });
  const four = await send(1, asMerchant([C1, C2, C3, C4]));
  assert.deepEqual([four.status, four.body.error?.code], [422, "full"]);
  assert.equal(four.body.error?.message, "This promo takes 3 cards, and these are more.");
  assert.equal((await send(1, asMerchant([C1, C2]))).status, 202);
  await relayer.drained();
  // Two are registered: the same two and one more fit, two more do not.
  assert.equal((await send(1, asMerchant([C3, C4]))).body.error?.code, "full");
  assert.equal((await send(1, asMerchant([C1, C2, C3]))).status, 202);
  await relayer.drained();
  assert.deepEqual(state.sent, [`1:${C1}`, `1:${C2}`, `1:${C3}`]);
});

test("cards_cardsStillInTheLine_countTowardWhatThePromoTakes", async () => {
  const { send, relayer, state, hold, release } = setup({ cardsFrom: 1n });
  hold();
  assert.equal((await send(1, asMerchant([C1, C2]))).status, 202);
  // Neither has been registered yet; two waiting and two new are four.
  const more = await send(1, asMerchant([C3, C4]));
  assert.equal(more.body.error?.code, "full");
  // The same two again, while they wait, are not put in the line twice.
  const again = await send(1, asMerchant([C1, C2]));
  assert.deepEqual([again.status, again.body.queued, again.body.waiting], [202, 0, 2]);
  release();
  await relayer.drained();
  assert.deepEqual(state.sent, [`1:${C1}`, `1:${C2}`]);
});

// ---- Sending the same list again ----

test("cards_theSameListAgain_skipsWhatIsRegistered_andSendsTheRest", async () => {
  const { send, relayer, state } = setup({ cardsFrom: 1n });
  await send(1, asMerchant([C1]));
  await relayer.drained();
  const again = await send(1, asMerchant([C1, C2, C3]));
  assert.deepEqual(again.body, { promoId: "1", cards: 3, alreadyRegistered: 1, queued: 2, waiting: 2 });
  await relayer.drained();
  const once = await send(1, asMerchant([C1, C2, C3]));
  assert.deepEqual([once.status, once.body.alreadyRegistered, once.body.queued], [202, 3, 0]);
  await relayer.drained();
  assert.deepEqual(state.sent, [`1:${C1}`, `1:${C2}`, `1:${C3}`]);
});

test("cards_whenThePromoClosesMidway_theRestAreSkippedWithoutACall", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const { send, relayer, state, promos } = setup({ cardsFrom: 1n });
  // The deadline passes once the first card is in.
  const real = promos[1]!;
  let registered = 0;
  Object.defineProperty(real, "claimCount", {
    get: () => registered,
    set: (n: number) => {
      registered = n;
      if (n === 1) real.claimDeadline = BigInt(NOW);
    },
  });
  assert.equal((await send(1, asMerchant([C1, C2, C3]))).status, 202);
  await relayer.drained();
  assert.deepEqual(state.sent, [`1:${C1}`]);
  // The second card found the promo closed; the third was dropped without a call to the chain.
  assert.deepEqual(state.checked, [C1, C2]);
  assert.deepEqual(relayer.queuedCards(1n), []);
});

// ---- The limit ----

test("cards_haveTheirOwnLimit_whichLeavesTheOtherRoutesOpen", async () => {
  const { send, get } = setup({ cardsFrom: 1n, limits: { cards: { name: "cards", max: 2, windowMs: 60_000 } } });
  // The bad list is refused by the route, after the limit has counted it.
  assert.equal((await send(1, asMerchant([]))).status, 400);
  assert.equal((await send(1, asMerchant([]))).status, 400);
  const third = await send(1, asMerchant([]));
  assert.deepEqual([third.status, third.body.error?.code], [429, "too-many"]);
  assert.equal((await get("/promos/1")).status, 200);
  assert.equal(LIMITS.cards.max, 10);
  assert.equal(LIMITS.cards.windowMs, 60_000);
});

// ---- The open claim on a card promo ----

test("claims_onACardPromo_areRefusedWithCardsOnly_onBothPaths", async () => {
  const { claim, state } = setup({ cardsFrom: 1n, testKey: KEY });
  const login = await claim({ promoId: "1", customer: ALICE, userToken: "alice.token" });
  assert.deepEqual([login.status, login.body.error?.code], [409, "cards-only"]);
  assert.equal(login.body.error?.message, "This promo uses cards. Ask for yours where you bought.");
  const testPath = await claim({ promoId: "1", customer: ALICE, testUser: "customer1" }, { "x-test-key": KEY });
  assert.deepEqual([testPath.status, testPath.body.error?.code], [409, "cards-only"]);
  assert.deepEqual(state.asked, []);
  assert.deepEqual(state.sent, []);
});

test("claims_onAPromoBeforeTheSwitch_orACover_goTheWayTheyAlwaysHave", async () => {
  const { claim, state } = setup({ cardsFrom: 1n, testKey: KEY });
  const before = await claim({ promoId: "0", customer: ALICE, userToken: "alice.token" });
  assert.deepEqual([before.status, before.body.alreadyRegistered], [200, false]);
  assert.deepEqual(state.sent, [`0:${ALICE}`]);
  // A cover's one claimant is the merchant, registered when it was made: the relayer says it is full.
  const cover = await claim({ promoId: "2", customer: ALICE, testUser: "customer1" }, { "x-test-key": KEY });
  assert.deepEqual([cover.status, cover.body.error?.code], [422, "full"]);
  // An id the vault does not have: the relayer's answer, as before.
  const unknown = await claim({ promoId: "9", customer: ALICE, testUser: "customer2" }, { "x-test-key": KEY });
  assert.deepEqual([unknown.status, unknown.body.error?.code], [422, "unknown-promo"]);
});

test("claims_withTheSwitchOff_neverReadThePromoFirst", async () => {
  const { claim, state } = setup({ testKey: KEY });
  await claim({ promoId: "1", customer: ALICE, testUser: "customer1" }, { "x-test-key": KEY });
  // The relayer reads the chain itself; the route does not.
  assert.equal(state.reads, 0);
});
