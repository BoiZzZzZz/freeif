// Addresses and URLs the browser and the server both use. Nothing secret lives here.
import { defineChain } from "viem";

/** The keeper: prices, signed quotes, claims and promo status. Its API is in keeper/README.md. */
export const KEEPER_URL = (process.env.NEXT_PUBLIC_KEEPER_URL ?? "https://freeif-production.up.railway.app").replace(/\/$/, "");

export const RPC_URL = process.env.NEXT_PUBLIC_ARC_RPC_URL ?? "https://rpc.testnet.arc.io";
export const EXPLORER_URL = "https://explorer.testnet.arc.io";
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as const;

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  // USDC is the gas token. As gas it has 18 decimals; the ERC-20 interface the vault uses has 6.
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Arc explorer", url: EXPLORER_URL } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

export const explorerTx = (hash: string): string => `${EXPLORER_URL}/tx/${hash}`;
export const explorerAddress = (address: string): string => `${EXPLORER_URL}/address/${address}`;

/** What a wallet must hold beyond the cost of a promo: it pays its own network fee, about one cent. */
export const FEE_BUFFER = 50_000n;
