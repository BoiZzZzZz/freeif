// Kalshi's public market data, read without a key. The server reads it because Kalshi's API refuses a
// browser on our origin (a request with `Origin: https://freeif.app` gets 403; checked Nov 25 2026).
//
// Three reads make a league's game list: the teams, the schedule (Kalshi's "milestones": when each game
// starts and who is at home), and the open game events with their two markets, one per team. A market
// says nothing about when its game starts, so the schedule is needed.
//
// A team's nickname is in one place or the other, by league: the schedule calls a football game
// "CHI Bears at DET Lions" and a hockey game "Calgary at Pittsburgh", while the team list has "CGY Flames"
// for hockey and only "Detroit" for football. Basketball has it in both.
import type { Book, Level } from "@/lib/plan";
import { kept } from "./kept";

const API = "https://api.elections.kalshi.com/trade-api/v2";

export type KalshiLeague = { key: string; name: string; series: string; competition: string; teamType: string };

export const LEAGUES: KalshiLeague[] = [
  { key: "nba", name: "Pro Basketball", series: "KXNBAGAME", competition: "NBA", teamType: "basketball_team" },
  { key: "nhl", name: "Pro Hockey", series: "KXNHLGAME", competition: "NHL", teamType: "hockey_team" },
  { key: "nfl", name: "Pro Football", series: "KXNFLGAME", competition: "NFL", teamType: "football_team" },
];

export const leagueOf = (ticker: string): KalshiLeague | null => LEAGUES.find((l) => ticker.startsWith(`${l.series}-`)) ?? null;

/** Kalshi's general taker rate: fee = 0.07 x contracts x price x (1 - price). A series can scale it. */
const GENERAL_TAKER = 0.07;

/** Kalshi answered, and not with what was asked for. `status` 404 is a market or game it does not have. */
export class KalshiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function read<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(12_000), cache: "no-store" });
  if (!res.ok) throw new KalshiError(res.status, `Kalshi ${res.status} for ${path.split("?")[0]}`);
  return (await res.json()) as T;
}

type Target = { id: string; name: string };

/** "NY Knicks" -> "Knicks": Kalshi writes a team as a short code in capitals, then its nickname. */
export const nicknameOf = (name: string): string | null => /^[A-Z]{2,4} (\S.*)$/.exec(name.trim())?.[1] ?? null;

/** Team id -> nickname, for the teams Kalshi's team list gives one. */
const teams = (league: KalshiLeague) =>
  kept(`kalshi teams ${league.key}`, 24 * 3600_000, async () => {
    const body = await read<{ structured_targets?: Target[] }>(
      `/structured_targets?type=${league.teamType}&competition=${league.competition}&page_size=200`,
    );
    const names = new Map<string, string>();
    for (const t of body.structured_targets ?? []) {
      const nickname = nicknameOf(t.name);
      if (nickname) names.set(t.id, nickname);
    }
    return names;
  });

/** The taker fee rate for a league's game markets. */
export const kalshiFee = (league: KalshiLeague) =>
  kept(`kalshi fee ${league.key}`, 24 * 3600_000, async () => {
    const body = await read<{ series?: { fee_multiplier?: number } }>(`/series/${league.series}`);
    const multiplier = body.series?.fee_multiplier;
    return GENERAL_TAKER * (typeof multiplier === "number" && multiplier > 0 ? multiplier : 1);
  });

type Milestone = {
  start_date?: string;
  /** "MIA Heat at NY Knicks", or with cities only: "Calgary at Pittsburgh". */
  title?: string;
  details?: { main_game_event_ticker?: string; home_team_id?: string; away_team_id?: string };
  related_event_tickers?: string[];
};
type Slot = { startTime: number; home: string; away: string; names: Map<string, string> };

function slotOf(m: Milestone): Slot | null {
  const startTime = Math.floor(Date.parse(m.start_date ?? "") / 1000);
  const { home_team_id: home, away_team_id: away } = m.details ?? {};
  if (!Number.isFinite(startTime) || !home || !away) return null;
  const names = new Map<string, string>();
  const sides = (m.title ?? "").split(" at ");
  if (sides.length === 2) {
    const [awayName, homeName] = [nicknameOf(sides[0]!), nicknameOf(sides[1]!)];
    if (awayName && homeName) names.set(away, awayName).set(home, homeName);
  }
  return { startTime, home, away, names };
}

/** A team's name for the page: its nickname from the schedule or the team list, or Kalshi's own word. */
const nameOf = (m: Market, slot: Slot | null, names: Map<string, string>): string => {
  const teamId = Object.values(m.custom_strike ?? {})[0] ?? "";
  return slot?.names.get(teamId) ?? names.get(teamId) ?? m.yes_sub_title ?? "";
};

/** Event ticker -> when the game starts and which team is at home, for games from six hours ago on. */
const schedule = (league: KalshiLeague) =>
  kept(`kalshi schedule ${league.key}`, 5 * 60_000, async () => {
    const since = new Date(Date.now() - 6 * 3600_000).toISOString();
    const slots = new Map<string, Slot>();
    let cursor = "";
    for (let page = 0; page < 4; page++) {
      const body = await read<{ milestones?: Milestone[]; cursor?: string }>(
        `/milestones?limit=200&competition=${league.competition}&minimum_start_date=${encodeURIComponent(since)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      for (const m of body.milestones ?? []) {
        const event = m.details?.main_game_event_ticker ?? m.related_event_tickers?.find((t) => t.startsWith(`${league.series}-`));
        const slot = slotOf(m);
        if (event && slot) slots.set(event, slot);
      }
      cursor = body.cursor ?? "";
      if (!cursor) break;
    }
    return slots;
  });

type Market = {
  ticker: string;
  event_ticker: string;
  status: string;
  result?: string;
  yes_sub_title?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  custom_strike?: Record<string, string>;
};
type Event = { event_ticker: string; title: string; markets?: Market[] };

const price = (text: string | undefined): number | null => {
  const n = Number(text);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
};

export type KalshiTeam = { name: string; home: boolean; ticker: string; kalshiName: string; ask: number | null; bid: number | null };
export type KalshiGame = { id: string; kalshiTitle: string; startTime: number; teams: KalshiTeam[] };

function gameOf(event: Event, slot: Slot, names: Map<string, string>): KalshiGame | null {
  const sides: KalshiTeam[] = [];
  for (const m of event.markets ?? []) {
    const teamId = Object.values(m.custom_strike ?? {})[0];
    if (teamId !== slot.home && teamId !== slot.away) return null;
    sides.push({
      name: nameOf(m, slot, names),
      home: teamId === slot.home,
      ticker: m.ticker,
      kalshiName: m.yes_sub_title ?? "",
      ask: m.status === "active" ? price(m.yes_ask_dollars) : null,
      bid: m.status === "active" ? price(m.yes_bid_dollars) : null,
    });
  }
  const away = sides.find((s) => !s.home);
  const home = sides.find((s) => s.home);
  if (sides.length !== 2 || !away || !home || !away.name || !home.name) return null;
  return { id: event.event_ticker, kalshiTitle: event.title, startTime: slot.startTime, teams: [away, home] };
}

/** A league's open games on Kalshi, soonest first. Games with no schedule entry are left out. */
export const kalshiGames = (league: KalshiLeague) =>
  kept(`kalshi games ${league.key}`, 20_000, async () => {
    const [names, slots, body] = await Promise.all([
      teams(league),
      schedule(league),
      read<{ events?: Event[] }>(`/events?series_ticker=${league.series}&status=open&with_nested_markets=true&limit=200`),
    ]);
    const games: KalshiGame[] = [];
    for (const event of body.events ?? []) {
      const slot = slots.get(event.event_ticker);
      const game = slot ? gameOf(event, slot, names) : null;
      if (game) games.push(game);
    }
    return games.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  });

type Orderbook = { orderbook_fp?: { yes_dollars?: [string, string][]; no_dollars?: [string, string][] } };

/**
 * One team's book. Kalshi lists bids only, on "yes" and on "no", each from the lowest price up. An offer
 * to sell "yes" at 61 cents is a bid for "no" at 39, so the offers are the "no" bids turned around.
 */
export function kalshiBookOf(body: Orderbook): Book {
  const yes = body.orderbook_fp?.yes_dollars ?? [];
  const no = body.orderbook_fp?.no_dollars ?? [];
  const asks: Level[] = [];
  for (let i = no.length - 1; i >= 0; i--) {
    const [p, size] = [Number(no[i]![0]), Number(no[i]![1])];
    if (p > 0 && p < 1 && size > 0) asks.push({ price: Math.round((1 - p) * 10_000) / 10_000, size });
  }
  return { bid: price(yes[yes.length - 1]?.[0]), asks };
}

export const kalshiBook = (ticker: string) =>
  kept(`kalshi book ${ticker}`, 3_000, async () => kalshiBookOf(await read<Orderbook>(`/markets/${ticker}/orderbook?depth=60`)));

export type KalshiResult = { team: string; game: string; startTime: number | null; final: boolean; won: boolean };

/** One team's market by its ticker, for a voucher: the words, and the result once Kalshi has one. */
export const kalshiResult = (ticker: string, league: KalshiLeague) =>
  kept(`kalshi result ${ticker}`, 20_000, async (): Promise<KalshiResult> => {
    const eventTicker = ticker.slice(0, ticker.lastIndexOf("-"));
    const [names, body, slot] = await Promise.all([
      teams(league).catch(() => new Map<string, string>()),
      read<{ event?: Event; markets?: Market[] }>(`/events/${eventTicker}?with_nested_markets=true`),
      kept(`kalshi slot ${eventTicker}`, 10 * 60_000, async () => {
        const found = await read<{ milestones?: Milestone[] }>(`/milestones?limit=5&related_event_ticker=${eventTicker}`);
        return (found.milestones ?? []).map(slotOf).find((s) => s !== null) ?? null;
      }).catch(() => null),
    ]);
    const markets = body.event?.markets ?? body.markets ?? [];
    const mine = markets.find((m) => m.ticker === ticker);
    if (!mine) throw new KalshiError(404, `Kalshi has no market ${ticker}`);
    const other = markets.find((m) => m.ticker !== ticker);
    const iAmHome = slot !== null && Object.values(mine.custom_strike ?? {})[0] === slot.home;
    const [away, home] = iAmHome ? [other, mine] : [mine, other];
    const game = slot && away && home ? `${nameOf(away, slot, names)} at ${nameOf(home, slot, names)}` : (body.event?.title ?? "");
    const result = mine.result ?? "";
    return { team: nameOf(mine, slot, names), game, startTime: slot?.startTime ?? null, final: result === "yes" || result === "no", won: result === "yes" };
  });
