// What the keeper learns from a Circle login token, with Circle replaced by a fake. The answers are
// the shapes the real API gave on Nov 13.
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeIdentify } from "../src/circle.ts";

type Answer = { status: number; body: unknown };

const USER = {
  status: 200,
  body: { data: { id: "3f5ee8dc-5aca-5dfe-aab9-26d215f1f67f", status: "ENABLED", pinStatus: "ENABLED", authMode: "EMAIL" } },
};
const arcWallet = {
  id: "4dee5644-3e71-5edc-9854-62da5bbdd6ac",
  state: "LIVE",
  custodyType: "ENDUSER",
  userId: "3f5ee8dc-5aca-5dfe-aab9-26d215f1f67f",
  address: "0x49aac84bd97afb29db7f53ee43be2ede963b8937",
  blockchain: "ARC-TESTNET",
  accountType: "EOA",
};
const WALLETS = { status: 200, body: { data: { wallets: [arcWallet] } } };
const INVALID = { status: 403, body: { code: 155105, message: "The userToken is invalid." } };

/** A fake `fetch` that answers the two routes and keeps what it was asked. */
function fakeCircle(user: Answer, wallets: Answer) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetcher = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    const answer = url.endsWith("/user") ? user : wallets;
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof fetch;
  return { identify: makeIdentify("the-api-key", fetcher), calls };
}

test("identify_goodToken_givesTheUserIdAndTheirWalletsOnArc", async () => {
  const { identify, calls } = fakeCircle(USER, WALLETS);
  assert.deepEqual(await identify("a.user.token"), {
    userId: "3f5ee8dc-5aca-5dfe-aab9-26d215f1f67f",
    wallets: ["0x49Aac84BD97aFB29Db7F53Ee43be2EdE963b8937"],
  });
  assert.deepEqual(calls.map((c) => c.url).sort(), [
    "https://api.circle.com/v1/w3s/user",
    "https://api.circle.com/v1/w3s/wallets",
  ]);
  for (const call of calls) {
    assert.equal(call.headers.Authorization, "Bearer the-api-key");
    assert.equal(call.headers["X-User-Token"], "a.user.token");
  }
});

test("identify_walletsOnOtherChains_areLeftOut", async () => {
  const elsewhere = { ...arcWallet, address: "0x6f3de22768b24a4cae412bf3575e691488b7d6e4", blockchain: "ETH-SEPOLIA" };
  const { identify } = fakeCircle(USER, { status: 200, body: { data: { wallets: [elsewhere, arcWallet] } } });
  assert.deepEqual((await identify("a.user.token"))?.wallets, ["0x49Aac84BD97aFB29Db7F53Ee43be2EdE963b8937"]);
});

test("identify_userWithNoWalletYet_hasAnEmptyList", async () => {
  const { identify } = fakeCircle(USER, { status: 200, body: { data: { wallets: [] } } });
  assert.deepEqual(await identify("a.user.token"), { userId: "3f5ee8dc-5aca-5dfe-aab9-26d215f1f67f", wallets: [] });
});

test("identify_invalidOrExpiredToken_isNoLogin", async () => {
  assert.equal(await fakeCircle(INVALID, INVALID).identify("tampered"), null);
  const expired = { status: 403, body: { code: 155104, message: "The userToken has expired." } };
  assert.equal(await fakeCircle(expired, expired).identify("old"), null);
  // One route refusing is enough.
  assert.equal(await fakeCircle(USER, INVALID).identify("half"), null);
});

test("identify_refusalAboutTheKeeperNotTheCustomer_throws", async () => {
  const wrongKey = { status: 401, body: { code: 401, message: "Invalid credentials." } };
  await assert.rejects(fakeCircle(wrongKey, wrongKey).identify("a.user.token"), /Circle answered 401/);
  const down = { status: 503, body: {} };
  await assert.rejects(fakeCircle(USER, down).identify("a.user.token"), /Circle answered 503/);
});

test("identify_answerWithNoUserId_throws", async () => {
  const { identify } = fakeCircle({ status: 200, body: { data: {} } }, WALLETS);
  await assert.rejects(identify("a.user.token"), /no user id/);
});

test("identify_networkFailure_throws", async () => {
  const fetcher = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  await assert.rejects(makeIdentify("the-api-key", fetcher)("a.user.token"), /fetch failed/);
});
