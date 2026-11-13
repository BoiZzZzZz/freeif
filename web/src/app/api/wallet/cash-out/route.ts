// Cash out: a challenge to send part of the account's balance to an address its owner typed. The call
// is built here (`cashOutCall`): always a USDC transfer from the account itself, checked and simulated
// first, so a transfer that would fail is never handed to the wallet.
import { randomUUID } from "node:crypto";
import { cashOutCall, NOT_SENT } from "@/lib/server/cash-out";
import { circle, requireLogin, requireWallet } from "@/lib/server/circle";
import { post, Refusal, text } from "@/lib/server/http";

export const POST = post(async (body) => {
  const userToken = text(body, "userToken");
  const wallet = await requireWallet(userToken, text(body, "walletId"));
  const { token, callData, to } = await cashOutCall(wallet.address, text(body, "to"), text(body, "amount"));

  // Circle estimates the network fee; the account pays it, about one cent.
  const reply = await circle<{ challengeId: string }>("POST", "/user/transactions/contractExecution", {
    userToken,
    body: { idempotencyKey: randomUUID(), walletId: wallet.id, contractAddress: token, callData, feeLevel: "MEDIUM" },
  });
  requireLogin(reply);
  if (!reply.data?.challengeId) {
    console.error("[cash-out]", reply.status, reply.code, reply.message);
    throw new Refusal(502, "failed", NOT_SENT);
  }
  return { challengeId: reply.data.challengeId, to };
});
