// How a promo's chance has moved since the promo started (SPEC section 3, "Odds history"). On every pass
// of the settlement loop the keeper reads the top of Gemini's order book for the contract of each promo
// that is waiting for its result, and keeps the reading with its time. The promo page draws the readings
// as its chart.
import type { Hex } from "viem";
import { getBook, priceToBps, type TopOfBook } from "./gemini.ts";
import { isMarket } from "./pricing.ts";
import type { Store } from "./store.ts";

/**
 * One reading of a contract's book: unix seconds, the chance of "yes", the best bid and the best ask.
 * The three prices are basis points of a dollar (3900 is 0.39, a 39% chance). The chance is the ask,
 * the price the pricing service quotes on. Bid and ask are null only in a promo's first reading, when
 * its quote was priced on the last trade.
 */
export type OddsPoint = [t: number, chance: number, bid: number | null, ask: number | null];

/** A promo that is waiting for its result, as the settlement loop reads it from the chain. */
export type OpenPromo = { promoId: string; instrumentSymbol: Hex };

/** A reading that is the same as the last one kept is kept anyway once that one is this old. */
const KEEP_EVERY_SECONDS = 300;
/** The most readings kept for one promo. Past it, the older half loses every second one. */
const MAX_POINTS = 4_000;
const MAX_PENDING = 2_000;
const PENDING_SECONDS = 86_400;

/**
 * The chance a book shows: its best ask. Null when the book is not a market (pricing.ts): a side is
 * missing (an empty book on Gemini shows an ask of 0.02 and no bid), or the two sides are more than half
 * a dollar apart (a window that has not started shows 0.01 against 0.99).
 */
export function readBook(book: TopOfBook, t: number): OddsPoint | null {
  const bid = priceToBps(book.bid ?? undefined);
  const ask = priceToBps(book.ask ?? undefined);
  if (ask === null || !isMarket(bid, ask)) return null;
  return [t, ask, bid, ask];
}

/** The reading a quote was priced on, kept under the quote's nonce until the quote's promo exists. */
export function keepPending(pending: Record<Hex, OddsPoint>, nonce: Hex, point: OddsPoint): void {
  pending[nonce] = point;
  // A quote can be used for 90 seconds. One that is a day old never became a promo.
  for (const n of Object.keys(pending) as Hex[]) if (pending[n]![0] < point[0] - PENDING_SECONDS) delete pending[n];
  const left = (Object.keys(pending) as Hex[]).sort((a, b) => pending[a]![0] - pending[b]![0]);
  for (const n of left.slice(0, Math.max(0, left.length - MAX_PENDING))) delete pending[n];
}

/** Drops every second reading of the older half, never the first: the newest stay as they were read. */
export function thin(points: OddsPoint[]): void {
  const half = Math.floor(points.length / 2);
  points.splice(0, half, ...points.slice(0, half).filter((_, i) => i % 2 === 0));
}

const same = (a: OddsPoint, b: OddsPoint): boolean => a[1] === b[1] && a[2] === b[2] && a[3] === b[3];

type Deps = {
  store: Store;
  /** How often the loop asks for readings, for the page to say. */
  everySeconds: number;
  /** Replaceable in tests. */
  fetchBook?: (symbol: string) => Promise<TopOfBook | null>;
  /** Unix seconds. Replaceable in tests. */
  now?: () => number;
  log?: (line: string) => void;
};

export class Odds {
  readonly #d: Deps;
  /** The newest reading of each promo, kept or not. */
  readonly #newest = new Map<string, OddsPoint>();
  #busy = false;
  #lastError = "";

  constructor(deps: Deps) {
    this.#d = deps;
  }

  #now(): number {
    return this.#d.now ? this.#d.now() : Math.floor(Date.now() / 1000);
  }

  /**
   * Reads Gemini's book for each promo's contract, once per contract: two promos on one team share the
   * read. Returns how many readings were kept. It never throws, and a call that comes while the last one
   * is still waiting for Gemini does nothing: the settlement loop does not wait for this.
   */
  async sample(promos: readonly OpenPromo[]): Promise<number> {
    if (this.#busy || promos.length === 0) return 0;
    this.#busy = true;
    try {
      const bySymbol = new Map<string, string[]>();
      for (const promo of promos) {
        // The plain symbol behind a promo's hash is written down when its quote is signed.
        const symbol = this.#d.store.data.instruments[promo.instrumentSymbol]?.symbol;
        if (symbol) bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), promo.promoId]);
      }

      let kept = 0;
      for (const [symbol, promoIds] of bySymbol) {
        let book: TopOfBook | null;
        try {
          book = await (this.#d.fetchBook ?? getBook)(symbol);
          this.#lastError = "";
        } catch (err) {
          const message = (err as Error).message.split("\n")[0] ?? "";
          if (message !== this.#lastError) (this.#d.log ?? console.log)(`[odds] reading the book of ${symbol} failed: ${message}`);
          this.#lastError = message;
          continue;
        }
        const point = book === null ? null : readBook(book, this.#now());
        if (point === null) continue;
        for (const promoId of promoIds) if (this.#add(promoId, point)) kept++;
      }
      if (kept > 0) this.#d.store.save();
      return kept;
    } finally {
      this.#busy = false;
    }
  }

  /** Keeps a reading that differs from the last one kept, or comes five minutes after it. */
  #add(promoId: string, point: OddsPoint): boolean {
    const all = (this.#d.store.data.odds[promoId] ??= []);
    const kept = all.at(-1);
    const before = this.#newest.get(promoId);
    const last = before ?? kept;
    if (last !== undefined && point[0] <= last[0]) return false;
    this.#newest.set(promoId, point);
    if (kept !== undefined) {
      const changed = !same(point, kept);
      if (!changed && point[0] - kept[0] < KEEP_EVERY_SECONDS) return false;
      // A change after a quiet stretch: the last reading before it is kept too, so the line stays flat
      // up to the change instead of sloping across the stretch.
      if (changed && before !== undefined && before[0] > kept[0]) all.push(before);
    }
    all.push(point);
    if (all.length > MAX_POINTS) thin(all);
    return true;
  }

  /**
   * A promo was made from the quote with this nonce: the reading that quote was priced on is the
   * chart's first point, at the moment the promo started (`at`, the block's time).
   */
  start(promoId: string, nonce: Hex, at: number): void {
    const { pendingOdds, oddsStart } = this.#d.store.data;
    const point = pendingOdds[nonce];
    if (point === undefined) return;
    delete pendingOdds[nonce];
    oddsStart[promoId] = [at, point[1], point[2], point[3]];
    this.#d.store.save();
  }

  /**
   * A promo's readings, oldest first. `start` is the one the promo was priced on, null for a promo from
   * before readings were kept. `latest` is the newest reading, which `points` leaves out when it is the
   * same as the one before it. With `after`, only the readings later than that time.
   */
  history(promoId: string, after = 0) {
    const { odds, oddsStart } = this.#d.store.data;
    const start = oddsStart[promoId] ?? null;
    const all = odds[promoId] ?? [];
    const kept = all.at(-1);
    const newest = this.#newest.get(promoId);
    const from = Math.max(after, start?.[0] ?? 0);
    return {
      everySeconds: this.#d.everySeconds,
      start,
      points: from > 0 ? all.filter((p) => p[0] > from) : all,
      latest: newest !== undefined && (kept === undefined || newest[0] > kept[0]) ? newest : (kept ?? start),
    };
  }

  /** The chance a promo's newest reading shows (0.41 is 41%) and its time. Null when it has none. */
  chance(promoId: string): { chance: number; at: number } | null {
    const { latest } = this.history(promoId);
    return latest === null ? null : { chance: latest[1] / 10_000, at: latest[0] };
  }
}
