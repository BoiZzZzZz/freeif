// Circle's user-controlled wallets API, for the one question the keeper asks it: whose login is this?
// A customer logs in by email in the web app and gets a user token, good for 60 minutes. The claim
// carries that token; with the API key, Circle says which user it belongs to and which wallets are theirs.
import { getAddress, isAddress, type Address } from "viem";

const BASE = "https://api.circle.com/v1/w3s";

/** The Circle user behind a token, and that user's wallets on Arc. */
export type CircleUser = { userId: string; wallets: Address[] };

/** Null when the token is expired or not valid. Throws when Circle could not be asked. */
export type Identify = (userToken: string) => Promise<CircleUser | null>;

type Reply<T> = { status: number; code?: number; message?: string; data?: T };
type UserData = { id?: string; user?: { id?: string } };
type WalletsData = { wallets?: { address?: string; blockchain?: string }[] };

// Circle's codes for a user token that is missing, expired or not valid. Seen in the spike: a token
// with its last characters changed gets 403 with 155105.
const LOGIN_CODES = new Set([155103, 155104, 155105]);

export function makeIdentify(apiKey: string, fetcher: typeof fetch = fetch): Identify {
  async function get<T>(path: string, userToken: string): Promise<Reply<T>> {
    const res = await fetcher(BASE + path, {
      headers: { Authorization: `Bearer ${apiKey}`, "X-User-Token": userToken },
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as Omit<Reply<T>, "status">;
    return { ...json, status: res.status };
  }

  return async (userToken) => {
    const [user, wallets] = await Promise.all([
      get<UserData>("/user", userToken),
      get<WalletsData>("/wallets", userToken),
    ]);
    for (const reply of [user, wallets]) {
      if (reply.code !== undefined && LOGIN_CODES.has(reply.code)) return null;
      // Anything else that is not a 200 is about us (the API key, Circle being down), not the customer.
      if (reply.status !== 200) throw new Error(`Circle answered ${reply.status}, code ${reply.code ?? "none"}: ${reply.message ?? ""}`);
    }
    const userId = user.data?.id ?? user.data?.user?.id;
    if (typeof userId !== "string" || userId === "") throw new Error("Circle's answer has no user id");
    return {
      userId,
      // Circle returns addresses in lower case.
      wallets: (wallets.data?.wallets ?? [])
        .filter((w) => w.blockchain === "ARC-TESTNET" && typeof w.address === "string" && isAddress(w.address))
        .map((w) => getAddress(w.address!)),
    };
  };
}
