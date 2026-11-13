// Paying for a promo, step 3: where the transaction is. The browser asks every second or two after the
// merchant approves it. One look per request, so nothing here waits in a loop.
import { parseEventLogs, type Hex } from "viem";
import { promoVaultAbi } from "@/lib/abi";
import { circle, requireLogin } from "@/lib/server/circle";
import { chain } from "@/lib/server/chain";
import { NOT_CHARGED, post, text } from "@/lib/server/http";

type Challenge = { challenge?: { correlationIds?: string[]; status?: string } };
type Transaction = { transaction?: { state?: string; txHash?: Hex; errorReason?: string } };

const FAILED = new Set(["FAILED", "CANCELLED", "DENIED"]);

export const POST = post(async (body) => {
  const userToken = text(body, "userToken");
  const challengeId = text(body, "challengeId");

  const challenge = await circle<Challenge>("GET", `/user/challenges/${encodeURIComponent(challengeId)}`, { userToken });
  requireLogin(challenge);
  if (challenge.data?.challenge?.status === "FAILED" || challenge.data?.challenge?.status === "EXPIRED") {
    return { state: "failed", message: NOT_CHARGED };
  }
  // The challenge names Circle's transaction once the merchant has approved it.
  const id = challenge.data?.challenge?.correlationIds?.[0];
  if (!id) return { state: "pending" };

  const reply = await circle<Transaction>("GET", `/transactions/${encodeURIComponent(id)}`, { userToken });
  const tx = reply.data?.transaction;
  if (tx?.state && FAILED.has(tx.state)) {
    console.error("[tx]", tx.state, tx.errorReason);
    return { state: "failed", message: NOT_CHARGED };
  }
  if (!tx?.txHash) return { state: "pending" };

  const receipt = await chain.getTransactionReceipt({ hash: tx.txHash }).catch(() => null);
  if (!receipt) return { state: "pending", txHash: tx.txHash };
  if (receipt.status !== "success") return { state: "failed", message: NOT_CHARGED, txHash: tx.txHash };

  const [created] = parseEventLogs({ abi: promoVaultAbi, eventName: "PromoCreated", logs: receipt.logs });
  if (!created) return { state: "failed", message: NOT_CHARGED, txHash: tx.txHash };
  return { state: "done", txHash: tx.txHash, promoId: created.args.promoId.toString() };
});
