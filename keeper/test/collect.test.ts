// Collecting a claim card: the fee held back, and the one transaction the card signs, against a fake chain.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, erc20Abi, parseTransaction, recoverTransactionAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import "../src/config.ts";
import { CARD_DUST, collectCard, holdback, type CollectClient } from "../src/collect.ts";

const USDC: Address = "0x3600000000000000000000000000000000000000";
const TO: Address = "0x6f3DE22768B24a4cAE412BF3575E691488B7d6E4";
const KEY: Hex = `0x${"5a".repeat(32)}`;
const CARD = privateKeyToAccount(KEY).address;

test("holdback_isTheEstimatePlusAFifth_andTheMostThatCanCost_roundedUpToABaseUnit", () => {
  // 49,338 gas (a USDC transfer on Arc) at 24 gwei.
  const { gasLimit, fee } = holdback(49_338n, 24_000_000_000n);
  assert.equal(gasLimit, 59_206n); // 59,205.6 rounded up
  // 59,206 x 24 gwei = 1,420,944 gwei = 0.001420944 USDC: 1,421 base units, rounded up.
  assert.equal(fee, 1_421n);
  // A fee that is a whole number of base units is not rounded up again.
  assert.deepEqual(holdback(100n, 10n ** 12n), { gasLimit: 120n, fee: 120n });
  assert.deepEqual(holdback(100n, 10n ** 10n), { gasLimit: 120n, fee: 2n });
});

function fakeChain(balance: bigint) {
  const sent: Hex[] = [];
  const estimated: { account: Address; data: Hex }[] = [];
  const client: CollectClient = {
    readContract: async ({ args }) => (args[0] === CARD ? balance : 0n),
    estimateGas: async ({ account, data }) => {
      estimated.push({ account, data });
      return 49_338n;
    },
    estimateFeesPerGas: async () => ({ maxFeePerGas: 24_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }),
    getTransactionCount: async () => 0,
    sendRawTransaction: async ({ serializedTransaction }) => {
      sent.push(serializedTransaction);
      return `0x${"cd".repeat(32)}`;
    },
  };
  return { client, sent, estimated };
}

test("collectCard_sendsTheBalanceLessTheFee_withExactlyThatGasAndFee_signedByTheCard", async () => {
  const { client, sent, estimated } = fakeChain(8_000_000n);
  const done = await collectCard(client, USDC, KEY, TO);
  assert.deepEqual([done.card, done.balance, done.fee, done.amount, done.gasLimit], [CARD, 8_000_000n, 1_421n, 7_998_579n, 59_206n]);

  // The estimate is from the card, for the whole balance.
  assert.equal(estimated[0]!.account, CARD);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: estimated[0]!.data }).args, [TO, 8_000_000n]);

  assert.equal(sent.length, 1);
  const tx = parseTransaction(sent[0]!);
  assert.equal(await recoverTransactionAddress({ serializedTransaction: sent[0]! as `0x02${string}` }), CARD);
  assert.deepEqual([tx.chainId, tx.to, tx.gas, tx.maxFeePerGas, tx.maxPriorityFeePerGas, tx.nonce], [5042002, USDC, 59_206n, 24_000_000_000n, 1_000_000_000n, 0]);
  assert.equal(tx.value ?? 0n, 0n);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: tx.data! }).args, [TO, 7_998_579n]);
  // What is sent plus the most the fee can cost is never more than the card holds.
  assert.ok(done.amount * 10n ** 12n + tx.gas! * tx.maxFeePerGas! <= 8_000_000n * 10n ** 12n);
});

test("collectCard_aCardWithUnderACent_isRefused_andNothingIsSent", async () => {
  const { client, sent } = fakeChain(CARD_DUST - 1n);
  await assert.rejects(collectCard(client, USDC, KEY, TO), /nothing to collect/);
  assert.deepEqual(sent, []);
});
