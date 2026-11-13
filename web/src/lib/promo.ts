// A promo in words: its title, the customer's card state, and the one sentence that tells a merchant
// what is going on (prep/WIREFRAMES.md sections 6, 8 and 9.1).
import type { CardState } from "@/components/receipt-card";
import { capitalize, timeOf, usd } from "./format";
import type { FeedEvent, Promo } from "./keeper";

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

/** One line of the promo page's feed. */
export type FeedLine = {
  id: string;
  /** The block's time, unix seconds. */
  at: number;
  text: string;
  /** The transaction's hash. */
  hash: string;
  /** How the event reached the keeper: the QuickNode Stream's delivery, or the keeper's read of the chain. */
  via: "stream" | "rpc";
  /** How long after the block the keeper had it. Null for an event read back later. */
  lagMs: number | null;
};

/** The feed, newest first: one line for each event on the promo (prep/WIREFRAMES.md section 9.2). */
export function feedLines(p: Promo, merchant: boolean): FeedLine[] {
  // A customer is a number on this page, never an address: their place in line.
  const places = new Map<string, number>();
  for (const e of p.events) {
    if (e.event === "ClaimRegistered" && e.customer) places.set(e.customer.toLowerCase(), e.claimCount ?? places.size + 1);
  }
  const who = (e: FeedEvent): string => {
    const place = e.customer ? places.get(e.customer.toLowerCase()) : undefined;
    return place === undefined ? "A customer" : `Customer ${place}`;
  };
  const describe = (e: FeedEvent): string | null => {
    switch (e.event) {
      case "PromoCreated":
        return `Promo started. ${merchant ? "You" : "The shop"} paid ${usd(e.amount)}.`;
      case "ClaimRegistered":
        return `${who(e)} covered`;
      case "Settled": {
        // "Result: the Lions won".
        const what = e.outcomeYes ? won(p) : lost(p);
        return `Result: ${what[0]!.toLowerCase()}${what.slice(1, -1)}`;
      }
      case "Vetoed":
        return "The result is being checked";
      case "SettlementReset":
        return "The result was taken back. Waiting for it again.";
      case "Finalized":
        return "Result confirmed";
      case "Voided":
        return `Game cancelled. ${usd(e.amount)} refunded.`;
      case "Paid":
        return `${who(e)} paid ${usd(e.amount)}`;
      case "PayoutFailed":
        return `${who(e)}'s ${usd(e.amount)} is waiting. We'll send it again.`;
      default:
        return null;
    }
  };

  const lines: FeedLine[] = [];
  for (const e of p.events) {
    const text = describe(e);
    if (text === null) continue;
    const lag = e.seenAt - e.at * 1000;
    lines.push({ id: e.id, at: e.at, text, hash: e.hash, via: e.via, lagMs: lag < 60_000 ? Math.max(lag, 0) : null });
  }
  return lines.reverse();
}
