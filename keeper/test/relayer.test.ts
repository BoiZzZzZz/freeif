// The relayer's rules for who may claim, with Circle and the chain replaced by fakes: a claim needs a
// login Circle knows, for an address that is one of that user's wallets, once per user per promo.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import { Status, type PublicClient, type WalletClient } from "../src/chain.ts";
import type { CircleUser } from "../src/circle.ts";
import { ClaimRefusal, Relayer, type ClaimRefusalCode } from "../src/relayer.ts";
import { makeApp } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { Feed } from "../src/stream.ts";

const VAULT: Address = "0x68a00243927f250dBcD9160b5d06623b62B2e06d";
const RELAYER: Address = "0xa03aF58DF0B042fFA9342F178bb37F8a9f1E3286";
const ALICE: Address = "0x6f3DE22768B24a4cAE412BF3575E691488B7d6E4";
const ALICE_2: Address = "0x2235755531e63f2c716C3167e622685d79C12477";
const BOB: Address = "0x7DA5F6f9bbEBf584f71CdD082aeBEaF46fa7E799";
const NOW = 1_794_500_000;
const TX: Hex = `0x${"ab".repeat(32)}`;

/** Circle, as a table: token => the user, null for a token it refuses, "down" when it cannot be asked. */
const logins: Record<string, CircleUser | null | "down"> = {
  "alice.token": { userId: "user-alice", wallets: [ALICE, ALICE_2] },
  "bob.token": { userId: "user-bob", wallets: [BOB] },
  "expired.token": null,
  "circle.is.down": "down",
};

function setup() {
  const state = {
    promo: { claimSigner: RELAYER, status: Status.Open as number, claimDeadline: BigInt(NOW + 3600), claimCount: 0, maxClaims: 3 },
    claimed: new Set<string>(),
    /** Every address the relayer sent a `registerClaim` for. */
    sent: [] as Address[],
    /** Every token Circle was asked about. */
    asked: [] as string[],
  };
  const client = {
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "promoCount") return 1n;
      if (functionName === "getPromo") return state.promo;
      if (functionName === "hasClaim") return state.claimed.has((args![1] as string).toLowerCase());
      throw new Error(`unexpected read ${functionName}`);
    },
    getBlock: async () => ({ timestamp: BigInt(NOW) }),
    simulateContract: async ({ args }: { args: readonly unknown[] }) => ({ request: { args } }),
    waitForTransactionReceipt: async () => ({ status: "success", logs: [] }),
  } as unknown as PublicClient;
  const wallet = {
    account: { address: RELAYER },
    writeContract: async ({ args }: { args: readonly [bigint, Address] }) => {
      state.claimed.add(args[1].toLowerCase());
      state.promo.claimCount += 1;
      state.sent.push(args[1]);
      return TX;
    },
  } as unknown as WalletClient;
  const identify = async (token: string) => {
    state.asked.push(token);
    const user = logins[token] ?? null;
    if (user === "down") throw new Error("Circle answered 503");
    return user;
  };
  const relayer = new Relayer({ client, wallet, vault: VAULT, store: new Store(null), identify });
  return { relayer, state };
}

async function refusal(run: Promise<unknown>, code: ClaimRefusalCode): Promise<void> {
  try {
    await run;
  } catch (err) {
    assert.ok(err instanceof ClaimRefusal, `expected a ClaimRefusal, got ${String(err)}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected the claim to be refused with "${code}"`);
}

test("registerClaim_goodLogin_registersThatUsersWallet", async () => {
  const { relayer, state } = setup();
  const result = await relayer.registerClaim(0n, ALICE, "alice.token");
  assert.equal(result.alreadyRegistered, false);
  assert.equal(result.txHash, TX);
  assert.deepEqual(state.sent, [ALICE]);
});

test("registerClaim_addressInLowerCase_isTheSameWallet", async () => {
  const { relayer, state } = setup();
  await relayer.registerClaim(0n, ALICE.toLowerCase(), "alice.token");
  assert.equal(state.sent.length, 1);
});

test("registerClaim_loginCircleDoesNotKnow_isRefusedAndNothingIsSent", async () => {
  const { relayer, state } = setup();
  await refusal(relayer.registerClaim(0n, ALICE, "expired.token"), "login");
  await refusal(relayer.registerClaim(0n, ALICE, "made.up.token"), "login");
  assert.deepEqual(state.sent, []);
});

test("registerClaim_addressOfAnotherUser_isRefused", async () => {
  const { relayer, state } = setup();
  await refusal(relayer.registerClaim(0n, ALICE, "bob.token"), "not-your-wallet");
  assert.deepEqual(state.sent, []);
});

test("registerClaim_oneUser_getsOneClaimPerPromoWhicheverWalletTheyUse", async () => {
  const { relayer, state } = setup();
  await relayer.registerClaim(0n, ALICE, "alice.token");
  await refusal(relayer.registerClaim(0n, ALICE_2, "alice.token"), "already-claimed");
  assert.deepEqual(state.sent, [ALICE]);
});

test("registerClaim_repeated_saysAlreadyRegisteredAndSendsNothing", async () => {
  const { relayer, state } = setup();
  await relayer.registerClaim(0n, ALICE, "alice.token");
  const again = await relayer.registerClaim(0n, ALICE, "alice.token");
  assert.equal(again.alreadyRegistered, true);
  assert.equal(again.txHash, null);
  assert.deepEqual(state.sent, [ALICE]);
});

test("registerClaim_twoUsersAtTheSameMoment_eachGetTheirClaim", async () => {
  const { relayer, state } = setup();
  await Promise.all([relayer.registerClaim(0n, ALICE, "alice.token"), relayer.registerClaim(0n, BOB, "bob.token")]);
  assert.deepEqual([...state.sent].sort(), [ALICE, BOB].sort());
});

test("registerClaim_circleCannotBeAsked_failsAndNothingIsSent", async (t) => {
  // The relayer logs the reason; keep it out of the test output.
  t.mock.method(console, "error", () => undefined);
  const { relayer, state } = setup();
  await refusal(relayer.registerClaim(0n, ALICE, "circle.is.down"), "failed");
  assert.deepEqual(state.sent, []);
});

test("registerClaim_tokenThatCannotBeOne_neverReachesCircle", async () => {
  const { relayer, state } = setup();
  for (const token of ["", "alice.token and more", "x".repeat(5000)]) {
    await refusal(relayer.registerClaim(0n, ALICE, token), "login");
  }
  assert.deepEqual(state.asked, []);
});

test("registerClaim_notAnAddress_isRefusedBeforeCircleIsAsked", async () => {
  const { relayer, state } = setup();
  await refusal(relayer.registerClaim(0n, "0x1234", "alice.token"), "bad-request");
  await refusal(relayer.registerTestClaim(0n, "0x1234", "customer1"), "bad-request");
  assert.deepEqual(state.asked, []);
});

test("registerClaim_fullClosedOrUnknownPromo_isRefused", async () => {
  const full = setup();
  full.state.promo.claimCount = 3;
  await refusal(full.relayer.registerClaim(0n, ALICE, "alice.token"), "full");
  const closed = setup();
  closed.state.promo.claimDeadline = BigInt(NOW);
  await refusal(closed.relayer.registerClaim(0n, ALICE, "alice.token"), "closed");
  const unknown = setup();
  await refusal(unknown.relayer.registerClaim(1n, ALICE, "alice.token"), "unknown-promo");
});

test("registerTestClaim_asksCircleNothing_andIsCountedUnderItsOwnName", async () => {
  const { relayer, state } = setup();
  await relayer.registerTestClaim(0n, ALICE, "customer1");
  await refusal(relayer.registerTestClaim(0n, BOB, "customer1"), "already-claimed");
  // A test name is never mistaken for a Circle user with the same id.
  logins["named.like.a.test"] = { userId: "customer1", wallets: [BOB] };
  await relayer.registerClaim(0n, BOB, "named.like.a.test");
  assert.deepEqual(state.sent, [ALICE, BOB]);
  assert.deepEqual(state.asked, ["named.like.a.test"]);
});

// The route: the same rules as HTTP statuses, and the test key.
function route(testKey?: string) {
  const { relayer, state } = setup();
  const unused = {} as never;
  const store = new Store(null);
  const feed = new Feed({ store, vault: VAULT });
  const app = makeApp({ client: unused, vault: VAULT, usdc: VAULT, maxLockedBps: 6000, pricer: unused, games: unused, relayer, oracle: RELAYER, store, feed, testKey });
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request("/claims", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { alreadyRegistered?: boolean; error?: { code: string } } };
  };
  return { post, state };
}

test("postClaims_login_answersByWhatCircleSays", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const { post, state } = route();
  assert.equal((await post({ promoId: "0", customer: ALICE })).status, 400);
  assert.equal((await post({ promoId: "0", customer: ALICE, email: "alice@example.com" })).status, 400);
  const unknown = await post({ promoId: "0", customer: ALICE, userToken: "made.up.token" });
  assert.deepEqual([unknown.status, unknown.body.error?.code], [401, "login"]);
  const notTheirs = await post({ promoId: "0", customer: ALICE, userToken: "bob.token" });
  assert.deepEqual([notTheirs.status, notTheirs.body.error?.code], [403, "not-your-wallet"]);
  const down = await post({ promoId: "0", customer: ALICE, userToken: "circle.is.down" });
  assert.deepEqual([down.status, down.body.error?.code], [502, "failed"]);
  assert.deepEqual(state.sent, []);

  assert.equal((await post({ promoId: "0", customer: ALICE, userToken: "alice.token" })).status, 200);
  const again = await post({ promoId: "0", customer: ALICE, userToken: "alice.token" });
  assert.deepEqual([again.status, again.body.alreadyRegistered], [200, true]);
  const second = await post({ promoId: "0", customer: ALICE_2, userToken: "alice.token" });
  assert.deepEqual([second.status, second.body.error?.code], [409, "already-claimed"]);
  assert.deepEqual(state.sent, [ALICE]);
});

test("postClaims_testUser_needsTheTestKey", async () => {
  const { post, state } = route("the-test-key");
  const claim = { promoId: "0", customer: ALICE, testUser: "customer1" };
  assert.equal((await post(claim)).status, 401);
  assert.equal((await post(claim, { "x-test-key": "a-guess" })).status, 401);
  assert.equal((await post({ ...claim, testUser: "" }, { "x-test-key": "the-test-key" })).status, 400);
  assert.deepEqual(state.sent, []);
  assert.equal((await post(claim, { "x-test-key": "the-test-key" })).status, 200);
  assert.deepEqual(state.sent, [ALICE]);
});

test("postClaims_testUser_keeperWithNoTestKey_isRefusedWhateverIsSent", async () => {
  const { post, state } = route();
  const claim = { promoId: "0", customer: ALICE, testUser: "customer1" };
  assert.equal((await post(claim)).status, 401);
  assert.equal((await post(claim, { "x-test-key": "" })).status, 401);
  assert.equal((await post(claim, { "x-test-key": "undefined" })).status, 401);
  assert.deepEqual(state.sent, []);
});
