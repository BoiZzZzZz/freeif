// The wallet in the browser (MetaMask and the like), for the one page that uses it: /lp. Merchants and
// customers log in by email and never see this. Deposits and withdrawals are sent by the wallet itself;
// what it holds is read from Arc.
import { createPublicClient, createWalletClient, custom, erc20Abi, http, numberToHex } from "viem";
import { promoVaultAbi } from "./abi";
import { arcTestnet, EXPLORER_URL, RPC_URL, USDC_ADDRESS } from "./config";

type Address = `0x${string}`;
type Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

/** The wallet's provider, or null when the browser has no wallet. */
export const injected = (): Provider | null =>
  typeof window === "undefined" ? null : ((window as unknown as { ethereum?: Provider }).ethereum ?? null);

const reader = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL, { timeout: 15_000 }) });

const need = (): Provider => {
  const provider = injected();
  if (!provider) throw new Error("No wallet found in this browser.");
  return provider;
};

/** Asks the wallet for its account. The wallet shows its own window the first time. */
export async function connect(): Promise<Address> {
  const accounts = (await need().request({ method: "eth_requestAccounts" })) as Address[];
  if (!accounts[0]) throw new Error("The wallet gave no account.");
  return accounts[0];
}

/** The account the wallet already shares with this site, without asking. */
export async function connected(): Promise<Address | null> {
  const provider = injected();
  if (!provider) return null;
  const accounts = (await provider.request({ method: "eth_accounts" }).catch(() => [])) as Address[];
  return accounts[0] ?? null;
}

/** Calls `listener` when the wallet's account changes, until the returned function is called. */
export function onAccount(listener: (account: Address | null) => void): () => void {
  const provider = injected();
  if (!provider?.on) return () => undefined;
  const handle = (accounts: unknown) => listener((accounts as Address[])[0] ?? null);
  provider.on("accountsChanged", handle);
  return () => provider.removeListener?.("accountsChanged", handle);
}

/** Puts the wallet on Arc testnet, adding the network first if the wallet does not know it. */
async function switchToArc(provider: Provider): Promise<void> {
  const chainId = numberToHex(arcTestnet.id);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (err) {
    // 4902: the wallet has never heard of this chain.
    if ((err as { code?: number }).code !== 4902) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: arcTestnet.name,
          nativeCurrency: arcTestnet.nativeCurrency,
          rpcUrls: [RPC_URL],
          blockExplorerUrls: [EXPLORER_URL],
        },
      ],
    });
  }
}

/** What an account has in and around the vault. Base units; shares have six decimals, like USDC. */
export type Position = { shares: bigint; balance: bigint; allowance: bigint };

export async function position(account: Address, vault: Address): Promise<Position> {
  const [shares, balance, allowance] = await Promise.all([
    reader.readContract({ address: vault, abi: promoVaultAbi, functionName: "shares", args: [account] }),
    reader.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    reader.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [account, vault] }),
  ]);
  return { shares, balance, allowance };
}

async function sent(hash: `0x${string}`): Promise<`0x${string}`> {
  const receipt = await reader.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The transaction was reverted.");
  return hash;
}

/**
 * Deposits `amount` USDC. The vault pulls the money, so the wallet first approves exactly that amount
 * when its allowance is short: up to two confirmations in the wallet. `step` says which one is up.
 */
export async function deposit(account: Address, vault: Address, amount: bigint, step: (text: string) => void): Promise<`0x${string}`> {
  const provider = need();
  await switchToArc(provider);
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: custom(provider) });
  const { allowance } = await position(account, vault);
  if (allowance < amount) {
    step("Approve the amount in your wallet");
    await sent(await wallet.writeContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "approve", args: [vault, amount] }));
  }
  step("Confirm the deposit in your wallet");
  // Checked against the chain first, so a deposit the vault would refuse never reaches the wallet.
  const { request } = await reader.simulateContract({ account, address: vault, abi: promoVaultAbi, functionName: "deposit", args: [amount] });
  const hash = await wallet.writeContract(request);
  step("Waiting for the deposit");
  return sent(hash);
}

/** Burns `shares` for their part of the vault's free balance. One confirmation in the wallet. */
export async function withdraw(account: Address, vault: Address, shares: bigint, step: (text: string) => void): Promise<`0x${string}`> {
  const provider = need();
  await switchToArc(provider);
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: custom(provider) });
  step("Confirm the withdrawal in your wallet");
  const { request } = await reader.simulateContract({ account, address: vault, abi: promoVaultAbi, functionName: "withdraw", args: [shares] });
  const hash = await wallet.writeContract(request);
  step("Waiting for the withdrawal");
  return sent(hash);
}
