// What a balance pays for. The form uses it to size a promo before Pay, and the Pay sheet when a balance
// turns out short. The cost grows about in step with the size, so the balance's share of the cost is the
// size that fits.
import { FEE_BUFFER } from "./config";

const DOLLAR = 1_000_000n;
const CENT = 10_000n;

/**
 * What of `funds` can go to a cost: the account keeps its network fee, and a cent is held back because a
 * smaller price is rounded up to a cent too.
 */
export const spendable = (funds: bigint): bigint => (funds > FEE_BUFFER + CENT ? funds - FEE_BUFFER - CENT : 0n);

/** True when `funds` do not pay `cost` and the network fee. */
export const isShort = (funds: bigint, cost: bigint): boolean => funds < cost + FEE_BUFFER;

/**
 * How many customers `funds` pay for, when `count` customers cost `cost`. For a balance that is short it
 * is always below `count`, so taking it can never land on the same size again. 0 when not even one fits.
 */
export function customersFor(funds: bigint, cost: bigint, count: number): number {
  if (cost <= 0n || count < 1) return 0;
  const fits = Number((spendable(funds) * BigInt(count)) / cost);
  return Math.max(Math.min(fits, count - 1), 0);
}

/**
 * How much cover `funds` pay for, in whole dollars (base units), when `payout` costs `cost`. Below
 * `payout` for a balance that is short; 0 when not even a dollar fits.
 */
export function amountFor(funds: bigint, cost: bigint, payout: bigint): bigint {
  if (cost <= 0n || payout <= 0n) return 0n;
  let amount = ((spendable(funds) * payout) / cost / DOLLAR) * DOLLAR;
  if (amount >= payout) amount = ((payout - 1n) / DOLLAR) * DOLLAR;
  return amount > 0n ? amount : 0n;
}
