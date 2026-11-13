// A promo in words: its title, the customer's card state, and the one sentence that tells a merchant
// what is going on (prep/WIREFRAMES.md sections 6, 8 and 9.1).
import type { CardState } from "@/components/receipt-card";
import { capitalize, timeOf, usd } from "./format";
import type { Promo } from "./keeper";

/** "Wings are free if the Lions win". Without an item: "Free if the Lions win". */
export function promoTitle(item: string | null | undefined, condition: string | null | undefined): string {
  const what = condition ?? "it happens";
  const name = item?.trim();
  if (!name) return `Free if ${what}`;
  // "Wings are", "Fries are"; "Dessert is", "Glass is".
  const plural = /[^s]s$/i.test(name);
  return `${name} ${plural ? "are" : "is"} free if ${what}`;
}

const won = (p: Promo): string => (p.subject ? `${capitalize(p.subject)} won.` : "It happened.");
const lost = (p: Promo): string => (p.subject ? `${capitalize(p.subject)} lost.` : "It didn't happen.");
const customers = (n: number): string => `${n} customer${n === 1 ? "" : "s"}`;

/** Whether the promo still takes customers: open, before its deadline, with room left. */
export function takingCustomers(p: Promo, now: number): "yes" | "full" | "closed" {
  if (p.status !== "Open" || now >= p.claimDeadline) return "closed";
  return p.claimCount >= p.maxClaims ? "full" : "yes";
}

/** The card a covered customer sees. */
export function coveredState(p: Promo, now: number): CardState {
  switch (p.status) {
    case "Open":
      return now >= p.claimDeadline ? "game-on" : "covered";
    case "Settled":
      return p.outcomeYes ? "won" : "lost";
    case "FinalizedYes":
    case "PaidOut":
      return p.customer?.paid ? "paid" : "won";
    case "FinalizedNo":
      return "lost";
    case "Vetoed":
      return "review";
    case "Voided":
      return "cancelled";
  }
}

export type StatusLine = { badge: string; tone: "go" | "plain" | "grey"; sentence: string };

/** The top block of the promo page. It answers "what do I need to do", and the answer is nothing. */
export function statusLine(p: Promo, now: number, merchant: boolean): StatusLine {
  const paid = usd(p.premiumPaid);
  const each = usd(p.payoutPerClaim);
  const total = usd(BigInt(p.payoutPerClaim) * BigInt(p.claimCount));
  const youPaid = merchant ? `You paid ${paid}` : `The shop paid ${paid}`;
  switch (p.status) {
    case "Open":
      if (now < p.claimDeadline) {
        return {
          badge: "OPEN",
          tone: "go",
          sentence: `${p.claimCount} of ${customers(p.maxClaims)} covered. Stops accepting at ${timeOf(p.claimDeadline)}.`,
        };
      }
      return { badge: "GAME ON", tone: "go", sentence: `${customers(p.claimCount)} covered. Nothing to do until the result is in.` };
    case "Settled":
      return {
        badge: "CONFIRMING",
        tone: "plain",
        sentence: p.outcomeYes
          ? `${won(p)} ${p.claimCount > 0 ? `Paying ${customers(p.claimCount)} shortly.` : "Nobody was covered, so nobody is owed anything."}`
          : `${lost(p)} Confirming the result.`,
      };
    case "FinalizedYes":
      return { badge: "PAYING", tone: "go", sentence: `${won(p)} Paying ${customers(p.claimCount)} ${each} each.` };
    case "PaidOut":
      return {
        badge: "✓ DONE",
        tone: "go",
        sentence:
          p.claimCount > 0
            ? `${won(p)} ${customers(p.claimCount)} ${p.claimCount === 1 ? "was" : "were"} paid ${total}. ${youPaid} and nothing more.`
            : `${won(p)} Nobody was covered, so nobody was owed anything. ${youPaid}.`,
      };
    case "FinalizedNo":
      return { badge: "PROMO OVER", tone: "grey", sentence: `${lost(p)} Nobody is owed anything. ${youPaid}.` };
    case "Vetoed":
      return { badge: "UNDER REVIEW", tone: "plain", sentence: "The result is being checked. Nothing to do." };
    case "Voided":
      return {
        badge: "CANCELLED",
        tone: "grey",
        sentence: merchant ? `The game was cancelled. Your ${paid} was refunded.` : "The game was cancelled. This promo is off.",
      };
  }
}

/** One line of the promo page's feed, newest first. */
export type FeedLine = { at: number; text: string; hash: string };

const ACTIONS: Record<string, (p: Promo, n: number) => string> = {
  registerClaim: (_p, n) => `Customer ${n} covered`,
  // "Result: the Lions won".
  settle: (p) => {
    const what = p.outcomeYes ? won(p) : lost(p);
    return `Result: ${what[0]!.toLowerCase()}${what.slice(1, -1)}`;
  },
  finalize: () => "Result confirmed",
  payoutBatch: (p) => `Customers paid ${usd(p.payoutPerClaim)} each`,
  retryPayout: (p) => `A customer was paid ${usd(p.payoutPerClaim)}`,
};

/** The feed, from the transactions the keeper sent for this promo. */
export function feedLines(p: Promo): FeedLine[] {
  let customer = 0;
  const lines: FeedLine[] = [];
  for (const tx of p.txs) {
    const describe = ACTIONS[tx.action];
    if (!describe) continue;
    if (tx.action === "registerClaim") customer++;
    lines.push({ at: tx.at, text: describe(p, customer), hash: tx.hash });
  }
  return lines.reverse();
}
