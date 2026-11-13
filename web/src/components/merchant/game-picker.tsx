"use client";

// Step 1 of the merchant form: which game, which team. One tap picks both. This is Gemini's game card
// with the Yes and No buttons removed: a merchant picks a team, not a side of a market.
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dayHeading, pct, timeOf } from "@/lib/format";
import { keeper, type Game, type GamesReply, type GameTeam, type IntervalWindow } from "@/lib/keeper";
import { useNow } from "@/lib/use-now";

export type Pick = { game: Game; team: GameTeam };

type Props = { picked: Pick | null; onPick: (pick: Pick) => void };

// Until the keeper answers, the tabs it is known to serve (keeper/src/games.ts).
const LEAGUES = [
  { key: "nfl", name: "Pro Football" },
  { key: "nba", name: "Pro Basketball" },
  { key: "nhl", name: "Pro Hockey" },
  { key: "ncaaf", name: "College Football" },
  { key: "ncaam", name: "College Basketball" },
];
const FIRST_SHOWN = 8;

// The build's test loop: with `?dev=1` in the address there is one more tab, 5-minute BTC markets,
// which settle in minutes where a game takes hours. It is never visible otherwise.
const CRYPTO = { key: "btc05m", name: "Crypto 5-min" };
const noop = () => () => {};
const useDev = () =>
  useSyncExternalStore(
    noop,
    () => new URLSearchParams(window.location.search).get("dev") === "1",
    () => false,
  );

/** A 5-minute window in the shape of a game with one side, "Up". */
const windowAsGame = (w: IntervalWindow): Game => ({
  eventTicker: w.eventTicker,
  game: w.eventTitle,
  startTime: w.closeTime,
  teams: [
    {
      instrumentSymbol: w.instrumentSymbol,
      team: "Up",
      condition: `${w.eventTitle} is Up`,
      chance: w.bestAsk === null ? null : Number(w.bestAsk),
      quotable: w.quotable && Number(w.bestAsk) < 0.95,
    },
  ],
});

const loadGames = (league: string, signal: AbortSignal): Promise<GamesReply> =>
  league === CRYPTO.key
    ? keeper.intervals(signal).then(({ windows }) => ({
        leagues: LEAGUES,
        league,
        games: windows.map(windowAsGame),
        fetchedAt: Math.floor(Date.now() / 1000),
      }))
    : keeper.games(league, signal);

export function GamePicker({ picked, onPick }: Props) {
  const [league, setLeague] = useState(LEAGUES[0]!.key);
  const [reply, setReply] = useState<GamesReply | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const now = useNow(60_000);
  const dev = useDev();

  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      loadGames(league, controller.signal).then(
        (games) => {
          setReply(games);
          setFailed(null);
        },
        () => {
          if (!controller.signal.aborted) setFailed(league);
        },
      );
    load();
    // Chances on the buttons are refreshed quietly; the price card below has the live one.
    const timer = window.setInterval(load, league === CRYPTO.key ? 20_000 : 60_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [league]);

  const leagues = [...(reply?.leagues ?? LEAGUES), ...(dev ? [CRYPTO] : [])];
  const loaded = reply && reply.league === league ? reply.games : null;
  const words = search.trim().toLowerCase();
  const matching = (loaded ?? []).filter(
    (g) => words === "" || g.game.toLowerCase().includes(words) || g.teams.some((t) => t.team.toLowerCase().includes(words)),
  );
  const shown = showAll || words !== "" ? matching : matching.slice(0, FIRST_SHOWN);

  // Games under a heading per day: Tonight, Tomorrow, Sun, Nov 15.
  const days: { heading: string; games: Game[] }[] = [];
  for (const game of shown) {
    const heading = dayHeading(game.startTime, now || undefined);
    const last = days[days.length - 1];
    if (last && last.heading === heading) last.games.push(game);
    else days.push({ heading, games: [game] });
  }

  return (
    <div className="space-y-3">
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
        {leagues.map((l) => (
          <Button
            key={l.key}
            variant="chip"
            selected={l.key === league}
            onClick={() => {
              setLeague(l.key);
              setShowAll(false);
            }}
          >
            {l.name}
          </Button>
        ))}
      </div>
      <Input type="search" placeholder="Search a team" aria-label="Search a team" value={search} onChange={(e) => setSearch(e.target.value)} />

      {loaded === null && failed !== league && (
        <div className="space-y-2" aria-label="Loading games">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[88px] animate-pulse rounded-[10px] border border-line bg-card" />
          ))}
        </div>
      )}
      {loaded === null && failed === league && (
        <p className="rounded-[10px] border border-line bg-card p-4 text-[15px]">We can&apos;t load the games right now. Try again in a moment.</p>
      )}
      {loaded !== null && matching.length === 0 && (
        <p className="rounded-[10px] border border-line bg-card p-4 text-[15px] text-ink/60">
          {words === "" ? "No games are open for promos in this league right now." : "No game matches that search."}
        </p>
      )}

      {days.map((day) => (
        <div key={day.heading} className="space-y-2">
          <h3 className="label pt-1">{day.heading}</h3>
          {day.games.map((game) => (
            <div key={game.eventTicker} className="rounded-[10px] border border-line bg-card p-3">
              <p className="text-[15px]">
                {game.game} <span className="num text-ink/60">· {timeOf(game.startTime)}</span>
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {game.teams.map((team) => {
                  const selected = picked?.team.instrumentSymbol === team.instrumentSymbol;
                  return (
                    <button
                      key={team.instrumentSymbol}
                      type="button"
                      disabled={!team.quotable}
                      aria-pressed={selected}
                      title={team.quotable ? undefined : "A promo on this team isn't available right now"}
                      onClick={() => onPick({ game, team })}
                      className={`flex h-12 items-center justify-between gap-2 rounded-[10px] border px-3 text-left text-[15px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-40 ${
                        selected ? "border-ink bg-ink text-white" : "border-line bg-paper hover:border-ink/40"
                      }`}
                    >
                      <span className="truncate">{team.team}</span>
                      <span className="num shrink-0">{team.chance === null ? "—" : pct(team.chance)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ))}

      {!showAll && words === "" && matching.length > FIRST_SHOWN && (
        <button className="text-[14px] underline underline-offset-2" onClick={() => setShowAll(true)}>
          Show all {matching.length} games
        </button>
      )}
    </div>
  );
}
