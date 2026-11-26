// What the plan page asks its server for: a league's games with both exchanges' markets for each team,
// one team's books, and one market's result for a voucher. Kalshi is the list; Polymarket US is added to a
// game when the same game is found there, and its absence never fails a read.
import { TICKER, type BooksReply, type GamesReply, type PlanGame, type VoucherMarket } from "@/lib/plan";
import { Refusal } from "./http";
import { kalshiBook, KalshiError, kalshiFee, kalshiGames, kalshiResult, leagueOf, LEAGUES } from "./kalshi";
import { matchGame, polymarketBook, polymarketFee, polymarketGames, type PolymarketGame } from "./polymarket";

/** Games are offered from now until this far ahead. Further out the books are too thin to price on. */
const AHEAD_SECONDS = 8 * 86_400;
const NO_PRICES = "We can't read the exchange's prices right now. Try again in a moment.";

const SLUG = /^[a-z0-9-]{6,80}$/;

export async function games(leagueKey: string): Promise<GamesReply> {
  const league = LEAGUES.find((l) => l.key === leagueKey);
  if (!league) throw new Refusal(400, "bad-request", "We don't list that league.");
  const [kalshi, polymarket] = await Promise.all([
    kalshiGames(league).catch((err: unknown) => {
      console.error("[plan]", err);
      throw new Refusal(502, "no-prices", NO_PRICES);
    }),
    polymarketGames(league.key).catch((err: unknown) => {
      console.error("[plan]", err);
      return [] as PolymarketGame[];
    }),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const list: PlanGame[] = [];
  for (const g of kalshi) {
    if (g.startTime <= now || g.startTime > now + AHEAD_SECONDS) continue;
    const [away, home] = g.teams;
    const twin = matchGame(polymarket, g.startTime, away!.name, home!.name);
    list.push({
      id: g.id,
      game: `${away!.name} at ${home!.name}`,
      kalshiTitle: g.kalshiTitle,
      startTime: g.startTime,
      teams: g.teams.map((t) => ({
        ...t,
        polymarket: twin ? { slug: twin.slug, long: t.home ? twin.home.long : twin.away.long, event: twin.event } : null,
      })),
    });
  }
  return { league: league.key, leagues: LEAGUES.map(({ key, name }) => ({ key, name })), games: list };
}

export async function books(ticker: string, slug: string | null, long: boolean): Promise<BooksReply> {
  const league = TICKER.test(ticker) ? leagueOf(ticker) : null;
  if (!league) throw new Refusal(400, "bad-request", "We don't know that game.");
  if (slug !== null && !SLUG.test(slug)) throw new Refusal(400, "bad-request", "We don't know that game.");
  const [kalshi, kalshiRate, polymarket, polymarketRate] = await Promise.all([
    kalshiBook(ticker).catch((err: unknown) => {
      console.error("[plan]", err);
      throw new Refusal(502, "no-prices", NO_PRICES);
    }),
    kalshiFee(league).catch(() => 0.07),
    slug === null ? null : polymarketBook({ slug, long }).catch(() => null),
    slug === null ? 0 : polymarketFee(league.key, slug),
  ]);
  return { kalshi, polymarket, fees: { kalshi: kalshiRate, polymarket: polymarketRate }, at: Date.now() };
}

export async function voucherMarket(ticker: string): Promise<VoucherMarket> {
  const league = TICKER.test(ticker) ? leagueOf(ticker) : null;
  if (!league) throw new Refusal(400, "bad-request", "We don't know that game.");
  const result = await kalshiResult(ticker, league).catch((err: unknown) => {
    if (err instanceof KalshiError && err.status === 404) throw new Refusal(404, "unknown-game", "We don't know that game.");
    console.error("[plan]", err);
    throw new Refusal(502, "no-prices", "We can't read the result right now. Try again in a moment.");
  });
  return { ticker, ...result };
}
