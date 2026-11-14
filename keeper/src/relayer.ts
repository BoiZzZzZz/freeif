// The claim relayer. Its key is every promo's `claimSigner` (F17), so it is the only address that can
// register a customer. A claim carries the customer's Circle login token: the relayer asks Circle whose
// it is, registers only an address that is one of that user's wallets, and allows one claim per Circle
// user per promo.
//
// A promo sold with claim cards is covered differently: the merchant's browser makes one small wallet per
// card and the relayer registers each card's address, after checking that the login is the promo's
// merchant. The one-claim-per-user rule does not apply to cards: someone who buys twice holds two.
import { createHash } from "node:crypto";
import { BaseError, ContractFunctionRevertedError, isAddress, parseEventLogs, type Address, type Hex } from "viem";
import { promoVaultAbi } from "./abi.ts";
import { Status, statusName, type PublicClient, type WalletClient } from "./chain.ts";
import type { Identify } from "./circle.ts";
import type { Store } from "./store.ts";

export type ClaimRefusalCode =
  | "bad-request"
  | "login"
  | "not-your-wallet"
  | "unknown-promo"
  | "not-our-promo"
  | "closed"
  | "full"
  | "already-claimed"
  | "failed"
  /** Cards were sent for a promo that is not sold with cards. */
  | "not-cards"
  /** A card address that cannot be one: not an address, the zero address, the vault, the token, or twice in the list. */
  | "bad-card"
  /** The login is not the promo's merchant. */
  | "not-your-promo"
  /** An open claim on a promo that is sold with cards. */
  | "cards-only";

export class ClaimRefusal extends Error {
  code: ClaimRefusalCode;
  constructor(code: ClaimRefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type ClaimResult = {
  promoId: string;
  customer: Address;
  /** True when this customer was already registered and nothing was sent. */
  alreadyRegistered: boolean;
  /** The customer's place in line, when this call registered them. */
  claimCount: number | null;
  txHash: Hex | null;
};

type Deps = { client: PublicClient; wallet: WalletClient; vault: Address; store: Store; identify: Identify };

// A Circle user token is a few hundred characters. Anything far longer is not one.
const MAX_TOKEN = 4096;

/** Refusals after which the cards still in the line for that promo cannot go through either. */
const STOPS_CARDS = new Set<ClaimRefusalCode>(["closed", "full", "unknown-promo", "not-our-promo"]);

/** The name a claim is counted under in the keeper's file: a hash, so the file holds no user ids. */
const claimKey = (who: string): string => createHash("sha256").update(who).digest("hex");

/** The name of the custom error a contract call reverted with, or null. */
export function revertName(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError ? (revert.data?.errorName ?? null) : null;
}

export class Relayer {
  readonly #d: Deps;
  #queue: Promise<unknown> = Promise.resolve();
  /** promo id => the cards of that promo waiting in the line, in lower case. */
  readonly #cards = new Map<string, Set<string>>();
  /** promo id => the refusal that ended its cards: the rest of them are skipped without a call. */
  readonly #stopped = new Map<string, ClaimRefusal>();

  constructor(deps: Deps) {
    this.#d = deps;
  }

  get address(): Address {
    return this.#d.wallet.account.address;
  }

  /**
   * Registers `customer` on the promo for the Circle login `userToken`. Circle is asked before the
   * claim joins the line, so a slow answer holds up nobody else.
   */
  async registerClaim(promoId: bigint, customer: string, userToken: string): Promise<ClaimResult> {
    if (!isAddress(customer)) throw new ClaimRefusal("bad-request", "That is not a wallet address.");
    const user = await this.#identify(userToken);
    if (!user.wallets.some((w) => w.toLowerCase() === customer.toLowerCase())) {
      throw new ClaimRefusal("not-your-wallet", "That login does not match this account. Please log in again.");
    }
    return this.#enqueue(promoId, customer, claimKey(`circle:${user.userId}`));
  }

  /** Whose login `userToken` is, by Circle. A token that cannot be one is refused before Circle is asked. */
  async #identify(userToken: string) {
    if (userToken === "" || userToken.length > MAX_TOKEN || /\s/.test(userToken)) {
      throw new ClaimRefusal("login", "Please log in again.");
    }
    let user;
    try {
      user = await this.#d.identify(userToken);
    } catch (err) {
      console.error("[relayer] could not check a login with Circle:", err);
      throw new ClaimRefusal("failed", "We can't check your login right now. Try again in a moment.");
    }
    if (user === null) throw new ClaimRefusal("login", "Please log in again.");
    return user;
  }

  /** Refuses unless the Circle login `userToken` has `merchant` among its wallets: the one who paid for a promo. */
  async checkMerchant(userToken: string, merchant: Address): Promise<void> {
    const user = await this.#identify(userToken);
    if (!user.wallets.some((w) => w.toLowerCase() === merchant.toLowerCase())) {
      throw new ClaimRefusal(
        "not-your-promo",
        "This login is not the account that paid for this promo. Log in with the email you paid with.",
      );
    }
  }

  /**
   * Puts each card in the line: one `registerClaim` each, one at a time with every other claim (the vault
   * has no batch, and only the relayer may call it, so a multicall cannot do it). Returns at once with how
   * many it added; a card already in the line is not added twice. The caller has checked the merchant's
   * login and that the cards fit the promo.
   */
  queueCards(promoId: bigint, cards: Address[]): number {
    const id = promoId.toString();
    const waiting = this.#cards.get(id) ?? new Set<string>();
    this.#cards.set(id, waiting);
    // The caller has just checked that the promo takes cards: whatever stopped the last ones is over.
    this.#stopped.delete(id);
    let added = 0;
    for (const card of cards) {
      const key = card.toLowerCase();
      if (waiting.has(key)) continue;
      waiting.add(key);
      added++;
      this.#enqueue(promoId, card, null)
        .catch((err: unknown) => {
          if (err instanceof ClaimRefusal && STOPS_CARDS.has(err.code)) {
            if (!this.#stopped.has(id)) console.error(`[relayer] the cards of promo ${id} stopped: ${err.code}`);
            this.#stopped.set(id, err);
          }
          // Anything else was logged by #register; the page sends the card again.
        })
        .finally(() => {
          waiting.delete(key);
          if (waiting.size === 0 && this.#cards.get(id) === waiting) this.#cards.delete(id);
        });
    }
    return added;
  }

  /** The cards of a promo waiting in the line, in lower case. */
  queuedCards(promoId: bigint): string[] {
    return [...(this.#cards.get(promoId.toString()) ?? [])];
  }

  /** Resolves once everything in the line so far has been dealt with (tests). */
  drained(): Promise<void> {
    return this.#queue.then(() => undefined);
  }

  /**
   * The test loop's way in: no login, a made-up user name. The server lets a request reach this only
   * with the test key. Test names and Circle users are counted apart.
   */
  registerTestClaim(promoId: bigint, customer: string, testUser: string): Promise<ClaimResult> {
    if (!isAddress(customer)) return Promise.reject(new ClaimRefusal("bad-request", "That is not a wallet address."));
    return this.#enqueue(promoId, customer, claimKey(`test:${testUser}`));
  }

  /**
   * One at a time, so two claims never race for a nonce or for the same user's one claim. `key` is who is
   * claiming; null for a card, which is counted against nobody.
   */
  #enqueue(promoId: bigint, customer: Address, key: string | null): Promise<ClaimResult> {
    const run = this.#queue.then(() => {
      const stopped = key === null ? this.#stopped.get(promoId.toString()) : undefined;
      if (stopped !== undefined) throw stopped;
      return this.#register(promoId, customer, key);
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #register(promoId: bigint, customer: Address, key: string | null): Promise<ClaimResult> {
    const { client, wallet, vault, store } = this.#d;
    const id = promoId.toString();

    const claimedBy = key === null ? undefined : store.data.claims[id]?.[key];
    if (claimedBy !== undefined && claimedBy.toLowerCase() !== customer.toLowerCase()) {
      throw new ClaimRefusal("already-claimed", "This email has already claimed this promotion.");
    }

    const count = await client.readContract({ address: vault, abi: promoVaultAbi, functionName: "promoCount" });
    if (promoId >= count) throw new ClaimRefusal("unknown-promo", "We could not find this promotion.");
    const [promo, hasClaim, block] = await Promise.all([
      client.readContract({ address: vault, abi: promoVaultAbi, functionName: "getPromo", args: [promoId] }),
      client.readContract({ address: vault, abi: promoVaultAbi, functionName: "hasClaim", args: [promoId, customer] }),
      client.getBlock(),
    ]);

    const remember = () => {
      if (key === null) return;
      (store.data.claims[id] ??= {})[key] = customer;
      store.save();
    };
    if (hasClaim) {
      remember();
      return { promoId: id, customer, alreadyRegistered: true, claimCount: null, txHash: null };
    }
    if (promo.claimSigner.toLowerCase() !== this.address.toLowerCase()) {
      throw new ClaimRefusal("not-our-promo", "This promotion does not take claims here.");
    }
    if (promo.status !== Status.Open || block.timestamp >= promo.claimDeadline) {
      throw new ClaimRefusal("closed", "This promotion is no longer taking customers.");
    }
    if (promo.claimCount >= promo.maxClaims) throw new ClaimRefusal("full", "This promotion is full.");

    try {
      const { request } = await client.simulateContract({
        account: wallet.account,
        address: vault,
        abi: promoVaultAbi,
        functionName: "registerClaim",
        args: [promoId, customer],
      });
      const txHash = await wallet.writeContract(request);
      const receipt = await client.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new ClaimRefusal("failed", "The claim did not go through. Try again.");
      remember();
      store.recordTx(promoId, "registerClaim", txHash);
      const [log] = parseEventLogs({ abi: promoVaultAbi, eventName: "ClaimRegistered", logs: receipt.logs });
      return { promoId: id, customer, alreadyRegistered: false, claimCount: log?.args.claimCount ?? null, txHash };
    } catch (err) {
      if (err instanceof ClaimRefusal) throw err;
      // The checks above can be overtaken between the read and the transaction.
      const name = revertName(err);
      if (name === "PromoFull") throw new ClaimRefusal("full", "This promotion is full.");
      if (name === "ClaimsClosed" || name === "WrongStatus") {
        throw new ClaimRefusal("closed", "This promotion is no longer taking customers.");
      }
      console.error(`[relayer] registerClaim(${id}, ${customer}) failed in status ${statusName(promo.status)}:`, err);
      throw new ClaimRefusal("failed", "The claim did not go through. Try again.");
    }
  }
}
