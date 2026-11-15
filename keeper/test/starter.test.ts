// Starter test dollars through the HTTP app, with Circle and the chain replaced by fakes: the switch, who
// may have them (as for a claim), once per login, the hold that stops two at once, a transfer that fails,
// the budget, the floor, the limit, `GET /health`, and that the user token is never logged or kept.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { format } from "node:util";
import type { Address, Hex } from "viem";
import "../src/config.ts";
import type { PublicClient, WalletClient } from "../src/chain.ts";
import type { CircleUser } from "../src/circle.ts";
import { LIMITS, type Limits } from "../src/limit.ts";
import { claimKey, Relayer } from "../src/relayer.ts";
import { makeApp } from "../src/server.ts";
import { Starter, type StarterSettings } from "../src/starter.ts";
import { Store } from "../src/store.ts";
import { Feed } from "../src/stream.ts";

const VAULT: Address = "0x68a00243927f250dBcD9160b5d06623b62B2e06d";
const USDC: Address = "0x3600000000000000000000000000000000000000";
const RELAYER: Address = "0xa03aF58DF0B042fFA9342F178bb37F8a9f1E3286";
const ALICE: Address = "0x6f3DE22768B24a4cAE412BF3575E691488B7d6E4";
const ALICE_2: Address = "0x2235755531e63f2c716C3167e622685d79C12477";
const BOB: Address = "0x7DA5F6f9bbEBf584f71CdD082aeBEaF46fa7E799";
const CAROL: Address = "0x5442DE8276aB4770a1e4EAAB6E6284c575987440";
const NOW = 1_794_500_000;
const TX: Hex = `0x${"ab".repeat(32)}`;
const USD = 1_000_000n;

// Tokens no other text in a log line or the file could contain by chance.
const T = {
  alice: "tok-alice-5c1f0e9a",
  bob: "tok-bob-77d2b3e4",
  carol: "tok-carol-1a9e44c0",
  expired: "tok-expired-90ab12cd",
  down: "tok-down-3e8f5a61",
};

/** Circle, as a table: token => the user, null for a token it refuses, "down" when it cannot be asked. */
const logins: Record<string, CircleUser | null | "down"> = {
  [T.alice]: { userId: "user-alice", wallets: [ALICE, ALICE_2] },
  [T.bob]: { userId: "user-bob", wallets: [BOB] },
  [T.carol]: { userId: "user-carol", wallets: [CAROL] },
  [T.expired]: null,
  [T.down]: "down",
};

type Next = "ok" | "simulate-fails" | "send-fails" | "reverts" | "lost";

function setup(opts: { settings?: Partial<StarterSettings>; relayerHolds?: bigint; limits?: Partial<Limits>; dir?: string; off?: boolean } = {}) {
  const state = {
    balances: new Map<string, bigint>([[RELAYER.toLowerCase(), opts.relayerHolds ?? 100n * USD]]),
    /** Every transfer that left the relayer. */
    sent: [] as { to: Address; amount: bigint }[],
    /** Every token Circle was asked about. */
    asked: [] as string[],
    /** How often the relayer's own balance was read. */
    relayerReads: 0,
    /** When true, reading the relayer's balance fails. */
    readsFail: false,
    /** How the next transfer goes. */
    next: "ok" as Next,
  };
  let clock = NOW * 1000;
  const holds = (who: string) => state.balances.get(who.toLowerCase()) ?? 0n;
  const client = {
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args: readonly unknown[] }) => {
      assert.deepEqual([address, functionName], [USDC, "balanceOf"]);
      const who = args[0] as string;
      if (who.toLowerCase() === RELAYER.toLowerCase()) {
        state.relayerReads++;
        if (state.readsFail) throw new Error("the RPC did not answer");
      }
      return holds(who);
    },
    simulateContract: async ({ address, functionName, args }: { address: Address; functionName: string; args: readonly unknown[] }) => {
      assert.deepEqual([address, functionName], [USDC, "transfer"]);
      if (state.next === "simulate-fails") throw new Error("the transfer would revert");
      return { request: { args } };
    },
    waitForTransactionReceipt: async () => {
      if (state.next === "lost") throw new Error("timed out waiting for the receipt");
      return { status: state.next === "reverts" ? "reverted" : "success", logs: [] };
    },
    getBlockNumber: async () => 1n,
  } as unknown as PublicClient;
  const wallet = {
    account: { address: RELAYER },
    writeContract: async ({ args }: { args: readonly [Address, bigint] }) => {
      if (state.next === "send-fails") throw new Error("nonce too low");
      if (state.next !== "reverts") {
        const [to, amount] = args;
        state.balances.set(RELAYER.toLowerCase(), holds(RELAYER) - amount);
        state.balances.set(to.toLowerCase(), holds(to) + amount);
        state.sent.push({ to, amount });
      }
      return TX;
    },
  } as unknown as WalletClient;
  const identify = async (token: string) => {
    state.asked.push(token);
    const user = logins[token] ?? null;
    // An error that names the token, to show it is cut out of the log line.
    if (user === "down") throw new Error(`Circle answered 503 for ${token}`);
    return user;
  };
  const store = new Store(opts.dir ?? null);
  const relayer = new Relayer({ client, wallet, vault: VAULT, store, identify });
  const settings: StarterSettings = { amount: 5n * USD, budget: 50n * USD, floor: 25n * USD, ...opts.settings };
  const now = () => clock;
  const starter = new Starter({ client, relayer, usdc: USDC, store, identify, settings, now });
  const unused = {} as never;
  const feed = new Feed({ store, vault: VAULT, log: () => undefined });
  const app = makeApp({
    client, vault: VAULT, usdc: USDC, maxLockedBps: 6000, pricer: unused, games: unused, relayer, oracle: RELAYER, store, feed,
    // The route's own limit is lifted, except where a test puts it back, so a test can ask many times.
    starter: opts.off ? undefined : starter, limits: { ...LIMITS, starter: { name: "starter", max: 1000, windowMs: 60_000 }, ...opts.limits }, now,
  });
  type Reply = { amount?: string; txHash?: string; error?: { code: string; message: string } };
  const post = async (body: unknown, ip = "203.0.113.7") => {
    const res = await app.request("/starter", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": ip },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Reply };
  };
  const health = async () => {
    const res = await app.request("/health");
    assert.equal(res.status, 200);
    return ((await res.json()) as { starter: { amount: string; left: number } | null }).starter;
  };
  return { app, post, health, state, store, relayer, pass: (ms: number) => { clock += ms; } };
}

const ask = (address: Address, userToken: string) => ({ address, userToken });

test("postStarter_featureOff_is404Off_andHealthSaysNull", async () => {
  const { post, health, state } = setup({ off: true });
  const reply = await post(ask(ALICE, T.alice));
  assert.deepEqual([reply.status, reply.body.error?.code], [404, "off"]);
  assert.equal(await health(), null);
  assert.deepEqual(state.asked, []);
});

test("postStarter_badBody_is400_andCircleIsNotAsked", async () => {
  const { post, state } = setup();
  for (const body of [{ userToken: T.alice }, ask("0x1234" as Address, T.alice), { address: ALICE }, ask(ALICE, ""), { address: ALICE, userToken: 7 }, null, [], "{not json"]) {
    const reply = await post(body);
    assert.deepEqual([reply.status, reply.body.error?.code], [400, "bad-request"], `for ${JSON.stringify(body)}`);
  }
  assert.deepEqual(state.asked, []);
  assert.deepEqual(state.sent, []);
});

test("postStarter_login_answersByWhatCircleSays_andSendsNothing", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const { post, state, store } = setup();
  const unknown = await post(ask(ALICE, T.expired));
  assert.deepEqual([unknown.status, unknown.body.error?.code], [401, "login"]);
  const madeUp = await post(ask(ALICE, "tok-nobody-knows"));
  assert.deepEqual([madeUp.status, madeUp.body.error?.code], [401, "login"]);
  // A token that cannot be one is refused before Circle is asked.
  const spaced = await post(ask(ALICE, "tok with spaces"));
  assert.deepEqual([spaced.status, spaced.body.error?.code], [401, "login"]);
  assert.ok(!state.asked.includes("tok with spaces"));

  const notTheirs = await post(ask(ALICE, T.bob));
  assert.deepEqual([notTheirs.status, notTheirs.body.error?.code], [403, "not-your-wallet"]);
  const down = await post(ask(ALICE, T.down));
  assert.deepEqual([down.status, down.body.error?.code], [502, "failed"]);

  assert.deepEqual(state.sent, []);
  assert.deepEqual(store.data.starter, {});
});

test("postStarter_goodLogin_sendsTheAmount_andKeepsTheGrantUnderTheHashOfTheLogin", async () => {
  const { post, state, store } = setup();
  const reply = await post(ask(ALICE.toLowerCase() as Address, T.alice));
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { amount: "5000000", txHash: TX });
  assert.deepEqual(state.sent, [{ to: ALICE, amount: 5n * USD }]);
  assert.deepEqual(store.data.starter, {
    [claimKey("circle:user-alice")]: { address: ALICE, amount: "5000000", at: NOW, txHash: TX },
  });
  // The file holds no user id.
  assert.ok(!JSON.stringify(store.data).includes("user-alice"));
});

test("postStarter_secondRequest_isRefusedAlready_whicheverWalletOfTheLoginItNames", async () => {
  const { post, state } = setup();
  assert.equal((await post(ask(ALICE, T.alice))).status, 200);
  const again = await post(ask(ALICE, T.alice));
  assert.deepEqual([again.status, again.body.error?.code], [409, "already"]);
  const otherWallet = await post(ask(ALICE_2, T.alice));
  assert.deepEqual([otherWallet.status, otherWallet.body.error?.code], [409, "already"]);
  assert.equal(state.sent.length, 1);
  // Another login is not held back by it.
  assert.equal((await post(ask(BOB, T.bob))).status, 200);
  assert.equal(state.sent.length, 2);
});

test("postStarter_twoRequestsAtOnce_fromOneLogin_giveOneGrant", async () => {
  const { post, state, store } = setup();
  const replies = await Promise.all([post(ask(ALICE, T.alice)), post(ask(ALICE_2, T.alice)), post(ask(ALICE, T.alice))]);
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409, 409]);
  assert.deepEqual(replies.filter((r) => r.status === 409).map((r) => r.body.error?.code), ["already", "already"]);
  assert.equal(state.sent.length, 1);
  assert.equal(Object.keys(store.data.starter).length, 1);
});

test("postStarter_transferThatFails_givesTheHoldBack_soTheyCanTryAgain", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const { post, state, store } = setup();
  for (const next of ["simulate-fails", "send-fails", "reverts"] as const) {
    state.next = next;
    const reply = await post(ask(ALICE, T.alice));
    assert.deepEqual([reply.status, reply.body.error?.code], [502, "failed"], next);
    assert.deepEqual(store.data.starter, {}, next);
  }
  assert.deepEqual(state.sent, []);
  state.next = "ok";
  assert.equal((await post(ask(ALICE, T.alice))).status, 200);
  assert.equal(state.sent.length, 1);
});

test("postStarter_sentButNotConfirmed_keepsTheGrant_becauseItMayHaveArrived", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const { post, state, store } = setup();
  state.next = "lost";
  const reply = await post(ask(ALICE, T.alice));
  assert.deepEqual([reply.status, reply.body.error?.code], [502, "failed"]);
  assert.match(reply.body.error!.message, /can't confirm/);
  assert.equal(store.data.starter[claimKey("circle:user-alice")]?.txHash, TX);
  state.next = "ok";
  const again = await post(ask(ALICE, T.alice));
  assert.deepEqual([again.status, again.body.error?.code], [409, "already"]);
  assert.equal(state.sent.length, 1);
});

test("postStarter_accountThatHoldsTheAmount_is409Funded_andKeepsNoHold", async () => {
  const { post, state, store } = setup();
  state.balances.set(ALICE.toLowerCase(), 5n * USD);
  const funded = await post(ask(ALICE, T.alice));
  assert.deepEqual([funded.status, funded.body.error?.code], [409, "funded"]);
  assert.deepEqual(store.data.starter, {});
  // A cent short of it is sent the whole amount.
  state.balances.set(ALICE.toLowerCase(), 5n * USD - 10_000n);
  assert.equal((await post(ask(ALICE, T.alice))).status, 200);
  assert.deepEqual(state.sent, [{ to: ALICE, amount: 5n * USD }]);
});

test("postStarter_budget_countsEveryGrant_andCircleIsNotAskedOnceItIsUsedUp", async () => {
  const { post, health, state } = setup({ settings: { budget: 10n * USD } });
  assert.equal((await health())?.left, 2);
  assert.equal((await post(ask(ALICE, T.alice))).status, 200);
  assert.equal((await post(ask(BOB, T.bob))).status, 200);
  const none = await post(ask(CAROL, T.carol));
  assert.deepEqual([none.status, none.body.error?.code], [409, "none-left"]);
  assert.ok(!state.asked.includes(T.carol));
  assert.equal((await health())?.left, 0);
  assert.equal(state.sent.length, 2);
});

test("postStarter_budget_countsAGrantBeingSent", async () => {
  const { post, state, relayer } = setup({ settings: { budget: 5n * USD } });
  // The line is busy (a claim), so Alice's grant is held but not sent when Bob asks.
  let release = () => {};
  const busy = relayer.inLine(() => new Promise<void>((resolve) => { release = resolve; }));
  const alice = post(ask(ALICE, T.alice));
  while (state.asked.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const bob = await post(ask(BOB, T.bob));
  assert.deepEqual([bob.status, bob.body.error?.code], [409, "none-left"]);
  release();
  await busy;
  assert.equal((await alice).status, 200);
  assert.deepEqual(state.sent, [{ to: ALICE, amount: 5n * USD }]);
});

test("postStarter_floor_neverTakesTheRelayerUnderIt", async () => {
  const { post, state, store } = setup({ relayerHolds: 29n * USD });
  const none = await post(ask(ALICE, T.alice));
  assert.deepEqual([none.status, none.body.error?.code], [409, "none-left"]);
  assert.deepEqual(store.data.starter, {});
  assert.deepEqual(state.sent, []);
  // With exactly the floor left after it, it goes.
  state.balances.set(RELAYER.toLowerCase(), 30n * USD);
  assert.equal((await post(ask(ALICE, T.alice))).status, 200);
  assert.equal(state.balances.get(RELAYER.toLowerCase()), 25n * USD);
});

test("health_starter_saysTheAmountAndWhatIsLeft_readingTheBalanceAtMostEvery30Seconds", async () => {
  const { post, health, state, pass } = setup({ relayerHolds: 47n * USD });
  // The budget allows ten; the floor allows four: (47 - 25) / 5.
  assert.deepEqual(await health(), { amount: "5000000", left: 4 });
  assert.equal(state.relayerReads, 1);
  pass(29_000);
  await health();
  assert.equal(state.relayerReads, 1);
  pass(1_000);
  await health();
  assert.equal(state.relayerReads, 2);

  // A grant drops the held balance: the next answer counts it.
  assert.equal((await post(ask(ALICE, T.alice))).status, 200);
  assert.deepEqual(await health(), { amount: "5000000", left: 3 });

  // The balance cannot be read: the budget's count alone, and /health still answers.
  pass(30_000);
  state.readsFail = true;
  assert.deepEqual(await health(), { amount: "5000000", left: 9 });
});

test("postStarter_hasItsOwnLimitOfFiveAMinute_whichLeavesTheOtherRoutesOpen", async () => {
  const { app, post } = setup({ limits: { starter: LIMITS.starter } });
  for (let i = 0; i < 5; i++) assert.equal((await post({})).status, 400);
  const sixth = await post({});
  assert.deepEqual([sixth.status, sixth.body.error?.code], [429, "too-many"]);
  // Another address has its own five.
  assert.equal((await post({}, "198.51.100.9")).status, 400);
  const feed = await app.request("/feed", { headers: { "x-real-ip": "203.0.113.7" } });
  assert.equal(feed.status, 200);
});

test("postStarter_waitsItsTurnInTheRelayersLine", async () => {
  const { post, state, relayer } = setup();
  let release = () => {};
  const claim = relayer.inLine(() => new Promise<void>((resolve) => { release = resolve; }));
  let done = false;
  const grant = post(ask(ALICE, T.alice)).then((reply) => {
    done = true;
    return reply;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(done, false);
  assert.deepEqual(state.sent, []);
  release();
  await claim;
  assert.equal((await grant).status, 200);
  assert.equal(state.sent.length, 1);
});

test("theUserToken_isNeverInALogLineOrInTheFile", async (t) => {
  const lines: string[] = [];
  for (const method of ["log", "error", "warn", "info", "debug"] as const) {
    t.mock.method(console, method, (...args: unknown[]) => {
      lines.push(format(...args));
    });
  }
  const dir = mkdtempSync(join(tmpdir(), "freeif-starter-"));
  try {
    const { post, state } = setup({ dir });
    const replies = [
      await post(ask(ALICE, T.expired)),
      await post(ask(ALICE, T.down)),
      await post(ask(ALICE, T.bob)),
    ];
    state.next = "send-fails";
    replies.push(await post(ask(ALICE, T.alice)));
    state.next = "reverts";
    replies.push(await post(ask(ALICE, T.alice)));
    state.next = "lost";
    replies.push(await post(ask(BOB, T.bob)));
    state.next = "ok";
    replies.push(await post(ask(ALICE, T.alice)));
    replies.push(await post(ask(ALICE, T.alice)));
    assert.deepEqual(
      replies.map((r) => r.status),
      [401, 502, 403, 502, 502, 502, 200, 409],
    );
    // Something was logged on the failures, and none of it holds a token.
    assert.ok(lines.length >= 4);
    const file = readFileSync(join(dir, "keeper.json"), "utf8");
    assert.ok(file.includes(TX));
    for (const token of Object.values(T)) {
      for (const line of lines) assert.ok(!line.includes(token), `a log line holds a token: ${line}`);
      assert.ok(!file.includes(token), "the file holds a token");
      for (const reply of replies) assert.ok(!JSON.stringify(reply.body).includes(token));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
