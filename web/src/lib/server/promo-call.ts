// The two things a merchant's account does to pay for a promo, built on the server so the browser
// cannot ask the account for anything else: the USDC permit it signs, and the `createPromoWithPermit`
// call it sends.
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  parseSignature,
  type Address,
  type Hex,
} from "viem";
import { promoVaultAbi } from "../abi";
import { arcTestnet, USDC_ADDRESS } from "../config";
import type { QuoteJson } from "../keeper";
import { chain, usdcAbi, vaultAddress } from "./chain";
import { NOT_CHARGED, Refusal } from "./http";

// Long enough for two confirmation screens, short enough that a signed permit is not left lying around.
const PERMIT_SECONDS = 600;

/**
 * EIP-2612 typed data: `owner` lets the vault take exactly `value`, once, until the deadline. The
 * domain is the one Arc's USDC reports (name "USDC", version "2"), read from the token.
 */
export async function permitTypedData(owner: Address, value: string) {
  const token = { address: USDC_ADDRESS, abi: usdcAbi } as const;
  const [vault, name, version, nonce] = await Promise.all([
    vaultAddress(),
    chain.readContract({ ...token, functionName: "name" }),
    chain.readContract({ ...token, functionName: "version" }),
    chain.readContract({ ...token, functionName: "nonces", args: [owner] }),
  ]);
  const deadline = Math.floor(Date.now() / 1000) + PERMIT_SECONDS;
  const typed = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    domain: { name, version, chainId: arcTestnet.id, verifyingContract: USDC_ADDRESS },
    message: { owner, spender: vault, value, nonce: nonce.toString(), deadline: String(deadline) },
  } as const;
  return { typed, deadline };
}

/** The vault's custom error behind a failed check, in the merchant's words. */
function refusalFor(err: unknown): Refusal {
  const revert = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
  const name = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
  if (name === "QuoteExpired" || name === "QuoteNonceUsed") {
    return new Refusal(409, "expired", "That price expired. Here is the current one.");
  }
  if (name === "ClaimDeadlinePassed") return new Refusal(409, "started", "This game has started. Pick another game.");
  if (name === "ExposureTooHigh" || name === "VaultPaused") {
    return new Refusal(409, "capacity", "We can't cover this promo right now. Try fewer customers.");
  }
  console.error("[create-promo] the call would revert:", name ?? (err instanceof BaseError ? err.shortMessage : err));
  return new Refusal(409, "failed", NOT_CHARGED);
}

/**
 * `createPromoWithPermit(quote, quoteSignature, permitDeadline, v, r, s)` from the keeper's signed
 * quote and the permit the account just signed. The call is simulated from the merchant's account
 * first: one that would revert is refused here, in words, and is never handed to the wallet.
 * Returns the vault and the calldata to send to it.
 */
export async function promoCall(
  owner: Address,
  j: QuoteJson,
  quoteSignature: Hex,
  permitSignature: Hex,
  permitDeadline: number,
): Promise<{ vault: Address; callData: Hex }> {
  const quote = {
    ...j,
    payoutPerClaim: BigInt(j.payoutPerClaim),
    premium: BigInt(j.premium),
    claimDeadline: BigInt(j.claimDeadline),
    marketCloseTime: BigInt(j.marketCloseTime),
    expiry: BigInt(j.expiry),
  };
  const { r, s, yParity } = parseSignature(permitSignature);
  const call = {
    abi: promoVaultAbi,
    functionName: "createPromoWithPermit",
    args: [quote, quoteSignature, BigInt(permitDeadline), 27 + yParity, r, s],
  } as const;

  const vault = await vaultAddress();
  try {
    await chain.simulateContract({ ...call, account: owner, address: vault });
  } catch (err) {
    throw refusalFor(err);
  }
  return { vault, callData: encodeFunctionData(call) };
}
