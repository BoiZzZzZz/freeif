// The claim relayer. Its key is every promo's `claimSigner` (F17), so it is the only address that can
// register a customer. It allows one claim per email per promo.
import { createHash } from "node:crypto";
import { BaseError, ContractFunctionRevertedError, isAddress, parseEventLogs, type Address, type Hex } from "viem";
import { promoVaultAbi } from "./abi.ts";
import { Status, statusName, type PublicClient, type WalletClient } from "./chain.ts";
import type { Store } from "./store.ts";

export type ClaimRefusalCode =
  | "bad-request"
  | "unknown-promo"
  | "not-our-promo"
  | "closed"
  | "full"
  | "email-used"
  | "failed";

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

type Deps = { client: PublicClient; wallet: WalletClient; vault: Address; store: Store };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emailKey = (email: string): string => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

/** The name of the custom error a contract call reverted with, or null. */
export function revertName(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError ? (revert.data?.errorName ?? null) : null;
}

export class Relayer {
  readonly #d: Deps;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: Deps) {
    this.#d = deps;
  }

  get address(): Address {
    return this.#d.wallet.account.address;
  }

  /** Registers `customer` on the promo. One at a time, so two claims never race for a nonce or an email. */
  registerClaim(promoId: bigint, customer: string, email: string): Promise<ClaimResult> {
    const run = this.#queue.then(() => this.#register(promoId, customer, email));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #register(promoId: bigint, customer: string, email: string): Promise<ClaimResult> {
    if (!isAddress(customer)) throw new ClaimRefusal("bad-request", "That is not a wallet address.");
    if (!EMAIL.test(email)) throw new ClaimRefusal("bad-request", "That is not an email address.");
    const { client, wallet, vault, store } = this.#d;
    const id = promoId.toString();
    const key = emailKey(email);

    const claimedBy = store.data.claims[id]?.[key];
    if (claimedBy !== undefined && claimedBy.toLowerCase() !== customer.toLowerCase()) {
      throw new ClaimRefusal("email-used", "This email has already claimed this promotion.");
    }

    const count = await client.readContract({ address: vault, abi: promoVaultAbi, functionName: "promoCount" });
    if (promoId >= count) throw new ClaimRefusal("unknown-promo", "We could not find this promotion.");
    const [promo, hasClaim, block] = await Promise.all([
      client.readContract({ address: vault, abi: promoVaultAbi, functionName: "getPromo", args: [promoId] }),
      client.readContract({ address: vault, abi: promoVaultAbi, functionName: "hasClaim", args: [promoId, customer] }),
      client.getBlock(),
    ]);

    const remember = () => {
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
      if (name === "ClaimsClosed" || name === "WrongStatus" || name === "VaultPaused") {
        throw new ClaimRefusal("closed", "This promotion is no longer taking customers.");
      }
      console.error(`[relayer] registerClaim(${id}, ${customer}) failed in status ${statusName(promo.status)}:`, err);
      throw new ClaimRefusal("failed", "The claim did not go through. Try again.");
    }
  }
}
