// What the keeper remembers between restarts, in one JSON file. The chain is the source of truth for
// promos and money; this file only holds what the chain does not: the plain strings behind the hashes
// in a promo, the quotes that are still usable, which logins have claimed, what each promo gives away and
// for which shop, the keeper's own tx hashes, the vault's events as the pages' feed, how each promo's
// chance has moved, and which logins have had their starter test dollars.
//
// The file is stamped with the vault it belongs to. Promo ids start again at 0 on a new vault, so a file
// read by a keeper on another vault would put one vault's words, charts and claims on the other's promos.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Address, Hex } from "viem";
import type { Label, PendingLabel } from "./labels.ts";
import type { OddsPoint } from "./odds.ts";
import type { FeedEvent } from "./stream.ts";
import type { Hedge } from "./hedge.ts";

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
/**
 * Starter test dollars sent to one Circle login (starter.ts). `txHash` is null while the grant is held
 * and not sent yet; a record left like that by a restart counts as given, because whether its transfer
 * went out is not known.
 */
export type StarterGrant = { address: Address; amount: string; at: number; txHash: Hex | null };

export type Data = {
  /** The vault this file belongs to. Absent in a file from before it was stamped, and in tests. */
  vault?: Address;
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
  /** promo id => the readings of its contract's book on Gemini since the promo started, oldest first (odds.ts). */
  odds: Record<string, OddsPoint[]>;
  /** promo id => the reading the promo was priced on, at the time the promo started. */
  oddsStart: Record<string, OddsPoint>;
  /** quote nonce => the reading that quote was priced on, until the quote's promo exists. */
  pendingOdds: Record<Hex, OddsPoint>;
  /** promo id => its hedge: an order on Gemini's sandbox exchange, or the order the keeper would place (hedge.ts). */
  hedges: Record<string, Hedge>;
  /**
   * Starter test dollars: who => what they were sent. "Who" is the SHA-256 of `circle:<Circle user id>`,
   * as for claims, so the file holds no user ids. One grant per login, for good.
   */
  starter: Record<string, StarterGrant>;
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
    /** How many of the deliveries carried QuickNode's signature. Absent in a file from before it was counted. */
    signed?: number;
  };
};

export const empty = (): Data => ({
  events: {},
  instruments: {},
  liveQuotes: {},
  claims: {},
  pendingLabels: {},
  promoLabels: {},
  odds: {},
  oddsStart: {},
  pendingOdds: {},
  hedges: {},
  starter: {},
  txs: [],
  feed: { events: [], cursor: null, deliveries: 0, lastDeliveryAt: null },
});
/** The most transactions kept in `txs`: the oldest go first. */
export const MAX_TXS = 2000;
const FILE = "keeper.json";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The name a vault's file is set aside under while the keeper runs on another vault. */
export const asideName = (vault: string): string => `keeper.${vault.toLowerCase()}.json`;

/** The file's contents, or null when there is no file. A file that cannot be read stops the keeper, as before. */
function readData(file: string): Partial<Data> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Partial<Data>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export class Store {
  readonly data: Data;
  readonly #file: string | null;

  /**
   * Pass a directory to keep the data on disk, or null to keep it in memory only (tests). With `vault`,
   * the file must be that vault's: a file with no stamp is taken and stamped; a file stamped for another
   * vault is set aside as `keeper.<that vault>.json` (never deleted), and this vault's own file is taken
   * back if one was set aside before, else the keeper starts with an empty file.
   */
  constructor(dir: string | null, vault?: Address | null, log: (line: string) => void = console.log) {
    if (dir === null) {
      this.#file = null;
      this.data = vault ? { ...empty(), vault } : empty();
      return;
    }
    mkdirSync(dir, { recursive: true });
    this.#file = join(dir, FILE);
    let loaded = readData(this.#file);
    if (!vault) {
      this.data = { ...empty(), ...loaded };
      return;
    }

    const said: string[] = [];
    const stamp = loaded?.vault;
    if (loaded !== null && typeof stamp === "string" && stamp.toLowerCase() !== vault.toLowerCase()) {
      // A name made from the stamp only when the stamp is an address, so a strange stamp cannot name a path.
      let aside = join(dir, ADDRESS.test(stamp) ? asideName(stamp) : `keeper.unknown.json`);
      if (existsSync(aside)) aside = aside.replace(/\.json$/, `.${Date.now()}.json`);
      renameSync(this.#file, aside);
      said.push(`${FILE} is for vault ${stamp}, and this keeper runs on ${vault}: set it aside as ${basename(aside)}`);
      loaded = null;
    }
    if (loaded === null) {
      // This vault's file, set aside when the keeper ran on another vault (or by a run that stopped half way).
      const own = join(dir, asideName(vault));
      const back = readData(own);
      if (back !== null) {
        renameSync(own, this.#file);
        loaded = back;
        said.push(`took back ${basename(own)}, this vault's file`);
      } else if (said.length > 0) {
        said.push("starting with an empty file");
      }
    } else if (stamp === undefined) {
      said.push(`${FILE} had no vault: it is now stamped ${vault}`);
    }
    this.data = { ...empty(), ...loaded, vault };
    if (said.length > 0) log(`[store] ${said.join("; ")}`);
    // The stamp goes on disk at once, so the next start finds it.
    if (stamp !== vault) this.save();
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
