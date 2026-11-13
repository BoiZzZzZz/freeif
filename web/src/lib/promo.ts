// A promo in words: its title, the customer's card state, and the one sentence that tells a merchant
// what is going on (prep/WIREFRAMES.md sections 6, 8 and 9.1).
import type { CardState } from "@/components/receipt-card";
import { capitalize, timeOf, usd, type Amount } from "./format";
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

/**
 * A promo that pays the business itself (hedge mode): "$250.00 to Tony's Pizza if the high in Austin on
 * November 14 is 66°F or below". The pages call it a cover.
 */
export function coverTitle(amount: Amount, business: string | null | undefined, condition: string | null | undefined): string {
  return `${usd(amount)} to ${business?.trim() || "your business"} if ${condition ?? "it happens"}`;
}

/** A promo's headline: what is free for its customers, or what the business gets. */
export const titleOf = (p: Pick<Promo, "hedgeMode" | "item" | "business" | "condition" | "payoutPerClaim">): string =>
  p.hedgeMode ? coverTitle(p.payoutPerClaim, p.business, p.condition) : promoTitle(p.item, p.condition);

const won = (p: Promo): string => (p.subject ? `${capitalize(p.subject)} won.` : "It happened.");
const lost = (p: Promo): string => (p.subject ? `${capitalize(p.subject)} lost.` : "It didn't happen.");
const customers = (n: number): string => `${n} customer${n === 1 ? "" : "s"}`;
const cardCount = (n: number): string => `${n} card${n === 1 ? "" : "s"}`;
/** Who a promo pays: its customers, or on a card promo, its cards. */
const payees = (p: Pick<Promo, "cards">, n: number): string => (p.cards ? cardCount(n) : customers(n));

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
  if (p.hedgeMode) return coverStatus(p, merchant);
  const paid = usd(p.premiumPaid);
  const each = usd(p.payoutPerClaim);
  const total = usd(BigInt(p.payoutPerClaim) * BigInt(p.claimCount));
  const youPaid = merchant ? `You paid ${paid}` : `The shop paid ${paid}`;
  const nobody = p.cards ? "No cards were made ready" : "Nobody was covered";
  switch (p.status) {
    case "Open":
      if (now < p.claimDeadline) {
        return {
          badge: "OPEN",
          tone: "go",
          sentence: p.cards
            ? `${p.claimCount} of ${cardCount(p.maxClaims)} ready. Each is worth ${each} if ${p.condition ?? "it happens"}.`
            : `${p.claimCount} of ${customers(p.maxClaims)} covered. Stops accepting at ${timeOf(p.claimDeadline)}.`,
        };
      }
      return {
        badge: "GAME ON",
        tone: "go",
        sentence: `${payees(p, p.claimCount)} ${p.cards ? "in play" : "covered"}. Nothing to do until the result is in.`,
      };
    case "Settled":
      return {
        badge: "CONFIRMING",
        tone: "plain",
        sentence: p.outcomeYes
          ? `${won(p)} ${p.claimCount > 0 ? `Paying ${payees(p, p.claimCount)} shortly.` : `${nobody}, so nobody is owed anything.`}`
          : `${lost(p)} Confirming the result.`,
      };
    case "FinalizedYes":
      return { badge: "PAYING", tone: "go", sentence: `${won(p)} Paying ${payees(p, p.claimCount)} ${each} each.` };
    case "PaidOut":
      return {
        badge: "✓ DONE",
        tone: "go",
        sentence:
          p.claimCount > 0
            ? `${won(p)} ${payees(p, p.claimCount)} ${p.claimCount === 1 ? "was" : "were"} paid ${total}.${p.cards ? " Card holders scan their card to collect." : ""} ${youPaid} and nothing more.`
            : `${won(p)} ${nobody}, so nobody was owed anything. ${youPaid}.`,
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

/** The same for a cover: one payout, to the business itself, and nobody to wait for at the counter. */
function coverStatus(p: Promo, merchant: boolean): StatusLine {
  const amount = usd(p.payoutPerClaim);
  const paid = usd(p.premiumPaid);
  const who = merchant ? "you" : (p.business ?? "the business");
  const youPaid = merchant ? `You paid ${paid}` : `${capitalize(who)} paid ${paid}`;
  switch (p.status) {
    case "Open":
      return {
        badge: "COVERED",
        tone: "go",
        sentence: `If ${p.condition ?? "it happens"}, ${who} ${merchant ? "get" : "gets"} ${amount}. Nothing to do until the result is in.`,
      };
    case "Settled":
      return {
        badge: "CONFIRMING",
        tone: "plain",
        sentence: p.outcomeYes ? `It happened. Paying ${who} ${amount} shortly.` : "It didn't happen. Confirming the result.",
      };
    case "FinalizedYes":
      return { badge: "PAYING", tone: "go", sentence: `It happened. Paying ${who} ${amount}.` };
    case "PaidOut":
      return {
        badge: "✓ PAID",
        tone: "go",
        sentence: `It happened. ${capitalize(who)} ${merchant ? "were" : "was"} paid ${amount}. ${youPaid} and nothing more.`,
      };
    case "FinalizedNo":
      return { badge: "OVER", tone: "grey", sentence: `It didn't happen. Nothing is owed. ${youPaid}.` };
    case "Vetoed":
      return { badge: "UNDER REVIEW", tone: "plain", sentence: "The result is being checked. Nothing to do." };
    case "Voided":
      return { badge: "CANCELLED", tone: "grey", sentence: merchant ? `This was cancelled. Your ${paid} was refunded.` : "This was cancelled." };
  }
}

/** One step of the promo's timeline. `at` is null for a step that has not happened yet. */
export type TimelineStep = { label: string; at: number | null; paid?: boolean };

/**
 * The promo's life in three steps, each with its real time (prep/WIREFRAMES.md section 9.1): it started,
 * the result came in, the customers were paid. Null until there is a result: before that the page shows
 * the counter code in this place.
 */
export function timeline(p: Promo, merchant: boolean): TimelineStep[] | null {
  if (p.status === "Open") return null;
  const when = (name: FeedEvent["event"]): number | null => p.events.findLast((e) => e.event === name)?.at ?? null;
  const started: TimelineStep = {
    label: p.hedgeMode ? "Cover started" : "Promo started",
    at: p.events.find((e) => e.event === "PromoCreated")?.at ?? null,
  };

  if (p.status === "Voided") {
    const at = when("Voided");
    return [
      started,
      { label: p.hedgeMode ? "Cancelled" : "Game cancelled", at },
      { label: merchant ? `Your ${usd(p.premiumPaid)} was refunded` : `The ${p.hedgeMode ? "business" : "shop"} was refunded`, at },
    ];
  }

  const what = p.outcomeYes ? won(p) : lost(p);
  const result: TimelineStep = {
    label: p.status === "Vetoed" ? "The result is being checked" : `Result: ${what[0]!.toLowerCase()}${what.slice(1, -1)}`,
    at: p.status === "Vetoed" ? null : p.settledAt || when("Settled"),
  };
  const confirmed = when("Finalized");
  let last: TimelineStep;
  if (p.status === "Vetoed") {
    last = { label: p.hedgeMode ? "Paid" : p.cards ? "Cards paid" : "Customers paid", at: null };
  } else if (!p.outcomeYes) {
    // A "no": the last step is the result becoming final.
    const at = p.status === "FinalizedNo" ? confirmed : null;
    last = { label: at === null ? "Confirming the result" : `Result confirmed. ${p.hedgeMode ? "Nothing is owed." : "Nobody is owed anything."}`, at };
  } else if (p.hedgeMode) {
    // A cover: the one payout goes to the business itself.
    const at = p.status === "PaidOut" ? (when("Paid") ?? confirmed) : null;
    const who = merchant ? "You" : (p.business ?? "The business");
    const verb = at === null ? (merchant ? "get" : "gets") : merchant ? "were paid" : "was paid";
    last = { label: `${who} ${verb} ${usd(p.payoutPerClaim)}`, at, paid: true };
  } else if (p.claimCount === 0) {
    const at = p.status === "PaidOut" ? confirmed : null;
    last = { label: at === null ? "Confirming the result" : `${p.cards ? "No cards were made ready" : "Nobody was covered"}, so nobody is owed anything`, at };
  } else {
    const at = p.status === "PaidOut" ? (when("Paid") ?? confirmed) : null;
    last = { label: `${payees(p, p.claimCount)} ${at === null ? (p.claimCount === 1 ? "gets" : "get") : "paid"} ${usd(p.payoutPerClaim)}${p.claimCount === 1 ? "" : " each"}`, at, paid: true };
  }
  return [started, result, last];
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
    if (p.cards) return place === undefined ? "A card" : `Card ${place}`;
    return place === undefined ? "A customer" : `Customer ${place}`;
  };
  const describe = (e: FeedEvent): string | null => {
    switch (e.event) {
      case "PromoCreated":
        return `${p.hedgeMode ? "Cover" : "Promo"} started. ${merchant ? "You" : p.hedgeMode ? "The business" : "The shop"} paid ${usd(e.amount)}.`;
      case "ClaimRegistered":
        // A cover registers the business itself in the transaction that starts it: not a line of its own.
        return p.hedgeMode ? null : `${who(e)} ${p.cards ? "ready" : "covered"}`;
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
        return `${p.hedgeMode ? "Cancelled" : "Game cancelled"}. ${usd(e.amount)} refunded.`;
      case "Paid":
        return p.hedgeMode ? `${merchant ? "You were" : "The business was"} paid ${usd(e.amount)}` : `${who(e)} paid ${usd(e.amount)}`;
      case "PayoutFailed":
        return p.hedgeMode ? `${usd(e.amount)} is waiting. We'll send it again.` : `${who(e)}'s ${usd(e.amount)} is waiting. We'll send it again.`;
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
