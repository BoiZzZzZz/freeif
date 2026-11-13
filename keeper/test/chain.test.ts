// The two wrappers around the RPC endpoints: the first endpoint's block number is noted, and a second
// endpoint is asked only while it keeps up with it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Transport } from "viem";
import { MAX_LAG_BLOCKS, keepingUp, tracking, type Head } from "../src/chain.ts";

/** An endpoint at `state.block` that counts what it is asked. */
function endpoint(state: { block: number; asked: string[] }): Transport {
  return (() => ({
    config: { key: "fake", name: "fake", type: "fake" },
    request: async ({ method }: { method: string }) => {
      state.asked.push(method);
      return method === "eth_blockNumber" ? `0x${state.block.toString(16)}` : "0xanswer";
    },
  })) as unknown as Transport;
}
const ask = (transport: Transport, method: string): Promise<unknown> =>
  (transport({}).request as (args: { method: string }) => Promise<unknown>)({ method });

test("tracking_notesTheNewestBlockTheEndpointReports_andNeverGoesBack", async () => {
  const state = { block: 1000, asked: [] as string[] };
  const head: Head = { block: 0 };
  const first = tracking(endpoint(state), head);
  assert.equal(await ask(first, "eth_blockNumber"), "0x3e8");
  assert.equal(head.block, 1000);
  await ask(first, "eth_call");
  assert.equal(head.block, 1000);
  state.block = 990;
  await ask(first, "eth_blockNumber");
  assert.equal(head.block, 1000);
});

test("keepingUp_anEndpointAtTheNewestBlock_isAsked", async () => {
  const state = { block: 1000, asked: [] as string[] };
  const second = keepingUp(endpoint(state), { block: 1000 + MAX_LAG_BLOCKS }, () => 0);
  assert.equal(await ask(second, "eth_call"), "0xanswer");
  assert.deepEqual(state.asked, ["eth_blockNumber", "eth_call"]);
});

test("keepingUp_anEndpointThatFellBehind_fails_andItsOldStateIsNeverRead", async () => {
  const state = { block: 1000, asked: [] as string[] };
  const second = keepingUp(endpoint(state), { block: 1000 + MAX_LAG_BLOCKS + 1 }, () => 0);
  await assert.rejects(ask(second, "eth_call"), /21 blocks behind/);
  await assert.rejects(ask(second, "eth_getLogs"), /blocks behind/);
  // Only its block number was read, once.
  assert.deepEqual(state.asked, ["eth_blockNumber"]);
});

test("keepingUp_checksEveryFiveSeconds_soAnEndpointThatCatchesUpIsUsedAgain", async () => {
  const state = { block: 1000, asked: [] as string[] };
  const head: Head = { block: 2000 };
  let now = 0;
  const second = keepingUp(endpoint(state), head, () => now);
  await assert.rejects(ask(second, "eth_call"));
  now = 4_999;
  state.block = 2000;
  await assert.rejects(ask(second, "eth_call"), /blocks behind/, "the last check still counts");
  now = 5_000;
  assert.equal(await ask(second, "eth_call"), "0xanswer");
  // And one that falls behind later stops being used at the next check.
  head.block = 3000;
  assert.equal(await ask(second, "eth_call"), "0xanswer");
  now = 10_000;
  await assert.rejects(ask(second, "eth_call"), /1000 blocks behind/);
});

test("keepingUp_beforeAnyBlockHasBeenSeen_theEndpointIsAsked", async () => {
  const state = { block: 1000, asked: [] as string[] };
  const second = keepingUp(endpoint(state), { block: 0 }, () => 0);
  assert.equal(await ask(second, "eth_call"), "0xanswer");
});
