// Cash out: the one thing an account sends besides a promo's price. Built on the server so the browser
// cannot ask the account for anything else: it is always a plain USDC transfer, from the account
// itself, of an amount it holds, to the address the person typed.
import { encodeFunctionData, erc20Abi, getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { FEE_BUFFER, USDC_ADDRESS } from "../config";
import { chain, vaultAddress } from "./chain";
import { Refusal } from "./http";

export const NOT_SENT = "That didn't go through. Nothing was sent.";

/** "$7.95" from base units. */
const usd = (units: bigint): string => `$${units / 1_000_000n}.${((units % 1_000_000n) / 10_000n).toString().padStart(2, "0")}`;

/**
 * The `transfer(to, amount)` call on Arc's USDC that sends `amount` (base units) from `owner` to `to`.
 * Refused, in the person's words, when the address is not one, is the account's own, or is a place the
 * money would be lost; when the account does not hold the amount and a few cents for the network fee;
 * and when the transfer would revert. Returns the token and the calldata to send to it.
 */
export async function cashOutCall(owner: Address, to: string, amount: string): Promise<{ token: Address; callData: Hex; to: Address }> {
  if (!/^\d{1,15}$/.test(amount) || BigInt(amount) === 0n) throw new Refusal(400, "bad-request", "Enter an amount to send.");
  if (!isAddress(to)) throw new Refusal(400, "bad-address", "That doesn't look like an address. Check it and try again.");
  const recipient = getAddress(to);
  const lost: string[] = [zeroAddress, USDC_ADDRESS.toLowerCase(), (await vaultAddress()).toLowerCase()];
  if (recipient.toLowerCase() === owner.toLowerCase()) {
    throw new Refusal(400, "bad-address", "That is this account's own address. Enter the address you want the money sent to.");
  }
  if (lost.includes(recipient.toLowerCase())) throw new Refusal(400, "bad-address", "Money sent to that address would be lost. Enter another one.");

  const value = BigInt(amount);
  const balance = await chain.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  // The account pays its own network fee, about a cent, from the same balance.
  if (balance < value + FEE_BUFFER) {
    const most = balance > FEE_BUFFER ? balance - FEE_BUFFER : 0n;
    throw new Refusal(409, "short", most > 0n ? `You can send up to ${usd(most)} right now.` : "There is nothing to send right now.");
  }

  const call = { abi: erc20Abi, functionName: "transfer", args: [recipient, value] } as const;
  try {
    await chain.simulateContract({ ...call, account: owner, address: USDC_ADDRESS });
  } catch (err) {
    console.error("[cash-out] the transfer would revert:", err instanceof Error ? err.message.split("\n")[0] : err);
    throw new Refusal(409, "failed", "That address can't receive this. Nothing was sent.");
  }
  return { token: USDC_ADDRESS, callData: encodeFunctionData(call), to: recipient };
}
