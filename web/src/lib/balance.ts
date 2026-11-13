// An account's balance, read from Arc in the browser. The pages call it "Balance"; it is USDC.
import { createPublicClient, erc20Abi, http } from "viem";
import { arcTestnet, RPC_URL, USDC_ADDRESS } from "./config";

const client = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL, { timeout: 15_000 }) });

/** Base units (6 decimals). */
export const usdcBalance = (address: `0x${string}`): Promise<bigint> =>
  client.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] });
