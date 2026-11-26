// Polymarket US's public market data (gateway.polymarket.us), read without a key, to show the same order's
// price beside Kalshi's. It lists one market per game: the away team is its "long" side and the home team
// its "short" side, so buying the home team is selling the away team, at one dollar less its price.
import type { Book, Level, PolymarketSide } from "@/lib/plan";
import { kept } from "./kept";

const API = "https://gateway.polymarket.us";

/** The app's taker rate for an account with under $10,000 of volume in 30 days (its fee page, Nov 2026). */
const APP_TAKER = 0.11;

async function read<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(12_000), cache: "no-store" });
  if (!res.ok) throw new Error(`Polymarket US ${res.status} for ${path.split("?")[0]}`);
  return (await res.json()) as T;
}

type Side = { description?: string; long?: boolean; tradable?: boolean; team?: { ordering?: string } };
type Market = { slug: string; sportsMarketType?: string; active?: boolean; closed?: boolean; feeCoefficient?: number; marketSides?: Side[] };
type Event = { slug?: string; startTime?: string; live?: boolean; ended?: boolean; markets?: Market[] };

export type PolymarketGame = {
  startTime: number;
  /** The game-winner market, and the event it belongs to (the game's page on the site). */
  slug: string;
  event: string;
  fee: number;
  /** The two teams' nicknames in lower case, letters and digits only, and which is the long side. */
  away: { name: string; long: boolean };
  home: { name: string; long: boolean };
};

export const plain = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A league's games that have not started, each with its game-winner market. */
export const polymarketGames = (league: string) =>
  kept(`polymarket games ${league}`, 30_000, async () => {
    const body = await read<{ events?: Event[] }>(`/v2/leagues/${league}/events?limit=100`);
    const games: PolymarketGame[] = [];
    for (const event of body.events ?? []) {
      if (event.live || event.ended) continue;
      const startTime = Math.floor(Date.parse(event.startTime ?? "") / 1000);
      const market = (event.markets ?? []).find((m) => (m.sportsMarketType ?? "").endsWith("_team_full_game_winner") && m.active && !m.closed);
      const sides = market?.marketSides ?? [];
      const away = sides.find((s) => s.team?.ordering === "away");
      const home = sides.find((s) => s.team?.ordering === "home");
      if (!market || !Number.isFinite(startTime) || sides.length !== 2 || !away?.description || !home?.description) continue;
      if (away.tradable === false || home.tradable === false || away.long === home.long) continue;
      games.push({
        startTime,
        slug: market.slug,
        event: event.slug ?? market.slug.replace(/^aec-/, ""),
        fee: typeof market.feeCoefficient === "number" && market.feeCoefficient > 0 ? market.feeCoefficient : APP_TAKER,
        away: { name: plain(away.description), long: away.long === true },
        home: { name: plain(home.description), long: home.long === true },
      });
    }
    return games;
  });

/** The same game on Polymarket US: it starts at the same minute and both nicknames are the same. */
export function matchGame(games: PolymarketGame[], startTime: number, away: string, home: string): PolymarketGame | null {
  const found = games.filter((g) => Math.abs(g.startTime - startTime) <= 60 && g.away.name === plain(away) && g.home.name === plain(home));
  return found.length === 1 ? found[0]! : null;
}

type Quote = { px?: { value?: string }; qty?: string };
type BookBody = { marketData?: { bids?: Quote[]; offers?: Quote[] } };

const levels = (quotes: Quote[] | undefined): Level[] =>
  (quotes ?? [])
    .map((q) => ({ price: Number(q.px?.value), size: Number(q.qty) }))
    .filter((l) => l.price > 0 && l.price < 1 && l.size > 0);

/** One side's book. The short side buys from the bids: a bid of 39 cents is an offer of 61 for the other team. */
export function polymarketBookOf(body: BookBody, long: boolean): Book {
  const bids = levels(body.marketData?.bids).sort((a, b) => b.price - a.price);
  const offers = levels(body.marketData?.offers).sort((a, b) => a.price - b.price);
  if (long) return { bid: bids[0]?.price ?? null, asks: offers };
  const flip = (l: Level): Level => ({ price: Math.round((1 - l.price) * 10_000) / 10_000, size: l.size });
  return { bid: offers[0] ? flip(offers[0]).price : null, asks: bids.map(flip) };
}

export const polymarketBook = (side: Pick<PolymarketSide, "slug" | "long">) =>
  kept(`polymarket book ${side.slug} ${side.long}`, 3_000, async () =>
    polymarketBookOf(await read<BookBody>(`/v1/markets/${side.slug}/book`), side.long),
  );

/** The taker rate the market itself reports, or the app's standard one. */
export async function polymarketFee(league: string, slug: string): Promise<number> {
  const games = await polymarketGames(league).catch(() => [] as PolymarketGame[]);
  return games.find((g) => g.slug === slug)?.fee ?? APP_TAKER;
}
