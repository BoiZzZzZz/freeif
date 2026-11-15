// Starter test dollars. A judge who opens the merchant page and logs in with an email gets a new account
// that holds nothing, so Pay stops at "Add money". The keeper sends such an account a few test dollars,
// once per Circle login, from the relayer's wallet.
//
// Who may have them is decided as a claim is: Circle says whose login the token is, the address must be
// one of that login's wallets, and the login is counted under the SHA-256 of `circle:<id>` (never the id,
// never the token). The transfer goes through the relayer's line, so it never races a claim for a nonce.
import { erc20Abi, type Address, type Hex } from "viem";
import type { PublicClient, WalletClient } from "./chain.ts";
import type { Identify } from "./circle.ts";
import { claimKey, plausibleToken, type Relayer } from "./relayer.ts";
import type { StarterGrant, Store } from "./store.ts";

export type StarterRefusalCode =
  | "off"
  | "login"
  | "not-your-wallet"
  /** This login has had its grant (or one is being sent). */
  | "already"
  /** The account already holds the amount. */
  | "funded"
  /** The budget is used up, or the relayer would keep less than its floor. */
  | "none-left"
  | "failed";

/** A grant the keeper will not make. `message` is written for the merchant's Pay sheet. */
export class StarterRefusal extends Error {
  code: StarterRefusalCode;
  constructor(code: StarterRefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Base units (6 decimals): what one login gets, the most given out in all, and what the relayer always keeps. */
export type StarterSettings = { amount: bigint; budget: bigint; floor: bigint };

type Deps = {
  client: PublicClient;
  /** The sender: its wallet, and its line of transactions. */
  relayer: Relayer;
  usdc: Address;
  store: Store;
  identify: Identify;
  settings: StarterSettings;
  /** Milliseconds (tests move it). */
  now?: () => number;
};

/** The relayer's balance is read at most this often for `GET /health`. */
const BALANCE_READ_MS = 30_000;

// What a merchant reads. None of it says USDC, wallet, gas or transaction.
const LOGIN = "Please log in again.";
const NONE_LEFT = "We've given out all the test dollars we have for now.";
const FAILED = "We couldn't send your test dollars. Try again in a moment.";

/** 5000000 -> "$5.00". */
const dollarsText = (units: bigint): string =>
  `$${units / 1_000_000n}.${((units % 1_000_000n) / 10_000n).toString().padStart(2, "0")}`;

export class Starter {
  readonly #d: Deps;
  readonly #now: () => number;
  #senderRead: { at: number; value: Promise<bigint> } | null = null;

  constructor(deps: Deps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
  }

  #balanceOf(address: Address): Promise<bigint> {
    return this.#d.client.readContract({ address: this.#d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] });
  }

  /** What the budget can still give. Every grant in the file counts, the ones being sent too. */
  #budgetLeft(): bigint {
    let given = 0n;
    for (const grant of Object.values(this.#d.store.data.starter)) given += BigInt(grant.amount);
    return this.#d.settings.budget - given;
  }

  /** The relayer's balance, read again only after 30 seconds or a grant. */
  #senderBalance(): Promise<bigint> {
    const held = this.#senderRead;
    if (held !== null && this.#now() - held.at < BALANCE_READ_MS) return held.value;
    const read = { at: this.#now(), value: this.#balanceOf(this.#d.relayer.address) };
    this.#senderRead = read;
    // A read that failed is not served again.
    read.value.catch(() => {
      if (this.#senderRead === read) this.#senderRead = null;
    });
    return read.value;
  }

  /**
   * For `GET /health`: the amount, and how many more grants the budget and the floor allow right now. When
   * the relayer's balance cannot be read, `left` is the budget's count alone. Never throws.
   */
  async status(): Promise<{ amount: string; left: number }> {
    const { amount, floor } = this.#d.settings;
    let left = this.#budgetLeft() / amount;
    try {
      const byFloor = ((await this.#senderBalance()) - floor) / amount;
      if (byFloor < left) left = byFloor;
    } catch {
      // The budget's count alone.
    }
    return { amount: amount.toString(), left: left > 0n ? Number(left) : 0 };
  }

  /**
   * Sends the starter amount to `address`, the account of the Circle login `userToken`, once per login, and
   * waits for the receipt. Refusals are `StarterRefusal`s. The checks that need no call come first, then
   * Circle, then the hold on the grant, then the chain.
   */
  async grant(address: Address, userToken: string): Promise<{ amount: string; txHash: Hex }> {
    const { store, settings, client, usdc } = this.#d;
    const amount = settings.amount;
    if (!plausibleToken(userToken)) throw new StarterRefusal("login", LOGIN);
    if (this.#budgetLeft() < amount) throw new StarterRefusal("none-left", NONE_LEFT);

    let user;
    try {
      user = await this.#d.identify(userToken);
    } catch (err) {
      // Circle's errors do not carry the token, but no log line may ever hold one, so it is cut out anyway.
      console.error("[starter] could not check a login with Circle:", String(err).replaceAll(userToken, "<token>"));
      throw new StarterRefusal("failed", "We can't check your login right now. Try again in a moment.");
    }
    if (user === null) throw new StarterRefusal("login", LOGIN);
    if (!user.wallets.some((w) => w.toLowerCase() === address.toLowerCase())) {
      throw new StarterRefusal("not-your-wallet", "That login does not match this account. Please log in again.");
    }

    // From this check to the hold there is no await, so two requests from one login cannot both pass.
    const key = claimKey(`circle:${user.userId}`);
    if (store.data.starter[key] !== undefined) {
      throw new StarterRefusal("already", "This email has already had its test dollars. They're given once per email.");
    }
    if (this.#budgetLeft() < amount) throw new StarterRefusal("none-left", NONE_LEFT);
    const grant: StarterGrant = { address, amount: amount.toString(), at: Math.floor(this.#now() / 1000), txHash: null };
    store.data.starter[key] = grant;
    store.save();

    // Held. Whatever stops it now gives the hold back, unless the test dollars may have left.
    let txHash: Hex;
    try {
      if ((await this.#balanceOf(address)) >= amount) {
        throw new StarterRefusal("funded", `Your account already has ${dollarsText(amount)} or more in test dollars.`);
      }
      txHash = await this.#d.relayer.inLine(async (wallet: WalletClient) => {
        // Read in the line: no other transaction of the relayer's comes between this and the transfer.
        const mine = await this.#balanceOf(wallet.account.address);
        if (mine - amount < settings.floor) throw new StarterRefusal("none-left", NONE_LEFT);
        const { request } = await client.simulateContract({
          account: wallet.account,
          address: usdc,
          abi: erc20Abi,
          functionName: "transfer",
          args: [address, amount],
        });
        const hash = await wallet.writeContract(request);
        // From here the test dollars may have left: the hold stays unless the chain says they did not.
        grant.txHash = hash;
        store.save();
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          console.error(`[starter] the test dollars to ${address} reverted: ${hash}`);
          grant.txHash = null;
          throw new StarterRefusal("failed", FAILED);
        }
        return hash;
      });
    } catch (err) {
      this.#senderRead = null;
      if (grant.txHash !== null) {
        // Sent and not confirmed: they may have arrived, so the grant counts as given.
        console.error(`[starter] the test dollars to ${address} were sent (${grant.txHash}) and not confirmed:`, err);
        throw new StarterRefusal("failed", "We sent your test dollars but can't confirm them yet. Check your balance again in a minute.");
      }
      if (store.data.starter[key] === grant) {
        delete store.data.starter[key];
        store.save();
      }
      if (err instanceof StarterRefusal) throw err;
      console.error(`[starter] sending test dollars to ${address} failed:`, err);
      throw new StarterRefusal("failed", FAILED);
    }
    this.#senderRead = null;
    return { amount: amount.toString(), txHash };
  }
}
