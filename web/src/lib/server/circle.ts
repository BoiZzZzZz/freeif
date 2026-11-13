// Circle's user-controlled wallets API, for the calls that need the API key. Everything a user does
// (creating the wallet, signing, sending) is a "challenge": this server asks Circle for one with the
// user's token, and the browser's SDK runs it. The key never reaches the browser.
import { getAddress, type Address } from "viem";
import { env, Refusal } from "./http";

const BASE = "https://api.circle.com/v1/w3s";

export type CircleReply<T> = { status: number; code?: number; message?: string; data?: T };

export async function circle<T>(
  method: "GET" | "POST",
  path: string,
  options: { userToken?: string; body?: unknown } = {},
): Promise<CircleReply<T>> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env("CIRCLE_API_KEY")}`,
      ...(options.userToken ? { "X-User-Token": options.userToken } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as Omit<CircleReply<T>, "status">;
  return { ...json, status: res.status };
}

// Circle's codes for a user token that is missing, expired or not valid. A token lasts 60 minutes.
const LOGIN_CODES = new Set([155103, 155104, 155105]);

/** Throws the refusal that sends the browser back to the email step when the user's token is no good. */
export function requireLogin(reply: CircleReply<unknown>): void {
  if (reply.status === 401 || reply.status === 403 || (reply.code !== undefined && LOGIN_CODES.has(reply.code))) {
    throw new Refusal(401, "login", "Please log in again.");
  }
}

type CircleWallet = { id: string; address: string; blockchain: string; accountType: string };

export type Wallet = { id: string; address: Address };

/**
 * The user's wallet on Arc, or null when they have none yet. It is an EOA on purpose: Arc's USDC
 * checks a permit from a plain account with `ecrecover`, which is what `createPromoWithPermit` needs.
 */
export async function findWallet(userToken: string): Promise<Wallet | null> {
  const reply = await circle<{ wallets: CircleWallet[] }>("GET", "/wallets", { userToken });
  requireLogin(reply);
  const wallet = reply.data?.wallets?.find((w) => w.blockchain === "ARC-TESTNET" && w.accountType === "EOA");
  // Circle returns the address in lower case.
  return wallet ? { id: wallet.id, address: getAddress(wallet.address) } : null;
}

/** The user's wallet, checked against the id the browser sent. */
export async function requireWallet(userToken: string, walletId: string): Promise<Wallet> {
  const wallet = await findWallet(userToken);
  if (!wallet || wallet.id !== walletId) throw new Refusal(401, "login", "Please log in again.");
  return wallet;
}
