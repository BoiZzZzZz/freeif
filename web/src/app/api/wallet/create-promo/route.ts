// Paying for a promo, step 2: a challenge to send `createPromoWithPermit` from the merchant's wallet.
// The call is built here from the keeper's signed quote and the permit the wallet just signed, always
// to the vault, and simulated first: a call that would revert is never sent.
import { randomUUID } from "node:crypto";
import { isHex } from "viem";
import { circle, requireLogin, requireWallet } from "@/lib/server/circle";
import { NOT_CHARGED, post, Refusal, text } from "@/lib/server/http";
import { promoCall } from "@/lib/server/promo-call";
import type { QuoteJson } from "@/lib/keeper";

export const POST = post(async (body) => {
  const userToken = text(body, "userToken");
  const signature = text(body, "signature");
  const permitSignature = text(body, "permitSignature");
  const permitDeadline = Number(body.permitDeadline);
  const quote = body.quote as QuoteJson | undefined;
  if (!quote || typeof quote !== "object" || !isHex(signature) || !isHex(permitSignature) || !Number.isInteger(permitDeadline)) {
    throw new Refusal(400, "bad-request", "The request was not understood.");
  }
  const wallet = await requireWallet(userToken, text(body, "walletId"));
  if (wallet.address.toLowerCase() !== String(quote.merchant).toLowerCase()) {
    throw new Refusal(400, "bad-request", "This price was made for another account.");
  }

  const { vault, callData } = await promoCall(wallet.address, quote, signature, permitSignature, permitDeadline);

  // Circle estimates the gas; the wallet pays it, about one cent.
  const reply = await circle<{ challengeId: string }>("POST", "/user/transactions/contractExecution", {
    userToken,
    body: { idempotencyKey: randomUUID(), walletId: wallet.id, contractAddress: vault, callData, feeLevel: "MEDIUM" },
  });
  requireLogin(reply);
  if (!reply.data?.challengeId) {
    console.error("[create-promo]", reply.status, reply.code, reply.message);
    throw new Refusal(502, "failed", NOT_CHARGED);
  }
  return { challengeId: reply.data.challengeId };
});
