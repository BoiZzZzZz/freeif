// Collecting a claim card: one USDC transfer of the card's balance, less its own network fee, from the
// card's address to the holder's account, signed with the card's key. On Arc the network fee is paid in
// USDC from the same balance (the native balance is the ERC-20 balance times 10^12), so the card pays for
// itself. The card page does the same in the browser (web/src/lib/cards.ts); the test loop uses this one.
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID } from "./config.ts";

/** Native units (18 decimals) in one base unit of the ERC-20 (6 decimals). */
export const NATIVE_PER_UNIT = 10n ** 12n;
/** Under a cent on a card is what a fee left behind: there is nothing to collect. */
export const CARD_DUST = 10_000n;

/**
 * The gas limit for the transfer (the estimate and 20% more) and the most it can cost, in base units,
 * rounded up. The card sends its balance less that fee; what the fee does not use stays on the card.
 */
export function holdback(gasEstimate: bigint, maxFeePerGas: bigint): { gasLimit: bigint; fee: bigint } {
  const gasLimit = (gasEstimate * 120n + 99n) / 100n;
  const fee = (gasLimit * maxFeePerGas + NATIVE_PER_UNIT - 1n) / NATIVE_PER_UNIT;
  return { gasLimit, fee };
}

/** The reads and the one send collecting needs. A viem public client has all of them. */
export type CollectClient = {
  readContract: (args: { address: Address; abi: typeof erc20Abi; functionName: "balanceOf"; args: readonly [Address] }) => Promise<bigint>;
  estimateGas: (args: { account: Address; to: Address; data: Hex; prepare: false }) => Promise<bigint>;
  estimateFeesPerGas: () => Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  getTransactionCount: (args: { address: Address; blockTag: "pending" }) => Promise<number>;
  sendRawTransaction: (args: { serializedTransaction: Hex }) => Promise<Hex>;
};

export type Collected = { hash: Hex; card: Address; balance: bigint; amount: bigint; fee: bigint; gasLimit: bigint };

/** Sends what card `key` holds, less its fee, to `to`. Throws when the card holds under a cent. */
export async function collectCard(client: CollectClient, usdc: Address, key: Hex, to: Address): Promise<Collected> {
  const account = privateKeyToAccount(key);
  const card = account.address;
  const balance = await client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [card] });
  if (balance < CARD_DUST) throw new Error(`card ${card} holds ${balance} base units: nothing to collect`);
  const transfer = (amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
  // Without fees in the request the node does not take the fee from the balance while it estimates, so
  // the whole balance can be estimated. The gas does not depend on the amount.
  const gasEstimate = await client.estimateGas({ account: card, to: usdc, data: transfer(balance), prepare: false });
  const { maxFeePerGas, maxPriorityFeePerGas } = await client.estimateFeesPerGas();
  const { gasLimit, fee } = holdback(gasEstimate, maxFeePerGas);
  const amount = balance - fee;
  if (amount <= 0n) throw new Error(`card ${card} holds ${balance} base units, less than its fee of ${fee}`);
  const nonce = await client.getTransactionCount({ address: card, blockTag: "pending" });
  const serializedTransaction = await account.signTransaction({
    type: "eip1559",
    chainId: CHAIN_ID,
    nonce,
    to: usdc,
    data: transfer(amount),
    value: 0n,
    gas: gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  const hash = await client.sendRawTransaction({ serializedTransaction });
  return { hash, card, balance, amount, fee, gasLimit };
}
