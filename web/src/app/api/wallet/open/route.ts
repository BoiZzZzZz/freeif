// Step 2 of a login: the user's wallet on Arc. Returns the wallet when it exists; otherwise a
// challenge that creates it, for the browser to run before it asks again.
import { randomUUID } from "node:crypto";
import { circle, findWallet, requireLogin } from "@/lib/server/circle";
import { post, Refusal, text } from "@/lib/server/http";

// Circle's code for "this user has been set up already": they need a wallet added, not a first one.
const USER_EXISTS = 155106;

export const POST = post(async (body) => {
  const userToken = text(body, "userToken");
  const wallet = await findWallet(userToken);
  if (wallet) return { wallet };
  // While the browser waits for a wallet it has already asked for, it only looks: asking Circle to
  // create one again would make a second wallet.
  if (body.create === false) return { wallet: null };

  // "EOA", not the "SCA" of Circle's tutorial: a permit from a contract wallet is checked another way.
  const create = { idempotencyKey: randomUUID(), accountType: "EOA", blockchains: ["ARC-TESTNET"] };
  let reply = await circle<{ challengeId: string }>("POST", "/user/initialize", { userToken, body: create });
  if (reply.code === USER_EXISTS) {
    reply = await circle<{ challengeId: string }>("POST", "/user/wallets", {
      userToken,
      body: { ...create, idempotencyKey: randomUUID() },
    });
  }
  requireLogin(reply);
  if (!reply.data?.challengeId) {
    console.error("[open]", reply.status, reply.code, reply.message);
    throw new Refusal(502, "no-wallet", "We couldn't set up your account right now. Try again in a moment.");
  }
  return { challengeId: reply.data.challengeId };
});
