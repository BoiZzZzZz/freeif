// What the keeper remembers between restarts, in one JSON file. The chain is the source of truth for
// promos and money; this file only holds what the chain does not: the plain strings behind the hashes
// in a promo, the quotes that are still usable, which logins have claimed, what each promo gives away and
// for which shop, the keeper's own tx hashes, and the vault's events as the pages' feed.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import type { Label, PendingLabel } from "./labels.ts";
import type { FeedEvent } from "./stream.ts";

/** `game`, `league` and `startTime` are the words for the card (names.ts); older records lack them. */
export type EventRecord = {
  eventId: string;
  eventTicker: string;
  title: string;
  game?: string;
  league?: string | null;
  startTime?: number | null;
};
/** `team`, `subject`, `condition` and `rule` are the words for the card; older records lack them. */
export type InstrumentRecord = {
  symbol: string;
  label: string;
  team?: string;
  subject?: string;
  condition?: string;
  rule?: string;
};
export type LiveQuote = { maxPayout: string; premium: string; expiry: number };
export type TxRecord = { at: number; promoId: string; action: string; hash: Hex };

type Data = {
  /** keccak256(event id string) => the event. A promo stores only the hash. */
  events: Record<Hex, EventRecord>;
  /** keccak256(instrument symbol) => the contract. */
  instruments: Record<Hex, InstrumentRecord>;
  /** quote nonce => a signed quote that may still be used. */
  liveQuotes: Record<Hex, LiveQuote>;
  /**
   * promo id => who claimed => the customer address they claimed with. "Who" is the SHA-256 of
   * `circle:<Circle user id>` (of `test:<name>` for the test loop, and of an email before Nov 13).
   */
  claims: Record<string, Record<string, Address>>;
  /** quote nonce => what is free and the shop's name, until the quote's promo is first read. */
  pendingLabels: Record<Hex, PendingLabel>;
  /** promo id => what is free and the shop's name. */
  promoLabels: Record<string, Label>;
  /** The most recent transactions the keeper and the relayer sent. */
  txs: TxRecord[];
  /** The vault's events, from the QuickNode Stream and from the keeper's own read of the chain (stream.ts). */
  feed: {
    events: FeedEvent[];
    /** The last block whose logs the keeper has read from the chain itself. Null before the first read. */
    cursor: number | null;
    /** Stream deliveries that carried a vault event: how many, and when the last one came (unix ms). */
    deliveries: number;
    lastDeliveryAt: number | null;
  };
};

const empty = (): Data => ({
  events: {},
  instruments: {},
  liveQuotes: {},
  claims: {},
  pendingLabels: {},
  promoLabels: {},
  txs: [],
  feed: { events: [], cursor: null, deliveries: 0, lastDeliveryAt: null },
});
const MAX_TXS = 2000;

export class Store {
  readonly data: Data;
  readonly #file: string | null;

  /** Pass a directory to keep the data on disk, or null to keep it in memory only (tests). */
  constructor(dir: string | null) {
    if (dir === null) {
      this.#file = null;
      this.data = empty();
      return;
    }
    mkdirSync(dir, { recursive: true });
    this.#file = join(dir, "keeper.json");
    let loaded: Partial<Data> = {};
    try {
      loaded = JSON.parse(readFileSync(this.#file, "utf8")) as Partial<Data>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.data = { ...empty(), ...loaded };
  }

  save(): void {
    if (this.#file === null) return;
    // Write to a second file and rename, so a crash never leaves half a file behind.
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.#file);
  }

  recordTx(promoId: bigint, action: string, hash: Hex): void {
    this.data.txs.push({ at: Math.floor(Date.now() / 1000), promoId: promoId.toString(), action, hash });
    if (this.data.txs.length > MAX_TXS) this.data.txs.splice(0, this.data.txs.length - MAX_TXS);
    this.save();
  }
}
