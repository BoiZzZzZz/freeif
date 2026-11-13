// GET /vault: the vault's books as a liquidity provider reads them, from a fake chain with four promos.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import { Status, type PublicClient } from "../src/chain.ts";
import { makeApp } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { Feed } from "../src/stream.ts";

const VAULT: Address = "0x68a00243927f250dBcD9160b5d06623b62B2e06d";
const USDC: Address = "0x3600000000000000000000000000000000000000";
const EVENT: Hex = `0x${"11".repeat(32)}`;
const WINGS: Hex = `0x${"22".repeat(32)}`;

const promo = (over: Record<string, unknown>) => ({
  merchant: VAULT,
  geminiEventId: EVENT,
  instrumentSymbol: WINGS,
  payoutPerClaim: 8_000_000n,
  maxClaims: 12,
  claimCount: 0,
  paidCount: 0,
  premiumPaid: 39_310_000n,
  collateralLocked: 0n,
  claimDeadline: 1794600000n,
  marketCloseTime: 1794700000n,
  settledAt: 0n,
  status: Status.Open as number,
  outcomeYes: false,
  hedgeMode: false,
  ...over,
});

// Four promos: one open with its full payout locked, one that ended "no", one that paid nine customers,
// one that was voided.
const PROMOS = [
  promo({ claimCount: 7, collateralLocked: 96_000_000n }),
  promo({ status: Status.FinalizedNo, claimCount: 5, settledAt: 1794650000n }),
  promo({ status: Status.PaidOut, claimCount: 9, paidCount: 9, outcomeYes: true, settledAt: 1794650000n }),
  promo({ status: Status.Voided }),
];

function setup() {
  const calls = { reads: 0 };
  const books: Record<string, unknown> = {
    lockedCollateral: 96_000_000n,
    pendingCollateral: 96_000_000n,
    totalOwedPayouts: 0n,
    totalShares: 1_500_000_000n,
    maxExposureBps: 2000,
    paused: false,
    disputeWindow: 3600,
    promoCount: BigInt(PROMOS.length),
  };
  const client = {
    getBlockNumber: async () => 72190000n,
    readContract: async ({ functionName }: { functionName: string }) => {
      assert.equal(functionName, "balanceOf");
      return 1_606_620_000n;
    },
    multicall: async ({ contracts }: { contracts: Array<{ functionName: string; args?: readonly bigint[] }> }) => {
      calls.reads++;
      return contracts.map(({ functionName, args }) => (functionName === "getPromo" ? PROMOS[Number(args![0])] : books[functionName]));
    },
  } as unknown as PublicClient;
  const store = new Store(null);
  store.data.events[EVENT] = { eventId: "1", eventTicker: "NFL-X-M", title: "Lions at Bears", game: "Lions at Bears" };
  store.data.instruments[WINGS] = { symbol: "GEMI-X", label: "Detroit", condition: "the Lions win" };
  store.data.promoLabels["0"] = { item: "Wings", business: "Tony's Pizza" };
  const feed = new Feed({ store, vault: VAULT, log: () => undefined });
  const unused = {} as never;
  const app = makeApp({ client, vault: VAULT, usdc: USDC, maxLockedBps: 6000, pricer: unused, games: unused, relayer: unused, oracle: VAULT, store, feed });
  return { app, feed, calls };
}

type Vault = {
  balance: string;
  locked: string;
  pending: string;
  free: string;
  depositBasis: string;
  totalShares: string;
  maxExposureBps: number;
  maxLockedBps: number;
  netEarned: string;
  promos: Array<{ promoId: string; status: string; item: string | null; game: string | null; condition: string | null; premium: string; maxPayout: string; locked: string; net: string | null }>;
  events: unknown[];
};

test("getVault_theBooksAddUp_andBothSharePricesHaveTheirBasis", async () => {
  const { app } = setup();
  const res = await app.request("/vault");
  assert.equal(res.status, 200);
  const v = (await res.json()) as Vault;
  assert.equal(v.balance, "1606620000");
  assert.equal(v.locked, "96000000");
  // A withdrawal is priced on what is free; a deposit on that plus the locks that may come back.
  assert.equal(v.free, "1510620000");
  assert.equal(v.depositBasis, "1606620000");
  assert.equal(v.totalShares, "1500000000");
  assert.deepEqual([v.maxExposureBps, v.maxLockedBps], [2000, 6000]);
});

test("getVault_netEarned_isPremiumsKeptLessPayouts_onPromosWithAFinalResultOnly", async () => {
  const { app } = setup();
  const v = (await (await app.request("/vault")).json()) as Vault;
  // The open promo: not counted. The "no": +39.31. The paid one: 39.31 - 9 x 8 = -32.69. The voided one: 0.
  assert.deepEqual(v.promos.map((p) => p.net), [null, "39310000", "-32690000", "0"]);
  assert.equal(v.netEarned, "6620000");
  assert.deepEqual(v.promos.map((p) => p.status), ["Open", "FinalizedNo", "PaidOut", "Voided"]);
});

test("getVault_aPromo_carriesItsWordsAndWhatItLocks", async () => {
  const { app } = setup();
  const v = (await (await app.request("/vault")).json()) as Vault;
  const open = v.promos[0]!;
  assert.deepEqual([open.item, open.game, open.condition], ["Wings", "Lions at Bears", "the Lions win"]);
  assert.deepEqual([open.premium, open.maxPayout, open.locked], ["39310000", "96000000", "96000000"]);
  // A promo with no label kept for it has no item.
  assert.equal(v.promos[1]!.item, null);
});

test("getVault_manyRequests_readTheChainOnce_untilAnEventArrives", async () => {
  const { app, feed, calls } = setup();
  await Promise.all(Array.from({ length: 10 }, () => app.request("/vault")));
  // One read is two multicalls: the books, then the promos.
  assert.equal(calls.reads, 2);
  feed.deliver({ message: "PING" });
  await app.request("/vault");
  assert.equal(calls.reads, 2, "a message with no vault event changes nothing");
});
