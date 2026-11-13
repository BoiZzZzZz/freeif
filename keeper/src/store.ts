// What the keeper remembers between restarts, in one JSON file. The chain is the source of truth for
// promos and money; this file only holds what the chain does not: the plain strings behind the hashes
// in a promo, the quotes that are still usable, which emails have claimed, and the keeper's own tx hashes.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";

export type EventRecord = { eventId: string; eventTicker: string; title: string };
export type InstrumentRecord = { symbol: string; label: string };
export type LiveQuote = { maxPayout: string; premium: string; expiry: number };
export type TxRecord = { at: number; promoId: string; action: string; hash: Hex };

type Data = {
  /** keccak256(event id string) => the event. A promo stores only the hash. */
  events: Record<Hex, EventRecord>;
  /** keccak256(instrument symbol) => the contract. */
  instruments: Record<Hex, InstrumentRecord>;
  /** quote nonce => a signed quote that may still be used. */
  liveQuotes: Record<Hex, LiveQuote>;
  /** promo id => sha256(email) => the customer address that email claimed with. */
  claims: Record<string, Record<string, Address>>;
  /** The most recent transactions the keeper and the relayer sent. */
  txs: TxRecord[];
};

const empty = (): Data => ({ events: {}, instruments: {}, liveQuotes: {}, claims: {}, txs: [] });
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
