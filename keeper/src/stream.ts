// The vault's events, as the feed the pages show. They reach the keeper two ways. A QuickNode Stream
// posts each block's vault logs to `POST /stream`, about a second after the block. And the keeper reads
// the chain's logs itself, a few seconds behind, for whatever the Stream has not delivered (and for
// everything from before the Stream existed). Each event remembers which way it came.
import { decodeEventLog, getAddress, type Address, type Hex } from "viem";
import { promoVaultAbi } from "./abi.ts";
import type { PublicClient } from "./chain.ts";
import { sleep } from "./sleep.ts";
import type { Store } from "./store.ts";

/** The events the feed keeps. `keeper/stream/filter.js` lets the same eleven through. */
export const FEED_EVENTS = [
  "PromoCreated",
  "ClaimRegistered",
  "Settled",
  "Vetoed",
  "SettlementReset",
  "Finalized",
  "Voided",
  "Paid",
  "PayoutFailed",
  "Deposited",
  "Withdrawn",
] as const;
export type FeedEventName = (typeof FEED_EVENTS)[number];
export type Via = "stream" | "rpc";

/** One vault event. Amounts are USDC base units as decimal strings; `at` is the block's time. */
export type FeedEvent = {
  /** Transaction hash and log index: the same event from both sources has the same id. */
  id: string;
  event: FeedEventName;
  /** Null for a deposit or a withdrawal. */
  promoId: string | null;
  block: number;
  logIndex: number;
  hash: Hex;
  /** Unix seconds. */
  at: number;
  /** How the keeper got it first: the Stream's delivery, or its own read of the chain. */
  via: Via;
  /** When the keeper got it, unix milliseconds. */
  seenAt: number;
  customer?: Address;
  merchant?: Address;
  lp?: Address;
  /** The premium, the payout, the lock released, the refund, or the deposit, by event. */
  amount?: string;
  shares?: string;
  claimCount?: number;
  outcomeYes?: boolean;
  /** PromoCreated only: the nonce of the quote the promo was made from. */
  nonce?: Hex;
};

/** A log before it is decoded, from either source. */
export type RawLog = {
  address: string;
  topics: readonly Hex[];
  data: Hex;
  block: number;
  logIndex: number;
  hash: Hex;
  /** Unix seconds, or NaN when the source did not say. */
  at: number;
};

const HASH = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x[0-9a-fA-F]*$/;

/** A JSON number, or a number as a decimal or 0x string. NaN for anything else. */
function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "") return Number(value);
  return NaN;
}

function toRawLog(item: Record<string, unknown>): RawLog | null {
  const { address, topics, data } = item;
  const hash = item.transactionHash ?? item.txHash;
  const block = toNumber(item.blockNumber ?? item.block);
  const logIndex = toNumber(item.logIndex);
  if (typeof address !== "string" || typeof data !== "string" || !HEX.test(data)) return null;
  if (!Array.isArray(topics) || topics.length === 0 || !topics.every((t) => typeof t === "string" && HASH.test(t))) return null;
  if (typeof hash !== "string" || !HASH.test(hash)) return null;
  if (!Number.isInteger(block) || block < 0 || !Number.isInteger(logIndex) || logIndex < 0) return null;
  return {
    address,
    topics: topics as Hex[],
    data: data as Hex,
    block,
    logIndex,
    hash: hash as Hex,
    at: toNumber(item.blockTimestamp ?? item.timestamp),
  };
}

/**
 * The logs in a Stream delivery. It takes what `stream/filter.js` returns (`{ events: [...] }`) and also
 * the dataset as QuickNode sends it with no filter (`{ data: [...] }`, arrays inside arrays). Anything
 * that is not a log is skipped, so QuickNode's test message gives an empty list.
 */
export function readDelivery(body: unknown): RawLog[] {
  const out: RawLog[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    if (Array.isArray(item.topics)) {
      const log = toRawLog(item);
      if (log) out.push(log);
      return;
    }
    for (const key of ["events", "logs", "data"]) walk(item[key], depth + 1);
  };
  walk(body, 0);
  return out;
}

const eventId = (log: { hash: Hex; logIndex: number }): string => `${log.hash.toLowerCase()}:${log.logIndex}`;

/** Decodes one log with the vault's ABI. Null when it is not the vault's, or not an event the feed keeps. */
export function decodeLog(log: RawLog, vault: Address, via: Via, seenAt: number): FeedEvent | null {
  if (log.address.toLowerCase() !== vault.toLowerCase()) return null;
  let decoded;
  try {
    decoded = decodeEventLog({ abi: promoVaultAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data });
  } catch {
    return null;
  }
  const base = {
    id: eventId(log),
    block: log.block,
    logIndex: log.logIndex,
    hash: log.hash.toLowerCase() as Hex,
    at: Number.isFinite(log.at) ? log.at : Math.floor(seenAt / 1000),
    via,
    seenAt,
  };
  const promo = (id: bigint) => ({ ...base, promoId: id.toString() });
  switch (decoded.eventName) {
    case "PromoCreated": {
      const a = decoded.args;
      return { ...promo(a.promoId), event: "PromoCreated", merchant: a.merchant, amount: a.quote.premium.toString(), nonce: a.quote.nonce };
    }
    case "ClaimRegistered": {
      const a = decoded.args;
      return { ...promo(a.promoId), event: "ClaimRegistered", customer: a.customer, claimCount: a.claimCount };
    }
    case "Settled": {
      const a = decoded.args;
      return { ...promo(a.promoId), event: "Settled", outcomeYes: a.outcomeYes };
    }
    case "Vetoed": {
      const a = decoded.args;
      return { ...promo(a.promoId), event: "Vetoed" };
    }
    case "SettlementReset": {
      const a = decoded.args;
      return { ...promo(a.promoId), event: "SettlementReset" };
    }
    case "Finalized": {
      const a = decoded.args;
      return { ...promo(a.promoId), event: "Finalized", outcomeYes: a.outcomeYes, amount: a.collateralReleased.toString() };
    }
    case "Voided": {
      const a = decoded.args;
      return { ...promo(a.promoId), event: "Voided", merchant: a.merchant, amount: a.premiumRefunded.toString() };
    }
    case "Paid": {
      const a = decoded.args;
      return { ...promo(a.promoId), event: "Paid", customer: a.customer, amount: a.amount.toString() };
    }
    case "PayoutFailed": {
      const a = decoded.args;
      return { ...promo(a.promoId), event: "PayoutFailed", customer: a.customer, amount: a.amount.toString() };
    }
    case "Deposited": {
      const a = decoded.args;
      return { ...base, promoId: null, event: "Deposited", lp: a.lp, amount: a.amount.toString(), shares: a.sharesMinted.toString() };
    }
    case "Withdrawn": {
      const a = decoded.args;
      return { ...base, promoId: null, event: "Withdrawn", lp: a.lp, amount: a.amount.toString(), shares: a.sharesBurned.toString() };
    }
    default:
      return null;
  }
}

const byPosition = (a: FeedEvent, b: FeedEvent): number => a.block - b.block || a.logIndex - b.logIndex;

type Deps = {
  store: Store;
  vault: Address;
  /** Reads the chain's logs. Without it the Stream is the feed's only source (tests). */
  client?: PublicClient;
  /** How long a log on the chain waits for the Stream to deliver it before the keeper takes it itself. */
  graceMs?: number;
  /** Where the first read of the chain starts. Unset, the keeper finds the vault's first block itself. */
  startBlock?: number;
  /** Unix milliseconds. */
  now?: () => number;
  log?: (line: string) => void;
};

/** The Arc RPC refuses a log query over more than 10,000 blocks. */
const CHUNK_BLOCKS = 9_000;
/** A pause between two queries of a long catch-up: the public RPC limits requests per second. */
const CHUNK_PAUSE_MS = 350;
const CURSOR_SAVE_MS = 60_000;
const MAX_EVENTS = 5_000;

export class Feed {
  readonly #d: Deps;
  readonly #ids = new Set<string>();
  readonly #listeners = new Set<(event: FeedEvent) => void>();
  #cursorSavedAt = 0;
  #lastError = "";

  constructor(deps: Deps) {
    this.#d = deps;
    for (const event of deps.store.data.feed.events) this.#ids.add(event.id);
  }

  #now(): number {
    return (this.#d.now ?? Date.now)();
  }

  #log(line: string): void {
    (this.#d.log ?? console.log)(`[feed] ${line}`);
  }

  /** Calls `listener` with every event that is new to the feed, until the returned function is called. */
  subscribe(listener: (event: FeedEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Adds the logs that are the vault's and not in the feed yet. Returns the events that were new. */
  add(logs: readonly RawLog[], via: Via): FeedEvent[] {
    const { store, vault } = this.#d;
    const feed = store.data.feed;
    const seenAt = this.#now();
    const added: FeedEvent[] = [];
    for (const log of logs) {
      if (this.#ids.has(eventId(log))) continue;
      const event = decodeLog(log, vault, via, seenAt);
      if (!event) continue;
      this.#ids.add(event.id);
      feed.events.push(event);
      added.push(event);

      // The event carries the quote's nonce, and the label was kept under it: this promo is that quote's.
      if (event.event === "PromoCreated" && event.nonce && event.promoId !== null) {
        const label = store.data.pendingLabels[event.nonce];
        if (label) {
          store.data.promoLabels[event.promoId] = { item: label.item, business: label.business };
          delete store.data.pendingLabels[event.nonce];
        }
      }
    }
    if (added.length === 0) return added;

    if (feed.events.length > MAX_EVENTS) {
      for (const old of feed.events.splice(0, feed.events.length - MAX_EVENTS)) this.#ids.delete(old.id);
    }
    store.save();
    for (const event of added) {
      for (const listener of this.#listeners) {
        try {
          listener(event);
        } catch (err) {
          this.#log(`a listener failed on ${event.event}: ${(err as Error).message}`);
        }
      }
    }
    return added;
  }

  /** Takes one delivery from the Stream. `logs` counts the vault's events in it, `added` the new ones. */
  deliver(body: unknown): { logs: number; added: number } {
    const { store, vault } = this.#d;
    const logs = readDelivery(body).filter((log) => decodeLog(log, vault, "stream", 0) !== null);
    if (logs.length === 0) return { logs: 0, added: 0 };
    const added = this.add(logs, "stream");
    const feed = store.data.feed;
    feed.deliveries += 1;
    feed.lastDeliveryAt = this.#now();
    store.save();
    return { logs: logs.length, added: added.length };
  }

  /** A promo's events, oldest first. */
  forPromo(promoId: string): FeedEvent[] {
    return this.#d.store.data.feed.events.filter((e) => e.promoId === promoId).sort(byPosition);
  }

  /** The newest `limit` events of every kind, oldest first. */
  recent(limit: number): FeedEvent[] {
    return [...this.#d.store.data.feed.events].sort(byPosition).slice(-limit);
  }

  /** What the Stream has done so far, and how far the keeper's own read of the chain has come. */
  status() {
    const feed = this.#d.store.data.feed;
    return {
      deliveries: feed.deliveries,
      /** Unix seconds. Null until the Stream has delivered a vault event. */
      lastDeliveryAt: feed.lastDeliveryAt === null ? null : Math.floor(feed.lastDeliveryAt / 1000),
      events: feed.events.length,
      byStream: feed.events.filter((e) => e.via === "stream").length,
      cursor: feed.cursor,
    };
  }

  /**
   * One read of the chain's logs, from the block after the last one read up to the newest. A log the
   * Stream has not delivered is left alone until it is `graceMs` old, so the Stream gets to deliver it
   * first; after that the keeper adds it itself. Returns the number of events added.
   */
  async catchUp(): Promise<number> {
    const { client, vault, store } = this.#d;
    if (!client) return 0;
    const feed = store.data.feed;
    const grace = this.#d.graceMs ?? 4_000;
    // viem keeps a block number for four seconds; this read is every two and wants the newest.
    const head = Number(await client.getBlockNumber({ cacheTime: 0 }));
    if (feed.cursor === null) {
      let start = this.#d.startBlock;
      if (start === undefined) {
        try {
          start = await firstBlockOf(client, vault, head);
        } catch {
          // A node that keeps no history cannot say when the vault was deployed: start near the newest block.
          start = Math.max(0, head - CHUNK_BLOCKS);
        }
      }
      feed.cursor = start - 1;
      this.#log(`reading the vault's logs from block ${start}`);
    }

    let added = 0;
    while (feed.cursor < head) {
      const from = feed.cursor + 1;
      const to = Math.min(from + CHUNK_BLOCKS - 1, head);
      const logs = await client.getLogs({ address: vault, fromBlock: BigInt(from), toBlock: BigInt(to) });
      const raw: RawLog[] = [];
      const times = new Map<bigint, number>();
      for (const log of logs) {
        if (log.blockNumber === null || log.logIndex === null || log.transactionHash === null) continue;
        let at = log.blockTimestamp === undefined || log.blockTimestamp === null ? undefined : Number(log.blockTimestamp);
        if (at === undefined) {
          // A node that leaves the time off its logs: read it from the block, once per block.
          at = times.get(log.blockNumber) ?? Number((await client.getBlock({ blockNumber: log.blockNumber })).timestamp);
          times.set(log.blockNumber, at);
        }
        raw.push({
          address: log.address,
          topics: log.topics,
          data: log.data,
          block: Number(log.blockNumber),
          logIndex: log.logIndex,
          hash: log.transactionHash,
          at,
        });
      }

      const now = this.#now();
      const waiting = raw.find((log) => !this.#ids.has(eventId(log)) && now - log.at * 1000 < grace);
      const upTo = waiting ? waiting.block - 1 : to;
      added += this.add(raw.filter((log) => log.block <= upTo), "rpc").length;
      feed.cursor = upTo;
      if (waiting) break;
      if (to < head) await sleep(CHUNK_PAUSE_MS);
    }

    // `add` saves when it adds. A pass that only moved the cursor saves once a minute: after a restart
    // the keeper reads a few hundred blocks twice, and the ids keep any event from being added twice.
    if (added === 0 && this.#now() - this.#cursorSavedAt >= CURSOR_SAVE_MS) {
      this.#cursorSavedAt = this.#now();
      store.save();
    }
    return added;
  }

  /** Reads the chain every `intervalMs` until `signal` aborts. A failed read is logged and tried again. */
  async run(intervalMs: number, signal: AbortSignal): Promise<void> {
    if (!this.#d.client) return;
    while (!signal.aborted) {
      try {
        await this.catchUp();
        this.#lastError = "";
      } catch (err) {
        const message = (err as Error).message.split("\n")[0] ?? "";
        if (message !== this.#lastError) this.#log(`reading the chain failed: ${message}`);
        this.#lastError = message;
      }
      await sleep(intervalMs, signal);
    }
  }
}

/** The block the vault was deployed in, by bisection: the first block at which its address has code. */
export async function firstBlockOf(client: PublicClient, vault: Address, head: number): Promise<number> {
  const address = getAddress(vault);
  let low = 0;
  let high = head;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const code = await client.getCode({ address, blockNumber: BigInt(middle) });
    if (code !== undefined && code !== "0x") high = middle;
    else low = middle + 1;
  }
  return low;
}
