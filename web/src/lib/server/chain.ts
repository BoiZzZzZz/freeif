// Arc testnet from the server: the reads behind a permit and the check before a promo is sent.
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { arcTestnet, KEEPER_URL, RPC_URL } from "../config";

export const chain = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL, { timeout: 15_000 }) });

export const usdcAbi = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function nonces(address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

let held: { at: number; address: Address } | null = null;

/**
 * The vault's address, as the keeper reports it. The keeper is the one place that names the vault, so
 * a new deploy needs no change here. Held for five minutes.
 */
export async function vaultAddress(): Promise<Address> {
  if (held && Date.now() - held.at < 300_000) return held.address;
  const res = await fetch(`${KEEPER_URL}/health`, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
  if (!res.ok) throw new Error(`The keeper's /health answered ${res.status}`);
  const { vault } = (await res.json()) as { vault: Address };
  held = { at: Date.now(), address: vault };
  return vault;
}
