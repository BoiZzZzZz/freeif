// The games a merchant can run a promo on: Gemini's active game-winner markets that have not started.
// This is step 1 of the merchant form.
//
// Gemini's event list is heavy: every market of a game (quarters, spreads, totals, player props) is its
// own event, a page of 100 is 3 to 12 MB, and the list for all sports leaves pro football out. So the
// keeper asks league by league with Gemini's `search` filter, keeps only the winner markets, and holds
// each league's list in memory. A list that has gone old is served as it is while a new one is read.
import { eventStart, isDailyHigh, listEvents, priceToBps, toUnix, type GeminiContract, type GeminiEvent } from "./gemini.ts";
import { isMarket } from "./pricing.ts";
import { DAILY_HIGH, displayNames } from "./names.ts";

/** The tabs of the form, in order. `search` is the start of Gemini's tickers for the league. */
export const LEAGUES = [
  { key: "nfl", name: "Pro Football", search: "NFL" },
  { key: "nba", name: "Pro Basketball", search: "NBA" },
  { key: "nhl", name: "Pro Hockey", search: "NHL" },
  { key: "ncaaf", name: "College Football", search: "NCAAF" },
  { key: "ncaam", name: "College Basketball", search: "NCAAM" },
] as const;
/** One list the keeper holds: a league's games, or the temperature markets. */
export type League = { key: string; name: string; search: string; weather?: boolean };

/**
 * Not a tab of the promo form: the list behind "My business gets paid" (hedge mode). Gemini's daily
 * high-temperature markets, one per city and day, about a hundred of them in one page.
 */
export const WEATHER: League = { key: "weather", name: "Weather", search: "WXHIGH", weather: true };

export type GameTeam = {
  instrumentSymbol: string;
  /** "Heat", "Georgia". */
  team: string;
  /** "the Heat win", "Georgia wins": what follows "free if". */
  condition: string;
  /** Gemini's ask as a chance: 0.39 is 39%. Null when there is no ask. */
  chance: number | null;
  /** False when a promo on this team would be refused: no two-sided price, or the result is too likely. */
  quotable: boolean;
};

export type Game = {
  eventTicker: string;
  /** "Cavaliers at Heat", or "Austin high on November 14". */
  game: string;
  /** Unix seconds: kickoff, or the start of a temperature market's day. A promo is sold until then. */
  startTime: number;
  /** A game's two teams, or a temperature market's ranges from the coldest up. */
  teams: GameTeam[];
  /** A temperature market's city and day, as Gemini writes them: "Austin", "November 14". */
  city?: string;
  day?: string;
};

type Page = { data: GeminiEvent[]; pagination: { total: number } };

type Rules = {
  /** The spread the pricing service adds, to leave out results it would refuse as too likely. */
  spreadBps: number;
  /** A game that starts sooner than this is left out: a promo on it would be refused. */
  minLeadSeconds: number;
};

type Deps = Rules & {
  /** How long a league's list is served before Gemini is asked again. */
  ttlMs?: number;
  /** The wait before a page that failed is asked for a second time. */
  retryPauseMs?: number;
  /** Replaceable in tests. */
  fetchPage?: (search: string, offset: number, limit: number) => Promise<Page>;
  now?: () => number;
};

const PAGE = 100;
const MAX_PAGES = 10;
/** Games further ahead than this are not listed. */
const HORIZON_SECONDS = 8 * 86_400;

/** A game's winner market: Gemini's ticker for it ends in `-M`. Spreads, totals and quarters do not. */
export const isGameWinner = (event: Pick<GeminiEvent, "ticker">): boolean => event.ticker.endsWith("-M");

const sideOf = (event: GeminiEvent, team: GameTeam): string | undefined =>
  event.contracts.find((c) => c.instrumentSymbol === team.instrumentSymbol)?.sportsSide;

/** One result as a button of the form: its name, its chance, and whether a promo on it would be priced. */
function teamOf(event: GeminiEvent, c: GeminiContract, rules: Rules): GameTeam {
  const ask = priceToBps(c.prices?.bestAsk);
  const bid = priceToBps(c.prices?.bestBid);
  const open = c.marketState === undefined || c.marketState === "open";
  // The same line as the pricing service's "too likely": the cost would be more than the payout.
  const tooLikely = ask !== null && ask * (10_000 + rules.spreadBps) >= 10_000 * 10_000;
  const names = displayNames(event, c);
  return {
    instrumentSymbol: c.instrumentSymbol,
    team: names.team,
    condition: names.condition,
    chance: ask === null ? null : ask / 10_000,
    // A price with nobody on the other side is not a chance: an empty book shows an ask of 0.02.
    // The same rule as the pricing service: only a book that is a market is offered.
    quotable: open && isMarket(bid, ask) && !tooLikely,
  };
}

/** Turns Gemini's events into the form's list: winner markets only, not started, with a usable price. */
export function toGames(events: GeminiEvent[], nowSeconds: number, rules: Rules): Game[] {
  const games: Game[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (!isGameWinner(event) || event.status !== "active" || !event.startTime || seen.has(event.ticker)) continue;
    seen.add(event.ticker);
    const startTime = toUnix(event.startTime);
    const lead = startTime - nowSeconds;
    if (lead < rules.minLeadSeconds || lead > HORIZON_SECONDS) continue;

    const teams = event.contracts
      .filter((c) => c.sportsSide === "home" || c.sportsSide === "away")
      .map((c) => teamOf(event, c, rules));
    if (teams.length < 2 || !teams.some((t) => t.quotable)) continue;
    // The away team first, as in "Cavaliers at Heat".
    teams.sort((a, b) => Number(sideOf(event, b) === "away") - Number(sideOf(event, a) === "away"));

    const names = displayNames(event, event.contracts.find((c) => c.sportsSide) ?? event.contracts[0]!);
    games.push({ eventTicker: event.ticker, game: names.game, startTime, teams });
  }
  return games.sort((a, b) => a.startTime - b.startTime);
}

/** "66°F or below" -> 66: the ranges of a temperature market are listed from the coldest up. */
const degrees = (label: string): number => Number.parseInt(label, 10) || 0;

/**
 * Turns Gemini's daily temperature events into the same list: one entry per city and day whose day has
 * not begun, each range as a "team". Soonest day first, then by city.
 */
export function toWeather(events: GeminiEvent[], nowSeconds: number, rules: Rules): Game[] {
  const markets: Game[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const start = eventStart(event);
    const title = DAILY_HIGH.exec(event.title);
    if (!isDailyHigh(event) || event.status !== "active" || start === null || !title || seen.has(event.ticker)) continue;
    seen.add(event.ticker);
    const lead = start - nowSeconds;
    if (lead < rules.minLeadSeconds || lead > HORIZON_SECONDS) continue;

    const teams = event.contracts.map((c) => teamOf(event, c, rules)).sort((a, b) => degrees(a.team) - degrees(b.team));
    if (!teams.some((t) => t.quotable)) continue;
    const names = displayNames(event, event.contracts[0]!);
    markets.push({ eventTicker: event.ticker, game: names.game, startTime: start, teams, city: title[1], day: title[2] });
  }
  return markets.sort((a, b) => a.startTime - b.startTime || a.game.localeCompare(b.game));
}

export class Games {
  readonly #d: Deps;
  readonly #cache = new Map<string, { at: number; games: Game[] }>();
  readonly #loading = new Map<string, Promise<void>>();

  constructor(deps: Deps) {
    this.#d = deps;
  }

  #now(): number {
    return this.#d.now ? this.#d.now() : Math.floor(Date.now() / 1000);
  }

  /**
   * One league's games. The first call for a league waits for Gemini; after that the list in memory is
   * returned at once, and read again in the background when it is older than `ttlMs`.
   */
  async list(league: League): Promise<{ league: string; games: Game[]; fetchedAt: number }> {
    const held = this.#cache.get(league.key);
    if (!held) await this.#refresh(league);
    else if (Date.now() - held.at >= (this.#d.ttlMs ?? 120_000)) {
      this.#refresh(league).catch((err) => console.error(`[games] ${league.name}: Gemini did not answer:`, err));
    }
    const { at, games } = this.#cache.get(league.key)!;
    // A game can start while its list is in memory.
    const now = this.#now();
    return {
      league: league.key,
      games: games.filter((g) => g.startTime - now >= this.#d.minLeadSeconds),
      fetchedAt: Math.floor(at / 1000),
    };
  }

  /** Reads every league once, one after the other, so the first visitor does not wait. */
  async prewarm(): Promise<void> {
    for (const league of [...LEAGUES, WEATHER]) {
      try {
        await this.#refresh(league);
      } catch (err) {
        console.error(`[games] ${league.name}: could not read Gemini's list:`, err);
      }
    }
  }

  /** One read per league at a time: callers that arrive while it runs wait for the same one. */
  #refresh(league: League): Promise<void> {
    let run = this.#loading.get(league.key);
    if (!run) {
      run = this.#load(league)
        .then((games) => {
          this.#cache.set(league.key, { at: Date.now(), games });
        })
        .finally(() => this.#loading.delete(league.key));
      this.#loading.set(league.key, run);
    }
    return run;
  }

  /** One page, tried twice. */
  async #page(fetchPage: NonNullable<Deps["fetchPage"]>, search: string, offset: number): Promise<Page> {
    try {
      return await fetchPage(search, offset, PAGE);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, this.#d.retryPauseMs ?? 1500));
      return fetchPage(search, offset, PAGE);
    }
  }

  /** Pages through one league, one page in memory at a time. Gemini lists events by start time. */
  async #load(league: League): Promise<Game[]> {
    const fetchPage =
      this.#d.fetchPage ??
      ((search: string, offset: number, limit: number) =>
        listEvents({ status: "active", category: league.weather ? "Weather" : "Sports", search, limit, offset }));
    const now = this.#now();
    const events: GeminiEvent[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      let result: Page;
      try {
        result = await this.#page(fetchPage, league.search, page * PAGE);
      } catch (err) {
        // Gemini answers 503 now and then on these large pages. The pages already read are the
        // soonest games, so a list that stops early is still the part a merchant needs.
        if (page === 0) throw err;
        console.error(`[games] ${league.name}: stopped at page ${page + 1}:`, err);
        break;
      }
      const { data, pagination } = result;
      // "NBA" also finds "WNBA..." season markets; a game's ticker starts with the league and a dash.
      events.push(...data.filter((e) => e.ticker.startsWith(`${league.search}-`) && (league.weather ? isDailyHigh(e) : isGameWinner(e))));
      // Past the last game worth listing: season-long markets have no start time and come last.
      const pastHorizon = data.every((e) => {
        const start = eventStart(e);
        return start === null || start - now > HORIZON_SECONDS;
      });
      if (data.length < PAGE || (page + 1) * PAGE >= pagination.total || pastHorizon) break;
    }
    return league.weather ? toWeather(events, now, this.#d) : toGames(events, now, this.#d);
  }
}
