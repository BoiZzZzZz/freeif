// Gemini's public prediction-market API. No key is needed for anything in this file.
import { geminiBase } from "./config.ts";

export type GeminiContract = {
  id: string;
  label: string;
  instrumentSymbol: string;
  marketState?: string;
  status?: string;
  expiryDate?: string;
  prices?: { bestBid?: string; bestAsk?: string; lastTradePrice?: string };
  /** Present once Gemini has settled the contract: "yes" or "no". */
  resolutionSide?: string;
  resolvedAt?: string;
  /** Which team of a game this contract is: "home" or "away". */
  sportsSide?: string;
  /** The rule Gemini settles the contract by, as a rich-text document. */
  description?: unknown;
};

export type GeminiParticipant = { name: string; abbreviation?: string; side?: string };

export type GeminiEvent = {
  id: string;
  ticker: string;
  title: string;
  category: string;
  status: string;
  series?: string;
  startTime?: string;
  expiryDate: string;
  resolvedAt?: string;
  contracts: GeminiContract[];
  eventTags?: { slug: string }[];
  /** The two teams of a game, each with its full name and its side. */
  participants?: GeminiParticipant[];
  /** The league, for example `{ name: "Pro Football" }`. */
  subcategory?: { name: string };
};

type Page = { data: GeminiEvent[]; pagination: { limit: number; offset: number; total: number } };

export class GeminiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function get<T>(path: string, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(`${geminiBase()}${path}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new GeminiError(res.status, `Gemini ${res.status} on ${path}`);
  return (await res.json()) as T;
}

/** One event by its full ticker, for example `BTC05M2611130405`. Returns null when Gemini has no such event. */
export async function getEvent(ticker: string): Promise<GeminiEvent | null> {
  try {
    const body = await get<GeminiEvent | { data: GeminiEvent }>(
      `/v1/prediction-markets/events/${encodeURIComponent(ticker)}`,
    );
    return "data" in body ? body.data : body;
  } catch (err) {
    if (err instanceof GeminiError && err.status === 404) return null;
    throw err;
  }
}

export async function listEvents(query: {
  status: "active" | "settled";
  category?: string;
  /** Gemini matches this against tickers and titles; it must be at least three characters. */
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<Page> {
  const params = new URLSearchParams({ status: query.status, limit: String(query.limit ?? 100) });
  if (query.category) params.set("category", query.category);
  if (query.search) params.set("search", query.search);
  if (query.offset) params.set("offset", String(query.offset));
  // A page of 100 sports events can be 12 MB and take several seconds.
  return get<Page>(`/v1/prediction-markets/events?${params}`, 40_000);
}

const INTERVAL_TICKER = /^([A-Z]+)(05|15)M(\d{10})$/;

/** 5 and 15-minute crypto markets. They are the test loop: quotable while the window is running. */
export function isIntervalMarket(event: Pick<GeminiEvent, "ticker">): boolean {
  return INTERVAL_TICKER.test(event.ticker);
}

/**
 * The ticker of an interval market from the time it closes. The ticker carries the close time in UTC:
 * `BTC05M2610250645` closes on 2026-10-25 at 06:45Z.
 */
export function intervalTicker(series: string, closeTime: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    series +
    p(closeTime.getUTCFullYear() % 100) +
    p(closeTime.getUTCMonth() + 1) +
    p(closeTime.getUTCDate()) +
    p(closeTime.getUTCHours()) +
    p(closeTime.getUTCMinutes())
  );
}

/** The next `count` windows of a series such as `BTC05M`, starting with the one that is running now. */
export function upcomingIntervalTickers(series: string, now: Date, count: number): { ticker: string; closeTime: Date }[] {
  const match = /^[A-Z]+(05|15)M$/.exec(series);
  if (!match) throw new Error(`Not an interval series: ${series}`);
  const stepMs = Number(match[1]) * 60_000;
  const firstClose = (Math.floor(now.getTime() / stepMs) + 1) * stepMs;
  return Array.from({ length: count }, (_, i) => {
    const closeTime = new Date(firstClose + i * stepMs);
    return { ticker: intervalTicker(series, closeTime), closeTime };
  });
}

/** A price such as "0.39" in basis points of a dollar (3900). Null when it is missing or not a price. */
export function priceToBps(price: string | undefined): number | null {
  if (price === undefined || !/^\d+(\.\d+)?$/.test(price)) return null;
  const bps = Math.round(Number(price) * 10_000);
  return bps > 0 && bps < 10_000 ? bps : null;
}

export const toUnix = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

/** The plain text of a contract's rule. Gemini sends it as a tree of nodes with the words in `value`. */
export function ruleText(description: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") parts.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === "object") {
      const { value, content } = node as { value?: unknown; content?: unknown };
      if (typeof value === "string") parts.push(value);
      walk(content);
    }
  };
  walk(description);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
