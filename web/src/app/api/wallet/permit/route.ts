// Paying for a promo, step 1: a challenge to sign a USDC permit for exactly the promo's cost, with
// the vault as the only spender. The typed data is built here, so this route cannot be used to have a
// wallet sign anything else.
import { circle, requireLogin, requireWallet } from "@/lib/server/circle";
import { NOT_CHARGED, post, Refusal, text } from "@/lib/server/http";
import { permitTypedData } from "@/lib/server/promo-call";

export const POST = post(async (body) => {
  const userToken = text(body, "userToken");
  const value = text(body, "value");
  if (!/^\d{1,15}$/.test(value) || BigInt(value) === 0n) throw new Refusal(400, "bad-request", "value must be an amount.");
  const wallet = await requireWallet(userToken, text(body, "walletId"));

  const { typed, deadline } = await permitTypedData(wallet.address, value);
  const reply = await circle<{ challengeId: string }>("POST", "/user/sign/typedData", {
    userToken,
    // Circle takes the typed data as a JSON string, with `EIP712Domain` listed among the types.
    body: { walletId: wallet.id, data: JSON.stringify(typed), memo: "Payment for a FreeIf promotion" },
  });
  requireLogin(reply);
  if (!reply.data?.challengeId) {
    console.error("[permit]", reply.status, reply.code, reply.message);
    throw new Refusal(502, "failed", NOT_CHARGED);
  }
  return { challengeId: reply.data.challengeId, deadline };
});
