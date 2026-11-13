// Claim cards (keeper/README.md, "Claim cards"). Each card is its own small wallet. The merchant's browser
// makes one private key per card, keeps the keys in this browser only, and sends the keeper the cards'
// addresses, which the keeper registers on the promo. The card is a QR code for /card/<promo>#<key>: the key
// is in the part of the address after "#", which a browser never sends to any server. On a "yes" the vault
// pays each card's address. The holder collects in their own browser: one transfer, signed with the card's
// key, of the card's balance less its own processing fee, to their FreeIf account.
//
// The key never leaves the browser: not in a request to FreeIf or the keeper, not in a log, and on the
// customer's side not in storage either. Only the merchant's browser stores keys, so it can print again.
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  TransactionReceiptNotFoundError,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arcTestnet, RPC_URL, USDC_ADDRESS } from "./config";
import { cardsKey, readLocal, saveLocal } from "./local";

type Address = `0x${string}`;

/** Native units (18 decimals) in one base unit of the dollar token (6 decimals): gas is paid in the same money. */
const NATIVE_PER_UNIT = 10n ** 12n;
/** Under a cent on a card is what a processing fee left behind: there is nothing to collect. */
export const CARD_DUST = 10_000n;

/** A merchant's cards for one promo, as this browser keeps them. */
export type CardSet = {
  /** One private key per card, in card order. */
  keys: Hex[];
  /** When they were made, in milliseconds. */
  at: number;
  /** When they were last printed, in milliseconds. Null until then. */
  printedAt: number | null;
};

/** Fresh keys for `count` cards. */
export const makeKeys = (count: number): Hex[] => Array.from({ length: count }, () => generatePrivateKey());

/** The card's address: what the keeper registers and the vault pays. */
export const addressOf = (key: Hex): Address => privateKeyToAccount(key).address;

/** The cards this browser made for a promo, or null. */
export const loadCards = (vault: string, promoId: string): CardSet | null => readLocal<CardSet | null>(cardsKey(vault, promoId), null);

/**
 * Keeps the cards in this browser. True only when they can be read back as written: the page sends no
 * address to the keeper for a card this browser could not keep.
 */
export function saveCards(vault: string, promoId: string, set: CardSet): boolean {
  const key = cardsKey(vault, promoId);
  saveLocal(key, set);
  try {
    return window.localStorage.getItem(key) === JSON.stringify(set);
  } catch {
    return false;
  }
}

/** What a card's QR code opens. The key goes after "#", without its "0x". */
export const cardUrl = (origin: string, promoId: string, key: Hex): string => `${origin}/card/${promoId}#${key.slice(2)}`;

/** The key in a card page's address (`location.hash`), or null when it is not one. */
export function keyFromHash(hash: string): Hex | null {
  const raw = hash.replace(/^#/, "").replace(/^0x/i, "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) return null;
  const key = `0x${raw.toLowerCase()}` as Hex;
  // A key must be a number the curve accepts (not 0, below its order); one that is not throws here.
  try {
    privateKeyToAccount(key);
  } catch {
    return null;
  }
  return key;
}

/**
 * The gas limit for the transfer (the estimate and 20% more) and the most it can cost, in base units,
 * rounded up. The card sends its balance less that; what the fee does not use stays on the card.
 */
export function holdback(gasEstimate: bigint, maxFeePerGas: bigint): { gasLimit: bigint; fee: bigint } {
  const gasLimit = (gasEstimate * 120n + 99n) / 100n;
  const fee = (gasLimit * maxFeePerGas + NATIVE_PER_UNIT - 1n) / NATIVE_PER_UNIT;
  return { gasLimit, fee };
}

/** Why collecting did not go through, in words for the card's holder. */
export class CollectError extends Error {
  code: "empty" | "failed" | "slow";
  constructor(code: CollectError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

// The public RPC answers a browser, and refuses a burst of more than about five calls: collecting makes
// six, one after the other, and viem tries a refused one again after a pause.
const chain = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL, { timeout: 15_000 }) });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Collects card `key` into the account `to`: one transfer, signed here with the card's key, of the card's
 * balance less its processing fee. Resolves once it is in a block, with what was sent.
 */
export async function collect(key: Hex, to: Address): Promise<{ hash: Hex; amount: bigint }> {
  const account = privateKeyToAccount(key);
  const card = account.address;
  const transfer = (amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
  let hash: Hex;
  let amount: bigint;
  try {
    const balance = await chain.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [card] });
    if (balance < CARD_DUST) throw new CollectError("empty", "There is nothing on this card to collect.");
    // Asked without fees, so the node does not take the fee out of the balance while it estimates.
    const gasEstimate = await chain.estimateGas({ account: card, to: USDC_ADDRESS, data: transfer(balance), prepare: false });
    const { maxFeePerGas, maxPriorityFeePerGas } = await chain.estimateFeesPerGas();
    const { gasLimit, fee } = holdback(gasEstimate, maxFeePerGas);
    amount = balance - fee;
    if (amount <= 0n) throw new CollectError("empty", "There is nothing on this card to collect.");
    const nonce = await chain.getTransactionCount({ address: card, blockTag: "pending" });
    const serializedTransaction = await account.signTransaction({
      type: "eip1559",
      chainId: arcTestnet.id,
      nonce,
      to: USDC_ADDRESS,
      data: transfer(amount),
      value: 0n,
      gas: gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    hash = await chain.sendRawTransaction({ serializedTransaction });
  } catch (err) {
    if (err instanceof CollectError) throw err;
    throw new CollectError("failed", "That didn't go through. Nothing left the card. Try again in a moment.");
  }
  // Asked every 1.5 seconds, once per call: Arc makes a block about every half second.
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    try {
      const receipt = await chain.getTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new CollectError("failed", "That didn't go through. Nothing left the card. Try again in a moment.");
      return { hash, amount };
    } catch (err) {
      if (err instanceof CollectError) throw err;
      if (!(err instanceof TransactionReceiptNotFoundError)) continue;
    }
  }
  throw new CollectError("slow", "This is taking longer than usual. Scan the card again in a minute before you try again.");
}
