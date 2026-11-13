// The two things a promo's card shows that neither the chain nor Gemini knows: what is free ("Wings")
// and the shop's name. The merchant sends them with the quote request; they are kept with the quote
// and tied to the promo the first time that promo is read.
import type { Address, Hex } from "viem";
import type { Quote } from "./chain.ts";

export type Label = { item: string; business: string };

/** A label waiting for its promo, with the quote fields the promo will carry on chain. */
export type PendingLabel = Label & {
  merchant: Address;
  geminiEventId: Hex;
  instrumentSymbol: Hex;
  payoutPerClaim: string;
  maxClaims: number;
  premium: string;
  claimDeadline: number;
  at: number;
};

/** The fields of a promo that came from its quote, as `getPromo` returns them. */
export type PromoKey = {
  merchant: Address;
  geminiEventId: Hex;
  instrumentSymbol: Hex;
  payoutPerClaim: bigint;
  maxClaims: number;
  premiumPaid: bigint;
  claimDeadline: bigint;
};

const MAX_LENGTH = 40;
const MAX_PENDING = 2000;

/** One line of plain text, at most 40 characters. Anything else a request sends becomes "". */
export function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  // Control characters out, runs of spaces to one.
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LENGTH);
}

export function pendingLabel(quote: Quote, label: Label, at: number): PendingLabel {
  return {
    item: label.item,
    business: label.business,
    merchant: quote.merchant,
    geminiEventId: quote.geminiEventId,
    instrumentSymbol: quote.instrumentSymbol,
    payoutPerClaim: quote.payoutPerClaim.toString(),
    maxClaims: quote.maxClaims,
    premium: quote.premium.toString(),
    claimDeadline: Number(quote.claimDeadline),
    at,
  };
}

/**
 * The nonce of the pending label whose quote made this promo, or null. A promo can only exist with
 * these exact values if the pricer signed a quote with them, so a match is the merchant's own label.
 * Two identical quotes from one merchant match the same promo; the newest wins.
 */
export function findLabel(pending: Record<Hex, PendingLabel>, promo: PromoKey): Hex | null {
  let best: Hex | null = null;
  for (const nonce of Object.keys(pending) as Hex[]) {
    const l = pending[nonce]!;
    const same =
      l.merchant.toLowerCase() === promo.merchant.toLowerCase() &&
      l.geminiEventId === promo.geminiEventId &&
      l.instrumentSymbol === promo.instrumentSymbol &&
      l.payoutPerClaim === promo.payoutPerClaim.toString() &&
      l.maxClaims === promo.maxClaims &&
      l.premium === promo.premiumPaid.toString() &&
      l.claimDeadline === Number(promo.claimDeadline);
    if (same && (best === null || l.at >= pending[best]!.at)) best = nonce;
  }
  return best;
}

/** Keeps the newest labels when quotes that were never used pile up. */
export function prunePending(pending: Record<Hex, PendingLabel>): void {
  const nonces = Object.keys(pending) as Hex[];
  if (nonces.length <= MAX_PENDING) return;
  nonces.sort((a, b) => pending[a]!.at - pending[b]!.at);
  for (const nonce of nonces.slice(0, nonces.length - MAX_PENDING)) delete pending[nonce];
}
