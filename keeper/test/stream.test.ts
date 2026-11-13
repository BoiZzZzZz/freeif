// The feed: the QuickNode Stream's filter run as QuickNode runs it, the decoding of a delivery, the two
// ways an event reaches the feed, and the webhook and the event stream through the HTTP app.
// test/fixtures/vault-logs.json is thirteen real logs of the deployed vault, as Arc's RPC and QuickNode's
// logs dataset both give them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import { toEventSelector, type Address, type Hex } from "viem";
import { promoVaultAbi } from "../src/abi.ts";
import type { PublicClient } from "../src/chain.ts";
import "../src/config.ts";
import { makeApp, validSignature } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { FEED_EVENTS, Feed, decodeLog, firstBlockOf, readDelivery, type FeedEvent } from "../src/stream.ts";

type ChainLog = {
  address: string;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  blockTimestamp: Hex;
  transactionHash: Hex;
  logIndex: Hex;
};

const VAULT: Address = "0x68a00243927f250dBcD9160b5d06623b62B2e06d";
const USDC: Address = "0x3600000000000000000000000000000000000000";
const SECRET = "the-streams-secret";
const logs = JSON.parse(readFileSync(new URL("./fixtures/vault-logs.json", import.meta.url), "utf8")) as ChainLog[];
const blockOf = (log: ChainLog): number => Number(log.blockNumber);
const timeOf = (log: ChainLog): number => Number(log.blockTimestamp);
/** Each event's topic hash, from the ABI. */
const selectors = new Map<string, Hex>();
for (const item of promoVaultAbi) if (item.type === "event") selectors.set(item.name, toEventSelector(item));
const named = (name: string): ChainLog[] => logs.filter((l) => l.topics[0] === selectors.get(name));
const one = (name: string): ChainLog => named(name)[0]!;

// A log of another contract in the same block: a USDC transfer.
const otherLog = (like: ChainLog): ChainLog => ({
  ...like,
  address: "0x3600000000000000000000000000000000000000",
  topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", like.topics[1]!, like.topics[1]!],
  logIndex: "0x63",
});

/** One block as QuickNode's logs dataset hands it to the filter: transactions, each a list of logs. */
function payload(blockLogs: ChainLog[]) {
  const byTx = new Map<string, ChainLog[]>();
  for (const log of blockLogs) byTx.set(log.transactionHash, [...(byTx.get(log.transactionHash) ?? []), log]);
  const block = blockLogs.length > 0 ? blockOf(blockLogs[0]!) : 72158000;
  return {
    data: [[...byTx.values()]],
    metadata: { network: "arc-testnet", stream_id: "stream-1", dataset: "logs", batch_start_range: block, batch_end_range: block },
  };
}

type Filtered = {
  vault: string;
  network: string;
  streamId: string;
  blockRange: [number, number];
  events: Array<{ event: string; promoId: number | null; txHash: string; blockNumber: number; timestamp: number; logIndex: number; customer?: string; merchant?: string; lp?: string }>;
};
const filterSource = readFileSync(new URL("../stream/filter.js", import.meta.url), "utf8");
const runFilter = new Function(`${filterSource}\nreturn main;`)() as (payload: unknown) => Filtered | null;

/** What QuickNode would deliver for the block these logs are in: the filter's answer, through JSON. */
const delivery = (blockLogs: ChainLog[]): unknown => JSON.parse(JSON.stringify(runFilter(payload(blockLogs))));

const paidBlock = named("Paid");
const claims = named("ClaimRegistered");

// ---- The filter ----

test("filter_blockWithVaultEvents_returnsThemNamedWithTheirPromoAndAccount", () => {
  const out = runFilter(payload([otherLog(paidBlock[0]!), ...paidBlock]));
  assert.ok(out);
  assert.equal(out.vault, VAULT.toLowerCase());
  assert.equal(out.network, "arc-testnet");
  assert.equal(out.streamId, "stream-1");
  assert.deepEqual(out.blockRange, [72158808, 72158808]);
  assert.deepEqual(out.events.map((e) => e.event), ["Paid", "Paid", "Paid"]);
  assert.deepEqual(out.events.map((e) => e.promoId), [1, 1, 1]);
  assert.equal(out.events[0]!.customer, "0x6f3de22768b24a4cae412bf3575e691488b7d6e4");
  assert.equal(out.events[0]!.txHash, paidBlock[0]!.transactionHash);
  assert.equal(out.events[0]!.blockNumber, 72158808);
  assert.equal(out.events[0]!.timestamp, timeOf(paidBlock[0]!));
  assert.equal(out.events[0]!.logIndex, 5);
});

test("filter_depositAndPromoCreated_nameTheLpAndTheMerchant", () => {
  const deposit = runFilter(payload([one("Deposited")]))!.events[0]!;
  assert.equal(deposit.promoId, null);
  assert.equal(deposit.lp, "0xeefe3a210de60533bbbd6e4021146c48cb1d665a");
  const created = runFilter(payload([one("PromoCreated")]))!.events[0]!;
  assert.equal(created.promoId, 1);
  assert.equal(created.merchant, `0x${one("PromoCreated").topics[2]!.slice(26)}`);
});

test("filter_blockWithNoVaultEvent_returnsNull_soNothingIsDelivered", () => {
  assert.equal(runFilter(payload([])), null);
  assert.equal(runFilter(payload([otherLog(paidBlock[0]!)])), null);
  // The vault's own log, but a settings change: not one of the events the feed keeps.
  assert.equal(runFilter(payload([one("DisputeWindowSet")])), null);
  assert.equal(runFilter({ data: [], metadata: {} }), null);
});

test("filter_topicHashes_areTheAbisEvents", () => {
  const table = new Map<string, string>();
  for (const [, hash, name] of filterSource.matchAll(/"(0x[0-9a-f]{64})": \{ name: "(\w+)"/g)) table.set(name!, hash!);
  assert.deepEqual([...table.keys()].sort(), [...FEED_EVENTS].sort());
  for (const name of FEED_EVENTS) {
    assert.equal(table.get(name), selectors.get(name), `${name}'s topic hash`);
  }
});

test("filter_vaultAddress_isLowerCase_andTheDeployedVault", () => {
  const address = /var VAULT = "(0x[0-9a-fA-F]{40})";/.exec(filterSource)?.[1];
  assert.ok(address, "the filter names the vault");
  // The filter compares against `log.address.toLowerCase()`.
  assert.equal(address, address.toLowerCase());
  if (process.env.VAULT_ADDRESS) assert.equal(address, process.env.VAULT_ADDRESS.toLowerCase());
});

// ---- Decoding a delivery ----

test("readDelivery_filterOutput_andTheUnfilteredDataset_giveTheSameEvents", () => {
  const decode = (body: unknown) => readDelivery(body).map((log) => decodeLog(log, VAULT, "stream", 1)).filter((e) => e !== null);
  const filtered = decode(delivery([otherLog(paidBlock[0]!), ...paidBlock]));
  const unfiltered = decode(payload([otherLog(paidBlock[0]!), ...paidBlock]));
  assert.equal(filtered.length, 3);
  assert.deepEqual(filtered, unfiltered);
});

test("readDelivery_quickNodesTestMessage_hasNoLogs", () => {
  assert.deepEqual(readDelivery({ message: "PING" }), []);
  assert.deepEqual(readDelivery(null), []);
  assert.deepEqual(readDelivery("PING"), []);
  assert.deepEqual(readDelivery({ events: [{ topics: ["not a hash"], data: "0x" }] }), []);
});

test("decodeLog_eachEvent_carriesItsFields", () => {
  const decode = (log: ChainLog): FeedEvent => {
    const event = decodeLog(readDelivery([log])[0]!, VAULT, "rpc", 5_000);
    assert.ok(event, "decodes");
    return event;
  };

  const created = decode(one("PromoCreated"));
  assert.equal(created.event, "PromoCreated");
  assert.equal(created.promoId, "1");
  assert.equal(created.merchant, "0x5442DE8276aB4770a1e4EAAB6E6284c575987440");
  // The quote's premium, read from the event's data: promo 1 cost its merchant $2.24.
  assert.equal(created.amount, "2240000");
  assert.match(created.nonce!, /^0x[0-9a-f]{64}$/);
  assert.equal(created.block, 72158239);
  assert.equal(created.at, timeOf(one("PromoCreated")));
  assert.equal(created.id, `${one("PromoCreated").transactionHash}:${Number(one("PromoCreated").logIndex)}`);
  assert.equal(created.via, "rpc");
  assert.equal(created.seenAt, 5_000);

  const claim = decode(claims[1]!);
  assert.deepEqual([claim.event, claim.promoId, claim.claimCount], ["ClaimRegistered", "1", 2]);
  assert.equal(claim.customer, "0x2235755531e63f2c716C3167e622685d79C12477");

  const [settledNo, settledYes] = named("Settled").map(decode);
  assert.deepEqual([settledNo!.promoId, settledNo!.outcomeYes], ["0", false]);
  assert.deepEqual([settledYes!.promoId, settledYes!.outcomeYes], ["1", true]);

  const [finalNo, finalYes] = named("Finalized").map(decode);
  assert.deepEqual([finalNo!.promoId, finalNo!.outcomeYes, finalNo!.amount], ["0", false, "3000000"]);
  assert.deepEqual([finalYes!.promoId, finalYes!.outcomeYes, finalYes!.amount], ["1", true, "0"]);

  const paid = decode(paidBlock[2]!);
  assert.deepEqual([paid.event, paid.promoId, paid.amount], ["Paid", "1", "1000000"]);
  assert.equal(paid.customer, "0x7DA5F6f9bbEBf584f71CdD082aeBEaF46fa7E799");

  const deposit = decode(one("Deposited"));
  assert.deepEqual([deposit.event, deposit.promoId, deposit.amount, deposit.shares], ["Deposited", null, "50000000", "49999000"]);
  assert.equal(deposit.lp, "0xEEfE3a210dE60533bBBd6E4021146c48Cb1d665A");
});

test("decodeLog_anotherContractsLog_orAnEventTheFeedDoesNotKeep_isNull", () => {
  const raw = (log: ChainLog) => readDelivery([log])[0]!;
  // The same bytes from another address are not the vault's event, whatever they decode to.
  assert.equal(decodeLog(raw({ ...paidBlock[0]!, address: "0x3600000000000000000000000000000000000000" }), VAULT, "stream", 1), null);
  assert.equal(decodeLog(raw(otherLog(paidBlock[0]!)), VAULT, "stream", 1), null);
  assert.equal(decodeLog(raw(one("DisputeWindowSet")), VAULT, "stream", 1), null);
  // Data that does not fit the event.
  assert.equal(decodeLog(raw({ ...paidBlock[0]!, data: "0x01" }), VAULT, "stream", 1), null);
});

// ---- The feed ----

function makeFeed(over: { now?: () => number; client?: PublicClient; graceMs?: number; startBlock?: number } = {}) {
  const store = new Store(null);
  const feed = new Feed({ store, vault: VAULT, log: () => undefined, ...over });
  return { store, feed };
}

test("deliver_aBlocksEvents_areAddedOnce_howeverOftenItIsDelivered", () => {
  const { store, feed } = makeFeed({ now: () => 9_000 });
  assert.deepEqual(feed.deliver(delivery(paidBlock)), { logs: 3, added: 3 });
  assert.deepEqual(feed.deliver(delivery(paidBlock)), { logs: 3, added: 0 });
  assert.equal(store.data.feed.events.length, 3);
  assert.ok(store.data.feed.events.every((e) => e.via === "stream" && e.seenAt === 9_000));
  assert.deepEqual(feed.status(), { deliveries: 2, signed: 0, lastDeliveryAt: 9, events: 3, byStream: 3, cursor: null });
});

test("deliver_aMessageWithNoVaultEvent_countsAsNoDelivery", () => {
  const { feed } = makeFeed();
  assert.deepEqual(feed.deliver({ message: "PING" }), { logs: 0, added: 0 });
  assert.deepEqual(feed.deliver(payload([otherLog(paidBlock[0]!)])), { logs: 0, added: 0 });
  assert.equal(feed.status().deliveries, 0);
  assert.equal(feed.status().lastDeliveryAt, null);
});

test("forPromo_isInChainOrder_whateverOrderTheEventsCameIn", () => {
  const { feed } = makeFeed();
  feed.deliver(delivery(paidBlock));
  feed.deliver(delivery(named("Finalized")));
  feed.deliver(delivery([claims[2]!]));
  feed.deliver(delivery([one("PromoCreated")]));
  assert.deepEqual(
    feed.forPromo("1").map((e) => e.event),
    ["PromoCreated", "ClaimRegistered", "Finalized", "Paid", "Paid", "Paid"],
  );
  assert.deepEqual(feed.forPromo("0").map((e) => e.event), ["Finalized"]);
  assert.deepEqual(feed.forPromo("7"), []);
});

test("subscribe_getsEachNewEventOnce_untilItStops", () => {
  const { feed } = makeFeed();
  const seen: string[] = [];
  const stop = feed.subscribe((event) => seen.push(`${event.event}:${event.promoId}`));
  feed.deliver(delivery([claims[0]!]));
  feed.deliver(delivery([claims[0]!]));
  assert.deepEqual(seen, ["ClaimRegistered:1"]);
  stop();
  feed.deliver(delivery([claims[1]!]));
  assert.equal(seen.length, 1);
});

test("add_promoCreated_tiesTheLabelKeptUnderItsQuotesNonce", () => {
  const { store, feed } = makeFeed();
  const created = decodeLog(readDelivery([one("PromoCreated")])[0]!, VAULT, "stream", 1)!;
  store.data.pendingLabels[created.nonce!] = {
    item: "Wings",
    business: "Tony's Pizza",
    merchant: created.merchant!,
    geminiEventId: `0x${"11".repeat(32)}`,
    instrumentSymbol: `0x${"22".repeat(32)}`,
    payoutPerClaim: "1000000",
    maxClaims: 3,
    premium: created.amount!,
    claimDeadline: 1,
    at: 1,
  };
  feed.deliver(delivery([one("PromoCreated")]));
  assert.deepEqual(store.data.promoLabels["1"], { item: "Wings", business: "Tony's Pizza" });
  assert.equal(store.data.pendingLabels[created.nonce!], undefined);
});

// ---- The keeper's own read of the chain ----

/** A chain that holds the fixture's logs and answers the four calls the feed makes. */
function fakeChain(head: number, deployBlock = 72150393) {
  const calls = { ranges: [] as Array<[number, number]>, code: 0 };
  const client = {
    getBlockNumber: async () => BigInt(head),
    getCode: async ({ blockNumber }: { blockNumber: bigint }) => {
      calls.code++;
      return Number(blockNumber) >= deployBlock ? "0x6080" : "0x";
    },
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      calls.ranges.push([Number(fromBlock), Number(toBlock)]);
      return logs
        .filter((l) => blockOf(l) >= Number(fromBlock) && blockOf(l) <= Number(toBlock))
        .map((l) => ({
          address: l.address,
          topics: l.topics,
          data: l.data,
          blockNumber: BigInt(l.blockNumber),
          blockTimestamp: BigInt(l.blockTimestamp),
          transactionHash: l.transactionHash,
          logIndex: Number(l.logIndex),
        }));
    },
  } as unknown as PublicClient;
  return { client, calls };
}

const LAST_BLOCK = blockOf(paidBlock[0]!);
const LAST_TIME = timeOf(paidBlock[0]!);

test("catchUp_firstRead_startsAtTheVaultsFirstBlock_inRangesTheRpcAccepts", async () => {
  const head = LAST_BLOCK + 40_000;
  const { client, calls } = fakeChain(head);
  const { store, feed } = makeFeed({ client, now: () => (LAST_TIME + 3600) * 1000 });
  const added = await feed.catchUp();

  // Twelve of the thirteen logs are events the feed keeps.
  assert.equal(added, 12);
  assert.ok(store.data.feed.events.every((e) => e.via === "rpc"));
  assert.equal(store.data.feed.cursor, head);
  assert.equal(calls.ranges[0]![0], 72150393);
  assert.equal(calls.ranges.at(-1)![1], head);
  for (const [i, [from, to]] of calls.ranges.entries()) {
    assert.ok(to - from + 1 <= 10_000, "a range the RPC accepts");
    if (i > 0) assert.equal(from, calls.ranges[i - 1]![1] + 1, "no block is skipped or read twice");
  }
  // Bisection, not a walk: about log2(72 million) questions.
  assert.ok(calls.code <= 28, `${calls.code} getCode calls`);

  // The next read has nothing to add and asks for nothing: the cursor is at the newest block.
  calls.ranges.length = 0;
  assert.equal(await feed.catchUp(), 0);
  assert.deepEqual(calls.ranges, []);
});

test("firstBlockOf_findsTheBlockTheVaultWasDeployedIn", async () => {
  for (const deployed of [0, 1, 72150393, 72199999]) {
    assert.equal(await firstBlockOf(fakeChain(72200000, deployed).client, VAULT, 72200000), deployed);
  }
});

test("catchUp_aLogTheStreamDeliversInTime_staysTheStreams", async () => {
  let now = LAST_TIME * 1000 + 1_000;
  const { client } = fakeChain(LAST_BLOCK + 2);
  const { store, feed } = makeFeed({ client, now: () => now, startBlock: LAST_BLOCK - 5, graceMs: 4_000 });

  // One second after the block: the log is on the chain, the Stream has not delivered it, the keeper waits.
  assert.equal(await feed.catchUp(), 0);
  assert.equal(store.data.feed.cursor, LAST_BLOCK - 1, "the cursor stops before the waiting block");

  // The Stream delivers. The keeper's next read finds nothing new and moves on.
  now += 500;
  feed.deliver(delivery(paidBlock));
  now += 5_000;
  assert.equal(await feed.catchUp(), 0);
  assert.equal(store.data.feed.cursor, LAST_BLOCK + 2);
  assert.deepEqual(store.data.feed.events.map((e) => e.via), ["stream", "stream", "stream"]);
});

test("catchUp_aLogTheStreamNeverDelivers_isTakenFromTheChainAfterTheGrace", async () => {
  let now = LAST_TIME * 1000 + 3_900;
  const { client } = fakeChain(LAST_BLOCK + 2);
  const { store, feed } = makeFeed({ client, now: () => now, startBlock: LAST_BLOCK - 5, graceMs: 4_000 });
  const seen: FeedEvent[] = [];
  feed.subscribe((event) => seen.push(event));

  assert.equal(await feed.catchUp(), 0);
  now = LAST_TIME * 1000 + 4_000;
  assert.equal(await feed.catchUp(), 3);
  assert.deepEqual(store.data.feed.events.map((e) => e.via), ["rpc", "rpc", "rpc"]);
  assert.equal(seen.length, 3);
  assert.equal(store.data.feed.cursor, LAST_BLOCK + 2);

  // A late delivery of the same block changes nothing but the Stream's own count.
  assert.deepEqual(feed.deliver(delivery(paidBlock)), { logs: 3, added: 0 });
  assert.deepEqual(store.data.feed.events.map((e) => e.via), ["rpc", "rpc", "rpc"]);
});

test("catchUp_olderLogsAreNotHeldBackByAYoungOne", async () => {
  // Finalized is 19 blocks before Paid. One second after Paid's block, Finalized is ten seconds old.
  const finalized = named("Finalized")[1]!;
  const { client } = fakeChain(LAST_BLOCK);
  const { store, feed } = makeFeed({ client, now: () => LAST_TIME * 1000 + 1_000, startBlock: blockOf(finalized), graceMs: 4_000 });
  assert.equal(await feed.catchUp(), 1);
  assert.deepEqual(store.data.feed.events.map((e) => e.event), ["Finalized"]);
  assert.equal(store.data.feed.cursor, LAST_BLOCK - 1);
});

// ---- The webhook and the event stream, through the HTTP app ----

/** `streamSecret` null is a keeper with no secret set. */
function makeHttp(streamSecret: string | null = SECRET) {
  const unused = {} as never;
  const { store, feed } = makeFeed();
  const app = makeApp({ client: unused, vault: VAULT, usdc: USDC, maxLockedBps: 6000, pricer: unused, games: unused, relayer: unused, oracle: VAULT, store, feed, streamSecret: streamSecret ?? undefined });
  const post = (body: unknown, headers: Record<string, string> = { "x-stream-secret": SECRET }) =>
    app.request("/stream", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { app, store, feed, post };
}

test("postStream_withoutTheSecret_isRefused_andNothingIsAdded", async () => {
  const { store, post } = makeHttp();
  assert.equal((await post(delivery(paidBlock), {})).status, 401);
  assert.equal((await post(delivery(paidBlock), { "x-stream-secret": "a guess" })).status, 401);
  assert.equal((await post(delivery(paidBlock), { "x-stream-secret": "" })).status, 401);
  assert.equal(store.data.feed.events.length, 0);
});

test("postStream_onAKeeperWithNoSecretSet_refusesEveryDelivery", async () => {
  const { store, post } = makeHttp(null);
  assert.equal((await post(delivery(paidBlock))).status, 401);
  assert.equal((await post(delivery(paidBlock), { "x-stream-secret": "undefined" })).status, 401);
  assert.equal((await post(delivery(paidBlock), {})).status, 401);
  assert.equal(store.data.feed.events.length, 0);
});

test("postStream_aDelivery_isInTheFeed_markedAsTheStreams", async () => {
  const { app, post } = makeHttp();
  const res = await post(delivery(paidBlock));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, signed: false, logs: 3, added: 3 });

  const feed = (await (await app.request("/feed")).json()) as { stream: { deliveries: number; byStream: number }; events: FeedEvent[] };
  assert.equal(feed.stream.deliveries, 1);
  assert.equal(feed.stream.byStream, 3);
  assert.deepEqual(feed.events.map((e) => [e.event, e.promoId, e.via, e.amount]), [
    ["Paid", "1", "stream", "1000000"],
    ["Paid", "1", "stream", "1000000"],
    ["Paid", "1", "stream", "1000000"],
  ]);
});

test("postStream_aGzippedDelivery_isRead", async () => {
  const { app, store } = makeHttp();
  const res = await app.request("/stream", {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "gzip", "x-stream-secret": SECRET },
    body: gzipSync(JSON.stringify(delivery(paidBlock))),
  });
  assert.equal(res.status, 200);
  assert.equal(store.data.feed.events.length, 3);
});

test("postStream_quickNodesTestMessage_isAnswered200_andABodyThatIsNotJsonIs400", async () => {
  const { app, store, post } = makeHttp();
  const ping = await post({ message: "PING" });
  assert.equal(ping.status, 200);
  assert.deepEqual(await ping.json(), { ok: true, signed: false, logs: 0, added: 0 });

  const bad = await app.request("/stream", { method: "POST", headers: { "x-stream-secret": SECRET }, body: "not json" });
  assert.equal(bad.status, 400);
  assert.equal(store.data.feed.events.length, 0);
});

test("getPromoEvents_sendsAPromosEventTheMomentItIsDelivered_andNoOtherPromos", async () => {
  const { app, post } = makeHttp();
  const res = await app.request("/promos/1/events");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const until = async (pattern: RegExp): Promise<void> => {
    while (!pattern.test(text)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the stream ended before ${pattern}`);
      text += decoder.decode(value, { stream: true });
    }
  };

  await until(/event: ready\n/);
  // Promo 0's event first: it must not be sent to a page that shows promo 1.
  await post(delivery([named("Finalized")[0]!]));
  await post(delivery([claims[0]!]));
  await until(/event: vault\n.*\n.*\n\n/);
  await reader.cancel();

  const lines = text.split("\n").filter((line) => line.startsWith("data: {\""));
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]!.slice("data: ".length)) as FeedEvent;
  assert.deepEqual([event.event, event.promoId, event.claimCount, event.via], ["ClaimRegistered", "1", 1, "stream"]);
});

// ---- QuickNode's signature on a delivery ----

/** A delivery signed the way QuickNode signs one: HMAC-SHA256 of nonce + timestamp + body, in hex. */
function signedHeaders(body: string, token = SECRET): Record<string, string> {
  const nonce = "5f2b9c1e0d3a4b6c8e7f9a0b1c2d3e4f";
  const timestamp = "1794559000";
  const signature = createHmac("sha256", token).update(nonce + timestamp + body).digest("hex");
  return { "content-type": "application/json", "x-qn-nonce": nonce, "x-qn-timestamp": timestamp, "x-qn-signature": signature };
}

test("validSignature_isTheHmacOfNonceTimestampAndBody_underTheToken", () => {
  const body = JSON.stringify(delivery(paidBlock));
  const h = signedHeaders(body);
  const check = (token: string, nonce: string | undefined, time: string | undefined, text: string, given: string | undefined) =>
    validSignature(token, nonce, time, text, given);
  assert.equal(check(SECRET, h["x-qn-nonce"], h["x-qn-timestamp"], body, h["x-qn-signature"]), true);
  assert.equal(check(SECRET, h["x-qn-nonce"], h["x-qn-timestamp"], body, h["x-qn-signature"]!.toUpperCase()), true);
  // Another token, another body, another nonce or time: not this delivery's signature.
  assert.equal(check("another token", h["x-qn-nonce"], h["x-qn-timestamp"], body, h["x-qn-signature"]), false);
  assert.equal(check(SECRET, h["x-qn-nonce"], h["x-qn-timestamp"], `${body} `, h["x-qn-signature"]), false);
  assert.equal(check(SECRET, "00", h["x-qn-timestamp"], body, h["x-qn-signature"]), false);
  assert.equal(check(SECRET, h["x-qn-nonce"], "1794559001", body, h["x-qn-signature"]), false);
  // Missing parts, and a signature that is not 64 hex characters.
  assert.equal(check(SECRET, undefined, h["x-qn-timestamp"], body, h["x-qn-signature"]), false);
  assert.equal(check(SECRET, h["x-qn-nonce"], undefined, body, h["x-qn-signature"]), false);
  assert.equal(check(SECRET, h["x-qn-nonce"], h["x-qn-timestamp"], body, undefined), false);
  assert.equal(check(SECRET, h["x-qn-nonce"], h["x-qn-timestamp"], body, "abcd"), false);
  assert.equal(check(SECRET, h["x-qn-nonce"], h["x-qn-timestamp"], body, "zz".repeat(32)), false);
});

test("postStream_aSignedDelivery_isTakenWithoutTheSecretHeader_andCountedAsSigned", async () => {
  const { app, feed } = makeHttp();
  const body = JSON.stringify(delivery(paidBlock));
  const res = await app.request("/stream", { method: "POST", headers: signedHeaders(body), body });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, signed: true, logs: 3, added: 3 });
  assert.equal(feed.status().signed, 1);
});

test("postStream_aSignatureMadeWithAnotherToken_orOverAnotherBody_isRefused", async () => {
  const { app, store } = makeHttp();
  const body = JSON.stringify(delivery(paidBlock));
  const forged = await app.request("/stream", { method: "POST", headers: signedHeaders(body, "a guess at the token"), body });
  assert.equal(forged.status, 401);
  // A real signature, moved to a body it was not made for.
  const moved = await app.request("/stream", { method: "POST", headers: signedHeaders(body), body: JSON.stringify(delivery([claims[0]!])) });
  assert.equal(moved.status, 401);
  assert.equal(store.data.feed.events.length, 0);
});

test("postStream_onAKeeperWithNoSecretSet_refusesASignedDeliveryToo", async () => {
  const { app, store } = makeHttp(null);
  const body = JSON.stringify(delivery(paidBlock));
  for (const token of ["", "undefined", SECRET]) {
    const res = await app.request("/stream", { method: "POST", headers: signedHeaders(body, token), body });
    assert.equal(res.status, 401);
  }
  assert.equal(store.data.feed.events.length, 0);
});

// ---- GET /promos/:id reads the chain once for everyone ----

/** A vault with `count` promos, read through multicall, that counts how often it is read. */
function fakeVault(count: number) {
  const calls = { multicall: 0, owed: 0 };
  const promo = {
    merchant: VAULT,
    claimSigner: VAULT,
    geminiEventId: `0x${"11".repeat(32)}` as Hex,
    instrumentSymbol: `0x${"22".repeat(32)}` as Hex,
    payoutPerClaim: 1_000_000n,
    maxClaims: 3,
    claimCount: 3,
    paidCount: 0,
    premiumPaid: 2_240_000n,
    collateralLocked: 3_000_000n,
    claimDeadline: 1794543060n,
    marketCloseTime: 1794543300n,
    settledAt: 0n,
    status: 0,
    outcomeYes: false,
    hedgeMode: false,
  };
  const client = {
    multicall: async ({ contracts }: { contracts: Array<{ functionName: string; args?: readonly bigint[] }> }) => {
      calls.multicall++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return contracts.map(({ functionName, args }) => {
        if (functionName === "promoCount") return { status: "success", result: BigInt(count) };
        if (functionName === "totalOwedPayouts") return { status: "success", result: 0n };
        if (args![0]! >= BigInt(count)) return { status: "failure", error: new Error("UnknownPromo") };
        if (functionName === "getPromo") return { status: "success", result: promo };
        return { status: "success", result: ["0x6f3DE22768B24a4cAE412BF3575E691488B7d6E4", "0x2235755531e63f2c716C3167e622685d79C12477"] };
      });
    },
    readContract: async () => {
      calls.owed++;
      return 0n;
    },
  } as unknown as PublicClient;
  const unused = {} as never;
  const { store, feed } = makeFeed();
  const app = makeApp({ client, vault: VAULT, usdc: USDC, maxLockedBps: 6000, pricer: unused, games: unused, relayer: unused, oracle: VAULT, store, feed, streamSecret: SECRET });
  return { app, feed, calls };
}

test("getPromo_manyRequestsAtOnce_readTheChainOnce", async () => {
  const { app, calls } = fakeVault(2);
  const answers = await Promise.all(
    Array.from({ length: 24 }, (_, i) => app.request(i % 2 ? "/promos/1?customer=0x2235755531e63f2c716C3167e622685d79C12477" : "/promos/1")),
  );
  assert.deepEqual([...new Set(answers.map((res) => res.status))], [200]);
  assert.equal(calls.multicall, 1);
  // Nothing is owed anywhere in the vault, so no customer's owed payout is read.
  assert.equal(calls.owed, 0);

  const withCustomer = (await answers[1]!.json()) as { status: string; claimCount: number; customer: { number: number; paid: boolean; owed: string } };
  assert.deepEqual([withCustomer.status, withCustomer.claimCount], ["Open", 3]);
  assert.deepEqual(withCustomer.customer, { address: "0x2235755531e63f2c716C3167e622685d79C12477", number: 2, paid: false, owed: "0" });
});

test("getPromo_afterAnEventOnThePromo_readsTheChainAgain", async () => {
  const { app, feed, calls } = fakeVault(2);
  assert.equal((await app.request("/promos/1")).status, 200);
  assert.equal((await app.request("/promos/1")).status, 200);
  assert.equal(calls.multicall, 1);

  // Promo 0's event leaves promo 1's read alone; promo 1's own event does not.
  feed.deliver(delivery([named("Finalized")[0]!]));
  await app.request("/promos/1");
  assert.equal(calls.multicall, 1);
  feed.deliver(delivery([claims[0]!]));
  const res = await app.request("/promos/1");
  assert.equal(calls.multicall, 2);
  const body = (await res.json()) as { events: FeedEvent[] };
  assert.deepEqual(body.events.map((e) => e.event), ["ClaimRegistered"]);
});

test("getPromo_aPromoTheVaultDoesNotHave_is404", async () => {
  const { app } = fakeVault(2);
  const res = await app.request("/promos/2");
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "unknown-promo");
});
