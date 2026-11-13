// How much one client may ask of the open routes, and how many event streams may be open at once.
//
// None of those routes needs a login, and each costs the keeper something: a read of Gemini's book for a
// price, room in the vault for 90 seconds for a quote, two calls to Circle and a transaction for a claim,
// a read of the chain for a promo. The only name a request has is the address it came from, so that is
// what is counted. It stops a loop left running and a script pointed at the keeper. It does not stop
// someone who comes from many addresses.

/** `max` requests, handed back evenly over `windowMs`. A client that has been quiet may send `max` at once. */
export type Rule = { name: string; max: number; windowMs: number };

/** Buckets are looked through for ones to drop when there are more than this, at most this often. */
const PRUNE_ABOVE = 5_000;
const PRUNE_EVERY_MS = 10_000;

export class Limiter {
  private readonly buckets = new Map<string, { left: number; at: number; fullAt: number }>();
  private readonly now: () => number;
  private prunedAt = 0;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * Takes one request out of what `who` has left under `rule`. Returns 0 when the request may go on, or
   * the seconds until the next one may.
   */
  take(rule: Rule, who: string): number {
    const now = this.now();
    const key = `${rule.name} ${who}`;
    const perMs = rule.max / rule.windowMs;
    const held = this.buckets.get(key);
    const left = held === undefined ? rule.max : Math.min(rule.max, held.left + (now - held.at) * perMs);
    const allowed = left >= 1;
    const after = allowed ? left - 1 : left;
    this.buckets.set(key, { left: after, at: now, fullAt: now + (rule.max - after) / perMs });
    this.prune(now);
    return allowed ? 0 : Math.max(1, Math.ceil((1 - left) / perMs / 1000));
  }

  /** A bucket that is full again says the same as no bucket. */
  private prune(now: number): void {
    if (this.buckets.size <= PRUNE_ABOVE || now - this.prunedAt < PRUNE_EVERY_MS) return;
    this.prunedAt = now;
    for (const [key, bucket] of this.buckets) if (bucket.fullAt <= now) this.buckets.delete(key);
  }

  /** How many buckets are held (tests). */
  get size(): number {
    return this.buckets.size;
  }
}

/** Counts what is open at once: so many per client, so many in all. */
export class Gate {
  private readonly open = new Map<string, number>();
  private total = 0;
  private readonly perClient: number;
  private readonly inAll: number;

  constructor(perClient: number, inAll: number) {
    this.perClient = perClient;
    this.inAll = inAll;
  }

  /** A place for one more from `who`: the function that gives it back, or null when there is none. */
  enter(who: string): (() => void) | null {
    const mine = this.open.get(who) ?? 0;
    if (mine >= this.perClient || this.total >= this.inAll) return null;
    this.open.set(who, mine + 1);
    this.total++;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.total--;
      const now = (this.open.get(who) ?? 1) - 1;
      if (now <= 0) this.open.delete(who);
      else this.open.set(who, now);
    };
  }

  get count(): number {
    return this.total;
  }
}

const MINUTE = 60_000;

/**
 * The limits, each per client address. They are set for a room of people behind one address (a shop's
 * WiFi, a hall of judges) to pass and a loop to stop: a page that shows a promo asks about six times a
 * minute, a merchant form asks for a price four times a minute.
 */
export type Limits = {
  /** Every route but `/health` and the Stream's webhook. */
  all: Rule;
  /** `GET /price`: one read of Gemini's book each. */
  price: Rule;
  /** `POST /quote`: a signed quote holds its room in the vault for 90 seconds. */
  quote: Rule;
  /** `POST /claims`: two calls to Circle each, and a transaction. */
  claims: Rule;
  /** `GET /intervals`: four reads of Gemini each. */
  intervals: Rule;
  /** `GET /health/rpc`: a call to every RPC endpoint. */
  rpc: Rule;
  /** Event streams open at once: per client, and in all. */
  streams: { perClient: number; inAll: number };
};

export const LIMITS: Limits = {
  all: { name: "all", max: 600, windowMs: MINUTE },
  price: { name: "price", max: 120, windowMs: MINUTE },
  quote: { name: "quote", max: 10, windowMs: MINUTE },
  claims: { name: "claims", max: 30, windowMs: MINUTE },
  intervals: { name: "intervals", max: 20, windowMs: MINUTE },
  rpc: { name: "rpc", max: 6, windowMs: MINUTE },
  streams: { perClient: 60, inAll: 1_000 },
};
