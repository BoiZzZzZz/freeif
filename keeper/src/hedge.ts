// The hedge (SPEC section 2, "Hedge"). For each open promo the keeper places a limit order on Gemini's
// sandbox exchange: buy "yes" on the promo's contract, one contract for every dollar the promo can pay,
// at the price the promo was sold on. If the result is "yes" the contracts pay what the vault owes.
// It is a sandbox order: it proves the trade and moves no money. Gemini's sandbox lists crypto and
// commodity markets only, so for a contract it does not list (every game) the keeper writes down the
// order it would place and marks it simulated.
import { createHmac } from "node:crypto";
import type { Hex } from "viem";
import { Status } from "./chain.ts";
import type { Store } from "./store.ts";

/** Gemini refused a request. `reason` is its error code ("InvalidSymbol"), `message` its sentence. */
export class SandboxError extends Error {
  status: number;
  reason: string;
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

type SandboxDeps = {
  key: string;
  secret: string;
  /** `https://api.sandbox.gemini.com`. */
  base: string;
  /** Replaceable in tests. */
  fetch?: typeof fetch;
  /** Unix seconds. Replaceable in tests. */
  now?: () => number;
};

export type SandboxOrder = { orderId: string; status: string };

/** Gemini's private API on the sandbox exchange: the two calls a hedge needs. */
export class Sandbox {
  readonly #d: SandboxDeps;
  #lastNonce = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: SandboxDeps) {
    this.#d = deps;
  }

  /**
   * One signed request. Gemini takes the JSON as a base64 header, signed with HMAC-SHA384 under the
   * secret; the body is empty. The nonce is a whole number of unix seconds and must grow with every
   * request, so requests go one at a time and two in the same second get different nonces.
   */
  call<T>(request: string, params: Record<string, unknown> = {}): Promise<T> {
    const run = this.#queue.then(() => this.#send<T>(request, params));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #send<T>(request: string, params: Record<string, unknown>): Promise<T> {
    const now = this.#d.now ? this.#d.now() : Math.floor(Date.now() / 1000);
    const nonce = Math.max(now, this.#lastNonce + 1);
    this.#lastNonce = nonce;
    const payload = Buffer.from(JSON.stringify({ request, nonce, ...params })).toString("base64");
    const res = await (this.#d.fetch ?? fetch)(`${this.#d.base}${request}`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": "0",
        "Cache-Control": "no-cache",
        "X-GEMINI-APIKEY": this.#d.key,
        "X-GEMINI-PAYLOAD": payload,
        "X-GEMINI-SIGNATURE": createHmac("sha384", this.#d.secret).update(payload).digest("hex"),
      },
      signal: AbortSignal.timeout(15_000),
    });
    // An order id is a whole number with more digits than a JSON number keeps: read it as text.
    const text = (await res.text()).replace(/"orderId"\s*:\s*(\d+)/g, '"orderId":"$1"');
    type Refused = { result?: string; reason?: string; message?: string; error?: string };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: the status decides.
      body = null;
    }
    const said: Refused = body !== null && typeof body === "object" ? body : {};
    if (!res.ok || body === null || said.result === "error") {
      throw new SandboxError(res.status, said.reason ?? String(res.status), said.message ?? said.error ?? `Gemini answered ${res.status}`);
    }
    return body as T;
  }

  /** A limit order to buy "yes" contracts. It rests on the book until it fills or is cancelled. */
  async buyYes(order: { symbol: string; quantity: string; price: string; clientOrderId: string }): Promise<SandboxOrder> {
    const placed = await this.call<{ orderId?: string | number; status?: string }>("/v1/prediction-markets/order", {
      symbol: order.symbol,
      outcome: "yes",
      orderType: "limit",
      side: "buy",
      quantity: order.quantity,
      price: order.price,
      clientOrderId: order.clientOrderId,
    });
    if (placed.orderId === undefined) throw new SandboxError(200, "NoOrderId", "Gemini accepted the order and gave no id");
    return { orderId: String(placed.orderId), status: placed.status ?? "open" };
  }

  async cancel(orderId: string): Promise<void> {
    await this.call("/v1/prediction-markets/order/cancel", { orderId });
  }
}

/** A promo's hedge, as the keeper's file keeps it. */
export type Hedge = {
  /**
   * "sandbox": an order on Gemini's sandbox exchange, with its id. "simulated": the order the keeper
   * would place, for a contract the sandbox does not list.
   */
  kind: "sandbox" | "simulated";
  /** The contract: the promo's instrument symbol. */
  symbol: string;
  /** Contracts to buy. One pays $1 on a "yes", so this is the promo's full payout in dollars. */
  quantity: string;
  /** The limit price: the price the promo was sold on. */
  price: string;
  /** Unix seconds. */
  at: number;
  orderId?: string;
  /** What Gemini said of the order when it was placed, then "cancelled" or "closed" once the promo is over. */
  status?: string;
  /** Why it is simulated, in Gemini's words where it said. */
  reason?: string;
  closedAt?: number;
};

/** A promo as the settlement loop reads it from the chain. */
export type HedgePromo = { promoId: string; status: number; payoutPerClaim: bigint; maxClaims: number; instrumentSymbol: Hex };

type Deps = {
  store: Store;
  /** Null when the keeper has no sandbox key: every hedge is then simulated. */
  sandbox: Pick<Sandbox, "buyYes" | "cancel"> | null;
  /** Unix seconds. Replaceable in tests. */
  now?: () => number;
  log?: (line: string) => void;
};

const FINAL: readonly number[] = [Status.FinalizedYes, Status.FinalizedNo, Status.PaidOut, Status.Voided];
/** An order Gemini refuses this many times is written down as simulated, with Gemini's reason. */
const MAX_TRIES = 3;

/** 1500000 base units -> "1.5": dollars, which is the number of contracts. */
export function contracts(maxPayout: bigint): string {
  const whole = maxPayout / 1_000_000n;
  const part = (maxPayout % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return part === "" ? whole.toString() : `${whole}.${part}`;
}

/** 4300 -> "0.43". */
export const priceOf = (bps: number): string => (bps / 10_000).toFixed(2);

export class Hedger {
  readonly #d: Deps;
  readonly #tries = new Map<string, number>();
  #busy = false;

  constructor(deps: Deps) {
    this.#d = deps;
  }

  #now(): number {
    return this.#d.now ? this.#d.now() : Math.floor(Date.now() / 1000);
  }

  #log(line: string): void {
    (this.#d.log ?? console.log)(`[hedge] ${line}`);
  }

  /**
   * One look at the promos the loop has just read, which is every promo that is not finished. An open
   * promo with no hedge gets one; a promo that is over has its resting order cancelled. It never throws,
   * and a call that comes while the last one is still talking to Gemini does nothing: the settlement loop
   * does not wait for this.
   */
  async sync(promos: readonly HedgePromo[]): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      for (const promo of promos) {
        const held = this.#d.store.data.hedges[promo.promoId];
        try {
          if (promo.status === Status.Open && held === undefined) await this.#open(promo);
          else if (FINAL.includes(promo.status) && held?.kind === "sandbox" && held.closedAt === undefined) await this.#close(promo.promoId, held);
        } catch (err) {
          this.#log(`promo ${promo.promoId}: ${(err as Error).message}`);
        }
      }
      // The loop reads a finished promo once and then never again. An order that was not closed on that
      // pass (Gemini was down, the keeper restarted) belongs to a promo that is no longer in the list.
      const read = new Set(promos.map((p) => p.promoId));
      for (const [promoId, held] of Object.entries(this.#d.store.data.hedges)) {
        if (read.has(promoId) || held.kind !== "sandbox" || held.closedAt !== undefined) continue;
        try {
          await this.#close(promoId, held);
        } catch (err) {
          this.#log(`promo ${promoId}: ${(err as Error).message}`);
        }
      }
    } finally {
      this.#busy = false;
    }
  }

  async #open(promo: HedgePromo): Promise<void> {
    const { store, sandbox } = this.#d;
    const symbol = store.data.instruments[promo.instrumentSymbol]?.symbol;
    // The price the promo was sold on: its first reading. A promo from before readings were kept is
    // hedged at its newest one. With neither yet, the next pass tries again.
    const reading = store.data.oddsStart[promo.promoId] ?? store.data.odds[promo.promoId]?.at(-1);
    if (!symbol || reading === undefined) return;

    const order = {
      symbol,
      quantity: contracts(promo.payoutPerClaim * BigInt(promo.maxClaims)),
      price: priceOf(reading[1]),
    };
    const at = this.#now();
    const simulated = (reason: string): void => {
      store.data.hedges[promo.promoId] = { kind: "simulated", ...order, at, reason };
      store.save();
      this.#log(`promo ${promo.promoId}: simulated, buy ${order.quantity} yes of ${symbol} at ${order.price} (${reason})`);
    };
    if (sandbox === null) return simulated("The keeper has no sandbox key.");

    try {
      const placed = await sandbox.buyYes({ ...order, clientOrderId: `freeif-${promo.promoId}-${at}` });
      store.data.hedges[promo.promoId] = { kind: "sandbox", ...order, at, orderId: placed.orderId, status: placed.status };
      store.save();
      this.#log(`promo ${promo.promoId}: order ${placed.orderId} on Gemini's sandbox, buy ${order.quantity} yes of ${symbol} at ${order.price} (${placed.status})`);
    } catch (err) {
      // "Not a valid symbol": the sandbox does not list this contract, and never will.
      const refused = err instanceof SandboxError && err.status >= 400 && err.status < 500;
      const tries = (this.#tries.get(promo.promoId) ?? 0) + 1;
      this.#tries.set(promo.promoId, tries);
      if (refused && /symbol/i.test(`${err.reason} ${err.message}`)) return simulated("Gemini's sandbox does not list this contract.");
      if (refused && tries >= MAX_TRIES) return simulated(`Gemini's sandbox refused the order: ${err.message}`);
      throw err;
    }
  }

  async #close(promoId: string, held: Hedge): Promise<void> {
    const { store, sandbox } = this.#d;
    if (sandbox === null || held.orderId === undefined) return;
    // An order Gemini filled is a position, not an order: there is nothing left to cancel.
    let status = held.status === "filled" ? "filled" : "cancelled";
    if (status !== "filled") {
      try {
        await sandbox.cancel(held.orderId);
      } catch (err) {
        // An order on a market that has closed is gone already. Anything else is tried again next pass.
        if (!(err instanceof SandboxError) || err.status < 400 || err.status >= 500) throw err;
        status = "closed";
      }
    }
    store.data.hedges[promoId] = { ...held, status, closedAt: this.#now() };
    store.save();
    this.#log(`promo ${promoId}: order ${held.orderId} ${status}`);
  }
}
