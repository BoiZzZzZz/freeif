// Arc testnet, the clients that talk to it, and the EIP-712 shape of a quote.
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, PUBLIC_RPC_URL, rpcUrls } from "./config.ts";

export const arcTestnet = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  // USDC is the gas token. As gas it has 18 decimals; the ERC-20 interface the vault uses has 6.
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [PUBLIC_RPC_URL] } },
  blockExplorers: { default: { name: "Arc explorer", url: "https://explorer.testnet.arc.io" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

export const explorerTx = (hash: Hex): string => `${arcTestnet.blockExplorers.default.url}/tx/${hash}`;

/** The newest block any endpoint has reported. One per process: every client shares it. */
export type Head = { block: number };
const head: Head = { block: 0 };

/** A second endpoint may be this many blocks behind the newest block seen and still be asked. */
export const MAX_LAG_BLOCKS = 20;
/** How long one check of a second endpoint's block number is trusted. */
const LAG_CHECK_MS = 5_000;

/** Notes the newest block the first endpoint reports, so the others can be measured against it. */
export function tracking(inner: Transport, seen: Head): Transport {
  return (options) => {
    const made = inner(options);
    const request = (async (args: { method: string }, ...rest: unknown[]) => {
      const result = await (made.request as (...a: unknown[]) => Promise<unknown>)(args, ...rest);
      if (args.method === "eth_blockNumber") seen.block = Math.max(seen.block, Number(result));
      return result;
    }) as typeof made.request;
    return { ...made, request };
  };
}

/**
 * A second endpoint, asked only while it keeps up. An endpoint that has fallen behind does not fail: it
 * answers, with old state, and a promo made a minute ago "does not exist". So before it is used (at most
 * once every five seconds) its own block number is read, and when that is more than `MAX_LAG_BLOCKS`
 * behind the newest block seen, the request fails instead, and the caller tries the first endpoint again.
 */
export function keepingUp(inner: Transport, seen: Head, now: () => number = Date.now): Transport {
  let checkedAt = -Infinity;
  let lag = 0;
  return (options) => {
    const made = inner(options);
    const ask = made.request as (...a: unknown[]) => Promise<unknown>;
    const request = (async (args: { method: string }, ...rest: unknown[]) => {
      if (now() - checkedAt >= LAG_CHECK_MS) {
        const block = Number(await ask({ method: "eth_blockNumber" }));
        checkedAt = now();
        lag = seen.block - block;
      }
      if (lag > MAX_LAG_BLOCKS) throw new Error(`this RPC endpoint is ${lag} blocks behind and is not used`);
      return ask(args, ...rest);
    }) as typeof made.request;
    return { ...made, request };
  };
}

/** The first endpoint, then the others for when it cannot be reached, each only while it keeps up. */
const transport = () =>
  fallback(
    rpcUrls().map((url, i) => {
      const endpoint = http(url, { timeout: 15_000 });
      return i === 0 ? tracking(endpoint, head) : keepingUp(endpoint, head);
    }),
  );

export function makePublicClient() {
  return createPublicClient({ chain: arcTestnet, transport: transport() });
}
export type PublicClient = ReturnType<typeof makePublicClient>;

export function makeWalletClient(privateKey: Hex) {
  return createWalletClient({ account: privateKeyToAccount(privateKey), chain: arcTestnet, transport: transport() });
}
export type WalletClient = ReturnType<typeof makeWalletClient>;

/** The quote the pricer signs. Field order and types match `Quote` in PromoVault.sol. */
export type Quote = {
  merchant: Address;
  claimSigner: Address;
  geminiEventId: Hex;
  instrumentSymbol: Hex;
  payoutPerClaim: bigint;
  maxClaims: number;
  premium: bigint;
  claimDeadline: bigint;
  marketCloseTime: bigint;
  hedgeMode: boolean;
  expiry: bigint;
  nonce: Hex;
};

export const quoteTypes = {
  Quote: [
    { name: "merchant", type: "address" },
    { name: "claimSigner", type: "address" },
    { name: "geminiEventId", type: "bytes32" },
    { name: "instrumentSymbol", type: "bytes32" },
    { name: "payoutPerClaim", type: "uint256" },
    { name: "maxClaims", type: "uint32" },
    { name: "premium", type: "uint256" },
    { name: "claimDeadline", type: "uint64" },
    { name: "marketCloseTime", type: "uint64" },
    { name: "hedgeMode", type: "bool" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const quoteDomain = (vault: Address) =>
  ({ name: "PromoVault", version: "1", chainId: CHAIN_ID, verifyingContract: vault }) as const;

/** Promo status, numbered as in the contract. */
export const Status = {
  Open: 0,
  Settled: 1,
  FinalizedYes: 2,
  FinalizedNo: 3,
  Vetoed: 4,
  PaidOut: 5,
  Voided: 6,
} as const;
export const statusName = (status: number): string =>
  Object.entries(Status).find(([, n]) => n === status)?.[0] ?? `Unknown(${status})`;

/** A quote as JSON: the three big numbers become decimal strings. */
export function quoteToJson(q: Quote) {
  return {
    ...q,
    payoutPerClaim: q.payoutPerClaim.toString(),
    premium: q.premium.toString(),
    claimDeadline: Number(q.claimDeadline),
    marketCloseTime: Number(q.marketCloseTime),
    expiry: Number(q.expiry),
  };
}
export type QuoteJson = ReturnType<typeof quoteToJson>;

export function quoteFromJson(j: QuoteJson): Quote {
  return {
    ...j,
    payoutPerClaim: BigInt(j.payoutPerClaim),
    premium: BigInt(j.premium),
    claimDeadline: BigInt(j.claimDeadline),
    marketCloseTime: BigInt(j.marketCloseTime),
    expiry: BigInt(j.expiry),
  };
}
