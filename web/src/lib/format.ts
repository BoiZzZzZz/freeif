// Money, chances and times as people read them. Amounts are USDC base units (6 decimals), as the
// keeper sends them; times are unix seconds, shown in the reader's own time zone.

export type Amount = string | bigint | null | undefined;

/** 39310000 -> "$39.31". Thousands are grouped: "$1,638.00". */
export function usd(base: Amount): string {
  if (base === null || base === undefined) return "$0.00";
  const units = BigInt(base);
  const cents = (units + 5_000n) / 10_000n;
  const dollars = (cents / 100n).toLocaleString("en-US");
  return `$${dollars}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** What someone typed as a price ("8", "8.5", "$8.00") in base units, or null when it is not a price. */
export function parseDollars(text: string): bigint | null {
  const match = /^\$?\s*(\d{1,6})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const units = BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(2, "0")) * 10_000n;
  return units > 0n ? units : null;
}

/** 0.39 -> "39%". */
export const pct = (chance: number): string => `${Math.round(chance * 100)}%`;

const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** "7:15 PM". */
export const timeOf = (unix: number): string => clock.format(new Date(unix * 1000));

/** "Tue 7:15 PM". */
export const dayTime = (unix: number): string => `${weekday.format(new Date(unix * 1000))} ${timeOf(unix)}`;

/** The heading a game is listed under: "Today", "Tonight", "Tomorrow", or "Sun, Nov 15". */
export function dayHeading(unix: number, now = Date.now()): string {
  const date = new Date(unix * 1000);
  const days = Math.round((startOfDay(date) - startOfDay(new Date(now))) / 86_400_000);
  if (days === 0) return date.getHours() >= 17 ? "Tonight" : "Today";
  if (days === 1) return "Tomorrow";
  return `${weekday.format(date)}, ${monthDay.format(date)}`;
}

const startOfDay = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "the Lions" -> "The Lions". */
export const capitalize = (text: string): string => (text === "" ? "" : text[0]!.toUpperCase() + text.slice(1));

/** 0x49aa…8937, for the few places an address is shown. */
export const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;
