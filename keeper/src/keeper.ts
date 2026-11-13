// The settlement loop (SPEC section 3). Each pass reads every promo that is not finished from the chain
// and moves it one step: settle once Gemini has a result, finalize once the dispute window is over, pay
// the customers of a "yes". Every step is decided from on-chain state and simulated before it is sent,
// so a restart or a second keeper can never repeat one.
import { keccak256, parseEventLogs, toBytes, type Address, type Hex } from "viem";
import { promoVaultAbi } from "./abi.ts";
import { Status, explorerTx, statusName, type PublicClient, type WalletClient } from "./chain.ts";
import { getEvent, listEvents, type GeminiContract, type GeminiEvent } from "./gemini.ts";
import type { HedgePromo } from "./hedge.ts";
import type { OpenPromo } from "./odds.ts";
import { revertName } from "./relayer.ts";
import { sleep } from "./sleep.ts";
import type { Store } from "./store.ts";

type Deps = {
  client: PublicClient;
  /** The oracle key: `settle` is oracle-only. It also sends finalize and the payouts, which anyone may. */
  wallet: WalletClient;
  vault: Address;
  store: Store;
  /** Takes a reading of Gemini's book for every promo that is waiting for its result (odds.ts). */
  odds?: { sample: (promos: readonly OpenPromo[]) => Promise<unknown> };
  /** Places a hedge order for each open promo and cancels it when the promo is over (hedge.ts). */
  hedge?: { sync: (promos: readonly HedgePromo[]) => Promise<unknown> };
  log?: (line: string) => void;
};

const PAYOUT_BATCH = 50;
const SETTLED_PAGES = 5;
const FINISHED: readonly number[] = [Status.FinalizedNo, Status.PaidOut, Status.Voided];

type Promo = {
  merchant: Address;
  geminiEventId: Hex;
  instrumentSymbol: Hex;
  payoutPerClaim: bigint;
  maxClaims: number;
  claimCount: number;
  claimDeadline: bigint;
  settledAt: bigint;
  status: number;
  paidCount: number;
};

export class Keeper {
  readonly #d: Deps;
  /** Promos in a final status with nothing left to pay: never read again. */
  readonly #finished = new Set<bigint>();
  /** Promos whose customers may still be owed a payout that failed. */
  readonly #paidOut = new Set<bigint>();
  /** What was last logged for a promo that is waiting, so the log says it once. */
  readonly #waiting = new Map<bigint, string>();
  /** Ends the pause between two passes early. Set only while the loop is pausing. */
  #wake: (() => void) | null = null;
  #nudged = false;

  constructor(deps: Deps) {
    this.#d = deps;
  }

  get address(): Address {
    return this.#d.wallet.account.address;
  }

  #log(line: string): void {
    (this.#d.log ?? console.log)(`[keeper] ${line}`);
  }

  /**
   * Starts the next pass now instead of at the end of the pause. The feed calls it when an event means
   * there is a step to take: a result that was just confirmed has customers to pay.
   */
  nudge(): void {
    this.#nudged = true;
    this.#wake?.();
  }

  /** One pass over every promo. Returns the number of transactions sent. */
  async tick(): Promise<number> {
    const { client, vault } = this.#d;
    const [count, disputeWindow, block] = await Promise.all([
      client.readContract({ address: vault, abi: promoVaultAbi, functionName: "promoCount" }),
      client.readContract({ address: vault, abi: promoVaultAbi, functionName: "disputeWindow" }),
      client.getBlock(),
    ]);
    const ids: bigint[] = [];
    for (let id = 0n; id < count; id++) if (!this.#finished.has(id)) ids.push(id);
    if (ids.length === 0) return 0;

    const promos = await client.multicall({
      allowFailure: false,
      contracts: ids.map((id) => ({ address: vault, abi: promoVaultAbi, functionName: "getPromo", args: [id] }) as const),
    });

    // The chart's readings, for every promo that has no result yet. Not waited for: a slow answer from
    // Gemini must not hold up a settlement.
    const open: OpenPromo[] = [];
    for (const [i, id] of ids.entries()) {
      const { status, instrumentSymbol } = promos[i] as Promo;
      if (status === Status.Open) open.push({ promoId: id.toString(), instrumentSymbol });
    }
    void this.#d.odds?.sample(open);
    // The hedge orders, for every promo this pass read: one placed for an open promo that has none, one
    // cancelled for a promo that is over. Not waited for either.
    void this.#d.hedge?.sync(
      ids.map((id, i) => {
        const { status, payoutPerClaim, maxClaims, instrumentSymbol } = promos[i] as Promo;
        return { promoId: id.toString(), status, payoutPerClaim, maxClaims, instrumentSymbol };
      }),
    );

    let sent = 0;
    for (const [i, id] of ids.entries()) {
      const promo = promos[i] as Promo;
      try {
        if (await this.#step(id, promo, block.timestamp, BigInt(disputeWindow))) sent++;
      } catch (err) {
        // One promo that fails must not stop the others. It is tried again on the next pass.
        this.#log(`promo ${id}: ${statusName(promo.status)} step failed: ${revertName(err) ?? (err as Error).message}`);
      }
    }
    return sent;
  }

  async #step(id: bigint, promo: Promo, now: bigint, disputeWindow: bigint): Promise<boolean> {
    if (FINISHED.includes(promo.status)) {
      this.#finished.add(id);
      if (promo.status === Status.PaidOut) this.#paidOut.add(id);
      return false;
    }
    switch (promo.status) {
      case Status.Open:
        return now >= promo.claimDeadline ? this.#settle(id, promo) : false;
      case Status.Settled:
        if (now < promo.settledAt + disputeWindow) return false;
        await this.#send(id, "finalize", [id]);
        return true;
      case Status.FinalizedYes:
        if (promo.paidCount >= promo.claimCount) return false;
        await this.#send(id, "payoutBatch", [id, PAYOUT_BATCH]);
        return true;
      default:
        // Vetoed: the owner decides what happens next (resetSettlement or voidPromo).
        return false;
    }
  }

  /** Posts Gemini's result for the promo's contract, if Gemini has one. */
  async #settle(id: bigint, promo: Promo): Promise<boolean> {
    const found = await this.#findContract(promo);
    if (!found) {
      this.#wait(id, "claims are closed; cannot find its Gemini event yet");
      return false;
    }
    const side = found.contract.resolutionSide;
    if (side !== "yes" && side !== "no") {
      this.#wait(id, `claims are closed; waiting for Gemini to settle ${found.event.ticker} (event status ${found.event.status})`);
      return false;
    }
    // The id string must be the one whose hash is in the promo, or `settle` reverts with EventIdMismatch.
    await this.#send(id, "settle", [id, side === "yes", found.event.id, side]);
    return true;
  }

  #wait(id: bigint, message: string): void {
    if (this.#waiting.get(id) === message) return;
    this.#waiting.set(id, message);
    this.#log(`promo ${id}: ${message}`);
  }

  /** The Gemini event and contract a promo is about. The promo holds only their hashes. */
  async #findContract(promo: Promo): Promise<{ event: GeminiEvent; contract: GeminiContract } | null> {
    const match = (event: GeminiEvent | null) => {
      if (!event || keccak256(toBytes(event.id)) !== promo.geminiEventId) return null;
      const contract = event.contracts.find((c) => keccak256(toBytes(c.instrumentSymbol)) === promo.instrumentSymbol);
      return contract ? { event, contract } : null;
    };

    // The pricing service wrote the ticker down when it signed the quote.
    const known = this.#d.store.data.events[promo.geminiEventId];
    if (known) return match(await getEvent(known.eventTicker));

    // Fallback, for a keeper that lost its file: look through the events Gemini settled most recently.
    for (let page = 0; page < SETTLED_PAGES; page++) {
      const { data } = await listEvents({ status: "settled", limit: 100, offset: page * 100 });
      for (const event of data) {
        const found = match(event);
        if (found) {
          this.#d.store.data.events[promo.geminiEventId] = { eventId: event.id, eventTicker: event.ticker, title: event.title };
          this.#d.store.save();
          return found;
        }
      }
      if (data.length < 100) break;
    }
    return null;
  }

  /** Payouts whose transfer failed stay owed. Tries each one again; it goes through once the transfer works. */
  async retryOwed(): Promise<number> {
    const { client, vault } = this.#d;
    const total = await client.readContract({ address: vault, abi: promoVaultAbi, functionName: "totalOwedPayouts" });
    if (total === 0n) return 0;

    let sent = 0;
    for (const id of this.#paidOut) {
      const customers = await client.readContract({ address: vault, abi: promoVaultAbi, functionName: "getClaimants", args: [id] });
      const owed = await client.multicall({
        allowFailure: false,
        contracts: customers.map(
          (customer) => ({ address: vault, abi: promoVaultAbi, functionName: "owedPayout", args: [id, customer] }) as const,
        ),
      });
      for (const [i, customer] of customers.entries()) {
        if (owed[i] === 0n) continue;
        try {
          await this.#send(id, "retryPayout", [id, customer]);
          sent++;
        } catch (err) {
          this.#log(`promo ${id}: payout to ${customer} still fails (${revertName(err) ?? (err as Error).message})`);
        }
      }
    }
    return sent;
  }

  /** Simulates a call, sends it, waits for the receipt and writes the hash down. Throws if any part fails. */
  async #send(
    id: bigint,
    functionName: "settle" | "finalize" | "payoutBatch" | "retryPayout",
    args: readonly unknown[],
  ): Promise<void> {
    const { client, wallet, vault, store } = this.#d;
    const { request } = await client.simulateContract({
      account: wallet.account,
      address: vault,
      abi: promoVaultAbi,
      functionName,
      args,
    } as Parameters<typeof client.simulateContract>[0]);
    const hash = await wallet.writeContract(request as Parameters<typeof wallet.writeContract>[0]);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted on chain: ${explorerTx(hash)}`);
    store.recordTx(id, functionName, hash);
    this.#waiting.delete(id);

    const logs = parseEventLogs({ abi: promoVaultAbi, logs: receipt.logs });
    const paid = logs.filter((l) => l.eventName === "Paid").length;
    const failed = logs.filter((l) => l.eventName === "PayoutFailed").length;
    const detail =
      functionName === "settle"
        ? ` (${String(args[3])}, event ${String(args[2])})`
        : functionName === "payoutBatch" || functionName === "retryPayout"
          ? ` (${paid} paid${failed ? `, ${failed} failed and owed` : ""})`
          : "";
    this.#log(`promo ${id}: ${functionName}${detail} ${explorerTx(hash)}`);
  }

  /** Runs the loop until `signal` aborts. A failed pass is logged and the next one runs as usual. */
  async run(loopMs: number, retryMs: number, signal: AbortSignal): Promise<void> {
    this.#log(`loop every ${loopMs / 1000}s as ${this.address}`);
    let lastRetry = 0;
    while (!signal.aborted) {
      this.#nudged = false;
      try {
        await this.tick();
        if (Date.now() - lastRetry >= retryMs) {
          lastRetry = Date.now();
          await this.retryOwed();
        }
      } catch (err) {
        this.#log(`pass failed: ${(err as Error).message}`);
      }
      // A nudge that came during the pass is not lost: the next pass starts at once.
      if (!this.#nudged) await sleep(loopMs, signal, (wake) => { this.#wake = wake; });
      this.#wake = null;
    }
  }
}
